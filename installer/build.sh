#!/bin/sh
# Сборка установщика (Linux/macOS, нужен makensis): sh installer/build.sh /путь/к/node.exe
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; NODE="$1"; OUT="$ROOT/dist"; S="$OUT/stage"
[ -f "$NODE" ] || { echo "укажи путь к node.exe (Windows, x64)"; exit 1; }
rm -rf "$OUT"; mkdir -p "$S/node"
cd "$ROOT"
cp -r server.js nvEngine.js routes public package.json package-lock.json LICENSE LICENSE-VCCLIENT README.md start.bat "$S/"
cp "$NODE" "$S/node/node.exe"
(cd "$S" && npm ci --omit=dev >/dev/null 2>&1)
python3 installer/icon.py "$S/overvoice.ico"
VER=$(node -p "require('./package.json').version")
makensis -V2 -DVERSION="$VER" -DSTAGE="$S" -DOUT="$OUT/Overvoice-Setup-$VER.exe" installer/overvoice.nsi
ls -la "$OUT"/*.exe
