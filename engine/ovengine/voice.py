"""Один голос RVC: модель .pth + (по желанию) индекс .index. Преобразует кусок звука 16 кГц в звук голоса."""
import numpy as np
import torch
import torch.nn.functional as F
from torchaudio.transforms import Resample

from ovengine.hub import hubert_features


def load_synth(pth, device, half):
    from ovengine.module.models import (SynthesizerTrnMs256NSFsid, SynthesizerTrnMs256NSFsid_nono,
                                        SynthesizerTrnMs768NSFsid, SynthesizerTrnMs768NSFsid_nono)
    cpt = torch.load(pth, map_location='cpu', weights_only=False)
    cpt['config'][-3] = cpt['weight']['emb_g.weight'].shape[0]
    f0 = cpt.get('f0', 1); ver = cpt.get('version', 'v1')
    cls = {('v1', 1): SynthesizerTrnMs256NSFsid, ('v1', 0): SynthesizerTrnMs256NSFsid_nono,
           ('v2', 1): SynthesizerTrnMs768NSFsid, ('v2', 0): SynthesizerTrnMs768NSFsid_nono}[(ver, f0)]
    net = cls(*cpt['config'], is_half=False) if f0 else cls(*cpt['config'])
    del net.enc_q
    net.load_state_dict(cpt['weight'], strict=False)
    net = net.float().eval().to(device)
    net.remove_weight_norm()
    if half:
        net = net.half()
    return net, cpt['config'][-1], f0, ver


class Voice:
    F0_MIN, F0_MAX = 50, 1100

    def __init__(self, pth, index, device, half, hubert, rmvpe):
        self.device, self.half, self.hubert, self.rmvpe = device, half, hubert, rmvpe
        self.net, self.sr, self.f0, self.version = load_synth(pth, device, half)
        self.index_path = index; self.index = None; self.big = None
        self.mel_min = 1127 * np.log(1 + self.F0_MIN / 700); self.mel_max = 1127 * np.log(1 + self.F0_MAX / 700)
        self.cache_pitch = torch.zeros(1024, device=device, dtype=torch.long)
        self.cache_pitchf = torch.zeros(1024, device=device, dtype=torch.float32)
        self._res = {}

    def reset(self):
        self.cache_pitch.zero_(); self.cache_pitchf.zero_()

    def _load_index(self):
        import faiss
        self.index = faiss.read_index(self.index_path)
        self.big = self.index.reconstruct_n(0, self.index.ntotal)

    def _f0(self, x, key):
        f0 = self.rmvpe.infer_from_audio(x, thred=0.03)
        uv = f0 == 0
        if np.any(~uv):
            f0[uv] = np.interp(np.where(uv)[0], np.where(~uv)[0], f0[~uv])
        f0 = f0 * pow(2, key / 12)
        f0 = torch.from_numpy(np.asarray(f0)).float().to(self.device).squeeze()
        mel = 1127 * torch.log(1 + f0 / 700)
        mel[mel > 0] = (mel[mel > 0] - self.mel_min) * 254 / (self.mel_max - self.mel_min) + 1
        mel[mel <= 1] = 1; mel[mel > 255] = 255
        return torch.round(mel).long(), f0

    def infer(self, wav16, block16, skip_head, ret_len, key=0, index_rate=0.0, formant=0.0):
        """wav16 — буфер 16 кГц (tensor), block16 — длина нового куска. Возвращает звук в частоте модели."""
        dt = torch.float16 if self.half else torch.float32
        with torch.no_grad():
            feats = hubert_features(self.hubert, wav16.to(dt).view(1, -1), self.version)
            feats = torch.cat((feats, feats[:, -1:, :]), 1)
            if index_rate > 0 and self.index_path:
                if self.index is None:
                    self._load_index()
                npy = feats[0][skip_head // 2:].float().cpu().numpy().astype('float32')
                score, ix = self.index.search(npy, k=8)
                if (ix >= 0).all():
                    w = np.square(1 / score); w /= w.sum(axis=1, keepdims=True)
                    npy = np.sum(self.big[ix] * np.expand_dims(w, axis=2), axis=1)
                    if self.half:
                        npy = npy.astype('float16')
                    feats[0][skip_head // 2:] = torch.from_numpy(npy).unsqueeze(0).to(self.device) * index_rate + (1 - index_rate) * feats[0][skip_head // 2:]
            p_len = wav16.shape[0] // 160
            factor = pow(2, formant / 12)
            ret2 = int(np.ceil(ret_len * factor))
            if self.f0:
                n = block16 + 800
                n = 5120 * ((n - 1) // 5120 + 1) - 160
                pitch, pitchf = self._f0(wav16[-n:], key - formant)
                shift = block16 // 160
                self.cache_pitch[:-shift] = self.cache_pitch[shift:].clone()
                self.cache_pitchf[:-shift] = self.cache_pitchf[shift:].clone()
                self.cache_pitch[4 - pitch.shape[0]:] = pitch[3:-1]
                self.cache_pitchf[4 - pitchf.shape[0]:] = pitchf[3:-1]
                cp = self.cache_pitch[None, -p_len:]; cpf = self.cache_pitchf[None, -p_len:] * ret2 / ret_len
            feats = F.interpolate(feats.permute(0, 2, 1), scale_factor=2).permute(0, 2, 1)[:, :p_len, :]
            plen = torch.LongTensor([p_len]).to(self.device); sid = torch.LongTensor([0]).to(self.device)
            if self.f0:
                out = self.net.infer(feats, plen, cp, cpf.to(dt) if self.half else cpf, sid, int(skip_head), int(ret_len), ret2)[0]
            else:
                out = self.net.infer(feats, plen, sid, int(skip_head), int(ret_len), ret2)[0]
            out = out.squeeze(1).float()
            up = int(np.floor(factor * self.sr // 100))
            if up != self.sr // 100:
                if up not in self._res:
                    self._res[up] = Resample(orig_freq=up, new_freq=self.sr // 100, dtype=torch.float32).to(self.device)
                out = self._res[up](out[:, :ret_len * up])
            return out.squeeze()
