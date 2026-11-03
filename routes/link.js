// routes/link.js — связь с Overdeck: адрес, статус и цвета активной темы админки.
const fs = require('fs');
const path = require('path');
function main(ctx) {
  const { app, dir } = ctx;
  const file = path.join(dir, 'link_settings.json');
  let url = process.env.OVERVOICE_OVERDECK_URL || 'http://localhost:3001';   // Overdeck при запуске сам передаёт свой адрес
  if (!process.env.OVERVOICE_OVERDECK_URL) { try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (typeof j.url === 'string') url = j.url; } catch (e) { /* первый запуск */ } }
  const clean = (u) => { u = String(u || '').trim().replace(/\/+$/, ''); if (!/^https?:\/\//i.test(u)) u = 'http://' + u; try { const p = new URL(u); if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(p.hostname)) return null; return p.origin; } catch (e) { return null; } };
  async function check() {
    const out = { connected: false, url, theme: null, themeName: '' };
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 2000);
      const r = await fetch(url + '/api/admin-themes', { signal: ctl.signal }); clearTimeout(t);
      const d = (await r.json()).adminThemes;
      const th = d.themes.find((x) => x.id === d.activeThemeId) || d.themes[0];
      out.connected = true; out.theme = th ? { bgColor: th.bgColor, textColor: th.textColor, accentColor: th.accentColor } : null; out.themeName = th ? th.name : '';
    } catch (e) { /* Overdeck выключен или адрес другой */ }
    return out;
  }
  app.get('/api/link', async (req, res) => res.json(await check()));
  app.post('/api/link', async (req, res) => {
    const u = clean((req.body || {}).url);
    if (!u) return res.status(400).json({ success: false, error: 'Нужен адрес на этом компьютере, например http://localhost:3001' });
    url = u; try { fs.writeFileSync(file, JSON.stringify({ url })); } catch (e) { /* не критично */ }
    res.json(Object.assign({ success: true }, await check()));
  });
  return {};
}
module.exports = { main };
