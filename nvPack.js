// nvPack.js — набор голосов: список и скачивание готовых голосов из отдельного репозитория по одной кнопке.
// В репозитории лежит manifest.json и файлы голосов, нарезанные на куски до 90 МБ (GitHub не принимает файлы больше 100 МБ).
const fs = require('fs'), path = require('path'), crypto = require('crypto'), https = require('https'), http = require('http');
const nv = require('./nvEngine');

const DEFAULT_BASE = 'https://raw.githubusercontent.com/starikovnik090909-pixel/overvoice-voices/main/';
const base = () => { const b = process.env.OVERVOICE_PACK_URL || DEFAULT_BASE; return b.endsWith('/') ? b : b + '/'; };
const FILE_RX = /^[^\\/:*?"<>|\x00-\x1f]{1,120}\.(pth|onnx|index|mp3|wav|ogg)$/i;
const PART_RX = /^[^\\:*?"<>|\x00-\x1f]{1,200}$/;
let st = { state: 'idle', text: '', pct: 0, name: '' };
const setSt = (s) => { st = Object.assign({ state: 'idle', text: '', pct: 0, name: '' }, s); };

function getJson(url, redirects) {
  return new Promise((resolve, reject) => {
    if ((redirects || 0) > 5) return reject(new Error('Слишком много перенаправлений'));
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'Overvoice' } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) { res.resume(); return resolve(getJson(new URL(res.headers.location, url).href, (redirects || 0) + 1)); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(res.statusCode === 404 ? 'Набор голосов пока не опубликован' : 'Сервер ответил ' + res.statusCode)); }
      let b = ''; res.setEncoding('utf8'); res.on('data', (c) => { b += c; if (b.length > 2e6) req.destroy(new Error('Слишком большой список')); });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('Список голосов повреждён')); } });
    });
    req.on('error', reject); req.setTimeout(15000, () => req.destroy(new Error('Нет ответа от сервера')));
  });
}
/** Проверка манифеста: только безопасные имена, только известные расширения. */
function cleanManifest(m) {
  const out = [];
  for (const v of (m && Array.isArray(m.voices) ? m.voices : [])) {
    if (!v || !nv.okName(v.name)) continue;
    const files = [];
    for (const f of (Array.isArray(v.files) ? v.files : [])) {
      if (!f || !FILE_RX.test(f.name || '') || !/^[0-9a-f]{64}$/.test(f.sha256 || '') || !(Number(f.size) > 0) || !Array.isArray(f.parts) || !f.parts.length || !f.parts.every((p) => typeof p === 'string' && PART_RX.test(p) && !p.includes('..'))) continue;
      files.push({ name: f.name, size: Number(f.size), sha256: f.sha256, parts: f.parts });
    }
    if (files.some((f) => /\.(pth|onnx)$/i.test(f.name))) out.push({ name: v.name, about: typeof v.about === 'string' ? v.about.slice(0, 160) : '', files });
  }
  return out;
}
async function list() {
  const voices = cleanManifest(await getJson(base() + 'manifest.json'));
  const have = new Set(nv.libraryList().map((v) => v.name));
  return voices.map((v) => ({ name: v.name, about: v.about, mb: Math.round(v.files.reduce((a, f) => a + f.size, 0) / 1048576), installed: have.has(v.name) }));
}
const sha256File = (p) => new Promise((resolve, reject) => { const h = crypto.createHash('sha256'); fs.createReadStream(p).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject); });
function appendFile(from, to) { return new Promise((resolve, reject) => { const rs = fs.createReadStream(from), ws = fs.createWriteStream(to, { flags: 'a' }); rs.on('error', reject); ws.on('error', reject); ws.on('finish', resolve); rs.pipe(ws); }); }

let busy = null;
/** Скачать выбранные голоса (по именам из набора) в библиотеку. */
function install(names) {
  if (busy) return busy;
  busy = (async () => {
    try {
      setSt({ state: 'working', text: 'Получаю список…' });
      const voices = cleanManifest(await getJson(base() + 'manifest.json')).filter((v) => (names || []).includes(v.name));
      if (!voices.length) throw new Error('Выбранных голосов нет в наборе');
      const total = voices.reduce((a, v) => a + v.files.reduce((b, f) => b + f.size, 0), 0); let done = 0;
      for (const v of voices) {
        const dir = path.join(nv.voicesDir(), v.name), tmp = path.join(dir, '.dl'); fs.mkdirSync(tmp, { recursive: true });
        for (const f of v.files) {
          const target = path.join(dir, f.name), out = target + '.part';
          try { fs.rmSync(out, { force: true }); } catch (e) { /* нет */ }
          for (let i = 0; i < f.parts.length; i++) {
            const pf = path.join(tmp, 'p' + i); const before = done;
            await nv.download(base() + f.parts[i].split('/').map(encodeURIComponent).join('/'), pf, (got) => { setSt({ state: 'working', name: v.name, text: 'Скачиваю «' + v.name + '»', pct: Math.min(99, Math.round(((before + got) / total) * 100)) }); });
            await appendFile(pf, out); done = before + fs.statSync(pf).size; fs.rmSync(pf, { force: true });
          }
          if (fs.statSync(out).size !== f.size || (await sha256File(out)) !== f.sha256) { fs.rmSync(out, { force: true }); throw new Error('Файл «' + f.name + '» скачался с ошибкой, попробуй ещё раз'); }
          fs.renameSync(out, target);
        }
        fs.rmSync(tmp, { recursive: true, force: true });
      }
      setSt({ state: 'working', text: 'Подключаю голоса к движку…', pct: 100 });
      try { await nv.syncLibrary(); } catch (e) { /* движок может быть выключен */ }
      setSt({ state: 'done', text: 'Готово: ' + voices.map((v) => v.name).join(', '), pct: 100 });
    } catch (e) { setSt({ state: 'error', text: e.message }); }
    finally { busy = null; }
  })();
  return busy;
}
module.exports = { list, install, status: () => ({ ...st }), cleanManifest, _base: base };
