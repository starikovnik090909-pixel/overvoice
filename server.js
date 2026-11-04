// Overvoice — нейроголос для стрима, свой движок на основе RVC (MIT).
// Страница управления: http://localhost:3055
'use strict';
const path = require('path');
const express = require('express');
const { exec } = require('child_process');
const nv = require('./nvEngine');

const PORT = Number(process.env.OVERVOICE_PORT) || 3055;
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
nv.init({ dir: __dirname });
nv.watch();
require('./obsLink').load(require('path').join(__dirname, 'obs_link.json'));
require('./routes/nv').main({ nv, app });
require('./routes/link').main({ app, dir: __dirname });
// остановка по просьбе Overdeck (с компьютера, где запущено): выключает движок и закрывается
app.post('/api/shutdown', (req, res) => { if (req.get('X-Overvoice') !== '1') return res.status(403).json({ success: false }); res.json({ success: true }); setTimeout(() => bye(), 200); });
const server = app.listen(PORT, '127.0.0.1', () => {
  const url = 'http://localhost:' + PORT;
  console.log('Overvoice: ' + url + '\nОстановить — закрой это окно.');
  if (process.env.OVERVOICE_NO_OPEN !== '1' && process.platform === 'win32') exec('start "" "' + url + '"');
  // первая установка из установщика: он кладёт файл-метку, и движок скачивается сам
  const flag = path.join(__dirname, 'autoinstall.flag');
  if (require('fs').existsSync(flag)) { try { require('fs').unlinkSync(flag); } catch (e) { /* не критично */ } if (!nv.state().installed) nv.install(); }
  if (nv.getSettings().autostart && nv.state().installed) setTimeout(() => nv.start().catch(() => {}), 3000);
});
server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? 'Порт ' + PORT + ' занят: Overvoice уже запущен?' : e.message); process.exit(1); });
function bye() { try { nv.stop(); } catch (e) { /* закрываемся */ } process.exit(0); }
process.on('SIGINT', bye); process.on('SIGTERM', bye); process.on('exit', () => { try { nv.stop(); } catch (e) { /* закрываемся */ } });
