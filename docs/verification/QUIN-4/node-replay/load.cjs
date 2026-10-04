// Loads Node v22.23.3's lib/path.js outside Node's bootstrap, as win32.
const fs = require('fs'), vm = require('vm');
const primordials = new Proxy({}, { get(_, name) {
  const m = /^(String|Array|Function|RegExp|Object)Prototype(\w+)$/.exec(name);
  if (m) { const k = m[2][0].toLowerCase() + m[2].slice(1);
    const proto = globalThis[m[1]].prototype; return (self, ...a) => proto[k].apply(self, a); }
  throw new Error('primordial ' + name);
}});
const C = { CHAR_UPPERCASE_A: 65, CHAR_LOWERCASE_A: 97, CHAR_UPPERCASE_Z: 90, CHAR_LOWERCASE_Z: 122,
  CHAR_DOT: 46, CHAR_FORWARD_SLASH: 47, CHAR_BACKWARD_SLASH: 92, CHAR_COLON: 58, CHAR_QUESTION_MARK: 63 };
module.exports = function load(cwd, env = {}) {
  const req = (n) => n === 'internal/constants' ? C
    : n === 'internal/validators' ? { validateObject() {}, validateString(v, n) { if (typeof v !== 'string') throw new TypeError(n); } }
    : n === 'internal/util' ? { getLazy: (f) => f, isWindows: true, isMacOS: false } : (() => { throw new Error(n); })();
  const mod = { exports: {} };
  const proc = { cwd: () => cwd, env, platform: 'win32' };
  vm.runInThisContext('(function(exports, require, module, primordials, process){' + fs.readFileSync(__dirname + '/path.js', 'utf8') + '\n})')(mod.exports, req, mod, primordials, proc);
  return mod.exports;
};
