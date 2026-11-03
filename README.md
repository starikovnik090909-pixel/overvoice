# Overvoice

Нейроголос для стрима. Отдельная программа, позже подключается к Overdeck.
Создано на основе VCClient (Wataru Okada, лицензия MIT): `LICENSE-VCCLIENT`.

## Запуск (Windows)
1. Нужен Node.js. Запусти `start.bat`.
2. Открой страницу, выбери видеокарту, нажми «Скачать и установить» (около 3 ГБ, движок берётся с Hugging Face автора VCClient).
3. Нужен виртуальный кабель VB-Cable: голос уходит в него, в OBS берёшь «Захват входящего звука».

Страница: http://localhost:3055 (порт меняется через `OVERVOICE_PORT`).

## Для Overdeck
`POST /api/nv/voice {"slot": 0}` включает голос, `POST /api/nv/release` останавливает.

## Голоса
Модели голосов не входят в программу: их добавляют сами в окне Overvoice.

## Тесты
`npm install && npm test`
