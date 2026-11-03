// nvEngine.js — Overvoice: нейроголос на основе VCClient (Wataru Okada, MIT). Приложение скачивает готовую сборку движка с Hugging Face автора,
// запускает её и управляет по её API. Сам движок мы не меняем и не распространяем.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { spawn, execFile } = require('child_process');

const BASE = 'https://huggingface.co/wok000/vcclient000/resolve/main/';
const VARIANTS = {
  cuda: { file: 'MMVCServerSIO_win_onnxgpu-cuda_v.1.5.3.18a.zip', gb: 3.3, label: 'видеокарта NVIDIA (CUDA)' },
  dml: { file: 'MMVCServerSIO_win_onnxdirectML-cuda_v.1.5.3.18a.zip', gb: 3.2, label: 'любая видеокарта (DirectML)' },
};
const DEFAULTS = { variant: 'cuda', port: 18888, autostart: false, urlOverride: '', obsInput: 'NV Микрофон', dir: '' };
let DIR = __dirname, cfg = { ...DEFAULTS }, useFile = true;
let st = { state: 'none', text: '', pct: 0 };
let child = null, log = [], busy = null, onChange = () => {};
const setSt = (state, text, extra) => { st = Object.assign({ state, text: text || '', pct: 0 }, extra || {}); onChange(); };

const baseDir = () => cfg.dir || DIR;   // куда ставится движок: выбранная папка или папка программы
const engineDir = () => path.join(baseDir(), 'nv-engine');
const cfgFile = () => path.join(DIR, 'nv_settings.json');
function load() { try { const j = JSON.parse(fs.readFileSync(cfgFile(), 'utf8')); cfg = clean(j); } catch (e) { cfg = { ...DEFAULTS }; } }
function clean(j) {
  const o = j && typeof j === 'object' ? j : {};
  const n = Number(o.port);
  return {
    variant: VARIANTS[o.variant] ? o.variant : cfg.variant, port: Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : cfg.port,
    autostart: typeof o.autostart === 'boolean' ? o.autostart : cfg.autostart, urlOverride: typeof o.urlOverride === 'string' && /^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:\/])[^\s]+\.zip$/i.test(o.urlOverride) ? o.urlOverride : (o.urlOverride === '' ? '' : cfg.urlOverride),
    dir: typeof o.dir === 'string' ? (o.dir === '' ? '' : (/^[A-Za-z]:\\[^<>:"|?*\x00-\x1f]{0,200}$/.test(o.dir) && !/(^|\\)\.\.(\\|$)/.test(o.dir) ? o.dir.replace(/\\+$/, '') : cfg.dir)) : cfg.dir,
    obsInput: typeof o.obsInput === 'string' ? o.obsInput.trim().slice(0, 120) || cfg.obsInput : cfg.obsInput,
  };
}
function persist() { if (!useFile) return; try { fs.writeFileSync(cfgFile(), JSON.stringify(cfg, null, 2)); } catch (e) { /* не критично */ } }
function init(o) {
  const x = o || {}; if (x.dir) DIR = x.dir; useFile = !x.noFile; if (x.onChange) onChange = x.onChange;
  cfg = { ...DEFAULTS }; if (useFile) load();
  st = findExe() ? { state: 'ready', text: 'Движок установлен', pct: 0 } : { state: 'none', text: '', pct: 0 };
}
const getSettings = () => ({ ...cfg });
function update(b) { if (busy && b && b.dir !== undefined && b.dir !== cfg.dir) return state(); cfg = clean(b); persist(); return state(); }
const zipUrl = () => cfg.urlOverride || BASE + VARIANTS[cfg.variant].file;
function state() { return { settings: getSettings(), status: { ...st, running: !!child && st.state === 'running' }, variants: VARIANTS, tail: log.slice(-12), installed: !!findExe() }; }

// ---------- поиск запускного файла и аргументов ----------
function walk(dir, depth, test) {
  let out = null;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isFile() && test(e.name)) return p;
      if (e.isDirectory() && depth > 0 && !out) out = walk(p, depth - 1, test);
    }
  } catch (e) { /* нет папки */ }
  return out;
}
function findExe() { return walk(engineDir(), 3, (n) => /^MMVCServerSIO(\.exe)?$/i.test(n)); }
/** Аргументы запуска берём из start_http.bat самой сборки, чтобы не гадать с путями к файлам нейросетей. */
function launchArgs(exe) {
  let args = ['--https', 'false'];
  const bat = walk(path.dirname(exe), 1, (n) => /^start_http\.bat$/i.test(n));
  if (bat) {
    try {
      const line = fs.readFileSync(bat, 'utf8').split(/\r?\n/).find((l) => /MMVCServerSIO/i.test(l) && !/^\s*(rem|::)/i.test(l));
      if (line) { const rest = line.replace(/^.*?MMVCServerSIO(\.exe)?"?/i, '').trim(); if (rest) args = rest.match(/"[^"]*"|\S+/g).map((a) => a.replace(/^"|"$/g, '')); }
    } catch (e) { /* возьмём по умолчанию */ }
  }
  const i = args.indexOf('-p'); if (i >= 0) args[i + 1] = String(cfg.port); else args.unshift('-p', String(cfg.port));
  return args;
}

// ---------- загрузка и распаковка ----------
function download(url, dest, onProg, redirects) {
  return new Promise((resolve, reject) => {
    if ((redirects || 0) > 6) return reject(new Error('Слишком много перенаправлений'));
    const part = dest + '.part'; let have = 0; try { have = fs.statSync(part).size; } catch (e) { have = 0; }
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers: have ? { Range: 'bytes=' + have + '-' } : {} }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) { res.resume(); return resolve(download(new URL(res.headers.location, url).href, dest, onProg, (redirects || 0) + 1)); }
      if (res.statusCode === 416) { res.resume(); fs.renameSync(part, dest); return resolve(dest); }
      if (res.statusCode !== 200 && res.statusCode !== 206) { res.resume(); return reject(new Error('Сервер ответил ' + res.statusCode)); }
      const resumed = res.statusCode === 206, len = Number(res.headers['content-length']) || 0, total = (resumed ? have : 0) + len;
      let got = resumed ? have : 0; const ws = fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' });
      res.on('data', (c) => { got += c.length; onProg(got, total); });
      res.pipe(ws);
      ws.on('finish', () => { if (total && got < total) return reject(new Error('Загрузка оборвалась')); try { fs.renameSync(part, dest); resolve(dest); } catch (e) { reject(e); } });
      ws.on('error', reject); res.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(30000, () => req.destroy(new Error('Нет ответа от сервера загрузки')));
  });
}
function unpack(zip, dir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(dir, { recursive: true });
    const win = process.platform === 'win32';
    execFile(win ? 'tar' : 'unzip', win ? ['-xf', zip, '-C', dir] : ['-q', '-o', zip, '-d', dir], { maxBuffer: 1 << 26 }, (e) => (e ? reject(new Error('Не удалось распаковать: ' + e.message)) : resolve()));
  });
}
function freeGb(dir) { try { const s = fs.statfsSync(dir); return (s.bavail * s.bsize) / 1073741824; } catch (e) { return Infinity; } }

/** Скачать и установить движок. Можно прервать закрытием программы: загрузка продолжится с того же места. */
function install() {
  if (busy) return busy;
  busy = (async () => {
    try {
      fs.mkdirSync(baseDir(), { recursive: true });
      const need = (VARIANTS[cfg.variant].gb || 3.5) * 2.2;
      if (freeGb(baseDir()) < need) throw new Error('Мало места на диске: нужно около ' + Math.ceil(need) + ' ГБ свободно');
      const zip = path.join(baseDir(), 'nv-engine.zip');
      setSt('downloading', 'Скачиваю движок…', { pct: 0 });
      let last = 0;
      await download(zipUrl(), zip, (got, total) => { const now = Date.now(); if (now - last < 700) return; last = now; st = { state: 'downloading', text: 'Скачиваю движок: ' + (got / 1073741824).toFixed(2) + (total ? ' из ' + (total / 1073741824).toFixed(2) : '') + ' ГБ', pct: total ? Math.round(got / total * 100) : 0 }; onChange(); });
      setSt('unpacking', 'Распаковываю (несколько минут)…');
      await unpack(zip, engineDir());
      try { fs.unlinkSync(zip); } catch (e) { /* не критично */ }
      if (!findExe()) throw new Error('В архиве не нашёлся запускной файл движка');
      setSt('ready', 'Движок установлен');
    } catch (e) { setSt('error', e.message); }
    finally { busy = null; }
  })();
  return busy;
}

// ---------- запуск ----------
function req(method, p, body, ms) {
  return new Promise((resolve, reject) => {
    const data = body ? new URLSearchParams(body).toString() : null;
    const r = http.request({ host: '127.0.0.1', port: cfg.port, path: p, method, timeout: ms || 4000, headers: data ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
      let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => { if (res.statusCode >= 400) return reject(new Error('Движок ответил ' + res.statusCode)); try { resolve(JSON.parse(s)); } catch (e) { resolve({}); } });
    });
    r.on('error', reject); r.on('timeout', () => r.destroy(new Error('Движок не ответил'))); if (data) r.write(data); r.end();
  });
}
const info = () => req('GET', '/info');
const setSetting = (key, val) => req('POST', '/update_settings', { key, val: String(val) });
async function alive() { try { await info(); return true; } catch (e) { return false; } }

async function start() {
  if (child) return state();
  if (await alive()) { setSt('running', 'Движок уже запущен'); return state(); }
  const exe = findExe(); if (!exe) { setSt('error', 'Движок не установлен'); return state(); }
  log = []; setSt('starting', 'Запускаю движок (в первый раз до нескольких минут)…');
  child = spawn(exe, launchArgs(exe), { cwd: path.dirname(exe), windowsHide: true });
  const keep = (b) => { String(b).split(/\r?\n/).filter(Boolean).forEach((l) => { log.push(l.slice(0, 300)); if (log.length > 60) log.shift(); }); };
  child.stdout.on('data', keep); child.stderr.on('data', keep);
  child.on('exit', (code) => { child = null; if (st.state === 'running' || st.state === 'starting') setSt('ready', code ? 'Движок остановился (код ' + code + ')' : 'Движок остановлен'); });
  child.on('error', (e) => { child = null; setSt('error', 'Не удалось запустить: ' + e.message); });
  for (let i = 0; i < 240 && child; i++) { if (await alive()) { setSt('running', 'Движок работает'); return state(); } await new Promise((r) => setTimeout(r, 1000)); }
  if (child) { stop(); setSt('error', 'Движок не запустился за 4 минуты. Проверь журнал ниже.'); }
  return state();
}
function stop() {
  const c = child; child = null;
  if (c) { try { if (process.platform === 'win32') execFile('taskkill', ['/PID', String(c.pid), '/T', '/F'], () => {}); else c.kill(); } catch (e) { /* уже завершён */ } }
  if (st.state === 'running' || st.state === 'starting') setSt('ready', 'Движок остановлен');
  return state();
}

// ---------- управление голосом (Overdeck и другие программы) ----------
const voiceFile = () => path.join(DIR, 'nv_voices.json');
function cachedVoices() { try { const j = JSON.parse(fs.readFileSync(voiceFile(), 'utf8')); return Array.isArray(j) ? j.filter((v) => v && Number.isInteger(v.slot) && typeof v.name === 'string') : []; } catch (e) { return []; } }
async function voices() {
  const j = await info();
  const list = (j.modelSlots || []).filter((s) => s && s.voiceChangerType === 'RVC' && s.name).map((s) => ({ slot: Number(s.slotIndex), name: String(s.name) }));
  if (useFile) { try { fs.writeFileSync(voiceFile(), JSON.stringify(list)); } catch (e) { /* не критично */ } }   // чтобы список голосов был виден и при выключенном движке
  return list;
}
/** Включить голос слота: выбрать модель, снять «пропуск», запустить обработку звука. */
async function useVoice(slot) {
  if (!child && !(await alive())) await start();
  await setSetting('modelSlotIndex', Number(slot)); await setSetting('passThrough', 0);
  const j = await info();
  if (Number(j.serverAudioStated) !== 1) { await setSetting('enableServerAudio', 1); await setSetting('serverAudioStated', 1); }
  return true;
}
/** Остановить обработку (видеокарта отдыхает). */
async function release() { try { await setSetting('serverAudioStated', 0); return true; } catch (e) { return false; } }

/** Пропускает запрос страницы Overvoice движку (чтобы страница работала с одного адреса с админкой). */
function proxy(rq, rs, sub) {
  const headers = { ...rq.headers, host: '127.0.0.1:' + cfg.port }; delete headers.origin; delete headers.referer;
  let body = null;
  if (rq._body) {   // тело уже прочитал парсер express: собираем заново
    body = /json/.test(headers['content-type'] || '') ? JSON.stringify(rq.body) : new URLSearchParams(rq.body).toString();
    headers['content-length'] = Buffer.byteLength(body); delete headers['transfer-encoding'];
  }
  const r = http.request({ host: '127.0.0.1', port: cfg.port, path: sub, method: rq.method, headers }, (res) => { rs.writeHead(res.statusCode, res.headers); res.pipe(rs); });
  r.on('error', () => { if (!rs.headersSent) rs.status(502).json({ success: false, error: 'Движок не запущен' }); else rs.end(); });
  if (body != null) r.end(body); else rq.pipe(r);
}
// ---------- диски и виртуальный кабель (Windows) ----------
const win = process.platform === 'win32';
const ps = (cmd, ms) => new Promise((resolve) => execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: ms || 20000, windowsHide: true }, (e, out) => resolve(e ? '' : String(out))));
/** Локальные диски с размером свободного места. Вне Windows возвращает пустой список. */
async function drives() {
  if (!win) return [];
  const out = await ps("Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Free -ne $null -and $_.Name.Length -eq 1 } | ForEach-Object { $_.Name + ':' + [math]::Round($_.Free/1GB,1) }");
  return out.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[A-Za-z]:[\d.,]+$/.test(l)).map((l) => ({ letter: l[0].toUpperCase(), freeGb: Number(l.slice(2).replace(',', '.')) }));
}
let cab = { state: 'idle', text: '' };
const CABLE_URL = 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack43.zip';
async function cableInstalled() { if (!win) return false; return /CABLE/i.test(await ps("(Get-CimInstance Win32_SoundDevice | Select-Object -ExpandProperty Name) -join ';'")); }
async function cableState() { const ok = await cableInstalled(); if (ok && cab.state !== 'working') cab = { state: 'ok', text: 'Виртуальный кабель установлен' }; return { installed: ok, supported: win, status: { ...cab } }; }
/** Скачать VB-Cable с сайта vb-audio.com и запустить его установщик. Windows спросит разрешение на установку драйвера. */
async function cableInstall() {
  if (!win) { cab = { state: 'error', text: 'Установка кабеля работает только в Windows' }; return cab; }
  if (cab.state === 'working') return cab;
  cab = { state: 'working', text: 'Скачиваю VB-Cable…' };
  try {
    const dir = path.join(os.tmpdir(), 'overvoice-vbcable'); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    const zip = path.join(dir, 'vbcable.zip');
    await download(CABLE_URL, zip, () => {});
    cab = { state: 'working', text: 'Распаковываю…' }; await unpack(zip, dir);
    const exe = walk(dir, 2, (n) => /^VBCABLE_Setup_x64\.exe$/i.test(n)); if (!exe) throw new Error('В архиве не нашёлся установщик');
    cab = { state: 'working', text: 'Windows спросит разрешение: нажми «Да», затем «Установить»…' };
    await new Promise((resolve) => execFile('powershell', ['-NoProfile', '-Command', "Start-Process -FilePath '" + exe.replace(/'/g, "''") + "' -ArgumentList '-i','-h' -Verb RunAs -Wait"], { timeout: 300000, windowsHide: true }, () => resolve()));
    const ok = await cableInstalled();
    cab = ok ? { state: 'ok', text: 'Кабель установлен. Если он не виден в списке звука, перезагрузи компьютер.' } : { state: 'error', text: 'Не удалось установить (разрешение не дано?). Попробуй ещё раз.' };
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* не критично */ }
  } catch (e) { cab = { state: 'error', text: e.message }; }
  return cab;
}
module.exports = { drives, cableState, cableInstall, cachedVoices, init, state, update, getSettings, install, start, stop, voices, useVoice, release, proxy, alive, info, setSetting, launchArgs, findExe, download, VARIANTS };
