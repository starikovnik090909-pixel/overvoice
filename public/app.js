// Страница Overvoice: установка движка, запуск, окно управления голосом (/nv/).
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var api = function (p, o) { return fetch(p, o).then(function (r) { return r.json(); }); };
  var post = function (p, b) { return api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }); };
  var framed = false;
  function render(s) {
    var c = s.settings, g = s.status, installing = g.state === 'downloading' || g.state === 'unpacking';
    var vs = $('nvVariant'); if (!vs.options.length) vs.innerHTML = Object.keys(s.variants).map(function (k) { return '<option value="' + k + '">' + s.variants[k].label + ' · ' + s.variants[k].gb + ' ГБ</option>'; }).join('');
    if (document.activeElement !== vs) vs.value = c.variant;
    $('nvSetup').hidden = !!s.installed && !installing; $('nvMain').hidden = !s.installed || installing;
    $('nvProg').hidden = g.state !== 'downloading'; $('nvBar').style.width = (g.pct || 0) + '%';
    $('nvMsg').textContent = g.text || ''; $('nvMsg').style.color = g.state === 'error' ? '#e5484d' : '';
    $('nvInstall').disabled = installing; $('nvInstall').textContent = installing ? 'Идёт установка…' : (g.state === 'error' ? 'Повторить' : 'Скачать и установить');
    $('nvStart').hidden = !s.installed || g.running || g.state === 'starting'; $('nvStop').hidden = !g.running && g.state !== 'starting';
    $('nvAuto').checked = !!c.autostart;
    $('nvStat').textContent = g.state === 'starting' ? g.text : (g.running ? 'Движок работает' : (s.installed ? 'Движок остановлен. Нажми «Запустить движок».' : ''));
    var fr = $('nvFrame');
    if (g.running && !framed) { fr.src = '/nv/index.html'; framed = true; }
    if (!g.running && framed) { fr.src = 'about:blank'; framed = false; }
  }
  var load = function () { return api('/api/nv/state').then(render).catch(function () {}); };
  $('nvVariant').addEventListener('change', function () { post('/api/nv/settings', { variant: $('nvVariant').value }).then(render); });
  $('nvInstall').addEventListener('click', function () { post('/api/nv/install').then(render); });
  $('nvStart').addEventListener('click', function () { post('/api/nv/start').then(render); });
  $('nvStop').addEventListener('click', function () { post('/api/nv/stop').then(render); });
  $('nvAuto').addEventListener('change', function () { post('/api/nv/settings', { autostart: $('nvAuto').checked }).then(render); });
  load(); setInterval(load, 1500);
})();
