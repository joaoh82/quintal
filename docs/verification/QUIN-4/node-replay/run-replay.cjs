const realpathSync = require('./replay.cjs');
const tail = ['Users', 'me', 'AppData', 'Local', 'Quintal', 'personal', 'node_modules', '@quintal', 'server', 'dist', 'index.js'];
const existing = new Map();          // what the volume holds, by namespaced path
let at = '\\\\?\\c:'; existing.set(at + '\\', 'dir');
tail.forEach((part, i) => { at += '\\' + part.toLowerCase(); existing.set(at, i === tail.length - 1 ? 'file' : 'dir'); });
for (const [label, entry] of [
  ['v0.6.4: entry on Tauri\'s resource_dir', '\\\\?\\C:\\' + tail.join('\\')],
  ['fixed: entry after dunce::simplified ', 'C:\\' + tail.join('\\')],
]) {
  const { result, error, calls } = realpathSync(entry, existing);
  console.log(`\n== ${label}\n   argv[1] = ${entry}\n   first lstat: ${calls[0]}`);
  console.log(error ? `   THROWS  ${error.message}  { errno: ${error.errno}, code: '${error.code}', syscall: '${error.syscall}', path: '${error.path}' }`
                    : `   resolves to ${result}  (${calls.length} lstats)`);
}
