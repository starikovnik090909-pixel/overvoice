// Тест obsLink: фейковый obs-websocket v5 с паролем (через ws из Overdeck).
const path = require('path'), assert = require('assert'), os = require('os'), fs = require('fs');
let WS; try { WS = require('ws'); } catch (e) { try { WS = require(path.join(__dirname, '../../twitch-overlay-v2/node_modules/ws')); } catch (e2) { console.log('obs test: ws не найден, пропуск'); process.exit(0); } }
const obs = require('../obsLink');
obs.load(path.join(os.tmpdir(), 'obs_link_test_' + process.pid + '.json'));
const calls = []; const salt = 'SALT', challenge = 'CHAL', pass = 'secret';
const expect = obs._sha(obs._sha(pass + salt) + challenge);
const srv = new WS.Server({ port: 0, host: '127.0.0.1' }, async () => {
  const port = srv.address().port;
  try {
    obs.save({ enabled: true, port, password: pass, main: 'Mic', cable: 'Cable' });
    assert.deepStrictEqual(obs.get(), { enabled: true, port, hasPassword: true, main: 'Mic', cable: 'Cable' });
    const list = await obs.inputs(); assert.deepStrictEqual(list.map((i) => i.name), ['Mic', 'Cable']);
    await obs.live(true); await obs.live(false);
    assert.deepStrictEqual(calls, [['Mic', true], ['Cable', false], ['Mic', false], ['Cable', true]]);
    obs.save({ password: 'bad' }); await obs.live(true).then(() => assert.fail('нужна ошибка'), () => {});
    obs.save({ enabled: false, password: pass }); assert.deepStrictEqual(await obs.live(true), { skipped: true });
    obs.save({ enabled: true, port: 1 }); await obs.inputs().then(() => assert.fail('нужна ошибка'), (e) => assert.ok(/OBS/.test(e.message)));
    console.log('obs tests ok');
  } catch (e) { console.error(e); process.exitCode = 1; }
  srv.close(); try { fs.unlinkSync(path.join(os.tmpdir(), 'obs_link_test_' + process.pid + '.json')); } catch (e) { /* ok */ }
});
srv.on('connection', (ws) => {
  ws.send(JSON.stringify({ op: 0, d: { rpcVersion: 1, authentication: { challenge, salt } } }));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.op === 1) { if (m.d.authentication === expect) ws.send(JSON.stringify({ op: 2, d: {} })); else ws.close(4009); }
    else if (m.op === 6) {
      const d = m.d.requestData; let rd = {};
      if (m.d.requestType === 'GetInputList') rd = { inputs: [{ inputName: 'Mic', inputKind: 'wasapi_input_capture' }, { inputName: 'Cable', inputKind: 'wasapi_input_capture' }, { inputName: 'Img', inputKind: 'image_source' }] };
      else calls.push([d.inputName, d.inputMuted]);
      ws.send(JSON.stringify({ op: 7, d: { requestId: m.d.requestId, requestStatus: { result: true, code: 100 }, responseData: rd } }));
    }
  });
});
