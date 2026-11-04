// Маршруты библиотеки: «настройки» не должны перехватываться маршрутом загрузки файлов.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const express = require('express'); const nv = require('../nvEngine');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-')); nv.init({ dir: tmp, noFile: true });
const app = express(); app.use(express.json()); require('../routes/nv').main({ nv, app });
const srv = app.listen(0, '127.0.0.1', async () => {
  const port = srv.address().port; let n = 0;
  const call = (m, u, body, hdr) => new Promise((res, rej) => { const rq = http.request({ port, method: m, path: u, headers: hdr || { 'Content-Type': 'application/json' } }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(JSON.parse(b))); }); rq.on('error', rej); rq.end(body); });
  try {
    const put = await call('PUT', '/api/nv/library/Test/t.pth', Buffer.alloc(100, 1), { 'Content-Type': 'application/octet-stream' }); assert(put.success && put.size === 100); n++;
    const st = await call('PUT', '/api/nv/library/Test/settings', JSON.stringify({ pitch: 4 })); assert(st.success && st.settings.pitch === 4, 'настройки сохраняются через маршрут'); n++;
    const ac = await call('PUT', '/api/nv/active', JSON.stringify({ name: 'Test' })); assert(ac.success); n++;
    const g = await call('GET', '/api/nv/active'); assert(g.name === 'Test'); n++;
    const bad = await call('PUT', '/api/nv/active', JSON.stringify({ name: '../x' })); assert(!bad.success); n++;
    console.log('✓ routes: ' + n + ' проверок');
  } catch (e) { console.error('✗', e.message); process.exitCode = 1; }
  srv.close(); fs.rmSync(tmp, { recursive: true, force: true });
});
