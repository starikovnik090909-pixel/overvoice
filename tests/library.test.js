// Библиотека голосов Overvoice: сохранение файлов, защита имён, подключение к (поддельному) движку.
const assert = require('assert'); const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http');
let n = 0; const ok = (c, m) => { assert(c, m); n++; };
const nv = require('../nvEngine');
const { Readable } = require('stream');
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-'));
  nv.init({ dir: tmp, noFile: true }); nv.update({ port: 18997 });
  const buf = (k) => Buffer.alloc(k, 7);
  ok((await nv.libraryState()).voices.length === 0, 'библиотека пуста');
  await nv.libraryPut('Маша', 'model.pth', Readable.from([buf(300000)]));
  await nv.libraryPut('Маша', 'added.index', Readable.from([buf(5000)]));
  await nv.libraryPut('Вася', 'v.onnx', Readable.from([buf(1000)]));
  for (const [nm, f] of [['..', 'a.pth'], ['x/y', 'a.pth'], ['ok', '..\\a.pth'], ['ok', 'a.txt'], ['', 'a.pth'], ['ok', 'a.exe']]) {
    let bad = false; try { await nv.libraryPut(nm, f, Readable.from([buf(10)])); } catch (e) { bad = true; } ok(bad, 'отклонено: ' + nm + '/' + f);
  }
  let big = false; try { await nv.libraryPut('Big', 'b.pth', Readable.from([buf(2000)]), 1000); } catch (e) { big = true; } ok(big, 'слишком большой файл отклонён');
  ok(!fs.existsSync(path.join(tmp, 'voices', 'Big', 'b.pth')) && !fs.existsSync(path.join(tmp, 'voices', 'Big', 'b.pth.part')), 'недокачанный файл не остался');
  ok(!fs.existsSync(path.join(tmp, 'a.pth')), 'за пределы папки ничего не записано');
  let list = nv.libraryList(); ok(list.length === 2 && list[0].name === 'Вася' && list[1].index === 'added.index', 'список голосов');
  ok((await nv.syncLibrary()).running === false, 'без движка: подключится позже');

  // поддельный движок
  const slots = [0, 1, 2].map((i) => ({ slotIndex: i, voiceChangerType: i ? null : 'RVC', name: i ? '' : 'Диктор' })); const got = {};
  const upd = {};
  const eng = http.createServer((q, r) => {
    const chunks = []; q.on('data', (c) => chunks.push(c)); q.on('end', () => {
      const body = Buffer.concat(chunks);
      if (q.url === '/upload_file') { const m = /name="file"; filename="([^"]+)"\r\n.*?\r\n\r\n/s.exec(body.toString('latin1')); const head = m[0].length, start = body.toString('latin1').indexOf(m[0]) + head; got[Buffer.from(m[1], 'latin1').toString('utf8')] = body.length - start - ('\r\n--' + /boundary=(.+)/.exec(q.headers['content-type'])[1] + '--\r\n').length; }
      if (q.url === '/update_settings') { const f = new URLSearchParams(body.toString()); upd[f.get('key')] = f.get('val'); }
      if (q.url === '/load_model') { const p = JSON.parse(new URLSearchParams(body.toString()).get('params')); const s = slots[p.slot]; s.name = p.files[0].name; s.voiceChangerType = 'RVC'; }
      r.setHeader('Content-Type', 'application/json'); r.end(JSON.stringify({ modelSlots: slots, modelSlotIndex: 0 }));
    });
  }).listen(18997, '127.0.0.1'); await new Promise((r) => eng.on('listening', r));

  let st = await nv.libraryState(); ok(st.running && st.voices.every((v) => !v.loaded), 'движок запущен, голоса не подключены');
  let r = await nv.syncLibrary(); ok(r.running && r.added === 2 && r.failed === 0, 'подключено 2 голоса');
  ok(got['model.pth'] === 300000 && got['added.index'] === 5000 && got['v.onnx'] === 1000, 'файлы дошли до движка целиком');
  st = await nv.libraryState(); ok(st.voices.every((v) => v.loaded), 'голоса отмечены как подключённые');
  r = await nv.syncLibrary(); ok(r.added === 0, 'повторно ничего не добавляется');
  const vs = await nv.voices(); ok(vs.some((v) => v.name === 'Маша') && vs.some((v) => v.name === 'Вася'), 'в списке голосов названия из библиотеки');
  await nv.libraryPut('Оля', 'o.pth', Readable.from([buf(50)]));
  r = await nv.syncLibrary(); ok(r.added === 0 && r.full === 1, 'нет мест: сообщает, не падает');
  // пример голоса и настройки
  await nv.libraryPut('Маша', 'sample.mp3', Readable.from([buf(2000)]));
  ok(nv.samplePath('Маша') && nv.samplePath('Маша').endsWith('sample.mp3') && !nv.samplePath('Вася'), 'файл примера находится');
  ok(nv.samplePath('../x') === null, 'путь к примеру не выходит из папки');
  let vs0 = nv.libraryList().find((v) => v.name === 'Маша').settings; ok(vs0.pitch === 0 && vs0.idx === 50, 'настройки по умолчанию');
  const sv = nv.saveVoiceSettings('Маша', { pitch: 99, idx: -5, gate: 33.4, vol: 150, junk: 1 }); ok(sv.pitch === 24 && sv.idx === 0 && sv.gate === 33 && sv.vol === 150 && !('junk' in sv), 'настройки ограничиваются');
  ok(nv.libraryList().find((v) => v.name === 'Маша').settings.pitch === 24, 'настройки сохраняются в файл');
  let nof = false; try { nv.saveVoiceSettings('Нет', {}); } catch (e) { nof = true; } ok(nof, 'настройки несуществующего голоса отклонены');
  ok((await nv.libraryState()).voices.find((v) => v.name === 'Маша').hasSample === true, 'в состоянии есть отметка примера');
  // последний выбранный голос и его настройки после перезапуска
  ok(nv.getActive() === '', 'активного голоса сначала нет');
  nv.setActive('Маша'); ok(nv.getActive() === 'Маша', 'активный голос запоминается');
  let nb = false; try { nv.setActive('../x'); } catch (e) { nb = true; } ok(nb && nv.getActive() === 'Маша', 'чужое имя активным не станет');
  nv.saveVoiceSettings('Маша', { pitch: -3, idx: 70, gate: 0, vol: 120 });
  ok(await nv.applyActive() === true, 'настройки активного голоса применены');
  ok(upd.tran === '-3' && upd.indexRatio === '0.7' && upd.silentThreshold === '0' && upd.serverOutputAudioGain === '1.2' && upd.modelSlotIndex !== undefined, 'в движок ушли высота, сходство, шум, громкость и слот');
  eng.close(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log('✓ library: ' + n + ' проверок'); process.exit(0);
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
