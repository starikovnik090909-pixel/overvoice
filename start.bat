@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Нужен Node.js: https://nodejs.org
  pause
  exit /b 1
)
if not exist node_modules (
  echo Первый запуск: ставлю нужное, это быстро...
  call npm install --omit=dev
)
node server.js
pause
