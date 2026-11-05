"""Обработка звука вокруг нейросети: шумоподавление на входе, компрессор и ограничитель на выходе.
Всё на numpy, без дополнительных библиотек; состояние хранится между блоками, чтобы на стыках не было щелчков."""
import numpy as np

WIN, HOP = 512, 128


class Denoiser:
    """Потоковый спектральный шумодав (окно 512, шаг 128, 75% перекрытие): шум оценивается по паузам, из спектра вычитается."""

    def __init__(self):
        self.win = np.sqrt(np.hanning(WIN + 1)[:-1]).astype(np.float32)
        self.acc = np.zeros(WIN - HOP, dtype=np.float32)       # входной хвост: нули, потом настоящий звук
        self.ola = np.zeros(WIN, dtype=np.float32)
        self.fifo = np.zeros(HOP, dtype=np.float32)
        self.noise = None; self.ps = None; self.gprev = None

    def process(self, x, strength):
        """x — float32 моно. strength 0..1. Возвращает массив той же длины (с постоянной задержкой ~3-4 мс)."""
        n = len(x)
        self.acc = np.concatenate([self.acc, x.astype(np.float32)])
        out = []
        over = 1.0 + 2.5 * strength; gmin = 10 ** (-(8 + 22 * strength) / 20)
        while len(self.acc) >= WIN:
            fr = self.acc[:WIN] * self.win
            X = np.fft.rfft(fr)
            P = (X.real ** 2 + X.imag ** 2) + 1e-12
            if self.noise is None:
                self.noise = P.copy(); self.ps = P.copy(); self.gprev = np.ones_like(P); self.xi_prev = np.zeros_like(P)
            self.ps = 0.85 * self.ps + 0.15 * P                    # медленное сглаживание — для оценки шума
            # шум: вниз к тихим кускам, медленно (~3 дБ/с) вверх
            self.noise = np.where(self.ps < self.noise, 0.9 * self.noise + 0.1 * self.ps, self.noise * 1.002)
            nz = self.noise * (1.0 + 1.5 * strength) * 1.6          # запас: минимум занижает среднюю мощность шума
            gam = P / nz
            xi = 0.92 * (self.gprev ** 2) * self.gam_prev + 0.08 * np.maximum(gam - 1.0, 0.0) if hasattr(self, 'gam_prev') else np.maximum(gam - 1.0, 0.0)
            self.gam_prev = gam
            g = np.maximum(xi / (1.0 + xi), gmin)                   # фильтр Винера по отношению сигнал/шум
            g = np.maximum(g, self.gprev * 0.9)
            g = 0.25 * np.roll(g, 1) + 0.5 * g + 0.25 * np.roll(g, -1)
            self.gprev = g
            y = np.fft.irfft(X * g, WIN).astype(np.float32) * self.win * 0.5   # 0.5: сумма окон при 75% перекрытии равна 2
            self.ola += y
            out.append(self.ola[:HOP].copy())
            self.ola = np.concatenate([self.ola[HOP:], np.zeros(HOP, dtype=np.float32)])
            self.acc = self.acc[HOP:]
        if out:
            self.fifo = np.concatenate([self.fifo] + out)
        res = self.fifo[:n]; self.fifo = self.fifo[n:]
        if len(res) < n:   # на случай самого первого блока короче окна
            res = np.concatenate([np.zeros(n - len(res), dtype=np.float32), res])
        return res.astype(np.float32)


class Compressor:
    """Мягкий компрессор по уровню (RMS по 10 мс): выравнивает тихие и громкие слова, не поднимает тишину."""

    def __init__(self, sr):
        self.fr = max(1, sr // 100); self.red = 0.0; self.gprev = 1.0

    def process(self, y, amount):
        if amount <= 0.01:
            self.red = 0.0; self.gprev = 1.0; return y
        fr = self.fr; nfr = max(1, len(y) // fr)
        R = 1.0 + 5.0 * amount; T = -26.0
        seg = y[:nfr * fr].reshape(nfr, fr)
        env = 20 * np.log10(np.sqrt((seg ** 2).mean(axis=1)) + 1e-9)
        want = (1 - 1 / R) * np.maximum(env - T, 0.0)             # сколько дБ убрать
        make = (1 - 1 / R) * (-T) * 0.45 * np.clip((env + 58) / 12, 0.0, 1.0)   # добавка громкости, но не на шуме
        gdb = np.empty(nfr, dtype=np.float32); red = self.red
        for i in range(nfr):
            red = 0.5 * red + 0.5 * want[i] if want[i] > red else 0.93 * red + 0.07 * want[i]
            gdb[i] = make[i] - red
        self.red = red
        g = 10 ** (gdb / 20)
        # плавно между центрами кусков
        xs = np.arange(nfr) * fr + fr / 2.0
        full = np.interp(np.arange(len(y)), np.concatenate([[-fr / 2.0], xs]), np.concatenate([[self.gprev], g])).astype(np.float32)
        self.gprev = float(g[-1])
        return y * full


class Limiter:
    """Ограничитель пиков: громче потолка не будет, сначала плавно прижимает усиление, в конце страховка."""

    def __init__(self, sr):
        self.fr = max(1, sr // 1000); self.g = 1.0

    def process(self, y, ceil_db):
        c = 10 ** (ceil_db / 20); fr = self.fr
        nfr = max(1, len(y) // fr); seg = np.abs(y[:nfr * fr]).reshape(nfr, fr).max(axis=1)
        tgt = np.minimum(1.0, c / (seg + 1e-9))
        g = np.empty(nfr, dtype=np.float32); cur = self.g
        for i in range(nfr):
            cur = tgt[i] if tgt[i] < cur else cur + (1.0 - cur) * 0.004   # вниз сразу, вверх за ~250 мс
            g[i] = cur
        self.g = cur
        # усиление на куске берём минимальным из соседних: пик не проскочит на стыке
        gm = np.minimum(g, np.minimum(np.concatenate([[g[0]], g[:-1]]), np.concatenate([g[1:], [g[-1]]])))
        full = np.repeat(gm, fr); full = np.concatenate([full, np.full(len(y) - len(full), gm[-1], dtype=np.float32)])
        return np.clip(y * full, -c, c).astype(np.float32)


class Chain:
    def __init__(self, sr):
        self.sr = sr; self.dn = Denoiser(); self.cp = Compressor(sr); self.lm = Limiter(sr)

    def denoise(self, x, strength):
        return self.dn.process(x, strength) if strength > 0.01 else x

    def master(self, y, comp, ceil_db):
        return self.lm.process(self.cp.process(y, comp), ceil_db)
