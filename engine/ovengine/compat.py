"""Совместимость: в коде RVC инференс обёрнут в run_cuda_graph. Здесь он просто вызывает функцию (быстро и без сюрпризов на любой карте)."""


def run_cuda_graph(model, key, fn, *args, **kwargs):
    return fn(*args, **kwargs)


# ---------- слой совместимости с VCClient: Овервойс и админка уже умеют говорить так ----------
import math
import os


def _slots(eng):
    out = []
    for i, v in enumerate(eng.library()):
        try:
            pth, _ = eng.files_of(v['name'])
        except Exception:
            continue
        out.append({'slotIndex': i, 'voiceChangerType': 'RVC', 'name': os.path.basename(pth), 'voice': v['name']})
    return out


def _lists(eng):
    try:
        devs = eng.devices()
    except Exception:
        return [], []
    if any('WASAPI' in d['api'] for d in devs):
        devs = [d for d in devs if 'WASAPI' in d['api']]   # без дублей из MME/DirectSound/WDM-KS
    ins = [{'kind': 'audioinput', 'index': d['id'], 'name': d['name'], 'hostAPI': d['api']} for d in devs if d['in'] > 0]
    outs = [{'kind': 'audiooutput', 'index': d['id'], 'name': d['name'], 'hostAPI': d['api']} for d in devs if d['out'] > 0]
    return ins, outs


def vc_info(eng):
    """Ответ /info в форме VCClient (плюс собственные поля движка)."""
    d = eng.info(); slots = _slots(eng)
    idx = next((s['slotIndex'] for s in slots if s['voice'] == eng.active), 0)
    ins, outs = _lists(eng); c = eng.cfg
    di, do = eng.pref_ids()
    gate = c['gate_db']
    d.update({
        'modelSlots': slots, 'modelSlotIndex': idx, 'serverAudioStated': 1 if eng._run else 0, 'passThrough': 1 if c['passthrough'] else 0,
        'serverInputDeviceId': di, 'serverOutputDeviceId': do, 'serverMonitorDeviceId': -1,
        'serverAudioInputDevices': ins, 'serverAudioOutputDevices': outs, 'gpus': [{'id': 0 if eng.dev.type == 'cuda' else -1, 'name': eng.dev_name}],
        'tran': c['pitch'], 'indexRatio': c['index_rate'], 'silentThreshold': 0 if gate <= -68 else 10 ** (gate / 20), 'serverOutputAudioGain': c['gain'],
        'serverReadChunkSize': int(round(c['block'] * 48000 / 128)), 'crossFadeOverlapSize': c['crossfade'], 'f0Detector': 'rmvpe',   # единицы как в VCClient: кусок = 128 отсчётов при 48 кГц
    })
    return d


def vc_set(eng, key, val, work=lambda text, fn: fn()):
    """Один параметр в форме VCClient (/update_settings). Возвращает True, если параметр понят."""
    f = lambda: float(val)
    if key == 'modelSlotIndex':
        slots = _slots(eng); i = int(f())
        if not 0 <= i < len(slots):
            raise ValueError('Нет голоса с номером %d' % i)
        work('Готовлю голос «%s»…' % slots[i]['voice'], lambda: eng.use(slots[i]['voice'])); return True
    if key == 'tran': eng.settings(pitch=f()); return True
    if key == 'indexRatio': eng.settings(index_rate=f()); return True
    if key == 'silentThreshold': eng.settings(gate_db=-90.0 if f() <= 0 else 20 * math.log10(f())); return True
    if key == 'serverOutputAudioGain': eng.settings(gain=f()); return True
    if key == 'serverReadChunkSize': eng.settings(block=f() * 128 / 48000); return True
    if key == 'crossFadeOverlapSize': eng.settings(crossfade=f()); return True
    if key == 'f0Detector': return True   # в Овервойсе всегда RMVPE
    if key == 'passThrough': eng.settings(passthrough=f() >= 1); return True
    if key in ('serverInputDeviceId', 'serverOutputDeviceId'):
        eng.pick_device_id('input' if key == 'serverInputDeviceId' else 'output', int(f())); return True
    if key == 'serverAudioStated':
        if f() >= 1:
            work('Включаю звук…', lambda: eng.start(None, None))
        else:
            eng.stop()
        return True
    return key in ('enableServerAudio', 'serverMonitorDeviceId')   # понятные, но ничего не меняющие
