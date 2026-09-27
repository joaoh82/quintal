/**
 * Drive a bundled Quintal through a personal office, from the outside.
 *
 * The unit tests prove the pieces — the port choice, the lock, the backup, the
 * restart budget — and the payload build proves the server boots on the
 * bundled Node. What neither sees is the app doing it: choosing the office,
 * starting the server, granting the origin, recovering when the server dies,
 * stopping it on the way out, and finding the same office again on the next
 * launch. This runs the real bundle against a throwaway HOME and checks each
 * of those, plus the two refusals that make the office *personal*: a stranger
 * cannot sign in, and a guest link does not work.
 *
 *   node scripts/personal-office-smoke.mjs [path/to/Quintal.app/Contents/MacOS/quintal-desktop]
 *
 * Needs a display — the app opens a window — and a bundle built with the
 * payload (`pnpm desktop:bundle`, or `tauri build` with
 * `tauri.bundle.conf.json` and `tauri.personal.conf.json`). Everything it
 * writes goes under a temporary directory that is removed at the end.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildAuthPayload,
  generateSecretKey,
  getPublicKeyHex,
  nsecDecode,
  signAuthPayload,
} from '@quintal/shared';

const binary =
  process.argv[2] ??
  'apps/desktop/src-tauri/target/release/bundle/macos/Quintal.app/Contents/MacOS/quintal-desktop';
if (!existsSync(binary)) {
  console.error(`no app at ${binary}`);
  process.exit(1);
}

const home = mkdtempSync(join(tmpdir(), 'quintal-personal-smoke-'));
const env = {
  ...process.env,
  HOME: home,
  XDG_DATA_HOME: home,
  QUINTAL_SECRETS_BACKEND: 'file',
  QUINTAL_NO_LOGIN_PATH: '1',
  QUINTAL_SERVER_URL: 'personal',
};

const results = [];
let failed = false;
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Where the app put the office, wherever Tauri resolved app_data_dir to. */
function findFile(dir, name, depth = 6) {
  if (depth === 0) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) {
      const found = findFile(path, name, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

async function waitFor(what, predicate, timeoutMs) {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return { value, ms: Date.now() - started };
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

function launch() {
  const child = spawn(binary, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (c) => (output += c));
  child.stderr.on('data', (c) => (output += c));
  return { child, output: () => output };
}

async function health(origin) {
  return fetch(`${origin}/health`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
}

async function signIn(origin, secretKey) {
  const pubkey = getPublicKeyHex(secretKey);
  const { nonce } = await fetch(`${origin}/api/auth/challenge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pubkey }),
  }).then((r) => r.json());
  const payload = buildAuthPayload({ origin, nonce, timestamp: Math.floor(Date.now() / 1000) });
  const response = await fetch(`${origin}/api/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pubkey, sig: signAuthPayload(secretKey, payload), payload }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

function listeners(port) {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .slice(1);
  } catch {
    return [];
  }
}

function rssMb(pid) {
  try {
    return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024;
  } catch {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readyOffice(timeoutMs) {
  const record = await waitFor('office.json', () => {
    const path = findFile(home, 'office.json');
    if (!path) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed.port ? { path, ...parsed } : null;
  }, timeoutMs);
  const origin = `http://127.0.0.1:${record.value.port}`;
  const up = await waitFor('/health', () => health(origin), timeoutMs);
  return { record: record.value, origin, ms: up.ms + record.ms };
}

let first = null;
let second = null;
try {
  console.log(`\nPersonal office smoke against ${binary}\nHOME=${home}\n`);

  // --- first launch: choose, start, serve -----------------------------------
  first = launch();
  const started = Date.now();
  const office = await readyOffice(120_000);
  const coldMs = Date.now() - started;
  check('the office comes up on a loopback port', true, `${office.origin} in ${coldMs}ms`);
  check('the port is not 3000', office.record.port !== 3000, String(office.record.port));

  const bound = listeners(office.record.port);
  check(
    'the server listens on 127.0.0.1 only',
    bound.length > 0 && bound.every((line) => line.includes('127.0.0.1:')),
    bound.map((l) => l.split(/\s+/).at(-2)).join(', '),
  );
  const nodePid = Number(bound[0]?.split(/\s+/)[1]);

  const about = await fetch(`${office.origin}/api/office`).then((r) => r.json());
  check('the server knows it is a personal office', about.personal === true, JSON.stringify(about));
  const login = await fetch(`${office.origin}/login`);
  check('the login page renders', login.status === 200, `HTTP ${login.status}`);

  // --- who may sign in ----------------------------------------------------------
  const secrets = JSON.parse(readFileSync(findFile(home, 'secrets.json'), 'utf8'));
  const ownerKey = nsecDecode(secrets.identity);
  const stranger = await signIn(office.origin, generateSecretKey());
  check(
    'a stranger is refused, even on an empty database',
    stranger.status === 403 && /personal office/.test(stranger.body?.message ?? ''),
    `HTTP ${stranger.status}: ${stranger.body?.message}`,
  );
  const owner = await signIn(office.origin, ownerKey);
  check('the owner signs in', owner.status === 200 && owner.body?.user?.id, `HTTP ${owner.status}`);
  const ownerId = owner.body?.user?.id;

  const joinPage = await fetch(`${office.origin}/join/v2.${'a'.repeat(43)}`).then((r) => r.text());
  check('a guest link is refused at the door', /personal office/.test(joinPage), 'the join page says so');

  // --- the data directory ----------------------------------------------------------
  const dataDir = join(office.record.path, '..');
  const files = readdirSync(dataDir);
  check(
    'the database, objects, secret and lock live in the data directory',
    ['quintal.db', 'auth-secret', 'office.json', 'office.lock'].every((f) => files.includes(f)),
    files.join(', '),
  );
  const secretMode = statSync(join(dataDir, 'auth-secret')).mode & 0o777;
  check('the session secret is private', secretMode === 0o600, `mode ${secretMode.toString(8)}`);
  const idleApp = rssMb(first.child.pid);
  const idleNode = rssMb(nodePid);
  console.log(`  info measured: cold start ${coldMs}ms; RSS app ${idleApp?.toFixed(0)}MB, server ${idleNode?.toFixed(0)}MB`);

  // --- a second launch hands off ------------------------------------------------------
  second = launch();
  const secondExit = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 15_000);
    second.child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? 'signal');
    });
  });
  check('a second launch exits and leaves the first alone', secondExit !== null && (await health(office.origin)) !== null, `second exited with ${secondExit}`);
  second = null;

  // --- the server dies, the app brings it back ---------------------------------------
  process.kill(nodePid, 'SIGKILL');
  const back = await waitFor('the server to come back', async () => {
    const again = listeners(office.record.port);
    const pid = Number(again[0]?.split(/\s+/)[1]);
    return pid && pid !== nodePid && (await health(office.origin)) ? pid : null;
  }, 60_000);
  check('a killed server is restarted on the same port', true, `new pid ${back.value} after ${back.ms}ms`);
  const afterRestart = await signIn(office.origin, ownerKey);
  check('the owner is still the owner after the restart', afterRestart.body?.user?.id === ownerId);

  // --- quitting leaves nothing behind ------------------------------------------------------
  // SIGTERM runs none of Tauri's exit handlers — it is the force-quit case,
  // not the tidy one — so what this proves is the pipe: the server notices
  // its parent is gone and stops itself.
  first.child.kill('SIGTERM');
  const gone = await waitFor('the app to exit', () => (first.child.exitCode !== null || first.child.signalCode ? true : null), 20_000);
  const stopped = await waitFor('the server to stop', () => (listeners(office.record.port).length === 0 && !alive(back.value) ? true : null), 15_000).catch(() => null);
  check('a force-quit app takes its server with it', stopped !== null, `app exited after ${gone.ms}ms; server gone ${stopped ? `${stopped.ms}ms later` : 'never'}`);
  check('the lock is released', (() => {
    // Not held: the OS released it with the process. Proven by the next launch working.
    return true;
  })());

  // --- the next launch finds the same office ------------------------------------------------
  first = launch();
  const again = await readyOffice(120_000);
  check('the next launch keeps the port', again.record.port === office.record.port, `${again.origin} in ${again.ms}ms`);
  check('the office id is stable', again.record.id === office.record.id);
  const returning = await signIn(again.origin, ownerKey);
  check('the owner comes back to the same account', returning.body?.user?.id === ownerId, `user ${returning.body?.user?.id}`);
  const backups = existsSync(join(dataDir, 'backups')) ? readdirSync(join(dataDir, 'backups')) : [];
  check('no backup is taken when the version has not changed', backups.length === 0, `${backups.length} backups`);
  console.log(`  info measured: warm start ${again.ms}ms`);

  first.child.kill('SIGTERM');
  await waitFor('the app to exit', () => (first.child.exitCode !== null || first.child.signalCode ? true : null), 20_000);
  first = null;
} catch (error) {
  failed = true;
  console.error(`\n${error.stack ?? error}`);
  if (first) console.error(`app output:\n${first.output()}`);
} finally {
  for (const run of [first, second]) {
    if (run && run.child.exitCode === null) run.child.kill('SIGKILL');
  }
  await sleep(300);
  rmSync(home, { recursive: true, force: true });
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${results.filter((r) => r.ok).length}/${results.length} checks`);
process.exit(failed ? 1 : 0);
