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
  const src = path.join(tmp, 'src'); fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'fake.js'), `
    const http=require('http');const i=process.argv.indexOf('--port');const port=Number(process.argv[i+1]);
    const st={modelSlotIndex:0,passThrough:1,serverAudioStated:0,enableServerAudio:0,modelSlots:[{slotIndex:0,voiceChangerType:'RVC',name:'Диктор'},{slotIndex:1,voiceChangerType:'RVC',name:'Парень'},{slotIndex:2,voiceChangerType:null,name:''}]};
    const srv=http.createServer((q,r)=>{let b='';q.on('data',c=>b+=c);q.on('end',()=>{if(q.url==='/update_settings'){const f=new URLSearchParams(b);st[f.get('key')]=Number(f.get('val'));}if(q.url==='/shutdown'){r.end('{}');setTimeout(()=>process.exit(0),50);return;}r.setHeader('Content-Type','application/json');r.end(JSON.stringify(st));});}).listen(port,'127.0.0.1');
    process.on('SIGTERM',()=>process.exit(0));
  `);
  const fakePy = path.join(src, 'python3'); fs.writeFileSync(fakePy, '#!/bin/sh\nexec node "' + path.join(src, 'fake.js') + '" "$@"\n', { mode: 0o755 });
  process.env.OV_PY = fakePy;
  const srv = { close() {} };
  const dir = path.join(tmp, 'app'); fs.mkdirSync(dir);
  nv.init({ dir });
  ok(!nv.state().installed && nv.state().status.state === 'none', 'сначала не установлен');
  nv.update({ port: 18999 });
  ok(nv.getSettings().port === 18999, 'настройки: порт');
  nv.update({ dir: 'D:\\Overvoice' }); ok(nv.getSettings().dir === 'D:\\Overvoice', 'папка установки: диск D');
  nv.update({ dir: 'D:\\..\\x' }); ok(nv.getSettings().dir === 'D:\\Overvoice', 'плохой путь игнорируется');
  nv.update({ dir: '' }); ok(nv.getSettings().dir === '', 'папка по умолчанию');
  nv.update({ port: 80 }); ok(nv.getSettings().port === 18999, 'плохой порт игнорируется');
  let ran = 0; nv._setInstaller(async () => { ran++; fs.mkdirSync(path.join(dir, 'ov-engine'), { recursive: true }); fs.writeFileSync(path.join(dir, 'ov-engine', '.ready'), '{}'); return 'CPU'; });
  await nv.install();
  ok(ran === 1 && nv.state().installed && nv.state().status.state === 'ready', 'установка: шаги выполнены, движок отмечен готовым');
  const args = nv.launchArgs(nv.findExe()); ok(args.slice(0, 2).join(' ') === '-m ovengine' && args.includes('--port') && args[args.indexOf('--port') + 1] === '18999' && args.includes('--parent') && args.includes('--voices'), 'аргументы запуска: ' + args.join(' '));
  nv._setInstaller(async () => { throw new Error('нет сети'); });
  fs.rmSync(path.join(dir, 'ov-engine', '.ready')); await nv.install();
  ok(!nv.state().installed && nv.state().status.state === 'error' && /нет сети/.test(nv.state().status.text) && nv.state().status.fix === 'reinstall', 'ошибка установки видна и предлагает переустановку');
  fs.writeFileSync(path.join(dir, 'ov-engine', '.ready'), '{}');
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
