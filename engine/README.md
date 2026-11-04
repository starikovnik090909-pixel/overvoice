# Движок Овервойса

Свой голосовой преобразователь (RVC) вместо VCClient. Код модели из RVC (MIT, `LICENSE-RVC`).

- `ovengine/voice.py` — один голос (.pth + .index)
- `ovengine/stream.py` — потоковая обработка блоков и склейка без щелчков
- `ovengine/hub.py` — общие модели HuBERT и RMVPE
- `tools/convert_file.py` — проверка: `python tools/convert_file.py <голос> <вход.mp3> <выход.wav> [блок_сек] [контекст_сек]`
  (`OV_ASSETS` — папка с `hubert_base/` и `rmvpe/rmvpe.pt`, `OV_VOICES` — папка голосов)
