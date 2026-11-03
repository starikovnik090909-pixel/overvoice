// nvEngine.js — Overvoice: нейроголос на основе VCClient (Wataru Okada, MIT). Приложение скачивает готовую сборку движка с Hugging Face автора,
// запускает её и управляет по её API. Сам движок мы не меняем и не распространяем.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn, execFile } = require('child_process');

const BASE = 'https://huggingface.co/wok000/vcclient000/resolve/main/';
const VARIANTS = {
  cuda: { file: 'MMVCServerSIO_win_onnxgpu-cuda_v.1.5.3.18a.zip', gb: 3.3, label: 'видеокарта NVIDIA (CUDA)' },
  dml: { file: 'MMVCServerSIO_win_onnxdirectML-cuda_v.1.5.3.18a.zip', gb: 3.2, label: 'любая видеокарта (DirectML)' },
};
const DEFAULTS = { variant: 'cuda', port: 18888, autostart: false, urlOverride: '', obsInput: 'NV Микрофон' };
let DIR = __dirname, cfg = { ...DEFAULTS }, useFile = true;
let st = { state: 'none', text: '', pct: 0 };
let child = null, log = [], busy = null, onChange = () => {};
const setSt = (state, text, extra) => { st = Object.assign({ state, text: text || '', pct: 0 }, extra || {}); onChange(); };

const engineDir = () => path.join(DIR, 'nv-engine');
const cfgFile = () => path.join(DIR, 'nv_settings.json');
function load() { try { const j = JSON.parse(fs.readFileSync(cfgFile(), 'utf8')); cfg = clean(j); } catch (e) { cfg = { ...DEFAULTS }; } }
function clean(j) {
  const o = j && typeof j === 'object' ? j : {};
  const n = Number(o.port);
  return {
    variant: VARIANTS[o.variant] ? o.variant : cfg.variant, port: Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : cfg.port,
    autostart: typeof o.autostart === 'boolean' ? o.autostart : cfg.autostart, urlOverride: typeof o.urlOverride === 'string' && /^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:\/])[^\s]+\.zip$/i.test(o.urlOverride) ? o.urlOverride : (o.urlOverride === '' ? '' : cfg.urlOverride),
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
function update(b) { cfg = clean(b); persist(); return state(); }
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
      fs.mkdirSync(DIR, { recursive: true });
      const need = (VARIANTS[cfg.variant].gb || 3.5) * 2.2;
      if (freeGb(DIR) < need) throw new Error('Мало места на диске: нужно около ' + Math.ceil(need) + ' ГБ свободно');
      const zip = path.join(DIR, 'nv-engine.zip');
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
module.exports = { cachedVoices, init, state, update, getSettings, install, start, stop, voices, useVoice, release, proxy, alive, info, setSetting, launchArgs, findExe, download, VARIANTS };
