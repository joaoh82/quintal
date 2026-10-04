// Node v22.23.3's realpathSync (lib/fs.js, verbatim) with the Windows binding mocked:
// every lstat goes through Node's own C++ ToNamespacedPath (./ns, built from src/path.cc),
// and the mock volume answers EISDIR for the volume device itself, as Windows does.
const fs = require('fs'), vm = require('vm'), { execFileSync } = require('child_process');
const src = fs.readFileSync(__dirname + '/fs.js', 'utf8').split('\n');
const start = src.findIndex((l) => l === 'let splitRoot;');
const fnAt = src.findIndex((l) => l.startsWith('function realpathSync('));
const end = src.findIndex((l, i) => i > fnAt && l === '}');
const body = src.slice(start, end + 1).join('\n');
const primordials = new Proxy({}, { get(_, n) {
  if (n === 'SideEffectFreeRegExpPrototypeExec') return (re, s) => re.exec(s);
  const m = /^(String|Array|BigInt)Prototype(\w+)$/.exec(n);
  const k = m[2][0].toLowerCase() + m[2].slice(1); const proto = globalThis[m[1]].prototype;
  return (self, ...a) => proto[k].apply(self, a);
}});
const S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFREG = 0o100000, S_IFLNK = 0o120000, S_IFIFO = 0o010000, S_IFSOCK = 0o140000;
module.exports = function realpathSync(p, existing) {
  const calls = [];
  const lstat = (base) => {
    const ns = execFileSync(__dirname + '/ns', { input: base + '\n' }).toString().trimEnd();
    const shown = ns.startsWith('\\\\?\\') ? ns.slice(4) : ns;   // src/api/exceptions.cc StringFromPath
    calls.push(`${base}  ->  ${ns}`);
    let err;
    if (/^\\\\\?\\[A-Za-z]:$/.test(ns)) err = ['EISDIR', -4068, 'illegal operation on a directory'];
    else if (!existing.has(ns.toLowerCase())) err = ['ENOENT', -4058, 'no such file or directory'];
    if (err) { const e = new Error(`${err[0]}: ${err[2]}, lstat '${shown}'`); Object.assign(e, { errno: err[1], code: err[0], syscall: 'lstat', path: shown }); throw e; }
    const mode = existing.get(ns.toLowerCase()) === 'file' ? S_IFREG : S_IFDIR; const a = [0, mode]; return a;
  };
  const ctx = {
    isWindows: true, primordials, pathModule: require('./load.cjs')('C:\\Users\\me\\AppData\\Roaming\\sh.quintal.desktop\\personal').win32,
    binding: { lstat, stat: lstat, readlink: () => { throw new Error('no links in this tree'); } },
    getOptions: (o) => o || {}, toPathIfFileURL: (x) => x, validatePath() {}, realpathCacheKey: Symbol('cache'),
    SafeMap: Map, SafeSet: Set, CHAR_BACKWARD_SLASH: 92, CHAR_FORWARD_SLASH: 47, Buffer, statValues: [0, 0],
    isFileType: (stats, t) => ((stats[1] & S_IFMT) === t), S_IFLNK, S_IFIFO, S_IFSOCK,
  };
  const fn = vm.runInNewContext(`(function(){ const { ${['StringPrototypeCharCodeAt','StringPrototypeSlice','SideEffectFreeRegExpPrototypeExec','BigIntPrototypeToString'].join(',')} } = primordials; ${body}; return realpathSync; })()`, ctx);
  try { return { result: fn(p), calls }; } catch (error) { return { error, calls }; }
};
