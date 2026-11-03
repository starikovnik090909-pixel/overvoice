// Overvoice: интерфейс управления сервером VCClient (режим «серверное устройство»: звук идёт с микрофона прямо в выбранный выход).
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var info = null, busy = false, saveT = 0;
  var EMOJI = ['🎙', '🧔', '🧑‍🎤', '👩', '🧚', '🎭', '🤖', '🦊'];
  var store = { get: function (k) { try { return localStorage.getItem('nv.' + k); } catch (e) { return null; } }, set: function (k, v) { try { localStorage.setItem('nv.' + k, v); } catch (e) { } } };
  var BASE = location.origin + '/api/nv/engine';   // Overdeck пропускает запросы к движку

  function api(path, form) {
    var o = form ? { method: 'POST', body: new URLSearchParams(form) } : {};
    return fetch(BASE + path, o).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }
  var setS = function (key, val) { return api('/update_settings', { key: key, val: String(val) }).then(function (j) { if (j && j.modelSlots) info = j; return j; }); };
  function say(id, text, kind) { var e = $(id); e.textContent = text || ''; e.className = 'msg' + (kind ? ' ' + kind : ''); }

  function conn(ok, text) { var c = $('conn'); c.className = 'conn ' + (ok ? 'ok' : 'bad'); $('connT').textContent = text; }

  function voicesOf(i) { return (i.modelSlots || []).filter(function (s) { return s && s.voiceChangerType === 'RVC' && s.name; }); }
  function renderVoices() {
    var list = voicesOf(info), cur = Number(info.modelSlotIndex);
    $('voices').innerHTML = list.map(function (s, n) {
      var sel = Number(s.slotIndex) === cur;
      return '<button type="button" class="v" aria-pressed="' + sel + '" data-slot="' + s.slotIndex + '"><span class="em">' + EMOJI[n % EMOJI.length] + '</span><span class="nm" title="' + esc(label(s)) + '">' + esc(label(s)) + '</span><span class="ds">' + esc(s.credit || s.description || 'RVC') + '</span></button>';
    }).join('') + '<button type="button" class="v add" id="addv">＋ Добавить свой голос</button>';
    if (!list.length) say('vmsg', 'Голосов пока нет. Нажми «Добавить свой голос» и кинь папку с голосом (там должен лежать файл .pth).');
  }
  var libNames = {};
  var label = function (s) { return libNames[VoicePack.norm(VoicePack.stem(s.name))] || s.name; };
  function loadNames() { return fetch('/api/nv/library').then(function (r) { return r.json(); }).then(function (j) { libNames = {}; (j.voices || []).forEach(function (v) { libNames[VoicePack.norm(VoicePack.stem(v.model))] = v.name; }); }).catch(function () { }); }
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };

  function fillDevices(sel, devices, withOff) {
    var prev = sel.value, h = withOff ? '<option value="-1">Нет</option>' : '';
    h += devices.map(function (d) { return '<option value="' + d.index + '">' + esc(d.name) + (d.hostAPI ? ' [' + esc(d.hostAPI) + ']' : '') + '</option>'; }).join('');
    sel.innerHTML = h; if (prev) sel.value = prev;
  }
  function pickDefault(sel, devices, rx, saved) {
    var want = saved && devices.filter(function (d) { return d.name === saved; })[0];
    if (!want && rx) want = devices.filter(function (d) { return rx.test(d.name); })[0];
    if (want) sel.value = String(want.index);
  }
  var nameOf = function (devs, idx) { var d = devs.filter(function (x) { return String(x.index) === String(idx); })[0]; return d ? d.name : ''; };

  function render() {
    var i = info, ins = i.serverAudioInputDevices || [], outs = i.serverAudioOutputDevices || [];
    fillDevices($('inDev'), ins, false); fillDevices($('outDev'), outs, false); fillDevices($('monDev'), outs, true);
    var inId = Number(i.serverInputDeviceId), outId = Number(i.serverOutputDeviceId), monId = Number(i.serverMonitorDeviceId);
    if (inId >= 0 && nameOf(ins, inId)) $('inDev').value = String(inId); else pickDefault($('inDev'), ins, /./, store.get('in'));
    if (outId >= 0 && nameOf(outs, outId)) $('outDev').value = String(outId); else pickDefault($('outDev'), outs, /CABLE Input/i, store.get('out'));
    $('monDev').value = String(monId);
    var hasCable = outs.some(function (d) { return /CABLE Input/i.test(d.name); });
    say('cable', hasCable ? 'Виртуальный кабель найден. В OBS добавь «Захват входящего звука» и выбери CABLE Output.' : 'Виртуальный кабель не найден. Установи бесплатный VB-Cable (vb-audio.com/Cable) и перезапусти NV.', hasCable ? 'ok' : 'err');
    renderVoices();
    var tran = Number(i.tran) || 0; $('pitch').value = tran; $('pitchv').textContent = (tran > 0 ? '+' : '') + tran;
    var ir = Math.round((Number(i.indexRatio) || 0) * 100); $('idx').value = ir; $('idxv').textContent = ir + '%';
    var st = Number(i.silentThreshold) || 0, g = st <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((Math.log10(st) + 5) * 50))); $('gate').value = g; $('gatev').textContent = g + '%';
    syncState();
  }
  function syncState() {
    var live = Number(info.serverAudioStated) === 1;
    $('go').classList.toggle('live', live); $('go').textContent = live ? '■ В эфире: остановить' : '▶ Запустить';
    var perf = info.performance || [], tot = perf.reduce(function (a, b) { return a + (Number(b) || 0); }, 0);
    $('lat').textContent = live && tot ? Math.round(tot) + ' мс' : '—';
    var gp = (info.gpus || []).filter(function (g) { return g && g.id >= 0; })[0];
    $('dev').textContent = gp ? gp.name : (info.gpus ? 'процессор' : '—');
  }

  function load() {
    return loadNames().then(function () { return api('/info'); }).then(function (j) { info = j; conn(true, 'Движок работает'); render(); }).catch(function () { conn(false, 'Нет связи с движком'); });
  }
  function poll() {
    if (busy) return;
    api('/info').then(function (j) { var wasLive = info && Number(info.serverAudioStated) === 1; info = j; conn(true, 'Движок работает'); syncState(); if (!document.activeElement || document.activeElement.tagName !== 'SELECT') { var cur = Number(j.modelSlotIndex); document.querySelectorAll('.v[data-slot]').forEach(function (b) { b.setAttribute('aria-pressed', String(Number(b.dataset.slot) === cur)); }); } }).catch(function () { conn(false, 'Нет связи с движком'); });
  }

  $('voices').addEventListener('click', function (e) {
    if (e.target.closest('#addv')) { $('file').click(); return; }
    var b = e.target.closest('.v[data-slot]'); if (!b) return;
    setS('modelSlotIndex', b.dataset.slot).then(function () { renderVoices(); store.set('voice', b.dataset.slot); }).catch(function () { say('vmsg', 'Не удалось выбрать голос', 'err'); });
  });
  function debounce(key, id, conv, label) { $(id).addEventListener('input', function () { label(); clearTimeout(saveT); saveT = setTimeout(function () { setS(key, conv($(id).value)); }, 250); }); }
  debounce('tran', 'pitch', function (v) { return v; }, function () { var v = Number($('pitch').value); $('pitchv').textContent = (v > 0 ? '+' : '') + v; });
  debounce('indexRatio', 'idx', function (v) { return Number(v) / 100; }, function () { $('idxv').textContent = $('idx').value + '%'; });
  debounce('silentThreshold', 'gate', function (v) { return Number(v) === 0 ? 0 : Math.pow(10, -5 + Number(v) / 50); }, function () { $('gatev').textContent = $('gate').value + '%'; });
  $('inDev').addEventListener('change', function () { store.set('in', nameOf(info.serverAudioInputDevices || [], $('inDev').value)); setS('serverInputDeviceId', $('inDev').value); });
  $('outDev').addEventListener('change', function () { store.set('out', nameOf(info.serverAudioOutputDevices || [], $('outDev').value)); setS('serverOutputDeviceId', $('outDev').value); });
  $('monDev').addEventListener('change', function () { setS('serverMonitorDeviceId', $('monDev').value); });

  $('go').addEventListener('click', function () {
    if (!info || busy) return; busy = true; $('go').disabled = true;
    var live = Number(info.serverAudioStated) === 1, chain;
    if (live) chain = setS('serverAudioStated', 0);
    else chain = setS('serverInputDeviceId', $('inDev').value).then(function () { return setS('serverOutputDeviceId', $('outDev').value); }).then(function () { return setS('serverMonitorDeviceId', $('monDev').value); }).then(function () { return setS('enableServerAudio', 1); }).then(function () { return setS('serverAudioStated', 1); });
    chain.then(load).catch(function () { say('cable', 'Не удалось запустить. Проверь микрофон и выход.', 'err'); }).then(function () { busy = false; $('go').disabled = false; });
  });

  // добавление голосов: общее окно (кинь папку), файлы попадают в библиотеку и подключаются к движку
  $('voices').addEventListener('click', function (e) { if (e.target.closest('#addv')) VoiceDrop.open(); });
  VoiceDrop.onDone(function () { setTimeout(load, 300); });

  load(); setInterval(poll, 1500);
})();
