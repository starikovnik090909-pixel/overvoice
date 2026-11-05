"""Ядро движка: голоса, настройки, звуковой поток. Всё, что нужно Овервойсу, доступно через методы этого класса."""
import glob
import json
import logging
import os
import queue
import threading
import time
import traceback
from collections import OrderedDict, deque

import numpy as np
import torch

from ovengine.hub import load_hubert, load_rmvpe
from ovengine.stream import Processor
from ovengine.voice import Voice

log = logging.getLogger('ovengine')

DEFAULTS = {'pitch': 0, 'index_rate': 0.5, 'formant': 0.0, 'gate_db': -48.0, 'gain': 1.0, 'rms_mix': 0.25,
            'block': 0.25, 'extra': 1.0, 'crossfade': 0.05, 'passthrough': False, 'half': False}
LIMITS = {'pitch': (-24, 24), 'index_rate': (0, 1), 'formant': (-6, 6), 'gate_db': (-90, 0), 'gain': (0, 4), 'rms_mix': (0, 1),
          'block': (0.08, 1.5), 'extra': (0.0, 5.0), 'crossfade': (0.01, 0.2)}
REBUILD = ('block', 'extra', 'crossfade')   # эти настройки пересоздают буферы


class EngineError(Exception):
    pass


def pick_device():
    if torch.cuda.is_available():
        return torch.device('cuda'), torch.cuda.get_device_name(0)
    return torch.device('cpu'), 'процессор'


class Engine:
    def __init__(self, assets, voices, max_loaded=2):
        self.assets, self.voices_dir, self.max_loaded = assets, voices, max_loaded
        self.dev, self.dev_name = pick_device()
        self.cfg = dict(DEFAULTS)
        self.hub = self.rm = None
        self.loaded = OrderedDict()   # имя -> Voice
        self.active = ''
        self.proc = None
        self.lock = threading.RLock()
        self.logs = deque(maxlen=80); self.err = ''
        self.stats = {'proc_ms': 0.0, 'blocks': 0, 'late': 0, 'dropped': 0}
        self._run = False; self._thr = None; self._stream = None; self._qin = None; self._qout = None
        self._gain_prev = 1.0
        self.io = {'input': '', 'output': ''}
        self.pref = {'input': '', 'output': ''}; self.state_file = os.path.join(os.path.dirname(os.path.abspath(assets)), 'engine_state.json')
        try:
            import json; self.pref.update({k: str(v) for k, v in json.load(open(self.state_file, encoding='utf-8')).items() if k in self.pref})
        except Exception:
            pass

    # ---------- журнал ----------
    def say(self, m):
        self.logs.append(time.strftime('%H:%M:%S ') + str(m)); log.info(m)

    def fail(self, e):
        self.err = str(e); self.say('ОШИБКА: ' + self.err); log.error(traceback.format_exc())

    # ---------- голоса ----------
    def _shared(self):
        with self.lock:
            self._shared_locked()

    def _shared_locked(self):
        if self.hub is None or self.rm is None:
            half = bool(self.cfg['half']) and self.dev.type == 'cuda'
            self.say('Загружаю общие модели (HuBERT, RMVPE) на ' + self.dev_name)
            hub = load_hubert(self.assets, self.dev, half); rm = load_rmvpe(self.assets, self.dev, half)
            self.hub, self.rm = hub, rm   # оба сразу: если вторая модель не загрузилась, первая не считается готовой

    def files_of(self, name):
        d = os.path.join(self.voices_dir, name)
        if not os.path.isdir(d) or os.path.basename(name) != name:
            raise EngineError('Голоса «%s» нет в библиотеке' % name)
        pth = sorted(glob.glob(os.path.join(d, '*.pth')))
        if not pth:
            raise EngineError('В папке голоса «%s» нет файла .pth (формат ONNX этот движок не читает)' % name)
        idx = sorted(glob.glob(os.path.join(d, '*.index')))
        return pth[0], (idx[0] if idx else '')

    def library(self):
        out = []
        try:
            for n in sorted(os.listdir(self.voices_dir)):
                try:
                    p, i = self.files_of(n); out.append({'name': n, 'index': bool(i), 'loaded': n in self.loaded})
                except EngineError:
                    pass
        except OSError:
            pass
        return out

    def load(self, name):
        """Загрузить голос в память (быстро, если уже загружен)."""
        with self.lock:
            if name in self.loaded:
                self.loaded.move_to_end(name); return self.loaded[name]
            pth, idx = self.files_of(name)
            self._shared()
            self.say('Загружаю голос «%s»' % name); t = time.time()
            half = bool(self.cfg['half']) and self.dev.type == 'cuda'
            v = Voice(pth, idx, self.dev, half, self.hub, self.rm)
            self.loaded[name] = v
            while len(self.loaded) > self.max_loaded:
                old = next(iter(self.loaded))
                if old == self.active:
                    self.loaded.move_to_end(old); old = next(iter(self.loaded))
                del self.loaded[old]; self.say('Выгружен голос «%s»' % old)
            self.say('Голос «%s» готов за %.1f с (частота %d)' % (name, time.time() - t, v.sr))
            return v

    def use(self, name):
        """Сделать голос активным: загрузить, если нужно, и подставить в поток."""
        with self.lock:
            self.err = ''
            try:
                v = self.load(name)
                self.active = name
                self._build(v)
                self.warm()
                if self._run:
                    self.reset_buffers()
                self.say('Включён голос «%s»' % name)
            except Exception as e:
                self.fail(e); raise
        return True

    def _build(self, voice):
        self.proc = Processor(voice, self.dev, io_sr=self.io_sr(voice), block=self.cfg['block'], crossfade=self.cfg['crossfade'], extra=self.cfg['extra'])

    def warm(self):
        """Прогрев: первые блоки у нейросети самые медленные. Делаем их заранее на тишине, чтобы в эфире их не было."""
        p = self.proc
        if p is None:
            return
        t = time.time()
        for _ in range(2):
            p.process(np.zeros(p.block, dtype=np.float32), key=self.cfg['pitch'], index_rate=self.cfg['index_rate'])
        p.reset(); self._gain_prev = 1.0
        self.say('Прогрев голоса: %.1f с' % (time.time() - t))

    def io_sr(self, voice):
        return getattr(self, '_io_sr', None) or voice.sr

    def reset_buffers(self):
        if self.proc:
            self.proc.reset()
        self._gain_prev = 1.0

    # ---------- настройки ----------
    def settings(self, **kw):
        with self.lock:
            rebuild = False
            for k, val in kw.items():
                if k not in DEFAULTS:
                    raise EngineError('Неизвестная настройка: ' + k)
                if isinstance(DEFAULTS[k], bool):
                    val = bool(val)
                else:
                    val = float(val); lo, hi = LIMITS[k]; val = max(lo, min(hi, val))
                if k == 'half' and val != self.cfg['half']:
                    self.hub = None; self.loaded.clear()
                if self.cfg.get(k) != val and k in REBUILD:
                    rebuild = True
                self.cfg[k] = val
            if rebuild and self.active and self.active in self.loaded:
                self._build(self.loaded[self.active])
        return dict(self.cfg)

    # ---------- обработка блока ----------
    def run_block(self, x):
        """Один блок звука (float32 моно, длина proc.block) -> блок голоса. Используется потоком и тестами."""
        p = self.proc
        if p is None:
            raise EngineError('Голос не выбран')
        c = self.cfg
        if c['passthrough']:
            return (x * c['gain']).astype(np.float32)
        rin = float(np.sqrt(np.mean(x ** 2)) + 1e-9)
        y = p.process(x.copy(), key=c['pitch'], index_rate=c['index_rate'], formant=c['formant'], gate_db=c['gate_db'])
        if c['rms_mix'] < 1:   # выровнять громкость по входу, плавно, чтобы не было ступенек
            rout = float(np.sqrt(np.mean(y ** 2)) + 1e-3)
            g = float(np.clip((rin / rout) ** (1.0 - c['rms_mix']), 0.0, 4.0)) if rin > 1e-3 else 0.0
            ramp = np.linspace(self._gain_prev, g, len(y), dtype=np.float32); self._gain_prev = g; y = y * ramp
        return np.clip(y * c['gain'], -1.0, 1.0).astype(np.float32)

    # ---------- звук ----------
    def devices(self):
        import sounddevice as sd
        apis = [a['name'] for a in sd.query_hostapis()]
        out = []
        for i, d in enumerate(sd.query_devices()):
            out.append({'id': i, 'name': d['name'], 'api': apis[d['hostapi']], 'in': d['max_input_channels'], 'out': d['max_output_channels'], 'sr': int(d['default_samplerate'])})
        return out

    def _find(self, want, kind):
        """Найти устройство по части имени. Предпочитает WASAPI (меньше задержка), потом остальные."""
        devs = [d for d in self.devices() if d[kind] > 0]
        if want in (None, ''):
            raise EngineError('Не выбрано устройство ' + ('ввода' if kind == 'in' else 'вывода'))
        w = str(want).lower()
        if str(want).isdigit() and int(want) < len(self.devices()):
            return self.devices()[int(want)]
        hit = [d for d in devs if w in d['name'].lower()]
        if not hit:
            raise EngineError('Устройство «%s» не найдено' % want)
        hit.sort(key=lambda d: ('WASAPI' not in d['api'], 'MME' in d['api']))
        return hit[0]

    def _save_pref(self):
        try:
            import json; json.dump(self.pref, open(self.state_file, 'w', encoding='utf-8'), ensure_ascii=False)
        except OSError:
            pass

    def pick_device_id(self, kind, did):
        """Запомнить устройство по номеру (в файле храним имя: номера между запусками меняются)."""
        if did < 0:
            self.pref[kind] = ''
        else:
            d = next((x for x in self.devices() if x['id'] == did), None)
            if d is None:
                raise EngineError('Нет устройства с номером %d' % did)
            self.pref[kind] = d['name']
        self._save_pref()

    def pref_ids(self):
        """Номера выбранных устройств (или -1)."""
        try:
            devs = self.devices()
        except Exception:
            return -1, -1
        def f(kind, key):
            n = self.pref[kind]
            if not n:
                return -1
            hit = sorted([d for d in devs if d['name'] == n and d[key] > 0], key=lambda d: 'WASAPI' not in d['api'])
            return hit[0]['id'] if hit else -1
        return f('input', 'in'), f('output', 'out')

    def auto_device(self, kind):
        """Выбор по умолчанию: микрофон — системный, вывод — виртуальный кабель, если он есть."""
        import sounddevice as sd
        devs = [d for d in self.devices() if d['in' if kind == 'input' else 'out'] > 0]
        if kind == 'output':
            cab = [d for d in devs if 'cable input' in d['name'].lower()]
            if cab:
                return sorted(cab, key=lambda d: 'WASAPI' not in d['api'])[0]['name']
            raise EngineError('Не найден виртуальный кабель (CABLE Input). Поставь его кнопкой в разделе «Звук и OBS»')
        try:
            di = sd.default.device[0]; return next(d['name'] for d in devs if d['id'] == di)
        except Exception:
            raise EngineError('Не выбран микрофон')

    def start(self, inp, out):
        inp = inp or self.pref['input'] or self.auto_device('input')
        out = out or self.pref['output'] or self.auto_device('output')
        return self._start(inp, out)

    def _start(self, inp, out):
        import sounddevice as sd
        with self.lock:
            if self._run:
                self.stop()
            if not self.active:
                raise EngineError('Сначала выбери голос')
            self.err = ''
            try:
                di, do = self._find(inp, 'in'), self._find(out, 'out')
                sr = do['sr'] if do['sr'] else 48000
                self._io_sr = sr; self._build(self.loaded[self.active]); self.warm()
                p = self.proc; n = p.block
                self._qin = queue.Queue(maxsize=8); self._qout = queue.Queue(maxsize=8)
                self._run = True; self.stats = {'proc_ms': 0.0, 'blocks': 0, 'late': 0, 'dropped': 0}
                extra = sd.WasapiSettings(auto_convert=True) if 'WASAPI' in di['api'] and 'WASAPI' in do['api'] else None
                outq, inq, st = self._qout, self._qin, self.stats
                buf_in = np.zeros(0, dtype=np.float32); buf_out = [np.zeros(0, dtype=np.float32)]

                def cb(indata, outdata, frames, t, status):
                    mono = indata.mean(axis=1) if indata.ndim > 1 and indata.shape[1] > 1 else indata[:, 0]
                    try:
                        inq.put_nowait(mono.astype(np.float32).copy())
                    except queue.Full:
                        st['dropped'] += 1
                    need = frames; got = buf_out[0]
                    while len(got) < need:
                        try:
                            got = np.concatenate([got, outq.get_nowait()])
                        except queue.Empty:
                            st['late'] += 1; got = np.concatenate([got, np.zeros(need - len(got), dtype=np.float32)]); break
                    outdata[:] = got[:need, None]; buf_out[0] = got[need:]

                self._thr = threading.Thread(target=self._work, daemon=True, name='ov-work'); self._thr.start()
                self._stream = sd.Stream(device=(di['id'], do['id']), samplerate=sr, channels=(1, 1), dtype='float32', blocksize=0, callback=cb, extra_settings=extra, latency='low')
                self._stream.start(); self.io = {'input': di['name'], 'output': do['name']}
                self.say('Звук включён: %s → %s (%d Гц)' % (di['name'], do['name'], sr))
            except Exception as e:
                self._run = False; self.fail(e); raise

    def _work(self):
        pend = np.zeros(0, dtype=np.float32)
        while self._run:
            p = self.proc; n = p.block
            try:
                pend = np.concatenate([pend, self._qin.get(timeout=0.2)])
            except queue.Empty:
                continue
            while len(pend) >= n and self._run:
                blk, pend = pend[:n], pend[n:]
                t = time.perf_counter()
                try:
                    y = self.run_block(blk)
                except Exception as e:
                    self.fail(e); y = np.zeros(n, dtype=np.float32); time.sleep(0.2)
                ms = (time.perf_counter() - t) * 1000
                s = self.stats; s['blocks'] += 1; s['proc_ms'] = ms if s['blocks'] == 1 else s['proc_ms'] * 0.9 + ms * 0.1
                try:
                    self._qout.put_nowait(y)
                except queue.Full:
                    s['dropped'] += 1
            if self._qin.qsize() > 4:   # не успеваем: выбрасываем накопившееся, лучше короткий провал, чем растущая задержка
                while self._qin.qsize() > 1:
                    try: self._qin.get_nowait(); self.stats['dropped'] += 1
                    except queue.Empty: break

    def stop(self):
        with self.lock:
            self._run = False
            if self._stream is not None:
                try: self._stream.abort(); self._stream.close()
                except Exception: pass
                self._stream = None
            if self._thr is not None:
                self._thr.join(timeout=3); self._thr = None
            self.say('Звук остановлен')

    # ---------- состояние ----------
    def info(self):
        p = self.proc
        lat = round((p.latency + self.stats['proc_ms'] / 1000) * 1000) if p else 0
        return {'version': __import__('ovengine').__version__, 'device': self.dev_name, 'cuda': self.dev.type == 'cuda', 'active': self.active, 'live': self._run,
                'loaded': list(self.loaded), 'settings': dict(self.cfg), 'io': self.io, 'stats': dict(self.stats), 'latency_ms': lat,
                'error': self.err, 'log': list(self.logs)[-12:], 'sr': p.sr if p else 0}
