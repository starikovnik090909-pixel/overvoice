// Тема и связь с Overdeck: берёт цвета активной темы админки Overdeck и показывает статус подключения.
(function () {
  'use strict';
  var root = document.documentElement;
  function rgb(h) { var n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  function hex(a) { return '#' + a.map(function (v) { return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'); }).join(''); }
  function mix(a, b, t) { var x = rgb(a), y = rgb(b); return hex([0, 1, 2].map(function (i) { return x[i] + (y[i] - x[i]) * t; })); }
  function lum(h) { return rgb(h).map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }).reduce(function (s, v, i) { return s + v * [0.2126, 0.7152, 0.0722][i]; }, 0); }
  // та же формула, что у панели Overdeck: из трёх цветов выводится вся палитра
  function palette(bg, tx, ac) {
    var light = lum(bg) > 0.5;
    return {
      '--bg': bg, '--win': light ? mix(bg, tx, 0.04) : mix(bg, tx, 0.025), '--panel': light ? mix(bg, '#ffffff', 0.65) : mix(bg, tx, 0.05),
      '--card': light ? mix(bg, '#ffffff', 0.65) : mix(bg, tx, 0.05), '--tile': light ? mix(bg, '#ffffff', 0.85) : mix(bg, tx, 0.085),
      '--line': mix(bg, tx, light ? 0.14 : 0.1), '--fg': tx, '--mute': mix(tx, bg, 0.45), '--accent': ac,
      '--on-accent': lum(ac) > 0.45 ? '#101114' : '#ffffff', '--bar': light ? mix(bg, tx, 0.04) : mix(bg, tx, 0.025), '--code': light ? mix(bg, '#ffffff', 0.85) : mix(bg, '#000000', 0.3),
      '--on': light ? '#1B8F5A' : '#3ECF8E', '--warn': light ? '#B7791F' : '#F5C542'
    };
  }
  var DEFAULT = { bg: '#0E0E10', tx: '#EDEDEF', ac: '#D84B55' };   // тема «Overdeck» в панели: цвета не заданы, это её родные
  var last = '';
  function apply(t) {
    var c = t && t.bgColor ? { bg: t.bgColor, tx: t.textColor, ac: t.accentColor } : DEFAULT;
    var key = [c.bg, c.tx, c.ac].join();
    if (key === last) return; last = key;
    var p = palette(c.bg, c.tx, c.ac);
    Object.keys(p).forEach(function (k) { root.style.setProperty(k, p[k]); });
    root.style.setProperty('color-scheme', lum(c.bg) > 0.5 ? 'light' : 'dark');
    try { Array.prototype.forEach.call(document.querySelectorAll('iframe'), function (f) { if (f.contentWindow && f.contentWindow.OVTheme) f.contentWindow.OVTheme.set(t); }); } catch (e) { /* пока не загрузилось */ }
  }
  var pill = document.getElementById('linkPill');
  function show(s) {
    if (!pill) return;
    pill.className = 'pill ' + (s.connected ? 'ok' : 'off');
    pill.textContent = s.connected ? 'Overdeck подключён · тема «' + (s.themeName || 'Overdeck') + '»' : 'Overdeck не найден';
    pill.title = 'Адрес: ' + s.url + '. Нажми, чтобы поменять.';
  }
  function poll() {
    fetch('/api/link').then(function (r) { return r.json(); }).then(function (s) { if (s.connected) apply(s.theme); show(s); }).catch(function () { show({ connected: false, url: '' }); });
  }
  window.OVTheme = { set: apply };
  if (pill) pill.addEventListener('click', function () {
    var cur = pill.title.replace(/^Адрес: (.*?)\. Нажми.*$/, '$1');
    var u = window.prompt('Адрес Overdeck (где открывается админка):', cur); if (!u) return;
    fetch('/api/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: u }) }).then(poll);
  });
  poll(); setInterval(poll, 4000);
})();
