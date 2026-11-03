// Overvoice — нейроголос для стрима на основе VCClient (Wataru Okada, MIT).
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
require('./routes/nv').main({ nv, app });
require('./routes/link').main({ app, dir: __dirname });
const server = app.listen(PORT, '127.0.0.1', () => {
  const url = 'http://localhost:' + PORT;
  console.log('Overvoice: ' + url + '\nОстановить — закрой это окно.');
  if (process.env.OVERVOICE_NO_OPEN !== '1' && process.platform === 'win32') exec('start "" "' + url + '"');
  if (nv.getSettings().autostart && nv.state().installed) setTimeout(() => nv.start().catch(() => {}), 3000);
});
server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? 'Порт ' + PORT + ' занят: Overvoice уже запущен?' : e.message); process.exit(1); });
const bye = () => { try { nv.stop(); } catch (e) { /* закрываемся */ } process.exit(0); };
process.on('SIGINT', bye); process.on('SIGTERM', bye); process.on('exit', () => { try { nv.stop(); } catch (e) { /* закрываемся */ } });
