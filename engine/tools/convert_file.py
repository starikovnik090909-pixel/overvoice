import sys, time, subprocess, numpy as np, torch, soundfile as sf
import os; sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from ovengine.hub import load_hubert, load_rmvpe
from ovengine.voice import Voice
from ovengine.stream import Processor
name, src, out = sys.argv[1], sys.argv[2], sys.argv[3]
dev = torch.device('cpu'); half = False
A = os.environ.get('OV_ASSETS', 'assets'); t0 = time.time()
hub = load_hubert(A, dev, half); rm = load_rmvpe(A, dev, half); print('shared', round(time.time() - t0, 1))
d = os.environ.get('OV_VOICES', 'voices') + '/' + name
t0 = time.time(); v = Voice(d + '/' + name + '.pth', d + '/' + name + '.index', dev, half, hub, rm); print('voice', round(time.time() - t0, 1), 'sr', v.sr, 'f0', v.f0, v.version)
P = Processor(v, dev, block=float(sys.argv[4]) if len(sys.argv) > 4 else 0.25, extra=float(sys.argv[5]) if len(sys.argv) > 5 else 1.0)
raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', src, '-t', '8', '-ac', '1', '-ar', str(P.sr), '-f', 'f32le', '-'], capture_output=True).stdout
x = np.frombuffer(raw, dtype=np.float32).copy(); x = np.pad(x, (0, (-len(x)) % P.block))
res = []; tt = []
for i in range(0, len(x), P.block):
    t0 = time.time(); res.append(P.process(x[i:i + P.block].copy(), key=0, index_rate=0.5)); tt.append(time.time() - t0)
y = np.concatenate(res); sf.write(out, y, P.sr)
print('blocks', len(tt), 'block_s', P.block / P.sr, 'avg_proc', round(np.mean(tt[2:]), 3), 'max', round(max(tt), 3), 'latency_min_s', round(P.latency, 3), 'peak', float(np.abs(y).max()))
