// Набор голосов: список, скачивание кусками, проверка sha256, защита от плохих имён.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), crypto = require('crypto');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-'));
const nv = require('../nvEngine'); nv.init({ dir: tmp, noFile: true });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const model = Buffer.alloc(300, 5), index = Buffer.alloc(80, 9);
const files = { 'Demo/Demo.pth.part000': model.subarray(0, 200), 'Demo/Demo.pth.part001': model.subarray(200), 'Demo/Demo.index.part000': index };
const manifest = { version: 1, voices: [
  { name: 'Demo', about: 'тест', files: [{ name: 'Demo.pth', size: 300, sha256: sha(model), parts: ['Demo/Demo.pth.part000', 'Demo/Demo.pth.part001'] }, { name: 'Demo.index', size: 80, sha256: sha(index), parts: ['Demo/Demo.index.part000'] }] },
  { name: 'Demo Two', files: [{ name: 'Demo Two.pth', size: 300, sha256: sha(model), parts: ['Demo/Demo.pth.part000', 'Demo/Demo.pth.part001'] }] },
  { name: 'Bad', files: [{ name: 'Bad.pth', size: 300, sha256: sha(Buffer.alloc(300, 1)), parts: ['Demo/Demo.pth.part000', 'Demo/Demo.pth.part001'] }] },
  { name: '../evil', files: [{ name: 'x.pth', size: 1, sha256: sha(Buffer.alloc(1)), parts: ['a'] }] },
  { name: 'Evil2', files: [{ name: '..\\x.pth', size: 1, sha256: sha(Buffer.alloc(1)), parts: ['a'] }] },
  { name: 'Evil3', files: [{ name: 'x.pth', size: 1, sha256: sha(Buffer.alloc(1)), parts: ['../../etc/passwd'] }] },
] };
const srv = http.createServer((q, r) => { const u = decodeURIComponent(q.url.slice(1)); if (u === 'manifest.json') return r.end(JSON.stringify(manifest)); if (files[u]) return r.end(files[u]); r.statusCode = 404; r.end(); });
srv.listen(0, '127.0.0.1', async () => {
  process.env.OVERVOICE_PACK_URL = 'http://127.0.0.1:' + srv.address().port + '/';
  const pack = require('../nvPack'); let n = 0; const ok = (c, m) => { assert(c, m); n++; };
  try {
    const l = await pack.list(); ok(l.length === 3 && l[0].name === 'Demo' && l[1].name === 'Demo Two' && l[2].name === 'Bad' && !l[0].installed, 'в списке только безопасные голоса');
    await pack.install(['Demo']); ok(pack.status().state === 'done', 'установка завершилась: ' + pack.status().text);
    const d = path.join(tmp, 'voices', 'Demo');
    ok(fs.readFileSync(path.join(d, 'Demo.pth')).equals(model) && fs.readFileSync(path.join(d, 'Demo.index')).equals(index), 'файлы собраны из кусков без искажений');
    ok(!fs.existsSync(path.join(d, '.dl')) && !fs.existsSync(path.join(d, 'Demo.pth.part')), 'временные файлы убраны');
    ok((await pack.list())[0].installed === true, 'голос отмечен как установленный');
    await pack.install(['Bad']); ok(pack.status().state === 'error' && /ошибкой/.test(pack.status().text), 'неверная контрольная сумма отклонена');
    ok(!fs.existsSync(path.join(tmp, 'voices', 'Bad', 'Bad.pth')), 'повреждённый файл не остался');
    await pack.install(['Nope']); ok(pack.status().state === 'error', 'голоса вне набора не ставятся');
    console.log('✓ pack: ' + n + ' проверок');
  } catch (e) { console.error('✗', e.message); process.exitCode = 1; }
  srv.close(); fs.rmSync(tmp, { recursive: true, force: true });
});
