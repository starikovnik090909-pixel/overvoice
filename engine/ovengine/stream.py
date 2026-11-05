"""Потоковая обработка: принимает блоки звука с микрофона, отдаёт блоки голоса. Склейка блоков без щелчков (SOLA)."""
import numpy as np
import torch
import torch.nn.functional as F
from torchaudio.transforms import Resample


class Processor:
    def __init__(self, voice, device, io_sr=None, block=0.25, crossfade=0.05, extra=1.0):
        self.v, self.dev = voice, device
        self.sr = int(io_sr or voice.sr)
        self.zc = self.sr // 100
        zc, sr = self.zc, self.sr
        self.block = int(np.round(block * sr / zc)) * zc
        self.block16 = 160 * self.block // zc
        cf = int(np.round(crossfade * sr / zc)) * zc
        self.sola_n = min(cf, 4 * zc); self.sola_search = zc
        self.extra = int(np.round(extra * sr / zc)) * zc
        total = self.extra + cf + self.sola_search + self.block
        f = dict(device=device, dtype=torch.float32)
        self.inp = torch.zeros(total, **f)
        self.inp16 = torch.zeros(160 * total // zc, **f)
        self.sola = torch.zeros(self.sola_n, **f)
        self.den = torch.ones(1, 1, self.sola_n, **f)
        self.fin = torch.sin(0.5 * np.pi * torch.linspace(0.0, 1.0, steps=self.sola_n, **f)) ** 2
        self.fout = 1 - self.fin
        self.skip_head = self.extra // zc
        self.ret_len = (self.block + self.sola_n + self.sola_search) // zc
        self.to16 = Resample(orig_freq=sr, new_freq=16000, dtype=torch.float32).to(device)
        self.back = Resample(orig_freq=voice.sr, new_freq=sr, dtype=torch.float32).to(device) if voice.sr != sr else None
        self.warm = False

    def reset(self):
        for t in (self.inp, self.inp16, self.sola):
            t.zero_()
        self.v.reset()

    @property
    def latency(self):
        """Ожидаемая задержка без учёта времени расчёта: блок + склейка."""
        return (self.block + self.sola_n) / self.sr

    def process(self, x, key=0, index_rate=0.0, formant=0.0, gate_db=-48.0):
        """x — float32 моно, ровно block отсчётов. Возвращает массив той же длины."""
        n = self.block
        if x.shape[0] != n:
            raise ValueError('ожидался блок %d отсчётов, пришло %d' % (n, x.shape[0]))
        if gate_db > -68:   # шумовой порог (дБ от полной шкалы): тихие куски обнуляем; ниже -68 — выключен
            zc = self.zc; seg = x[:len(x) // zc * zc].reshape(-1, zc)
            rms = np.sqrt((seg ** 2).mean(axis=1) + 1e-12); db = 20 * np.log10(rms + 1e-9)
            loud = db >= gate_db
            keep = loud.copy()
            for k in range(1, 6):   # по 50 мс вокруг громкого куска оставляем: не обрезать начало и конец слов
                keep[k:] |= loud[:-k]; keep[:-k] |= loud[k:]
            for i in np.where(~keep)[0]:
                x[i * zc:(i + 1) * zc] = 0
        t = torch.from_numpy(np.ascontiguousarray(x)).to(self.dev)
        self.inp[:-n] = self.inp[n:].clone(); self.inp[-n:] = t
        self.inp16[:-self.block16] = self.inp16[self.block16:].clone()
        src = self.inp[-n - 2 * self.zc:]
        self.inp16[-160 * (n // self.zc + 1):] = self.to16(src)[160:]
        out = self.v.infer(self.inp16, self.block16, self.skip_head, self.ret_len, key, index_rate, formant)
        if self.back is not None:
            out = self.back(out)
        conv = out[None, None, :self.sola_n + self.sola_search]
        nom = F.conv1d(conv, self.sola[None, None, :])
        den = torch.sqrt(F.conv1d(conv ** 2, self.den) + 1e-8)
        off = int(torch.argmax(nom[0, 0] / den[0, 0]))
        out = out[off:]
        out[:self.sola_n] = out[:self.sola_n] * self.fin + self.sola * self.fout
        self.sola[:] = out[n:n + self.sola_n]
        return out[:n].cpu().numpy()
