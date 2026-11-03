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
  var label = function (s) { var n = names(), m = n[s.name] || n[VoicePack.stem(s.name)]; return m || s.name; };
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
    return api('/info').then(function (j) { info = j; conn(true, 'Движок работает'); render(); }).catch(function () { conn(false, 'Нет связи с движком'); });
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

  // ---------- добавление голосов: окно, куда можно кинуть папку ----------
  var dlg = $('dlg'), working = false;
  function openDlg() { dlg.hidden = false; }
  function closeDlg() { if (working) return; dlg.hidden = true; dlg.classList.remove('busy'); $('plist').innerHTML = ''; say('pmsg', ''); }
  $('dlgx').addEventListener('click', closeDlg); $('pdone').addEventListener('click', closeDlg);
  dlg.addEventListener('mousedown', function (e) { if (e.target === dlg) closeDlg(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !dlg.hidden) closeDlg(); });
  $('drop').addEventListener('click', function () { $('dir').click(); });
  $('drop').addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('dir').click(); } });
  $('pfiles').addEventListener('click', function () { $('file').click(); });
  $('voices').addEventListener('click', function (e) { if (e.target.closest('#addv')) openDlg(); });

  // обход папки из перетаскивания (webkitGetAsEntry)
  function walk(entry, path, out) {
    return new Promise(function (resolve) {
      if (entry.isFile) { entry.file(function (f) { out.push({ path: path + f.name, name: f.name, file: f }); resolve(); }, function () { resolve(); }); return; }
      var rd = entry.createReader(), all = [];
      (function next() { rd.readEntries(function (b) { if (!b.length) { Promise.all(all.map(function (en) { return walk(en, path + entry.name + '/', out); })).then(resolve); return; } all = all.concat([].slice.call(b)); next(); }, function () { resolve(); }); })();
    });
  }
  function filesFromDrop(dt) {
    var items = [].slice.call(dt.items || []).map(function (it) { return it.webkitGetAsEntry && it.webkitGetAsEntry(); }).filter(Boolean), out = [];
    if (!items.length) return Promise.resolve([].slice.call(dt.files || []).map(function (f) { return { path: f.name, name: f.name, file: f }; }));
    return Promise.all(items.map(function (en) { return walk(en, '', out); })).then(function () { return out; });
  }
  function filesFromInput(inp) { return [].slice.call(inp.files || []).map(function (f) { return { path: f.webkitRelativePath || f.name, name: f.name, file: f }; }); }

  var dragN = 0, hasFiles = function (e) { return e.dataTransfer && [].indexOf.call(e.dataTransfer.types || [], 'Files') >= 0; };
  window.addEventListener('dragenter', function (e) { if (!hasFiles(e)) return; e.preventDefault(); dragN++; if (!working) openDlg(); });
  window.addEventListener('dragleave', function (e) { if (!hasFiles(e)) return; dragN = Math.max(0, dragN - 1); $('drop').classList.remove('over'); });
  window.addEventListener('dragover', function (e) { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; $('drop').classList.toggle('over', !!e.target.closest('#dlg')); });
  window.addEventListener('drop', function (e) {
    if (!hasFiles(e)) return; e.preventDefault(); dragN = 0; $('drop').classList.remove('over');
    if (working) return; openDlg();
    filesFromDrop(e.dataTransfer).then(addFiles);
  });
  $('dir').addEventListener('change', function () { var l = filesFromInput($('dir')); $('dir').value = ''; openDlg(); addFiles(l); });
  $('file').addEventListener('change', function () { var l = filesFromInput($('file')); $('file').value = ''; openDlg(); addFiles(l); });

  function upload(f, onp) {
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest(), fd = new FormData(); fd.append('file', f); fd.append('filename', f.name);
      x.open('POST', BASE + '/upload_file'); x.upload.onprogress = function (e) { if (e.lengthComputable) onp(e.loaded / e.total); };
      x.onload = function () { x.status < 400 ? resolve() : reject(new Error('upload')); }; x.onerror = function () { reject(new Error('upload')); };
      x.send(fd);
    });
  }
  function names() { try { return JSON.parse(store.get('names')) || {}; } catch (e) { return {}; } }
  function addFiles(list) {
    if (working) return;
    var g = VoicePack.group(list), existing = voicesOf(info || {}).map(function (s) { return VoicePack.norm(VoicePack.stem(s.name)); });
    var free = ((info && info.modelSlots) || []).filter(function (s) { return s && !s.name; }).map(function (s) { return Number(s.slotIndex); });
    if (!g.voices.length) { say('pmsg', 'В этой папке нет файла голоса (.pth). Кинь папку, где лежит модель.', 'err'); return; }
    working = true; dlg.classList.add('busy'); say('pmsg', '');
    var rows = g.voices.map(function (v) {
      var li = document.createElement('li'); li.className = 'pi';
      li.innerHTML = '<span class="t">' + esc(v.name) + '</span><span class="s">ждёт</span><span class="m">' + (v.index ? 'Модель и файл сходства (.index)' : 'Только модель, без .index (сходство работать не будет)') + '</span><span class="pb"><i></i></span>';
      $('plist').appendChild(li); return li;
    });
    var added = 0, failed = 0, chain = Promise.resolve();
    g.voices.forEach(function (v, n) {
      chain = chain.then(function () {
        var li = rows[n], st = li.querySelector('.s'), bar = li.querySelector('i'), fin = function (cls, txt) { li.classList.add(cls); st.textContent = txt; };
        if (existing.indexOf(VoicePack.norm(VoicePack.stem(v.model.name))) >= 0) { fin('err', 'уже есть'); failed++; return; }
        var slot = free.shift(); if (slot == null) { fin('err', 'нет места'); failed++; return; }
        var total = v.model.file.size + (v.index ? v.index.file.size : 0), done = 0, tick = function (cur) { var p = Math.min(1, (done + cur) / (total || 1)); bar.style.width = Math.round(p * 100) + '%'; st.textContent = Math.round(p * 100) + '%'; };
        st.textContent = '0%';
        return upload(v.model.file, function (r) { tick(r * v.model.file.size); }).then(function () { done = v.model.file.size; if (v.index) return upload(v.index.file, function (r) { tick(r * v.index.file.size); }); }).then(function () {
          st.textContent = 'подключаю…';
          var fl = [{ name: v.model.name, kind: 'rvcModel', dir: '' }]; if (v.index) fl.push({ name: v.index.name, kind: 'rvcIndex', dir: '' });
          return api('/load_model', { slot: String(slot), isHalf: 'true', params: JSON.stringify({ voiceChangerType: 'RVC', slot: slot, isSampleMode: false, sampleId: '', files: fl, params: {} }) });
        }).then(function () { bar.style.width = '100%'; fin('ok', 'готово'); added++; var nm = names(); nm[VoicePack.stem(v.model.name)] = v.name; store.set('names', JSON.stringify(nm)); })
          .catch(function () { fin('err', 'ошибка'); failed++; });
      });
    });
    chain.then(function () { return load(); }).then(function () {
      working = false;
      var txt = added ? 'Добавлено голосов: ' + added + (failed ? ', не удалось: ' + failed : '') : 'Ничего не добавлено';
      if (g.skipped.length) txt += '. ' + g.skipped.join('; ');
      say('pmsg', txt, added && !failed ? 'ok' : (added ? '' : 'err'));
    });
  }

  load(); setInterval(poll, 1500);
})();
