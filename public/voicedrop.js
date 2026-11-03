// Окно «Добавить голоса»: кинь папку (или несколько), голоса сохраняются в библиотеку Overvoice и подключаются к движку.
(function () {
  'use strict';
  var HTML = '<div class="dlgbox" role="dialog" aria-modal="true" aria-label="Добавить голоса">' +
    '<div class="dlghead"><b>Добавить голоса</b><button type="button" class="x" id="vdX" aria-label="Закрыть">✕</button></div>' +
    '<div class="drop" id="vdDrop" tabindex="0" role="button">' +
    '<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M12 10v5M9.8 12.2 12 10l2.2 2.2"/></svg>' +
    '<b>Кинь сюда папку с голосом</b><span>Можно сразу папку с несколькими голосами. Или нажми и выбери папку.</span></div>' +
    '<ul class="plist" id="vdList"></ul><p class="msg" id="vdMsg"></p>' +
    '<div class="dlgfoot"><button type="button" class="ghost" id="vdFiles">Выбрать файлы по одному…</button><button type="button" class="ghost" id="vdDone">Закрыть</button></div></div>' +
    '<input type="file" id="vdDir" webkitdirectory multiple hidden><input type="file" id="vdFile" accept=".pth,.index,.onnx" multiple hidden>';
  var dlg, $, working = false, onDone = function () {}, dragN = 0;
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var clean = function (n) { return String(n).replace(/[\\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_').trim().slice(0, 80) || 'Голос'; };
  function say(t, kind) { var e = $('vdMsg'); e.textContent = t || ''; e.className = 'msg' + (kind ? ' ' + kind : ''); }
  function build() {
    if (dlg) return;
    dlg = document.createElement('div'); dlg.className = 'dlg'; dlg.hidden = true; dlg.innerHTML = HTML; document.body.appendChild(dlg);
    $ = function (id) { return dlg.querySelector('#' + id); };
    $('vdX').onclick = close; $('vdDone').onclick = close;
    dlg.addEventListener('mousedown', function (e) { if (e.target === dlg) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !dlg.hidden) close(); });
    $('vdDrop').onclick = function () { $('vdDir').click(); };
    $('vdDrop').onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('vdDir').click(); } };
    $('vdFiles').onclick = function () { $('vdFile').click(); };
    $('vdDir').onchange = function () { var l = fromInput($('vdDir')); $('vdDir').value = ''; open(); addFiles(l); };
    $('vdFile').onchange = function () { var l = fromInput($('vdFile')); $('vdFile').value = ''; open(); addFiles(l); };
  }
  function open() { build(); dlg.hidden = false; }
  function close() { if (working || !dlg) return; dlg.hidden = true; dlg.classList.remove('busy'); $('vdList').innerHTML = ''; say(''); }

  function walk(entry, path, out) {
    return new Promise(function (resolve) {
      if (entry.isFile) { entry.file(function (f) { out.push({ path: path + f.name, name: f.name, file: f }); resolve(); }, function () { resolve(); }); return; }
      var rd = entry.createReader(), all = [];
      (function next() { rd.readEntries(function (b) { if (!b.length) { Promise.all(all.map(function (en) { return walk(en, path + entry.name + '/', out); })).then(resolve); return; } all = all.concat([].slice.call(b)); next(); }, function () { resolve(); }); })();
    });
  }
  function fromDrop(dt) {
    var items = [].slice.call(dt.items || []).map(function (it) { return it.webkitGetAsEntry && it.webkitGetAsEntry(); }).filter(Boolean), out = [];
    if (!items.length) return Promise.resolve([].slice.call(dt.files || []).map(function (f) { return { path: f.name, name: f.name, file: f }; }));
    return Promise.all(items.map(function (en) { return walk(en, '', out); })).then(function () { return out; });
  }
  function fromInput(inp) { return [].slice.call(inp.files || []).map(function (f) { return { path: f.webkitRelativePath || f.name, name: f.name, file: f }; }); }

  var ext = function (n) { return (/\.[^.]+$/.exec(n) || [''])[0].toLowerCase(); };
  var target = function (name, f, kind) { return (kind === 'sample' ? 'sample' : name) + ext(f.name); };   // под именем голоса: model.pth у разных голосов одинаковый
  function put(name, f, kind, onp) {
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest();
      x.open('PUT', '/api/nv/library/' + encodeURIComponent(name) + '/' + encodeURIComponent(target(name, f, kind)));
      x.setRequestHeader('Content-Type', 'application/octet-stream');
      x.upload.onprogress = function (e) { if (e.lengthComputable) onp(e.loaded); };
      x.onload = function () { x.status < 400 ? resolve() : reject(new Error('put')); }; x.onerror = function () { reject(new Error('put')); };
      x.send(f);
    });
  }
  var norm = function (s) { return VoicePack.norm(s); };

  function addFiles(list) {
    if (working) return;
    var g = VoicePack.group(list);
    if (!g.voices.length) { say('В этой папке нет файла голоса (.pth). Кинь папку, где лежит модель.', 'err'); return; }
    working = true; dlg.classList.add('busy'); say('');
    fetch('/api/nv/library').then(function (r) { return r.json(); }).catch(function () { return {}; }).then(function (lib) {
      var have = {}, used = {}; (lib.voices || []).forEach(function (v) { have[norm(v.name)] = 1; });
      var rows = g.voices.map(function (v) {
        var nm = clean(v.name), k = norm(nm), n = 1; while (used[norm(nm)]) { n++; nm = clean(v.name) + ' (' + n + ')'; } used[norm(nm)] = 1; v.libName = nm; v.exists = !!have[k] && n === 1;
        var li = document.createElement('li'); li.className = 'pi';
        li.innerHTML = '<span class="t">' + esc(nm) + '</span><span class="s">ждёт</span><span class="m">' + (v.index ? 'Модель и файл сходства (.index)' : 'Только модель, без .index (сходство работать не будет)') + '</span><span class="pb"><i></i></span>';
        $('vdList').appendChild(li); return li;
      });
      var added = 0, failed = 0, chain = Promise.resolve();
      g.voices.forEach(function (v, n) {
        chain = chain.then(function () {
          var li = rows[n], st = li.querySelector('.s'), bar = li.querySelector('i'), fin = function (cls, txt) { li.classList.add(cls); st.textContent = txt; };
          if (v.exists) { fin('err', 'уже есть'); failed++; return; }
          var total = v.model.file.size + (v.index ? v.index.file.size : 0), done = 0;
          var tick = function (cur) { var p = Math.min(1, (done + cur) / (total || 1)); bar.style.width = Math.round(p * 100) + '%'; st.textContent = Math.round(p * 100) + '%'; };
          st.textContent = '0%';
          return put(v.libName, v.model.file, 'model', tick).then(function () { done = v.model.file.size; if (v.index) return put(v.libName, v.index.file, 'index', tick); }).then(function () { if (v.index) done += v.index.file.size; if (v.sample && v.sample.file.size < 30e6) return put(v.libName, v.sample.file, 'sample', function () { }).catch(function () { }); })
            .then(function () { bar.style.width = '100%'; fin('ok', 'сохранён'); added++; }).catch(function () { fin('err', 'ошибка'); failed++; });
        });
      });
      return chain.then(function () {
        if (!added) return { added: 0, failed: failed, sync: null };
        say('Подключаю к движку…');
        return fetch('/api/nv/library/sync', { method: 'POST' }).then(function (r) { return r.json(); }).catch(function () { return null; }).then(function (sync) { return { added: added, failed: failed, sync: sync }; });
      });
    }).then(function (r) {
      working = false; var sy = r.sync, txt;
      if (!r.added) txt = 'Ничего не добавлено';
      else {
        txt = 'Добавлено голосов: ' + r.added + (r.failed ? ', не удалось: ' + r.failed : '') + '. ';
        if (sy && sy.running) txt += sy.failed ? 'Не все подключились к движку, попробуй ещё раз.' : (sy.full ? 'В движке нет свободных мест для ' + sy.full + ' гол. Удали ненужные.' : 'Они уже в списке голосов.');
        else txt += 'Движок не запущен: голоса подключатся сами при его запуске.';
      }
      if (g.skipped.length) txt += ' ' + g.skipped.join('; ');
      say(txt, r.added && !r.failed ? 'ok' : (r.added ? '' : 'err')); try { onDone(); } catch (e) { /* ок */ }
    });
  }

  var hasFiles = function (e) { return e.dataTransfer && [].indexOf.call(e.dataTransfer.types || [], 'Files') >= 0; };
  window.addEventListener('dragenter', function (e) { if (!hasFiles(e)) return; e.preventDefault(); dragN++; if (!working) open(); });
  window.addEventListener('dragleave', function (e) { if (!hasFiles(e)) return; dragN = Math.max(0, dragN - 1); if (dlg) $('vdDrop').classList.remove('over'); });
  window.addEventListener('dragover', function (e) { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; if (dlg) $('vdDrop').classList.toggle('over', !!e.target.closest('.dlg')); });
  window.addEventListener('drop', function (e) {
    if (!hasFiles(e)) return; e.preventDefault(); dragN = 0; if (dlg) $('vdDrop').classList.remove('over');
    if (working) return; open(); fromDrop(e.dataTransfer).then(addFiles);
  });
  window.VoiceDrop = { open: open, onDone: function (f) { onDone = f; } };
})();
