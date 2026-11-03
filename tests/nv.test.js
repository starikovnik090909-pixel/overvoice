// Overvoice: установка движка из архива, запуск, управление голосом и пропуск запросов (с поддельным движком).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
let n = 0; const ok = (c, m) => { assert(c, m); n++; };
if (process.platform === 'win32') { console.log('nv.test: пропущен на Windows'); process.exit(0); }
const nv = require('../nvEngine');
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-'));
  const src = path.join(tmp, 'src', 'Engine'); fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'fake.js'), `
    const http=require('http');const i=process.argv.indexOf('-p');const port=Number(process.argv[i+1]);
    const st={modelSlotIndex:0,passThrough:1,serverAudioStated:0,enableServerAudio:0,modelSlots:[{slotIndex:0,voiceChangerType:'RVC',name:'Диктор'},{slotIndex:1,voiceChangerType:'RVC',name:'Парень'},{slotIndex:2,voiceChangerType:null,name:''}]};
    http.createServer((q,r)=>{let b='';q.on('data',c=>b+=c);q.on('end',()=>{if(q.url==='/update_settings'){const f=new URLSearchParams(b);st[f.get('key')]=Number(f.get('val'));}r.setHeader('Content-Type','application/json');r.end(JSON.stringify(st));});}).listen(port,'127.0.0.1');`);
  fs.writeFileSync(path.join(src, 'MMVCServerSIO.exe'), '#!/bin/sh\nexec node "$(dirname "$0")/fake.js" "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(src, 'start_http.bat'), '@echo off\r\nrem comment\r\nMMVCServerSIO.exe -p 18888 --https false --sample_mode production\r\n');
  const zip = path.join(tmp, 'engine.zip');
  execFileSync('python3', ['-c', `import zipfile,os;z=zipfile.ZipFile(${JSON.stringify(zip)},'w');d=${JSON.stringify(src)}
for f in os.listdir(d):
  i=zipfile.ZipInfo('Engine/'+f);i.external_attr=0o755<<16;z.writestr(i,open(os.path.join(d,f),'rb').read())
z.close()`]);
  const srv = http.createServer((q, r) => { const buf = fs.readFileSync(zip); r.writeHead(200, { 'Content-Length': buf.length }); r.end(buf); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const zport = srv.address().port;
  const dir = path.join(tmp, 'app'); fs.mkdirSync(dir);
  nv.init({ dir });
  ok(!nv.state().installed && nv.state().status.state === 'none', 'сначала не установлен');
  nv.update({ port: 18999, urlOverride: 'http://127.0.0.1:' + zport + '/engine.zip' });
  ok(nv.getSettings().port === 18999 && /127\.0\.0\.1/.test(nv.getSettings().urlOverride), 'настройки: порт и адрес');
  nv.update({ dir: 'D:\\Overvoice' }); ok(nv.getSettings().dir === 'D:\\Overvoice', 'папка установки: диск D');
  nv.update({ dir: 'D:\\..\\x' }); ok(nv.getSettings().dir === 'D:\\Overvoice', 'плохой путь игнорируется');
  nv.update({ dir: '' }); ok(nv.getSettings().dir === '', 'папка по умолчанию');
  nv.update({ port: 80 }); ok(nv.getSettings().port === 18999, 'плохой порт игнорируется');
  await nv.install();
  ok(nv.state().installed && nv.state().status.state === 'ready', 'установка из архива');
  ok(!fs.existsSync(path.join(dir, 'nv-engine.zip')), 'архив удалён после распаковки');
  const args = nv.launchArgs(nv.findExe()); ok(args.join(' ') === '-p 18999 --https false --sample_mode production', 'аргументы из start_http.bat, порт заменён: ' + args.join(' '));
  await nv.start(); ok(nv.state().status.running, 'движок запущен');
  const vs = await nv.voices(); ok(vs.length === 2 && vs[0].name === 'Диктор' && nv.cachedVoices().length === 2, 'список голосов и кэш');
  await nv.useVoice(1); let j = await nv.info(); ok(j.modelSlotIndex === 1 && j.passThrough === 0 && j.serverAudioStated === 1 && j.enableServerAudio === 1, 'голос включён: слот, без пропуска, звук идёт');
  await nv.release(); j = await nv.info(); ok(j.serverAudioStated === 0, 'обработка остановлена');
  // пропуск запросов: тело формы должно дойти до движка, даже если его уже прочитал парсер
  const express = require('express'); const app = express(); app.use(express.urlencoded({ extended: true }));
  app.all('/api/nv/engine/*', (rq, rs) => nv.proxy(rq, rs, rq.originalUrl.replace(/^\/api\/nv\/engine/, '')));
  const ps = app.listen(0, '127.0.0.1'); await new Promise((r) => ps.on('listening', r));
  const resp = await fetch('http://127.0.0.1:' + ps.address().port + '/api/nv/engine/update_settings', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'key=tran&val=7' });
  ok((await resp.json()).tran === 7, 'пропуск запроса с формой');
  ok((await (await fetch('http://127.0.0.1:' + ps.address().port + '/api/nv/engine/info')).json()).modelSlots.length === 3, 'пропуск GET');
  ps.close(); nv.stop(); await new Promise((r) => setTimeout(r, 300)); ok(!nv.state().status.running, 'движок остановлен');
  srv.close(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log('✓ nv: ' + n + ' проверок'); process.exit(0);
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
