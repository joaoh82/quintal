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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildAuthPayload, verifyAuthSignature } from '@quintal/shared';

/**
 * Which origin to serve the fake office from.
 *
 * This matters more than it looks. Tauri calls a URL "local" when it is
 * relative to `devUrl`, and capabilities distinguish local from remote — so a
 * check that only ever runs on some other port exercises the remote path and
 * silently skips the one `tauri dev` actually uses. That gap shipped: every
 * command was refused in development while this script was green.
 *
 * `QUINTAL_IPC_PORT=3000` (the configured `devUrl` port) runs the local path.
 */
const PORT = Number(process.env.QUINTAL_IPC_PORT ?? 3399);
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
    await run('detect_runtimes', 'detect_runtimes', {});

    // Machine registration, from the outside. Reading the status before and
    // after storing a token is the pair that matters: the office decides
    // whether to register by reading that flag, so a status that never flips
    // would make the app re-register on every launch and revoke its own token
    // each time.
    await run('host_status (fresh)', 'host_status', {});
    await run('remember_host_token (empty)', 'remember_host_token', { token: '  ', label: 'laptop' });
    await run('remember_host_token', 'remember_host_token', { token: 'qh_ipc_check', label: 'ipc-check-machine' });
    await run('host_status (registered)', 'host_status', {});
    await run('forget_host_token', 'forget_host_token', {});
    await run('host_status (forgotten)', 'host_status', {});

    // The fleet, from the outside. Nothing is spawned here — there is no
    // harness on a CI runner — but the ACL and the guards are exactly what a
    // command being merely *declared* fails to prove.
    await run('fleet_status', 'fleet_status', {});
    await run('fleet_logs', 'fleet_logs', {});
    await run('repos_dir', 'repos_dir', {});
    await run('list_repos', 'list_repos', {});
    // Off unless somebody turns it on. Read rather than toggled: flipping a
    // login item on a contributor's machine is not a test's business.
    await run('opens_at_login', 'opens_at_login', {});
    // pick_repos_dir is deliberately not called: it opens a native folder
    // dialog and would wait forever for a click nobody is there to make. Its
    // grant is covered instead by the Rust test every_declared_command_is_granted,
    // which checks the ACL statically against the declared command list.
    // (No backticks in this block — it lives inside a template literal.)
    await run('stop_fleet (nothing running)', 'stop_fleet', {});
    // Takes no arguments at all: the working directory and the office are the
    // host's to decide, not the page's.
    await run('start_fleet (unregistered)', 'start_fleet', {});

    // The gate, from the outside: a confirmation nobody earned must be refused.
    await run('confirm_backup (junk token)', 'confirm_backup', { token: 'not-a-real-token' });

    // Export but deliberately do NOT confirm. The token stays outstanding,
    // which is the state the next steps are about — confirming it here would
    // spend it, and every later refusal would then be "already spent" rather
    // than "the import revoked it". That is the mistake the previous version of
    // this script made, and it is why it passed while the hole was open.
    const first = await run('export_backup', 'export_backup', {});

    await run('import_identity', 'import_identity', { secret: ${JSON.stringify('nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqps52s3re')} });
    await run('can_wipe (after import)', 'can_wipe', {});
    // The load-bearing step: an outstanding token from the identity that was
    // just replaced must not confirm a backup for its replacement.
    await run('confirm_backup (stale token)', 'confirm_backup', { token: first && first.token });
    await run('can_wipe (after stale confirm)', 'can_wipe', {});
    await run('wipe_identity (unbacked)', 'wipe_identity', {});

    // The replacement earns its own backup, and only then may be wiped.
    const second = await run('export_backup (second)', 'export_backup', {});
    await run('confirm_backup (second)', 'confirm_backup', { token: second && second.token });
    await run('can_wipe (final)', 'can_wipe', {});
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

  // Seed a chosen repos directory before the app starts.
  //
  // The picker itself cannot be driven here — it opens a native folder dialog
  // and would wait forever for a click nobody is there to make — so this covers
  // the half that everything else depends on: that a *stored* directory is the
  // one the host reports and would spawn in. The wiring from the dialog to the
  // store is the piece that once shipped doing nothing, and it is still only
  // verified by reading.
  const chosenRepos = join(dataDir, 'chosen-repos');
  mkdirSync(chosenRepos, { recursive: true });
  mkdirSync(join(chosenRepos, 'a-checkout', '.git'), { recursive: true });
  const appDir =
    process.platform === 'darwin'
      ? join(dataDir, 'Library', 'Application Support', 'sh.quintal.desktop')
      : join(dataDir, '.local', 'share', 'sh.quintal.desktop');
  mkdirSync(appDir, { recursive: true });
  writeFileSync(
    join(appDir, 'settings.json'),
    JSON.stringify({ repos_dir: chosenRepos }, null, 2),
  );
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
        // Keep this run's state out of the real app data directory — including
        // on macOS, where Tauri derives it from HOME and ignores XDG_DATA_HOME
        // entirely. Sharing it meant this check inherited whatever the real app
        // had left behind: a marker written by the keychain backend, with no
        // file behind it for the file backend to find, reads as a permanently
        // locked keychain. Every "locked" failure here was that, not a bug.
        XDG_DATA_HOME: dataDir,
        HOME: dataDir,
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
  // Contents depend on what is installed on the machine; what must hold is
  // that the call is permitted and answers.
  'detect_runtimes': { ok: true },
  // An identity exists by now (`get_public_key` made one), so registration is
  // allowed; `registered` must be false until something is actually stored.
  'host_status (fresh)': { ok: true, value: { registered: false } },
  // A blank token is refused rather than stored: a machine holding an empty
  // credential looks registered and can never boot anything.
  'remember_host_token (empty)': { ok: false },
  'remember_host_token': { ok: true },
  'host_status (registered)': { ok: true, value: { registered: true, label: 'ipc-check-machine' } },
  'forget_host_token': { ok: true },
  'host_status (forgotten)': { ok: true, value: { registered: false } },
  'fleet_status': { ok: true, value: { state: 'stopped' } },
  // Nothing has run, so there is nothing to have said.
  'fleet_logs': { ok: true, value: [] },
  'repos_dir': { ok: true },
  // The seeded checkout only exists in the *stored* directory, so finding it
  // proves the host is using that rather than the default.
  'list_repos': { ok: true, value: [{ name: 'a-checkout', git: true }] },
  'opens_at_login': { ok: true, value: false },
  'stop_fleet (nothing running)': { ok: false },
  // The token was just forgotten, so this must refuse rather than start a
  // harness with no credential — which would fail later and less clearly.
  'start_fleet (unregistered)': { ok: false },
  'confirm_backup (junk token)': { ok: false },
  'export_backup': { ok: true },
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
  'can_wipe (final)': { ok: true, value: true },
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
  } else if ('value' in expected && !matches(entry.value, expected.value)) {
    verdict = false;
    why = `expected ${JSON.stringify(expected.value)}`;
  }

  const detail = entry.ok ? shown : `refused (${entry.error})`;
  console.log(`  ${verdict ? 'ok  ' : 'FAIL'} ${entry.cmd} -> ${detail}${why ? ` — ${why}` : ''}`);
  if (!verdict) failed = true;
}

/**
 * Does the answer match what was expected?
 *
 * A plain object expectation is checked key by key rather than whole, so a
 * result carrying machine-specific detail (a hostname, a path) can still be
 * pinned on the part that is actually invariant. Anything else is compared
 * outright.
 */
function matches(actual, expected) {
  const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isPlainObject(expected) || !isPlainObject(actual)) {
    return JSON.stringify(actual) === JSON.stringify(expected);
  }
  return Object.entries(expected).every(
    ([key, want]) => JSON.stringify(actual[key]) === JSON.stringify(want),
  );
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
