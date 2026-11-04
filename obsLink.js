// obsLink.js — связь с OBS через obs-websocket v5 (встроен в OBS 28+): автопереключение микрофонов.
// «В эфире» → обычный микрофон в OBS глушится, источник с CABLE Output включается; «Стоп» → наоборот.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
let FILE = path.join(__dirname, 'obs_link.json');
const DEF = { enabled: false, host: '127.0.0.1', port: 4455, password: '', main: '', cable: '' };
let cfg = { ...DEF };

function clean(b) {
  const o = { ...DEF }; b = b || {};
  o.enabled = !!b.enabled;
  o.port = Number.isInteger(+b.port) && +b.port > 0 && +b.port < 65536 ? +b.port : DEF.port;
  o.password = typeof b.password === 'string' ? b.password.slice(0, 200) : '';
  o.main = typeof b.main === 'string' ? b.main.slice(0, 200) : '';
  o.cable = typeof b.cable === 'string' ? b.cable.slice(0, 200) : '';
  return o;   // адрес всегда локальный: OBS на этом же компьютере
}
function load(file) { if (file) FILE = file; try { cfg = clean(JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch (e) { cfg = { ...DEF }; } }
function get() { return { enabled: cfg.enabled, port: cfg.port, hasPassword: !!cfg.password, main: cfg.main, cable: cfg.cable }; }
function save(b) {
  b = b || {};
  const n = clean({ ...cfg, ...b, password: b.password === undefined ? cfg.password : b.password });
  cfg = n; try { fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2)); } catch (e) { /* не критично */ }
  return get();
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('base64');

// одно короткое соединение на одну пачку запросов
function session(requests, port, timeoutMs) {
  port = port || cfg.port; timeoutMs = timeoutMs || 4000;
  return new Promise((resolve, reject) => {
    if (typeof WebSocket === 'undefined') return reject(new Error('Нужен Node 22+ (встроенный WebSocket)'));
    let ws, done = false, step = 0; const out = [];
    const fin = (err, val) => { if (done) return; done = true; clearTimeout(t); try { ws && ws.close(); } catch (e) { /* уже закрыт */ } err ? reject(err) : resolve(val); };
    const t = setTimeout(() => fin(new Error('OBS не отвечает. Включи Сервис → Настройки WebSocket-сервера в OBS')), timeoutMs);
    try { ws = new WebSocket('ws://127.0.0.1:' + port); } catch (e) { return fin(e); }
    ws.onerror = () => fin(new Error('Не удалось подключиться к OBS (порт ' + port + '). OBS запущен? WebSocket включён?'));
    ws.onclose = () => fin(new Error('OBS закрыл соединение (неверный пароль?)'));
    const sendNext = () => {
      if (step >= requests.length) return fin(null, out);
      const r = requests[step];
      ws.send(JSON.stringify({ op: 6, d: { requestType: r.type, requestId: 'r' + step, requestData: r.data || {} } }));
    };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.op === 0) {
        const d = { rpcVersion: 1 };
        if (m.d && m.d.authentication) {
          if (!cfg.password) return fin(new Error('OBS просит пароль WebSocket'));
          d.authentication = sha(sha(cfg.password + m.d.authentication.salt) + m.d.authentication.challenge);
        }
        ws.send(JSON.stringify({ op: 1, d }));
      } else if (m.op === 2) sendNext();
      else if (m.op === 7) {
        const st = m.d && m.d.requestStatus;
        if (!st || !st.result) return fin(new Error((st && st.comment) || 'OBS отклонил запрос'));
        out.push(m.d.responseData || {}); step++; sendNext();
      }
    };
  });
}

/** Соединение с OBS: call(type, data) → данные ответа. Закрывается само по завершении fn. */
function run(fn, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket === 'undefined') return reject(new Error('Нужен Node 22+ (встроенный WebSocket)'));
    let ws, done = false, n = 0; const waits = {};
    const fin = (err, val) => { if (done) return; done = true; clearTimeout(t); try { ws && ws.close(); } catch (e) { /* уже закрыт */ } err ? reject(err) : resolve(val); };
    const t = setTimeout(() => fin(new Error('OBS не отвечает. Включи Сервис → Настройки WebSocket-сервера в OBS')), timeoutMs || 15000);
    try { ws = new WebSocket('ws://127.0.0.1:' + cfg.port); } catch (e) { return fin(e); }
    ws.onerror = () => fin(new Error('Не удалось подключиться к OBS (порт ' + cfg.port + '). OBS запущен? WebSocket включён?'));
    ws.onclose = () => fin(new Error('OBS закрыл соединение (неверный пароль?)'));
    const call = (type, data) => new Promise((res, rej) => { const id = 'c' + (n++); waits[id] = { res, rej }; ws.send(JSON.stringify({ op: 6, d: { requestType: type, requestId: id, requestData: data || {} } })); });
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.op === 0) {
        const d = { rpcVersion: 1 };
        if (m.d && m.d.authentication) { if (!cfg.password) return fin(new Error('OBS просит пароль WebSocket')); d.authentication = sha(sha(cfg.password + m.d.authentication.salt) + m.d.authentication.challenge); }
        ws.send(JSON.stringify({ op: 1, d }));
      } else if (m.op === 2) { Promise.resolve().then(() => fn(call)).then((v) => fin(null, v), (e) => fin(e)); }
      else if (m.op === 7 && waits[m.d.requestId]) {
        const w = waits[m.d.requestId]; delete waits[m.d.requestId]; const st = m.d.requestStatus || {};
        if (st.result) w.res(m.d.responseData || {}); else { const e = new Error(st.comment || 'OBS отклонил запрос'); e.code = st.code; w.rej(e); }
      }
    };
  });
}
const SRC_NAME = 'Овервойс (кабель)';
/** Создаёт в OBS источник «Захват входящего звука» с устройством CABLE Output, заглушает ему мониторинг и подставляет настройки. */
async function connectSource() {
  const out = await run(async (call) => {
    const log = [];
    let list = (await call('GetInputList')).inputs || [];
    let kind = ((await call('GetInputKindList', { unversioned: false })).inputKinds || []).filter((k) => /^wasapi_input_capture|coreaudio_input_capture|pulse_input_capture|alsa_input_capture/.test(k))[0];
    if (!kind) throw new Error('В OBS нет типа источника «Захват входящего звука»');
    if (!list.some((i) => i.inputName === SRC_NAME)) {
      let scene = ''; try { const r = await call('GetCurrentProgramScene'); scene = r.sceneName || r.currentProgramSceneName || ''; } catch (e) { /* нет сцены */ }
      if (!scene) throw new Error('В OBS не выбрана сцена');
      await call('CreateInput', { sceneName: scene, inputName: SRC_NAME, inputKind: kind, sceneItemEnabled: true });
      log.push('создан источник «' + SRC_NAME + '» в сцене «' + scene + '»');
    } else log.push('источник «' + SRC_NAME + '» уже есть');
    const items = (await call('GetInputPropertiesListPropertyItems', { inputName: SRC_NAME, propertyName: 'device_id' })).propertyItems || [];
    const dev = items.filter((d) => /CABLE Output/i.test(d.itemName || ''))[0];
    if (!dev) throw new Error('В OBS не виден CABLE Output. Установи виртуальный кабель (при необходимости перезагрузи компьютер) и повтори');
    await call('SetInputSettings', { inputName: SRC_NAME, inputSettings: { device_id: dev.itemValue }, overlay: true });
    await call('SetInputMute', { inputName: SRC_NAME, inputMuted: false });
    try { await call('SetInputAudioMonitorType', { inputName: SRC_NAME, monitorType: 'OBS_MONITORING_TYPE_NONE' }); } catch (e) { /* не критично */ }
    log.push('устройство: ' + dev.itemName);
    let main = '';
    try { main = (await call('GetSpecialInputs')).mic1 || ''; } catch (e) { /* нет */ }
    if (!main) { list = (await call('GetInputList')).inputs || []; const m = list.filter((i) => i.inputKind === kind && i.inputName !== SRC_NAME)[0]; main = m ? m.inputName : ''; }
    return { cable: SRC_NAME, main, log };
  });
  save({ enabled: true, cable: out.cable, main: cfg.main || out.main });
  out.main = cfg.main; return out;
}
async function inputs() {
  const [r] = await session([{ type: 'GetInputList' }]);
  return (r.inputs || []).map((i) => ({ name: i.inputName, kind: i.inputKind }))
    .filter((i) => /audio|wasapi|coreaudio|pulse|alsa|jack|capture/i.test(i.kind));
}
// on=true: в эфир идёт нейроголос (кабель включён, обычный микрофон заглушён)
async function live(on) {
  if (!cfg.enabled) return { skipped: true };
  if (!cfg.main || !cfg.cable) throw new Error('В OBS не выбраны источники микрофона и кабеля');
  await session([
    { type: 'SetInputMute', data: { inputName: cfg.main, inputMuted: !!on } },
    { type: 'SetInputMute', data: { inputName: cfg.cable, inputMuted: !on } },
  ]);
  return { on: !!on };
}
module.exports = { load, get, save, inputs, live, connectSource, run, clean, _sha: sha };
