// nvEngine.js — Overvoice: управление собственным движком нейроголоса (папка engine/, Python + PyTorch).
// Движок ставится одной кнопкой (встроенный Python, библиотеки, модели) и запускается скрытым процессом, которым управляет эта программа.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { spawn, execFile } = require('child_process');

const PY_URL = 'https://www.python.org/ftp/python/3.12.8/python-3.12.8-embed-amd64.zip';
const PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';
const HF = 'https://huggingface.co/lj1995/VoiceConversionWebUI/resolve/main/';
const ASSETS = [['hubert_base/config.json', 'hubert_base/config.json'], ['hubert_base/preprocessor_config.json', 'hubert_base/preprocessor_config.json'], ['hubert_base/pytorch_model.bin', 'hubert_base/pytorch_model.bin'], ['rmvpe.pt', 'rmvpe/rmvpe.pt']];
const VARIANTS = {
  cuda: { gb: 7, label: 'видеокарта NVIDIA (CUDA)', index: 'https://download.pytorch.org/whl/cu124', dl: 3.0 },
  dml: { gb: 3, label: 'без NVIDIA: процессор (медленно)', index: 'https://download.pytorch.org/whl/cpu', dl: 0.3 },
};
const DEFAULTS = { variant: 'cuda', port: 18900, autostart: false, urlOverride: '', obsInput: 'NV Микрофон', dir: '' };
let DIR = __dirname, cfg = { ...DEFAULTS }, useFile = true;
let st = { state: 'none', text: '', pct: 0 };
let child = null, log = [], busy = null, onChange = () => {};
const setSt = (state, text, extra) => { st = Object.assign({ state, text: text || '', pct: 0 }, extra || {}); onChange(); };

const baseDir = () => cfg.dir || DIR;   // куда ставится движок: выбранная папка или папка программы
const engineDir = () => path.join(baseDir(), 'ov-engine');
const codeDir = () => path.join(__dirname, 'engine');
const cfgFile = () => path.join(DIR, 'nv_settings.json');
function load() { try { const j = JSON.parse(fs.readFileSync(cfgFile(), 'utf8')); if (Number(j.port) === 18888) j.port = 18900; cfg = clean(j); } catch (e) { cfg = { ...DEFAULTS }; } }
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
function state() { return { settings: getSettings(), status: { ...st, running: st.state === 'running' }, variants: VARIANTS, tail: log.slice(-12), installed: !!findExe() }; }

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
const winp = process.platform === 'win32';
const pyExe = () => process.env.OV_PY || path.join(engineDir(), 'py', winp ? 'python.exe' : 'bin/python3');
const readyFile = () => path.join(engineDir(), '.ready');
const assetsDir = () => path.join(engineDir(), 'assets');
/** Запускной файл (Python движка), если установка завершена. */
function findExe() { return fs.existsSync(readyFile()) && fs.existsSync(pyExe()) ? pyExe() : null; }
function launchArgs() { return ['-m', 'ovengine', '--assets', assetsDir(), '--voices', voicesDir(), '--port', String(cfg.port), '--parent', String(process.pid)]; }
/** Файл ._pth встроенного Python должен знать, где лежит код движка (папка программы может переехать). */
function writePth() {
  const d = path.join(engineDir(), 'py'); let f = null;
  try { f = fs.readdirSync(d).find((x) => /^python3\d+\._pth$/i.test(x)); } catch (e) { return; }
  if (!f) return;
  const z = f.replace(/\._pth$/i, '.zip');
  fs.writeFileSync(path.join(d, f), [z, '.', 'Lib\\site-packages', codeDir(), 'import site', ''].join('\r\n'));
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
/** Есть ли рядом с запускным файлом python3xx.dll (без него движок не стартует). */
const hasPyDll = (exe) => !!exe && walk(path.dirname(exe), 1, (n) => /^python3\d+\.dll$/i.test(n)) !== null;
/** Запасная распаковка средствами .NET (PowerShell), если tar пропустил файлы. */
function unpackPs(zip, dir) {
  return new Promise((resolve, reject) => {
    const q = (x) => "'" + x.replace(/'/g, "''") + "'";
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[System.IO.Compression.ZipFile]::OpenRead(' + q(zip) + '); try { foreach($e in $z.Entries){ if($e.FullName.EndsWith("/")){continue}; $t=Join-Path ' + q(dir) + ' $e.FullName; New-Item -ItemType Directory -Force -Path (Split-Path $t) | Out-Null; [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e,$t,$true) } } finally { $z.Dispose() }'], { maxBuffer: 1 << 26, windowsHide: true, timeout: 1800000 }, (e) => (e ? reject(new Error('Не удалось распаковать: ' + e.message)) : resolve()));
  });
}
function freeGb(dir) { try { const s = fs.statfsSync(dir); return (s.bavail * s.bsize) / 1073741824; } catch (e) { return Infinity; } }

const dirSize = (d) => { let n = 0; try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); n += e.isDirectory() ? dirSize(p) : (e.isFile() ? fs.statSync(p).size : 0); } } catch (e) { /* нет папки */ } return n; };
/** Запуск python (pip и проверки) с выводом в журнал. */
function runPy(args, onLine, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(pyExe(), args, { cwd: engineDir(), windowsHide: true, env: Object.assign({}, process.env, { PYTHONUTF8: '1', PYTHONNOUSERSITE: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1' }, env || {}) });
    const tail = []; const feed = (b) => String(b).split(/\r?\n/).filter(Boolean).forEach((l) => { tail.push(l); if (tail.length > 12) tail.shift(); if (onLine) onLine(l); });
    p.stdout.on('data', feed); p.stderr.on('data', feed);
    p.on('error', reject); p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error('Команда завершилась с кодом ' + c + ': ' + tail.slice(-3).join(' | ')))));
  });
}
/** Шаги установки. Каждый можно повторять: что уже есть, пропускается. */
let installer = async function realInstall() {
  const ed = engineDir(), v = VARIANTS[cfg.variant]; fs.mkdirSync(ed, { recursive: true });
  if (!fs.existsSync(path.join(codeDir(), 'ovengine', '__init__.py'))) throw new Error('В папке программы нет кода движка (папка engine). Обнови Овервойс.');
  if (freeGb(ed) < v.gb) throw new Error('Мало места на диске: нужно около ' + v.gb + ' ГБ свободно');
  const prog = (text, pct) => { st = { state: 'downloading', text, pct: pct || 0 }; onChange(); };
  let last = 0; const dl = (url, dest, label) => download(url, dest, (got, total) => { const now = Date.now(); if (now - last < 700) return; last = now; prog(label + ': ' + (got / 1048576).toFixed(0) + (total ? ' из ' + (total / 1048576).toFixed(0) : '') + ' МБ', total ? Math.round((got / total) * 100) : 0); });
  // 1. Python
  if (!fs.existsSync(pyExe())) {
    const zip = path.join(ed, 'python-embed.zip'); await dl(PY_URL, zip, 'Скачиваю Python');
    setSt('unpacking', 'Распаковываю Python…'); await unpack(zip, path.join(ed, 'py')); try { fs.unlinkSync(zip); } catch (e) { /* не критично */ }
  }
  writePth();
  // 2. pip
  const hasPip = () => fs.existsSync(path.join(ed, 'py', 'Lib', 'site-packages', 'pip'));
  if (!hasPip()) { const gp = path.join(ed, 'get-pip.py'); await dl(PIP_URL, gp, 'Скачиваю установщик библиотек'); setSt('working', 'Ставлю установщик библиотек…'); await runPy([gp, '--no-warn-script-location']); try { fs.unlinkSync(gp); } catch (e) { /* не критично */ } }
  // 3. torch (самое большое: видеокартная сборка около 3 ГБ). Размер видно по папке кэша pip.
  const hasTorch = () => fs.existsSync(path.join(ed, 'py', 'Lib', 'site-packages', 'torch', '__init__.py'));
  const cache = path.join(ed, 'pipcache');
  if (!hasTorch()) {
    const t = setInterval(() => { const g = dirSize(cache) / 1073741824; st = { state: 'downloading', text: 'Скачиваю нейросетевую библиотеку: ' + g.toFixed(2) + ' из ~' + v.dl.toFixed(1) + ' ГБ (один раз)', pct: Math.min(99, Math.round((g / v.dl) * 100)) }; onChange(); }, 1500);
    try { await runPy(['-m', 'pip', 'install', '--no-warn-script-location', 'torch==2.6.0', 'torchaudio==2.6.0', '--index-url', v.index], null, { PIP_CACHE_DIR: cache }); } finally { clearInterval(t); }
  }
  setSt('working', 'Ставлю остальные библиотеки…');
  await runPy(['-m', 'pip', 'install', '--no-warn-script-location', '-r', path.join(codeDir(), 'requirements.txt')], (l) => { if (/^(Collecting|Downloading|Installing)/.test(l)) { st = { state: 'working', text: 'Ставлю библиотеки: ' + l.slice(0, 60), pct: 0 }; onChange(); } }, { PIP_CACHE_DIR: cache });
  try { fs.rmSync(cache, { recursive: true, force: true }); } catch (e) { /* не критично */ }
  // 4. модели HuBERT и RMVPE
  for (const [src, dst] of ASSETS) {
    const to = path.join(assetsDir(), dst); if (fs.existsSync(to) && fs.statSync(to).size > 1000) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true }); await dl(HF + src, to, 'Скачиваю модель ' + path.basename(dst));
  }
  // 5. проверка: библиотеки читаются, видеокарта видна
  setSt('working', 'Проверяю установку…');
  let out = ''; await runPy(['-c', 'import torch, ovengine, transformers, faiss, librosa, sounddevice; print("CUDA" if torch.cuda.is_available() else "CPU")'], (l) => { out = l; });
  fs.writeFileSync(readyFile(), JSON.stringify({ at: Date.now(), variant: cfg.variant, device: out }));
  return out;
};

/** Скачать и установить движок. Можно прервать закрытием программы: загрузка продолжится с того же места. */
function install(force) {
  if (busy) return busy;
  busy = (async () => {
    try {
      if (force) { stop(); await new Promise((r) => setTimeout(r, 800)); try { fs.rmSync(engineDir(), { recursive: true, force: true }); } catch (e) { throw new Error('Не удалось удалить старый движок: ' + e.message + '. Закрой программы, которые его используют, и попробуй ещё раз.'); } }
      fs.mkdirSync(baseDir(), { recursive: true });
      if (cfg.variant === 'cuda' && winp && !(await hasNvidia())) { cfg.variant = 'dml'; persist(); }
      try { fs.unlinkSync(readyFile()); } catch (e) { /* не было */ }
      const dev = await installer();
      setSt('ready', 'Движок установлен' + (dev === 'CPU' && cfg.variant === 'cuda' ? '. Видеокарта пока не видна — обнови драйвер NVIDIA' : ''));
    } catch (e) { setSt('error', e.message, { fix: 'reinstall' }); }
    finally { busy = null; }
  })();
  return busy;
}
const hasNvidia = () => new Promise((resolve) => execFile('nvidia-smi', ['-L'], { timeout: 8000, windowsHide: true }, (e, out) => resolve(!e && /GPU/.test(String(out)))));

// ---------- запуск ----------
function req(method, p, body, ms) {
  return new Promise((resolve, reject) => {
    const data = body ? new URLSearchParams(body).toString() : null;
    const r = http.request({ host: '127.0.0.1', port: cfg.port, path: p, method, timeout: ms || 4000, headers: data ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
      let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => { if (res.statusCode >= 400) { let m = ''; try { m = JSON.parse(s).error || ''; } catch (e) { m = ''; } return reject(new Error(m || 'Движок ответил ' + res.statusCode)); } try { resolve(JSON.parse(s)); } catch (e) { resolve({}); } });
    });
    r.on('error', reject); r.on('timeout', () => r.destroy(new Error('Движок не ответил'))); if (data) r.write(data); r.end();
  });
}
const info = () => req('GET', '/info');
const setSetting = (key, val) => req('POST', '/update_settings', { key, val: String(val) }, key === 'modelSlotIndex' || key === 'serverAudioStated' ? 180000 : 8000);
async function alive() { try { await info(); return true; } catch (e) { return false; } }

// движок мог остаться висеть в фоне (или запущен вручную): подхватываем его сами, без повторного запуска
async function adopt() {
  if (child || startP || busy) return;
  const up = await alive();
  if (up && st.state !== 'running') { setSt('running', 'Движок уже работал в фоне, подключился к нему'); syncAndApply(); }
  else if (!up && st.state === 'running' && !child) setSt('ready', 'Движок остановлен');
  else if (up && !syncing && Date.now() - lastSync.at > 20000) {   // в библиотеке есть голос, которого нет в движке: пробуем подключить ещё раз
    let miss = false; try { const have = new Set(((await info()).modelSlots || []).filter((x) => x && x.name).map((x) => normOf(stemOf(x.name)))); miss = libraryList().some((v) => !have.has(normOf(stemOf(v.model)))); } catch (e) { return; }
    if (miss && retries < 6) { retries++; await syncLibrary(); } else if (!miss) retries = 0;
  }
}
let adoptT = null;
function watch() { if (adoptT) return; adopt().catch(() => {}); adoptT = setInterval(() => adopt().catch(() => {}), 4000); if (adoptT.unref) adoptT.unref(); }
let startP = null;
const start = () => startP || (startP = startInner().finally(() => { startP = null; }));
async function startInner() {
  if (child) return state();
  if (await alive()) { setSt('running', 'Движок уже запущен'); syncAndApply(); return state(); }
  const exe = findExe(); if (!exe) { setSt('error', 'Движок не установлен'); return state(); }
  if (win && !fs.existsSync(path.join(path.dirname(exe), 'python310.dll')) && walk(path.dirname(exe), 2, (n) => /^python3\d+\.dll$/i.test(n)) === null) { setSt('error', 'В папке Python движка нет python312.dll: файл не распаковался или его удалил антивирус. Нажми «Переустановить движок».', { fix: 'reinstall' }); return state(); }
  log = []; setSt('starting', 'Запускаю движок (в первый раз до нескольких минут)…');
  // после «Остановить» старый процесс ещё может держать порт: ждём, пока он освободится (иначе новый движок не запустится)
  for (let i = 0; i < 20 && stoppedAt && Date.now() - stoppedAt < 15000 && (await alive()); i++) await new Promise((r) => setTimeout(r, 500));
  writePth();
  const me = spawn(exe, launchArgs(exe), { cwd: codeDir(), windowsHide: true, env: Object.assign({}, process.env, { PYTHONUTF8: '1', PYTHONUNBUFFERED: '1', PYTHONNOUSERSITE: '1' }) }); child = me;
  const dec = (b) => { if (!win) return String(b); try { const u = new TextDecoder('utf-8', { fatal: true }).decode(b); return u; } catch (e) { try { return new TextDecoder('ibm866').decode(b); } catch (e2) { return String(b); } } };
  const keep = (b) => { dec(b).split(/\r?\n/).filter(Boolean).forEach((l) => { log.push(l.slice(0, 300)); if (log.length > 60) log.shift(); }); };
  me.stdout.on('data', keep); me.stderr.on('data', keep);
  me.on('exit', (code) => { if (child === me) child = null; else return; if (st.state === 'running' || st.state === 'starting') { const dll = log.some((l) => /python\d*\.dll|LoadLibrary|DLL load failed|WinError 126/i.test(l)); setSt(dll ? 'error' : 'ready', dll ? 'Не загрузилась библиотека Python или PyTorch: чаще всего не хватает Visual C++ (его можно поставить кнопкой ниже) или антивирус заблокировал файлы движка (добавь папку в исключения или переустанови движок).' : (code ? 'Движок остановился (код ' + code + ')' : 'Движок остановлен'), dll ? { fix: 'vc' } : {}); } });
  me.on('error', (e) => { if (child === me) child = null; setSt('error', 'Не удалось запустить: ' + e.message); });
  for (let i = 0; i < 240 && child; i++) { if (await alive()) { setSt('running', 'Движок работает'); syncAndApply(); return state(); } await new Promise((r) => setTimeout(r, 1000)); }
  if (child === me) { stop(); setSt('error', 'Движок не запустился за 4 минуты. Проверь журнал ниже.'); }
  return state();
}
let stoppedAt = 0;
function stop() {
  const c = child; child = null; if (c) stoppedAt = Date.now();
  if (c) { try { if (process.platform === 'win32') execFile('taskkill', ['/PID', String(c.pid), '/T', '/F'], () => {}); else c.kill(); } catch (e) { /* уже завершён */ } }
  else { stoppedAt = Date.now(); req('POST', '/shutdown', {}, 3000).catch(() => {}); }   // движок запущен не нами (остался с прошлого раза): просим его закрыться
  if (st.state === 'running' || st.state === 'starting') setSt('ready', 'Движок остановлен');
  return state();
}

// ---------- библиотека голосов: файлы лежат в папке voices рядом с движком и подключаются к нему сами ----------
const voicesDir = () => path.join(baseDir(), 'voices');
const SAFE = /^[^\\/:*?"<>|\x00-\x1f]{1,80}$/;
const okName = (n) => typeof n === 'string' && SAFE.test(n) && n !== '.' && n !== '..' && !/^\.+$/.test(n) && n === n.trim();
const MODEL_RX = /\.(pth|onnx)$/i, INDEX_RX = /\.index$/i, AUDIO_RX = /\.(mp3|wav|ogg|m4a|flac)$/i;
const stemOf = (n) => String(n).replace(/\.[^.]+$/, '');
const normOf = (n) => String(n).toLowerCase().replace(/[\s_\-]+/g, '');
const DEF_VS = { pitch: 0, idx: 50, gate: 20, vol: 100 };
const clampN = (v, a, b, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(a, Math.min(b, Math.round(n))) : d; };
/** Настройки голоса (высота, сходство, шум, громкость), у каждого голоса свои. */
function voiceSettings(name) {
  try { const j = JSON.parse(fs.readFileSync(path.join(voicesDir(), name, 'settings.json'), 'utf8')); return cleanVs(j); } catch (e) { return { ...DEF_VS }; }
}
const cleanVs = (j) => { const o = j && typeof j === 'object' ? j : {}; return { pitch: clampN(o.pitch, -24, 24, DEF_VS.pitch), idx: clampN(o.idx, 0, 100, DEF_VS.idx), gate: clampN(o.gate, 0, 100, DEF_VS.gate), vol: clampN(o.vol, 0, 200, DEF_VS.vol) }; };
function saveVoiceSettings(name, body) {
  if (!okName(name) || !fs.existsSync(path.join(voicesDir(), name))) throw new Error('Такого голоса нет');
  const v = cleanVs(Object.assign({}, voiceSettings(name), body || {}));
  fs.writeFileSync(path.join(voicesDir(), name, 'settings.json'), JSON.stringify(v)); return v;
}
/** Путь к файлу примера голоса или null. */
function samplePath(name) { if (!okName(name)) return null; const v = libraryList().find((x) => x.name === name); return v && v.sample ? path.join(voicesDir(), name, v.sample) : null; }
/** Список голосов библиотеки: [{name, model, index|null, sample|null, settings}] */
function libraryList() {
  const out = [];
  let dirs = []; try { dirs = fs.readdirSync(voicesDir(), { withFileTypes: true }).filter((e) => e.isDirectory()); } catch (e) { return out; }
  dirs.forEach((d) => {
    let files = []; try { files = fs.readdirSync(path.join(voicesDir(), d.name)).filter((f) => !/\.part$/i.test(f)); } catch (e) { return; }
    const model = files.find((f) => MODEL_RX.test(f)); if (!model) return;
    const audio = files.filter((f) => AUDIO_RX.test(f)), sample = audio.find((f) => /^(sample|demo|preview|пример)/i.test(f)) || audio[0] || null;
    out.push({ name: d.name, model, index: files.find((f) => INDEX_RX.test(f)) || null, sample, settings: voiceSettings(d.name) });
  });
  return out.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}
/** Принять один файл голоса потоком (PUT) в voices/<имя>/<файл>. */
function libraryPut(name, file, stream, maxBytes) {
  return new Promise((resolve, reject) => {
    if (!okName(name) || !okName(file) || !(MODEL_RX.test(file) || INDEX_RX.test(file) || AUDIO_RX.test(file))) return reject(new Error('Неверное имя голоса или файла'));
    const dir = path.join(voicesDir(), name); fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, file), tmp = dest + '.part'; let n = 0, failed = false;
    const w = fs.createWriteStream(tmp);
    const fail = (e) => { if (failed) return; failed = true; try { w.destroy(); fs.rmSync(tmp, { force: true }); } catch (x) { /* ок */ } reject(e); };
    const cap = maxBytes || (AUDIO_RX.test(file) ? 30e6 : 2e9);
    stream.on('data', (c) => { n += c.length; if (n > cap) { fail(new Error('Файл слишком большой')); stream.destroy(); } });
    stream.on('error', fail); stream.on('aborted', () => fail(new Error('Загрузка прервана'))); w.on('error', fail);
    w.on('finish', () => { if (failed) return; try { fs.renameSync(tmp, dest); resolve({ size: n }); } catch (e) { fail(e); } });
    stream.pipe(w);
  });
}
/** Отправить файл в движок (multipart потоком, без загрузки в память). */
function uploadToEngine(file) {
  return new Promise((resolve, reject) => {
    const b = '----overvoice' + Date.now().toString(16), name = path.basename(file), size = fs.statSync(file).size;
    const head = Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="filename"\r\n\r\n' + name + '\r\n--' + b + '\r\nContent-Disposition: form-data; name="file"; filename="' + name + '"\r\nContent-Type: application/octet-stream\r\n\r\n', 'utf8');
    const tail = Buffer.from('\r\n--' + b + '--\r\n', 'utf8');
    const r = http.request({ host: '127.0.0.1', port: cfg.port, path: '/upload_file', method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=' + b, 'Content-Length': head.length + size + tail.length } }, (res) => { res.resume(); res.on('end', () => (res.statusCode < 400 ? resolve() : reject(new Error('Движок не принял файл ' + name)))); });
    r.on('error', reject); r.write(head);
    const rs = fs.createReadStream(file); rs.on('error', reject); rs.on('end', () => r.end(tail)); rs.pipe(r, { end: false });
  });
}
let syncing = false, lastSync = { at: 0, error: '', failed: 0 }, retries = 0;
/** Подключить к движку голоса из библиотеки, которых там ещё нет. */
async function loadOne(v, slot) {
  const dir = path.join(voicesDir(), v.name);
  await uploadToEngine(path.join(dir, v.model)); if (v.index) await uploadToEngine(path.join(dir, v.index));
  const fl = [{ name: v.model, kind: 'rvcModel', dir: '' }]; if (v.index) fl.push({ name: v.index, kind: 'rvcIndex', dir: '' });
  await req('POST', '/load_model', { slot: String(slot), isHalf: 'true', params: JSON.stringify({ voiceChangerType: 'RVC', slot, isSampleMode: false, sampleId: '', files: fl, params: {} }) }, 180000);
}
async function syncLibrary() {
  if (syncing) return { busy: true, added: 0, full: 0, failed: 0, running: true };
  syncing = true;
  const res = { added: 0, full: 0, failed: 0, running: false };
  try {
    if (!(await alive())) return res;
    res.running = true;
    const j = await info(), slots = j.modelSlots || [];
    const have = new Set(slots.filter((s) => s && s.name).map((s) => normOf(stemOf(s.name))));
    const free = slots.filter((s) => s && !s.name).map((s) => Number(s.slotIndex));
    for (const v of libraryList()) {
      if (have.has(normOf(stemOf(v.model)))) continue;
      const slot = free.shift(); if (slot == null) { res.full++; continue; }
      try { await loadOne(v, slot); res.added++; have.add(normOf(stemOf(v.model)));
      } catch (e) { res.failed++; res.error = v.name + ': ' + e.message; }
    }
    if (res.added) { try { await voices(); } catch (e) { /* кэш обновится позже */ } }
  } finally { syncing = false; lastSync = { at: Date.now(), error: res.error || '', failed: res.failed }; }
  return res;
}
// ---------- последний выбранный голос: после перезапуска движка его сохранённые настройки применяются сами ----------
const activeFile = () => path.join(voicesDir(), '_active.json');
function getActive() { try { const n = JSON.parse(fs.readFileSync(activeFile(), 'utf8')).name; return okName(n) ? n : ''; } catch (e) { return ''; } }
function setActive(name) {
  if (name !== '' && (!okName(name) || !fs.existsSync(path.join(voicesDir(), name)))) throw new Error('Такого голоса нет');
  fs.mkdirSync(voicesDir(), { recursive: true }); fs.writeFileSync(activeFile(), JSON.stringify({ name })); return name;
}
const gateVal = (g) => (Number(g) === 0 ? 0 : Math.pow(10, -5 + Number(g) / 50));
/** Выбрать голос в движке и поставить его сохранённые настройки (высота, сходство, шум, громкость). */
async function applyVoiceSettings(name) {
  const hit = (await voices()).find((v) => v.name === name), lv = libraryList().find((x) => x.name === name);
  if (!hit || !lv) return false;
  const s = voiceSettings(name);
  await setSetting('modelSlotIndex', hit.slot); await setSetting('tran', s.pitch);
  if (lv.index) await setSetting('indexRatio', s.idx / 100);
  await setSetting('silentThreshold', gateVal(s.gate)); await setSetting('serverOutputAudioGain', s.vol / 100);
  return true;
}
async function applyActive() { const n = getActive(); if (!n) return false; try { return await applyVoiceSettings(n); } catch (e) { return false; } }
const syncAndApply = () => syncLibrary().then(() => applyActive()).catch(() => {});

/** Библиотека + отметка, какие голоса уже подключены к движку. */
async function libraryState() {
  let slots = null; try { if (await alive()) slots = ((await info()).modelSlots || []).filter((s) => s && s.name); } catch (e) { slots = null; }
  const loaded = slots && new Set(slots.map((s) => normOf(stemOf(s.name))));
  return { running: !!slots, syncError: lastSync.error, select: selState(), voices: libraryList().map((v) => ({ name: v.name, model: v.model, hasIndex: !!v.index, hasSample: !!v.sample, settings: v.settings, loaded: loaded ? loaded.has(normOf(stemOf(v.model))) : false })) };
}

// ---------- «нажал на голос — он работает»: запуск движка, загрузка голоса, его настройки и включение звука за один шаг ----------
let selS = { name: '', phase: 'idle', text: '', error: '' }, selTok = 0;
const selState = () => ({ ...selS });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function selectRun(tok, v) {
  const say = (t) => { if (tok === selTok) selS.text = t; };
  if (!(await alive())) { say('Запускаю движок…'); await start(); if (!(await alive())) throw new Error(st.text || 'Движок не запустился'); }
  for (let i = 0; i < 720 && syncing && tok === selTok; i++) await sleep(500);
  if (tok !== selTok) return;
  const slotOf = async () => { const m = ((await info()).modelSlots || []).filter((x) => x && x.name).find((x) => normOf(stemOf(x.name)) === normOf(stemOf(v.model))); return m ? Number(m.slotIndex) : -1; };
  if ((await slotOf()) < 0) {
    say('Загружаю голос в движок (до минуты)…'); syncing = true;
    try {
      if ((await slotOf()) < 0) { const free = ((await info()).modelSlots || []).filter((x) => x && !x.name).map((x) => Number(x.slotIndex))[0]; if (free == null) throw new Error('В движке нет свободных мест под голоса'); await loadOne(v, free); }
    } finally { syncing = false; }
    if ((await slotOf()) < 0) throw new Error('Движок принял файлы, но голос не появился. Проверь, что это модель RVC (.pth или .onnx)');
  }
  if (tok !== selTok) return;
  say('Включаю голос…'); setActive(v.name);
  if (!(await applyVoiceSettings(v.name))) throw new Error('Не удалось выбрать голос в движке');
  await setSetting('passThrough', 0);
  const j = await info(); if (Number(j.serverAudioStated) !== 1) { await setSetting('enableServerAudio', 1); await setSetting('serverAudioStated', 1); }
  if (tok === selTok) selS = { name: v.name, phase: 'done', text: 'Голос «' + v.name + '» работает', error: '' };
}
function select(name) {
  const v = libraryList().find((x) => x.name === name); if (!v) throw new Error('Такого голоса нет');
  const tok = ++selTok; selS = { name: v.name, phase: 'working', text: 'Готовлю голос…', error: '' };
  selectRun(tok, v).catch((e) => { if (tok === selTok) selS = { name: v.name, phase: 'error', text: '', error: String(e.message || e) }; });
  return selState();
}

// ---------- управление голосом (Overdeck и другие программы) ----------
const voiceFile = () => path.join(DIR, 'nv_voices.json');
function cachedVoices() { try { const j = JSON.parse(fs.readFileSync(voiceFile(), 'utf8')); return Array.isArray(j) ? j.filter((v) => v && Number.isInteger(v.slot) && typeof v.name === 'string') : []; } catch (e) { return []; } }
async function voices() {
  const j = await info();
  const lib = libraryList(), nice = (n) => { const v = lib.find((x) => normOf(stemOf(x.model)) === normOf(stemOf(n))); return v ? v.name : String(n); };
  const list = (j.modelSlots || []).filter((s) => s && s.voiceChangerType === 'RVC' && s.name).map((s) => ({ slot: Number(s.slotIndex), name: nice(s.name) }));
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
const VC_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';
/** Скачать и запустить Microsoft Visual C++ Redistributable (нужен движку). Windows спросит разрешение. */
async function vcInstall() {
  if (!win) { setSt('error', 'Работает только в Windows'); return state(); }
  const dir = path.join(os.tmpdir(), 'overvoice-vc'); fs.mkdirSync(dir, { recursive: true });
  const exe = path.join(dir, 'vc_redist.x64.exe');
  try {
    setSt('working', 'Скачиваю Visual C++…');
    try { fs.rmSync(exe + '.part', { force: true }); } catch (e) { /* нет */ }
    await download(VC_URL, exe, () => {});
    setSt('working', 'Windows спросит разрешение: нажми «Да»…');
    await new Promise((resolve) => execFile('powershell', ['-NoProfile', '-Command', "Start-Process -FilePath '" + exe.replace(/'/g, "''") + "' -ArgumentList '/install','/passive','/norestart' -Verb RunAs -Wait"], { timeout: 600000, windowsHide: true }, () => resolve()));
    setSt('ready', 'Visual C++ установлен. Нажми «Запустить движок» (если не поможет, перезагрузи компьютер).');
  } catch (e) { setSt('error', 'Не удалось установить Visual C++: ' + e.message, { fix: 'vc' }); }
  return state();
}
const _setInstaller = (f) => { installer = f; };
module.exports = { _setInstaller, select, selState, watch, adopt, okName, getActive, setActive, applyActive, applyVoiceSettings, vcInstall, samplePath, saveVoiceSettings, libraryList, libraryPut, libraryState, syncLibrary, voicesDir, drives, cableState, cableInstall, cachedVoices, init, state, update, getSettings, install, start, stop, voices, useVoice, release, proxy, alive, info, setSetting, launchArgs, findExe, download, VARIANTS };
