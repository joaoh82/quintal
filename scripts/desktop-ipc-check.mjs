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
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildAuthPayload, verifyAuthSignature } from '@quintal/shared';

const PORT = 3399;
/** Generous on a cold CI runner, where WebKit takes its time to first paint. */
const TIMEOUT_MS = Number(process.env.QUINTAL_IPC_TIMEOUT_MS ?? 60_000);
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
    const run = async (label, cmd, args) => {
      try { out.push({ cmd: label, ok: true, value: await invoke(cmd, args) }); return out[out.length - 1].value; }
      catch (error) { out.push({ cmd: label, ok: false, error: String((error && error.message) || error) }); return undefined; }
    };

    // Ordered: read state, create and sign, then exercise the backup gate, then
    // replace the identity, then destroy it. Every command in the bridge gets
    // called on the hop where the ACL applies.
    await run('has_identity', 'has_identity', {});
    await run('get_public_key', 'get_public_key', {});
    await run('sign_challenge', 'sign_challenge', { payload: ${JSON.stringify(PAYLOAD)} });
    await run('can_wipe (before)', 'can_wipe', {});

    // The gate, from the outside: a confirmation nobody earned must be refused.
    await run('confirm_backup (junk token)', 'confirm_backup', { token: 'not-a-real-token' });
    const first = await run('export_backup', 'export_backup', {});
    await run('confirm_backup (real token)', 'confirm_backup', { token: first && first.token });
    await run('can_wipe (after confirm)', 'can_wipe', {});

    // Replacing the identity must revoke the previous one's permission to be
    // wiped — on disk *and* in memory. The stale token below is the half that
    // a disk-only fix leaves redeemable.
    await run('import_identity', 'import_identity', { secret: ${JSON.stringify('nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqps52s3re')} });
    await run('can_wipe (after import)', 'can_wipe', {});
    await run('confirm_backup (stale token)', 'confirm_backup', { token: first && first.token });
    await run('can_wipe (after stale confirm)', 'can_wipe', {});
    await run('wipe_identity (unbacked)', 'wipe_identity', {});

    // The replacement earns its own backup, and only then may be wiped.
    const second = await run('export_backup (second)', 'export_backup', {});
    await run('confirm_backup (second)', 'confirm_backup', { token: second && second.token });
    await run('wipe_identity', 'wipe_identity', {});
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
  const binary = 'apps/desktop/src-tauri/target/debug/quintal-desktop';
  if (!existsSync(binary)) {
    server.close();
    reject(new Error(`no binary at ${binary} — run \`cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml\` first`));
    return;
  }
  const app = spawn(
    binary,
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
  let stdout = '';
  let exited = null;
  app.stderr.on('data', (chunk) => (stderr += chunk));
  app.stdout.on('data', (chunk) => (stdout += chunk));
  app.on('exit', (code, signal) => {
    exited = `exit ${code}${signal ? ` (${signal})` : ''}`;
  });
  app.on('error', (error) => {
    exited = `could not spawn: ${error.message}`;
  });

  const done = () => {
    app.kill();
    rmSync(dataDir, { recursive: true, force: true });
  };
  const timer = setTimeout(() => {
    done();
    server.close();
    reject(
      new Error(
        [
          `the app never reported back within ${TIMEOUT_MS / 1000}s.`,
          `process: ${exited ?? 'still running'}`,
          stdout.trim() ? `stdout:\n${stdout.trim()}` : 'stdout: (empty)',
          stderr.trim() ? `stderr:\n${stderr.trim()}` : 'stderr: (empty)',
          '',
          'On a headless runner this is usually WebKitGTK failing to render:',
          'set WEBKIT_DISABLE_DMABUF_RENDERER=1 and WEBKIT_DISABLE_COMPOSITING_MODE=1.',
        ].join('\n'),
      ),
    );
  }, TIMEOUT_MS);

  server.on('close', () => {
    clearTimeout(timer);
    done();
  });
});

/**
 * What each call must do. Most have to succeed; two have to *fail*, and those
 * are the interesting ones — a gate that is open reports success just as
 * cheerfully as a gate that works.
 */
const EXPECTED = {
  'has_identity': { ok: true, value: 'none' },
  'get_public_key': { ok: true },
  'sign_challenge': { ok: true },
  'can_wipe (before)': { ok: true, value: false },
  'confirm_backup (junk token)': { ok: false },
  'export_backup': { ok: true },
  'confirm_backup (real token)': { ok: true },
  'can_wipe (after confirm)': { ok: true, value: true },
  'import_identity': { ok: true },
  // Importing replaces the identity, so the confirmation must not carry over.
  'can_wipe (after import)': { ok: true, value: false },
  // The other half of that, and the one a disk-only fix leaves open: the token
  // from the *previous* identity's export must no longer redeem.
  'confirm_backup (stale token)': { ok: false },
  'can_wipe (after stale confirm)': { ok: true, value: false },
  'wipe_identity (unbacked)': { ok: false },
  // ...and the replacement can be wiped once it has a backup of its own.
  'export_backup (second)': { ok: true },
  'confirm_backup (second)': { ok: true },
  'wipe_identity': { ok: true },
};

let failed = false;
console.log(`\nIPC from ${ORIGIN}\n`);
for (const entry of report) {
  const expected = EXPECTED[entry.cmd];
  const shown =
    typeof entry.value === 'string' && entry.value.length > 24
      ? `${entry.value.slice(0, 24)}…`
      : JSON.stringify(entry.value);

  let verdict = true;
  let why = '';
  if (!expected) {
    verdict = false;
    why = 'unexpected call';
  } else if (entry.ok !== expected.ok) {
    verdict = false;
    why = expected.ok ? `should have succeeded: ${entry.error}` : 'should have been refused';
  } else if ('value' in expected && JSON.stringify(entry.value) !== JSON.stringify(expected.value)) {
    verdict = false;
    why = `expected ${JSON.stringify(expected.value)}`;
  }

  const detail = entry.ok ? shown : `refused (${entry.error})`;
  console.log(`  ${verdict ? 'ok  ' : 'FAIL'} ${entry.cmd} -> ${detail}${why ? ` — ${why}` : ''}`);
  if (!verdict) failed = true;
}

const missing = Object.keys(EXPECTED).filter((cmd) => !report.some((r) => r.cmd === cmd));
if (missing.length > 0) {
  console.log(`  FAIL never called: ${missing.join(', ')}`);
  failed = true;
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
