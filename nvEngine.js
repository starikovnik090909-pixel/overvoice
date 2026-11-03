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

// ---------- скрыть собственное окно движка (Windows) ----------
// Готовая сборка сама открывает окно «Voice Changer Client Demo». Оно нам не нужно: всё управление идёт из Overvoice.
// Пока движок стартует (до двух минут), окна с таким названием прячутся, процесс при этом продолжает работать.
const HIDE_PS = `Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class OvW { public delegate bool CB(IntPtr h, IntPtr l);
[DllImport("user32.dll")] public static extern bool EnumWindows(CB cb, IntPtr l);
[DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
public static void Hide() { EnumWindows((h, l) => { if (IsWindowVisible(h)) { var sb = new StringBuilder(256); GetWindowText(h, sb, 256); if (sb.ToString().StartsWith("Voice Changer Client")) ShowWindow(h, 0); } return true; }, IntPtr.Zero); } }
"@
for ($i = 0; $i -lt 240; $i++) { [OvW]::Hide(); Start-Sleep -Milliseconds 500 }`;
function hideEngineWindow() {
  if (process.platform !== 'win32') return;
  try {
    const f = path.join(os.tmpdir(), 'overvoice-hide.ps1'); fs.writeFileSync(f, HIDE_PS);
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', f], { windowsHide: true, timeout: 150000 }, () => {});
  } catch (e) { /* окно просто останется видимым */ }
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
  if (await alive()) { setSt('running', 'Движок уже запущен'); syncLibrary().catch(() => {}); return state(); }
  const exe = findExe(); if (!exe) { setSt('error', 'Движок не установлен'); return state(); }
  if (win && !fs.existsSync(path.join(path.dirname(exe), 'python310.dll')) && walk(path.dirname(exe), 2, (n) => /^python3\d+\.dll$/i.test(n)) === null) { setSt('error', 'В папке движка нет python310.dll: файл удалён или не докачался (часто это антивирус). Добавь папку в исключения антивируса и переустанови движок.'); return state(); }
  log = []; setSt('starting', 'Запускаю движок (в первый раз до нескольких минут)…');
  child = spawn(exe, launchArgs(exe), { cwd: path.dirname(exe), windowsHide: true });
  hideEngineWindow();
  const dec = (b) => { if (!win) return String(b); try { const u = new TextDecoder('utf-8', { fatal: true }).decode(b); return u; } catch (e) { try { return new TextDecoder('ibm866').decode(b); } catch (e2) { return String(b); } } };
  const keep = (b) => { dec(b).split(/\r?\n/).filter(Boolean).forEach((l) => { log.push(l.slice(0, 300)); if (log.length > 60) log.shift(); }); };
  child.stdout.on('data', keep); child.stderr.on('data', keep);
  child.on('exit', (code) => { child = null; if (st.state === 'running' || st.state === 'starting') { const dll = log.some((l) => /python\d*\.dll|LoadLibrary/i.test(l)); setSt(dll ? 'error' : 'ready', dll ? 'Не загрузился python310.dll: чаще всего не хватает Visual C++ (его можно поставить кнопкой ниже) или антивирус заблокировал файлы движка (добавь папку в исключения или переустанови движок).' : (code ? 'Движок остановился (код ' + code + ')' : 'Движок остановлен'), dll ? { fix: 'vc' } : {}); } });
  child.on('error', (e) => { child = null; setSt('error', 'Не удалось запустить: ' + e.message); });
  for (let i = 0; i < 240 && child; i++) { if (await alive()) { setSt('running', 'Движок работает'); syncLibrary().catch(() => {}); return state(); } await new Promise((r) => setTimeout(r, 1000)); }
  if (child) { stop(); setSt('error', 'Движок не запустился за 4 минуты. Проверь журнал ниже.'); }
  return state();
}
function stop() {
  const c = child; child = null;
  if (c) { try { if (process.platform === 'win32') execFile('taskkill', ['/PID', String(c.pid), '/T', '/F'], () => {}); else c.kill(); } catch (e) { /* уже завершён */ } }
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
let syncing = false;
/** Подключить к движку голоса из библиотеки, которых там ещё нет. */
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
      try {
        const dir = path.join(voicesDir(), v.name);
        await uploadToEngine(path.join(dir, v.model)); if (v.index) await uploadToEngine(path.join(dir, v.index));
        const fl = [{ name: v.model, kind: 'rvcModel', dir: '' }]; if (v.index) fl.push({ name: v.index, kind: 'rvcIndex', dir: '' });
        await req('POST', '/load_model', { slot: String(slot), isHalf: 'true', params: JSON.stringify({ voiceChangerType: 'RVC', slot, isSampleMode: false, sampleId: '', files: fl, params: {} }) }, 180000);
        res.added++; have.add(normOf(stemOf(v.model)));
      } catch (e) { res.failed++; }
    }
    if (res.added) { try { await voices(); } catch (e) { /* кэш обновится позже */ } }
  } finally { syncing = false; }
  return res;
}
/** Библиотека + отметка, какие голоса уже подключены к движку. */
async function libraryState() {
  let slots = null; try { if (await alive()) slots = ((await info()).modelSlots || []).filter((s) => s && s.name); } catch (e) { slots = null; }
  const loaded = slots && new Set(slots.map((s) => normOf(stemOf(s.name))));
  return { running: !!slots, voices: libraryList().map((v) => ({ name: v.name, model: v.model, hasIndex: !!v.index, hasSample: !!v.sample, settings: v.settings, loaded: loaded ? loaded.has(normOf(stemOf(v.model))) : false })) };
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
module.exports = { vcInstall, samplePath, saveVoiceSettings, libraryList, libraryPut, libraryState, syncLibrary, voicesDir, drives, cableState, cableInstall, cachedVoices, init, state, update, getSettings, install, start, stop, voices, useVoice, release, proxy, alive, info, setSetting, launchArgs, findExe, download, VARIANTS };
