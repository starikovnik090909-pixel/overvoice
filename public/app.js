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
    needGb = Math.ceil(s.variants[c.variant].gb * 2.2); renderDrives(c, installing);
    $('nvInstall').disabled = installing; $('nvInstall').textContent = installing ? 'Идёт установка…' : (g.state === 'error' ? 'Повторить' : 'Скачать и установить');
    $('nvStart').hidden = !s.installed || g.running || g.state === 'starting'; $('nvStop').hidden = !g.running && g.state !== 'starting';
    $('nvAuto').checked = !!c.autostart;
    $('nvStat').textContent = g.state === 'starting' ? g.text : (g.running ? 'Движок работает' : (s.installed ? 'Движок остановлен. Нажми «Запустить движок».' : ''));
    var fr = $('nvFrame');
    if (g.running && !framed) { fr.src = '/nv/index.html'; framed = true; }
    if (!g.running && framed) { fr.src = 'about:blank'; framed = false; }
  }
  var drives = [], needGb = 8, cableOn = false;
  function renderDrives(c, installing) {
    var sel = $('nvDrive'), lab = sel.parentNode;
    lab.hidden = !drives.length; if (!drives.length) return;
    var want = c.dir ? c.dir.slice(0, 1).toUpperCase() : '', cur = sel.value;
    sel.innerHTML = '<option value="">В папку программы</option>' + drives.map(function (d) { return '<option value="' + d.letter + '"' + (d.freeGb < needGb ? ' disabled' : '') + '>Диск ' + d.letter + ': · свободно ' + d.freeGb + ' ГБ' + (d.freeGb < needGb ? ' (мало места)' : '') + '</option>'; }).join('');
    sel.value = want || (document.activeElement === sel ? cur : ''); sel.disabled = installing;
  }
  function renderCable(s) {
    $('cabBtn').hidden = !s.supported || s.installed; var t = s.status.text;
    $('cabMsg').textContent = !s.supported ? 'Автоустановка работает только в Windows.' : (s.installed ? 'Установлен' : (t || 'Не найден'));
    $('cabMsg').style.color = s.status.state === 'error' ? '#e5484d' : (s.installed ? 'var(--on)' : '');
    $('cabBtn').disabled = s.status.state === 'working'; $('cabBtn').textContent = s.status.state === 'working' ? 'Устанавливаю…' : 'Установить';
  }
  var loadCable = function () { return api('/api/nv/cable').then(renderCable).catch(function () {}); };
  var loadDrives = function () { return api('/api/nv/drives').then(function (r) { drives = r.drives || []; }).catch(function () {}); };
  $('nvDrive').addEventListener('change', function () { var v = $('nvDrive').value; post('/api/nv/settings', { dir: v ? v + ':\\Overvoice' : '' }).then(function (s) { render(s); }); });
  $('cabBtn').addEventListener('click', function () { post('/api/nv/cable/install').then(loadCable); });
  var load = function () { return api('/api/nv/state').then(render).catch(function () {}); };
  $('nvVariant').addEventListener('change', function () { post('/api/nv/settings', { variant: $('nvVariant').value }).then(render); });
  $('nvInstall').addEventListener('click', function () { post('/api/nv/install').then(render); });
  $('nvStart').addEventListener('click', function () { post('/api/nv/start').then(render); });
  $('nvStop').addEventListener('click', function () { post('/api/nv/stop').then(render); });
  $('nvAuto').addEventListener('change', function () { post('/api/nv/settings', { autostart: $('nvAuto').checked }).then(render); });
  loadDrives().then(load); loadCable(); setInterval(load, 1500); setInterval(loadCable, 3000);
})();
