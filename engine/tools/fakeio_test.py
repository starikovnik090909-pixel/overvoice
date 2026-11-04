"""Проверка звукового потока без железа: подменяем sounddevice поддельным и гоняем речь через настоящий движок."""
import os, subprocess, sys, threading, time, types
import numpy as np
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'); sys.path.insert(0, root)
src = sys.argv[1]; voice = sys.argv[2]; secs = float(sys.argv[3]) if len(sys.argv) > 3 else 6
SR = 48000
raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', src, '-t', str(secs), '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True).stdout
speech = np.frombuffer(raw, dtype=np.float32).copy(); collected = []
class Stream:
    def __init__(s, device, samplerate, channels, dtype, blocksize, callback, extra_settings=None, latency=None):
        s.cb = callback; s.run = False; assert samplerate == SR
    def start(s):
        s.run = True; threading.Thread(target=s.loop, daemon=True).start()
    def loop(s):
        i = 0; F = 480
        while s.run and i + F <= len(speech):
            out = np.zeros((F, 1), dtype=np.float32); s.cb(speech[i:i + F, None].copy(), out, F, None, None); collected.append(out[:, 0].copy()); i += F; time.sleep(F / SR)
        s.run = False
    def abort(s): s.run = False
    def close(s): pass
fake = types.ModuleType('sounddevice'); fake.Stream = Stream; fake.WasapiSettings = lambda **k: None
fake.query_hostapis = lambda: [{'name': 'Windows WASAPI'}]
fake.query_devices = lambda: [{'name': 'Test Mic', 'hostapi': 0, 'max_input_channels': 1, 'max_output_channels': 0, 'default_samplerate': SR}, {'name': 'CABLE Input (VB-Audio Virtual Cable)', 'hostapi': 0, 'max_input_channels': 0, 'max_output_channels': 2, 'default_samplerate': SR}]
sys.modules['sounddevice'] = fake
from ovengine.core import Engine
e = Engine(os.environ.get('OV_ASSETS', 'assets'), os.environ.get('OV_VOICES', 'voices'))
e.settings(block=float(os.environ.get("BLK","0.5")), extra=0.5); e.use(voice); e.start('Test Mic', 'CABLE')
time.sleep(secs + 1.5); e.stop()
y = np.concatenate(collected) if collected else np.zeros(1)
i = e.info(); print('io', i['io'], 'stats', i['stats'], 'latency_ms', i['latency_ms'], 'out_rms', round(float(np.sqrt((y ** 2).mean())), 4), 'sec', round(len(y) / SR, 1))
assert i['stats']['blocks'] >= 3 and np.abs(y).max() > 0.01, 'звук не прошёл через движок'
print('✓ поток работает: блоков', i['stats']['blocks'], 'пропусков', i['stats']['late'], 'сброшено', i['stats']['dropped'])
