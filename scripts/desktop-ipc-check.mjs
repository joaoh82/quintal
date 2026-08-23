/**
 * Drive the desktop bridge from a page, without a human clicking one.
 *
 * This exists because a whole slice shipped with every command rejected and no
 * test could see it. The Rust unit tests pass — they call the functions
 * directly. The web tests pass — they mock the bridge. What nothing covered was
 * the actual IPC hop from a *remote* origin, which is where Tauri's ACL applies
 * and where the commands were being refused.
 *
 * So: stand up a tiny office, point the app at it, and let the page call every
 * command and report back. The signature that comes out is then verified with
 * `@noble/curves` — the library the real office checks against — which closes
 * the loop from keychain to server.
 *
 *   node scripts/desktop-ipc-check.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildAuthPayload, verifyAuthSignature } from '@quintal/shared';

const PORT = 3399;
const ORIGIN = `http://localhost:${PORT}`;
const PAYLOAD = buildAuthPayload({
  origin: ORIGIN,
  nonce: 'a'.repeat(64),
  timestamp: Math.floor(Date.now() / 1000),
});

const page = `<!doctype html><meta charset="utf-8"><title>ipc check</title>
<body><p>checking…</p><script>
(async () => {
  const out = [];
  const invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
  if (typeof invoke !== 'function') {
    out.push({ cmd: '__bridge__', ok: false, error: 'no __TAURI_INTERNALS__.invoke on this page' });
  } else {
    const calls = [
      ['has_identity', {}],
      ['get_public_key', {}],
      ['sign_challenge', { payload: ${JSON.stringify(PAYLOAD)} }],
      ['can_wipe', {}],
    ];
    for (const [cmd, args] of calls) {
      try { out.push({ cmd, ok: true, value: await invoke(cmd, args) }); }
      catch (error) { out.push({ cmd, ok: false, error: String(error && error.message || error) }); }
    }
  }
  await fetch('/report', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(out),
  });
})();
</script></body>`;

const report = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/report') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        res.writeHead(204).end();
        server.close();
        resolve(JSON.parse(body));
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
  });
  server.listen(PORT);

  const dataDir = mkdtempSync(join(tmpdir(), 'quintal-ipc-'));
  const app = spawn(
    'apps/desktop/src-tauri/target/debug/quintal-desktop',
    [],
    {
      env: {
        ...process.env,
        QUINTAL_OFFICE_URL: ORIGIN,
        QUINTAL_SECRETS_BACKEND: 'file',
        // Keep this run's key out of the real app data directory.
        XDG_DATA_HOME: dataDir,
        HOME: process.env.HOME,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  app.stderr.on('data', (chunk) => (stderr += chunk));

  const done = () => {
    app.kill();
    rmSync(dataDir, { recursive: true, force: true });
  };
  const timer = setTimeout(() => {
    done();
    server.close();
    reject(new Error(`the app never reported back.\n${stderr}`));
  }, 45_000);

  server.on('close', () => {
    clearTimeout(timer);
    done();
  });
});

let failed = false;
console.log(`\nIPC from ${ORIGIN}\n`);
for (const entry of report) {
  const shown =
    typeof entry.value === 'string' && entry.value.length > 24
      ? `${entry.value.slice(0, 24)}…`
      : JSON.stringify(entry.value);
  console.log(`  ${entry.ok ? 'ok  ' : 'FAIL'} ${entry.cmd}${entry.ok ? ` -> ${shown}` : ` -> ${entry.error}`}`);
  if (!entry.ok) failed = true;
}

// The whole point: a signature made in the keychain, checked by the library the
// office uses. Rust verifying its own output would prove nothing.
const pubkey = report.find((r) => r.cmd === 'get_public_key')?.value;
const sig = report.find((r) => r.cmd === 'sign_challenge')?.value;
if (pubkey && sig) {
  const ok = verifyAuthSignature({ pubkey, sig, payload: PAYLOAD });
  console.log(`\n  ${ok ? 'ok  ' : 'FAIL'} the signature verifies with @noble/curves`);
  if (!ok) failed = true;
} else {
  console.log('\n  FAIL no key or signature to verify');
  failed = true;
}

console.log('');
process.exit(failed ? 1 : 0);
