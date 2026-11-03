// Разбор перетащенной папки: что в ней голоса (.pth/.onnx + .index). Работает и в браузере, и в Node (для тестов).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.VoicePack = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var MODEL = /\.(pth|onnx)$/i, INDEX = /\.index$/i;
  var stem = function (n) { return String(n).replace(/\.[^.]+$/, ''); };
  var norm = function (s) { return String(s).toLowerCase().replace(/[\s_\-]+/g, ''); };

  /** files: [{path:'Папка/голос.pth', name:'голос.pth', size?, file?}] -> {voices:[{name, model, index|null}], skipped:[строка]} */
  function group(files) {
    var dirs = {}, skipped = [];
    (files || []).forEach(function (f) {
      var p = String(f.path || f.name).replace(/\\/g, '/'), i = p.lastIndexOf('/'), dir = i < 0 ? '' : p.slice(0, i);
      (dirs[dir] = dirs[dir] || []).push(f);
    });
    var voices = [];
    Object.keys(dirs).sort().forEach(function (dir) {
      var list = dirs[dir], models = list.filter(function (f) { return MODEL.test(f.name); }), idx = list.filter(function (f) { return INDEX.test(f.name); });
      models.forEach(function (m) {
        var pair = idx.filter(function (x) { return norm(stem(x.name)) === norm(stem(m.name)); })[0];
        if (!pair && models.length === 1 && idx.length >= 1) pair = idx[0];
        var folder = dir ? dir.slice(dir.lastIndexOf('/') + 1) : '';
        voices.push({ name: models.length === 1 && folder ? folder : stem(m.name), model: m, index: pair || null });
      });
      if (!models.length && idx.length) skipped.push((dir ? dir + ': ' : '') + 'есть .index, но нет модели .pth');
    });
    return { voices: voices, skipped: skipped };
  }
  return { group: group, stem: stem, norm: norm };
});
