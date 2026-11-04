// routes/nv.js — установка и запуск движка, настройки, управление голосом, пропуск запросов окна к движку.
function main(ctx) {
  const { nv, app } = ctx;
  const ok = (res, extra) => res.json(Object.assign({ success: true }, nv.state(), extra || {}));
  app.get('/api/nv/state', async (req, res) => { let voices = nv.cachedVoices(); try { if (nv.state().status.running) voices = await nv.voices(); } catch (e) { /* движок занят */ } ok(res, { voices }); });
  app.post('/api/nv/settings', (req, res) => { nv.update(Object.assign({}, nv.getSettings(), req.body || {})); ok(res); });
  app.post('/api/nv/install', (req, res) => { nv.install(!!(req.body || {}).force); setTimeout(() => ok(res), 300); });
  app.post('/api/nv/start', (req, res) => { nv.start().catch(() => {}); setTimeout(() => ok(res), 300); });
  app.post('/api/nv/vc/install', (req, res) => { nv.vcInstall().catch(() => {}); setTimeout(() => ok(res), 300); });
  app.post('/api/nv/stop', (req, res) => { nv.stop(); ok(res); });
  const obs = require('../obsLink');
  app.get('/api/nv/obs', (req, res) => res.json({ success: true, obs: obs.get() }));
  app.put('/api/nv/obs', (req, res) => res.json({ success: true, obs: obs.save(req.body) }));
  app.get('/api/nv/obs/inputs', async (req, res) => { try { res.json({ success: true, inputs: await obs.inputs() }); } catch (e) { res.json({ success: false, inputs: [], error: e.message }); } });
  app.post('/api/nv/obs/connect', async (req, res) => { try { res.json(Object.assign({ success: true }, await obs.connectSource())); } catch (e) { res.json({ success: false, error: e.message }); } });
  app.post('/api/nv/obs/live', async (req, res) => { try { res.json(Object.assign({ success: true }, await obs.live(!!(req.body || {}).on))); } catch (e) { res.json({ success: false, error: e.message }); } });
  const pack = require('../nvPack');
  app.get('/api/nv/pack', async (req, res) => { try { res.json({ success: true, voices: await pack.list(), status: pack.status() }); } catch (e) { res.json({ success: false, voices: [], error: e.message, status: pack.status() }); } });
  app.post('/api/nv/pack/install', (req, res) => { const names = Array.isArray((req.body || {}).names) ? req.body.names.map(String).slice(0, 50) : []; pack.install(names).catch(() => {}); setTimeout(() => res.json({ success: true, status: pack.status() }), 200); });
  app.get('/api/nv/pack/status', (req, res) => res.json({ success: true, status: pack.status() }));
  app.get('/api/nv/drives', async (req, res) => res.json({ success: true, drives: await nv.drives() }));
  app.get('/api/nv/cable', async (req, res) => res.json(Object.assign({ success: true }, await nv.cableState())));
  app.post('/api/nv/cable/install', (req, res) => { nv.cableInstall(); setTimeout(() => res.json({ success: true }), 200); });
  app.get('/api/nv/library', async (req, res) => { try { res.json(Object.assign({ success: true }, await nv.libraryState())); } catch (e) { res.json({ success: false, voices: [], error: e.message }); } });
  app.put('/api/nv/library/:name/settings', (req, res) => { try { res.json({ success: true, settings: nv.saveVoiceSettings(req.params.name, req.body) }); } catch (e) { res.status(400).json({ success: false, error: e.message }); } });
  app.put('/api/nv/library/:name/:file', (req, res) => {
    let name, file; try { name = decodeURIComponent(req.params.name); file = decodeURIComponent(req.params.file); } catch (e) { return res.status(400).json({ success: false, error: 'Неверное имя' }); }
    nv.libraryPut(name, file, req).then((r) => res.json({ success: true, size: r.size })).catch((e) => res.status(400).json({ success: false, error: e.message }));
  });
  app.get('/api/nv/library/:name/sample', (req, res) => { const f = nv.samplePath(req.params.name); if (!f) return res.status(404).json({ success: false, error: 'Нет примера' }); res.sendFile(f); });
  app.put('/api/nv/active', (req, res) => { try { res.json({ success: true, name: nv.setActive(String((req.body || {}).name || '')) }); } catch (e) { res.status(400).json({ success: false, error: e.message }); } });
  app.get('/api/nv/active', (req, res) => res.json({ success: true, name: nv.getActive() }));
  app.post('/api/nv/library/sync', async (req, res) => { try { res.json(Object.assign({ success: true }, await nv.syncLibrary())); } catch (e) { res.status(500).json({ success: false, error: e.message }); } });
  app.get('/api/nv/voices', async (req, res) => { try { res.json({ success: true, voices: await nv.voices() }); } catch (e) { res.json({ success: false, voices: [], error: e.message }); } });
  // для Overdeck и других программ: включить голос слота (запускает обработку звука) и остановить её
  app.post('/api/nv/voice', async (req, res) => { try { const slot = Number((req.body || {}).slot); if (!Number.isInteger(slot) || slot < 0 || slot > 99) throw new Error('Неверный номер голоса'); await nv.useVoice(slot); ok(res); } catch (e) { res.status(400).json({ success: false, error: e.message }); } });
  app.post('/api/nv/release', async (req, res) => { await nv.release(); ok(res); });
  app.all('/api/nv/engine/*', (req, res) => nv.proxy(req, res, req.originalUrl.replace(/^\/api\/nv\/engine/, '') || '/'));
  return {};
}
module.exports = { main };
