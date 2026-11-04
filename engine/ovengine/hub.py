"""Общие модели: HuBERT (признаки речи) и RMVPE (высота тона). Загружаются один раз и служат всем голосам."""
import os
from pathlib import Path

import torch
from torch import nn
from transformers import HubertModel


class HubertWithProj(HubertModel):
    def __init__(self, config):
        super().__init__(config)
        self.final_proj = nn.Linear(config.hidden_size, config.classifier_proj_size)


def load_hubert(assets, device, half):
    path = Path(assets) / 'hubert_base'
    if not (path / 'config.json').is_file():
        raise FileNotFoundError('Нет модели HuBERT: ' + str(path))
    m = HubertWithProj.from_pretrained(str(path), local_files_only=True, torch_dtype=torch.float16 if half else torch.float32)
    return m.to(device).eval()


def hubert_features(model, source, version):
    """v1 (256) — слой 9 + final_proj, v2 (768) — последний слой."""
    with torch.no_grad():
        if version == 'v1':
            out = model(input_values=source, attention_mask=None, output_hidden_states=True, return_dict=True)
            return model.final_proj(out.hidden_states[9])
        return model(input_values=source, attention_mask=None, output_hidden_states=False, return_dict=True).last_hidden_state


def load_rmvpe(assets, device, half):
    from ovengine.rmvpe import RMVPE
    p = Path(assets) / 'rmvpe' / 'rmvpe.pt'
    if not p.is_file():
        raise FileNotFoundError('Нет модели RMVPE: ' + str(p))
    return RMVPE(str(p), is_half=half, device=device)
