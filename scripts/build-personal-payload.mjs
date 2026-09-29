/**
 * Assemble the personal office's payload: the production server, the built web
 * app, and everything either needs at runtime, as one relocatable directory.
 *
 *   node scripts/build-personal-payload.mjs [target-triple] [--skip-smoke | --smoke-only]
 *
 * The desktop app starts a private copy of the existing server for a personal
 * office — no Docker, no terminal, no server address. That server is a Node
 * program with a dependency tree, and `apps/server` boots Next.js from
 * `apps/web` in the same process, so the thing to ship is the *closure* of
 * both: what `pnpm install --prod` leaves behind in the Docker image, minus
 * anything only a build needs.
 *
 * How it is built, and why each step exists:
 *
 * - `pnpm deploy` of `@quintal/personal-payload`, a workspace package whose
 *   only job is to depend on the server and the web app. Deploying that one
 *   package yields the union of both dependency trees, exactly as the
 *   lockfile pins them. With `node-linker=hoisted` the result is a flat
 *   `node_modules` of real files: no symlinks into a store, so the tree can
 *   be copied into an app bundle and code-signed as ordinary files, and one
 *   copy of every module, so the server's `next` and the web app's `next` are
 *   the same module instance — which they must be, or React hooks break
 *   across the two halves of one process.
 *
 * - `next.config.ts` is compiled to `next.config.mjs`. Left as TypeScript,
 *   Next transpiles it at startup with `typescript` *and* the native SWC
 *   binary, and when either is missing it downloads them into the tree at
 *   runtime. A bundled app must never do that. Compiling the config once here
 *   is what lets both — ~150MB — stay out of the payload.
 *
 * - Platform-specific native packages are swapped for the target's. pnpm
 *   installs the optional dependencies for the machine it runs on, and the
 *   release matrix builds Intel macOS on Apple Silicon. Each swapped package
 *   is fetched from the registry at the version and integrity the lockfile
 *   pins, so a cross-build carries exactly what a native install would.
 *
 * - Sources, build configuration and dev leftovers are pruned, then Next's
 *   file traces retain only the web dependencies used at runtime. The custom
 *   server's untraced dependency closure (including Next) stays whole.
 *
 * - The result is booted once, on the bundled Node, and asked for its health,
 *   its login page and a sign-in challenge. A payload that does not start
 *   here is not shipped, which is the only proof of completeness that means
 *   anything: Next's dependency graph is not something to reason about by
 *   hand. The smoke also checks the tree was not written to, because the
 *   app installs it read-only and a signed bundle must not change.
 *
 * Deployment uses pnpm's dedicated lockfile mode. Its legacy hoisted mode
 * ignores the lockfile and can install versions different from the build's
 * traces. Injection is enabled for this command only; workspace config and
 * the workspace's installed dependencies are not changed.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { NODE_VERSION, hostTriple, runtimePath } from './fetch-node-runtime.mjs';
import { pruneFromTraces } from './prune-personal-payload.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PAYLOAD_DIR = join(root, 'apps/desktop/personal-payload');
const MODULES = join(PAYLOAD_DIR, 'node_modules');
const WEB = join(MODULES, '@quintal/web');
const SERVER = join(MODULES, '@quintal/server');
const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

const args = process.argv.slice(2);
const skipSmoke = args.includes('--skip-smoke');
const smokeOnly = args.includes('--smoke-only');
if (skipSmoke && smokeOnly) throw new Error('--skip-smoke and --smoke-only are mutually exclusive');
const triple = args.find((arg) => !arg.startsWith('--')) ?? hostTriple();

/**
 * Native packages that come in one flavour per platform.
 *
 * Each family is `<scope>/<prefix><flavour>`; the flavour installed here is
 * the host's, and the one the payload needs is the target's. Only families
 * that are actually in the tree are touched, and a family with no flavour
 * for the target (libvips on Windows, where sharp bundles it) is removed.
 */
const NATIVE_FAMILIES = [
  {
    scope: '@libsql',
    prefix: '',
    flavours: {
      'aarch64-apple-darwin': 'darwin-arm64',
      'x86_64-apple-darwin': 'darwin-x64',
      'x86_64-unknown-linux-gnu': 'linux-x64-gnu',
      'x86_64-pc-windows-msvc': 'win32-x64-msvc',
    },
  },
  {
    scope: '@img',
    prefix: 'sharp-',
    flavours: {
      'aarch64-apple-darwin': 'darwin-arm64',
      'x86_64-apple-darwin': 'darwin-x64',
      'x86_64-unknown-linux-gnu': 'linux-x64',
      'x86_64-pc-windows-msvc': 'win32-x64',
    },
  },
  {
    scope: '@img',
    prefix: 'sharp-libvips-',
    flavours: {
      'aarch64-apple-darwin': 'darwin-arm64',
      'x86_64-apple-darwin': 'darwin-x64',
      'x86_64-unknown-linux-gnu': 'linux-x64',
    },
  },
  {
    scope: '@msgpackr-extract',
    prefix: 'msgpackr-extract-',
    flavours: {
      'aarch64-apple-darwin': 'darwin-arm64',
      'x86_64-apple-darwin': 'darwin-x64',
      'x86_64-unknown-linux-gnu': 'linux-x64',
      'x86_64-pc-windows-msvc': 'win32-x64',
    },
  },
];

function run(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, {
    encoding: 'utf8',
    stdio: 'inherit',
    cwd: root,
    shell: process.platform === 'win32',
    ...options,
  });
}

function log(message) {
  console.log(`[payload] ${message}`);
}

function requireBuilt(path, hint) {
  if (!existsSync(path)) {
    console.error(`Missing ${path}.\nRun: ${hint}`);
    process.exit(1);
  }
}

// --- 1. the closure --------------------------------------------------------

function deploy() {
  rmSync(PAYLOAD_DIR, { recursive: true, force: true });
  log(`deploying @quintal/personal-payload into ${relative(root, PAYLOAD_DIR)}`);
  run(
    PNPM,
    [
      '--filter',
      '@quintal/personal-payload',
      'deploy',
      '--config.inject-workspace-packages=true',
      '--prod',
      '--config.node-linker=hoisted',
      PAYLOAD_DIR,
    ],
    // pnpm asks before purging a modules directory unless it believes it is
    // in CI; there is nobody at a terminal to answer.
    { env: { ...process.env, CI: 'true' } },
  );
}

// --- 2. natives for the target ---------------------------------------------

/** `name@version` → integrity, from the lockfile. */
function lockedIntegrity(name, version) {
  const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
  const key = `  '${name}@${version}':\n`;
  const at = lock.indexOf(key);
  if (at === -1) throw new Error(`${name}@${version} is not in pnpm-lock.yaml`);
  const block = lock.slice(at, lock.indexOf('\n\n', at));
  const integrity = block.match(/integrity: ([^}\s]+)/)?.[1];
  if (!integrity) throw new Error(`${name}@${version} has no integrity in pnpm-lock.yaml`);
  return integrity;
}

function verifyIntegrity(bytes, integrity) {
  const [algorithm, expected] = integrity.split('-', 2);
  const actual = createHash(algorithm).update(bytes).digest('base64');
  if (actual !== expected) {
    throw new Error(`integrity mismatch: expected ${integrity}, got ${algorithm}-${actual}`);
  }
}

async function fetchPackage(name, version, into) {
  const integrity = lockedIntegrity(name, version);
  const basename = name.split('/').pop();
  const url = `https://registry.npmjs.org/${name}/-/${basename}-${version}.tgz`;
  log(`fetching ${name}@${version} for ${triple}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  verifyIntegrity(bytes, integrity);

  const scratch = mkdtempSync(join(tmpdir(), 'quintal-native-'));
  try {
    const tarball = join(scratch, 'package.tgz');
    writeFileSync(tarball, bytes);
    rmSync(into, { recursive: true, force: true });
    mkdirSync(into, { recursive: true });
    execFileSync('tar', ['-xzf', tarball, '--strip-components=1', '-C', into], { stdio: 'inherit' });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function swapNatives() {
  for (const family of NATIVE_FAMILIES) {
    const scopeDir = join(MODULES, family.scope);
    if (!existsSync(scopeDir)) continue;
    const known = Object.values(family.flavours);
    const present = readdirSync(scopeDir).filter((entry) => {
      if (!entry.startsWith(family.prefix)) return false;
      return known.includes(entry.slice(family.prefix.length));
    });
    if (present.length === 0) continue;

    const wanted = family.flavours[triple];
    const wantedName = wanted ? `${family.prefix}${wanted}` : null;
    // Every flavour of a family is published at one version; the host's copy
    // says which.
    const version = JSON.parse(readFileSync(join(scopeDir, present[0], 'package.json'), 'utf8')).version;

    for (const entry of present) {
      if (entry !== wantedName) {
        log(`dropping ${family.scope}/${entry} (not for ${triple})`);
        rmSync(join(scopeDir, entry), { recursive: true, force: true });
      }
    }
    if (wantedName && !present.includes(wantedName)) {
      await fetchPackage(`${family.scope}/${wantedName}`, version, join(scopeDir, wantedName));
    }
  }
}

// --- 3. pruning --------------------------------------------------------------

function keepOnly(dir, keep) {
  for (const entry of readdirSync(dir)) {
    if (!keep.includes(entry)) rmSync(join(dir, entry), { recursive: true, force: true });
  }
}

function compileNextConfig() {
  // The workspace's TypeScript, at build time only. `transpileModule` does
  // no type checking — `pnpm typecheck` already did — it just strips types
  // and leaves the imports as they are, which is all a config file needs.
  const tsPath = join(root, 'node_modules/typescript/lib/typescript.js');
  const { createRequire } = /** @type {any} */ (globalThis.process.getBuiltinModule('node:module'));
  const ts = createRequire(import.meta.url)(tsPath);
  const source = readFileSync(join(WEB, 'next.config.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: 'next.config.ts',
  });
  writeFileSync(
    join(WEB, 'next.config.mjs'),
    `// Compiled from apps/web/next.config.ts by scripts/build-personal-payload.mjs.\n` +
      `// Shipped compiled so the personal office needs neither TypeScript nor SWC at runtime.\n` +
      outputText,
  );
}

function prune() {
  log('pruning sources, build tooling and caches');

  // The dedicated deploy lockfile and manifest contain absolute workspace
  // paths. They are build bookkeeping; restore the portable package manifest.
  keepOnly(PAYLOAD_DIR, ['node_modules', 'package.json']);
  cpSync(join(root, 'apps/personal-payload/package.json'), join(PAYLOAD_DIR, 'package.json'));

  // The web app: its build output and public assets, and nothing that made
  // them. `.next/cache` is the build's own scratch space — a third of a
  // gigabyte of webpack state the production server never reads.
  requireBuilt(join(WEB, '.next/BUILD_ID'), 'pnpm build');
  compileNextConfig();
  keepOnly(WEB, ['.next', 'public', 'package.json', 'next.config.mjs', 'node_modules']);
  rmSync(join(WEB, '.next/cache'), { recursive: true, force: true });

  // The server: compiled output only.
  requireBuilt(join(SERVER, 'dist/index.js'), 'pnpm build');
  keepOnly(SERVER, ['dist', 'package.json', 'node_modules']);

  // Build-time only, given the compiled config above. Both would otherwise
  // be re-downloaded by Next at runtime if absent, which the smoke below
  // would catch — see the header.
  for (const entry of readdirSync(join(MODULES, '@next'))) {
    if (entry.startsWith('swc-')) rmSync(join(MODULES, '@next', entry), { recursive: true, force: true });
  }
  rmSync(join(MODULES, 'typescript'), { recursive: true, force: true });

  // pnpm's bookkeeping and shim directories: symlinks and state files that
  // mean nothing outside a pnpm-managed tree.
  for (const entry of readdirSync(MODULES)) {
    if (entry.startsWith('.')) rmSync(join(MODULES, entry), { recursive: true, force: true });
  }
  for (const scoped of walkDirs(MODULES, 3)) {
    const bin = join(scoped, 'node_modules/.bin');
    if (existsSync(bin)) rmSync(bin, { recursive: true, force: true });
  }
}

function* walkDirs(dir, depth) {
  if (depth === 0) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    yield path;
    yield* walkDirs(path, depth - 1);
  }
}

// --- 4. the manifest ----------------------------------------------------------

function* walkFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(path);
    else if (entry.isFile()) yield path;
  }
}

function measure() {
  let files = 0;
  let bytes = 0;
  const byPackage = new Map();
  for (const path of walkFiles(PAYLOAD_DIR)) {
    const size = statSync(path).size;
    files += 1;
    bytes += size;
    const rel = relative(MODULES, path).split(/[\\/]/);
    const name = rel[0]?.startsWith('@') ? `${rel[0]}/${rel[1]}` : rel[0];
    if (name && !rel[0]?.startsWith('..')) byPackage.set(name, (byPackage.get(name) ?? 0) + size);
  }
  const largest = [...byPackage.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, size]) => ({ name, mb: Number((size / 1024 / 1024).toFixed(1)) }));
  return { files, bytes, largest };
}

function writeManifest(size, pruning) {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const manifest = {
    version,
    node: NODE_VERSION,
    target: triple,
    entry: 'node_modules/@quintal/server/dist/index.js',
    webDir: 'node_modules/@quintal/web',
    files: size.files,
    bytes: size.bytes,
    largest: size.largest,
    pruning,
    builtAt: new Date().toISOString(),
  };
  writeFileSync(join(PAYLOAD_DIR, 'payload.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

// --- 5. the proof -------------------------------------------------------------

function nodeBinaryFor(target) {
  const bundled = runtimePath(target);
  if (existsSync(bundled)) return bundled;
  console.warn(
    `[payload] no bundled Node at ${bundled}; smoking with the system node instead.\n` +
      `          Run node scripts/fetch-node-runtime.mjs to prove it on the runtime that ships.`,
  );
  return process.execPath;
}

function canRunHere(target) {
  const host = hostTriple();
  return target === host || (host === 'aarch64-apple-darwin' && target === 'x86_64-apple-darwin');
}

function freePort() {
  // Ask the OS, then release it: the server rebinds moments later. Never
  // 3000, which is reserved on developer machines, and never below 1024.
  const net = process.getBuiltinModule('node:net');
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => (port === 3000 ? freePort().then(resolvePort, reject) : resolvePort(port)));
    });
    server.on('error', reject);
  });
}

async function smoke(manifest) {
  if (!canRunHere(triple)) {
    console.warn(`[payload] cannot run a ${triple} payload on this machine; skipping the smoke.`);
    return { smoke: 'skipped' };
  }
  const node = nodeBinaryFor(triple);
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const { buildAuthPayload, generateSecretKey, getPublicKeyHex, signAuthPayload } =
    await import(pathToFileURL(join(root, 'packages/shared/dist/index.js')).href);
  const ownerKey = generateSecretKey();
  const pubkey = getPublicKeyHex(ownerKey);
  const before = snapshot();
  // Beside the payload, not in the OS temp directory, and specifically so the
  // two share a volume. Next resolves its project directory with
  // `path.relative(process.cwd(), dir)` (next/dist/server/next.js), and on
  // Windows two different drives have no relative path between them — so it
  // hands back the absolute `D:\\…` target, which is then joined onto the cwd
  // again. The payload booted from a `C:` temp directory with the repo on `D:`
  // went looking for
  // `C:\\…\\smoke\\D:\\…\\web\\D:\\…\\web\\.next\\routes-manifest.json`
  // and died. POSIX always has a relative path between two absolute paths,
  // which is why only Windows ever saw this.
  const smokeRoot = join(root, 'apps/desktop/src-tauri/target/payload-smoke');
  mkdirSync(smokeRoot, { recursive: true });
  const data = mkdtempSync(join(smokeRoot, 'run-'));

  log(`booting the payload on ${origin} with ${relative(root, node) || node}`);
  const child = spawn(node, [join(PAYLOAD_DIR, manifest.entry)], {
    cwd: data,
    env: {
      // A curated environment, the way the app spawns it: nothing from this
      // shell about where a database lives may reach the child.
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      NODE_ENV: 'production',
      NEXT_TELEMETRY_DISABLED: '1',
      HOST: '127.0.0.1',
      PORT: String(port),
      QUINTAL_DATA_ROOT: data,
      DATABASE_URL: `file:${join(data, 'quintal.db')}`,
      STORAGE_URL: `file:${join(data, 'objects')}`,
      STORAGE_ALLOW_LOCAL: '1',
      BETTER_AUTH_URL: origin,
      BETTER_AUTH_SECRET: 'smoke-only-secret-that-is-at-least-thirty-two-characters',
      QUINTAL_WEB_DIR: join(PAYLOAD_DIR, manifest.webDir),
      QUINTAL_PERSONAL_OWNER: pubkey,
      // The app holds the server's stdin open and expects it to stop when
      // the pipe closes. Proven below by closing it, instead of a signal.
      QUINTAL_EXIT_WITH_PARENT: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));

  const started = Date.now();
  try {
    let health = null;
    while (Date.now() - started < 90_000) {
      if (child.exitCode !== null) throw new Error(`the server exited with ${child.exitCode} before answering`);
      health = await fetch(`${origin}/health`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (health) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!health) throw new Error('the server never answered /health');
    const readyMs = Date.now() - started;

    const login = await fetch(`${origin}/login`);
    if (login.status !== 200) throw new Error(`/login answered ${login.status}`);
    const office = await fetch(`${origin}/api/office`).then((r) => r.json());
    if (office.personal !== true) throw new Error(`/api/office did not report a personal office: ${JSON.stringify(office)}`);
    const challenge = await fetch(`${origin}/api/auth/challenge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pubkey }),
    }).then((r) => r.json());
    if (challenge.origin !== origin) throw new Error(`challenge bound to ${challenge.origin}, not ${origin}`);

    const authPayload = buildAuthPayload({ origin, nonce: challenge.nonce, timestamp: Math.floor(Date.now() / 1000) });
    const signedIn = await fetch(`${origin}/api/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pubkey, sig: signAuthPayload(ownerKey, authPayload), payload: authPayload }),
    });
    const cookie = signedIn.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
    if (signedIn.status !== 200 || !cookie) throw new Error(`owner sign-in failed: HTTP ${signedIn.status}`);

    // A real 128×128 PNG: exercise storage and the user row through the same
    // upload/read routes as the profile screen, not an unauthenticated 401.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAABL0lEQVR4nO3SIQEAIBDAwI9DJiJSEmIgduL8xGadfema3wEYAANgAAyAATAABsAAGAADYAAMgAEwAAbAABgAA2AADIABMAAGwAAYAANgAAyAATAABsAAGAADYAAMgAEwAAbAABgAA2CAOAPEGSDOAHEGiDNAnAHiDBBngDgDxBkgzgBxBogzQJwB4gwQZ4A4A8QZIM4AcQaIM0CcAeIMEGeAOAPEGSDOAHEGiDNAnAHiDBBngDgDxBkgzgBxBogzQJwB4gwQZ4A4A8QZIM4AcQaIM0CcAeIMEGeAOAPEGSDOAHEGiDNAnAHiDBBngDgDxBkgzgBxBogzQJwB4gwQZ4A4A8QZIM4AcQaIM0CcAeIMEGeAOAPEGSDOAHEGiDNAnAHiDBBngDgDxBkgzgBxD0HTyBdO7xLBAAAAAElFTkSuQmCC',
      'base64',
    );
    const upload = await fetch(`${origin}/api/avatar`, {
      method: 'POST', headers: { cookie, 'content-type': 'image/png' }, body: png,
    });
    const avatar = await upload.json();
    if (upload.status !== 201 || !avatar.url?.startsWith('/api/objects/avatars/')) {
      throw new Error(`avatar upload failed: HTTP ${upload.status}: ${JSON.stringify(avatar)}`);
    }
    const profile = await fetch(`${origin}/settings/profile`, { headers: { cookie }, redirect: 'manual' });
    const html = await profile.text();
    if (profile.status !== 200 || !html.includes('brand-mark') || !html.includes(avatar.url)) {
      throw new Error(`profile did not render its icon and avatar: HTTP ${profile.status}`);
    }
    const icon = await fetch(`${origin}/brand/quintal-mark-small.png`);
    if (icon.status !== 200 || icon.headers.get('content-type') !== 'image/png' || (await icon.arrayBuffer()).byteLength === 0) {
      throw new Error(`brand icon failed: HTTP ${icon.status}`);
    }
    const object = await fetch(`${origin}${avatar.url}`, { headers: { cookie } });
    if (object.status !== 200 || object.headers.get('content-type') !== 'image/png' || !Buffer.from(await object.arrayBuffer()).equals(png)) {
      throw new Error(`avatar object did not round-trip: HTTP ${object.status}`);
    }
    log('/settings/profile 200 with brand icon and avatar; icon 200; /api/avatar 201; avatar object 200 (bytes match)');

    if (/Downloading|Installing/.test(output)) {
      throw new Error(`the server tried to fetch something at runtime:\n${output}`);
    }

    const rss = process.platform === 'win32' ? null : Number(execFileSync('ps', ['-o', 'rss=', '-p', String(child.pid)], { encoding: 'utf8' }).trim());

    // Not a signal: the pipe. This is how the server learns the app has
    // gone when the app died without running a handler, so it is the exit
    // path worth proving.
    child.stdin.end();
    const exited = await new Promise((r) => {
      const timer = setTimeout(() => r(false), 10_000);
      child.once('exit', () => {
        clearTimeout(timer);
        r(true);
      });
    });
    if (!exited) {
      child.kill('SIGKILL');
      throw new Error('the server did not stop within 10s of its stdin closing');
    }

    const after = snapshot();
    const changed = [...after.entries()].filter(([path, stamp]) => before.get(path) !== stamp);
    const deleted = [...before.keys()].filter((path) => !after.has(path));
    if (changed.length > 0 || deleted.length > 0) {
      throw new Error(
        `the server wrote into its own payload, which ships read-only:\n${[...changed.map(([p]) => p), ...deleted].slice(0, 20).join('\n')}`,
      );
    }
    log(`ready in ${readyMs}ms; /login 200; personal office; challenge bound to ${origin}` + (rss ? `; RSS ${(rss / 1024).toFixed(0)}MB idle` : '') + '; stopped on stdin EOF');
    return { smoke: 'passed', readyMs, rssMb: rss ? Number((rss / 1024).toFixed(0)) : null };
  } catch (error) {
    if (child.exitCode === null) child.kill('SIGKILL');
    console.error(output);
    throw error;
  } finally {
    // Windows holds files open a moment after the process exits, so a plain
    // rmSync throws EBUSY from the `finally` and replaces whatever actually
    // went wrong. Retry, then give up quietly: a leftover directory under
    // `target/` is not worth losing the real error over.
    try {
      rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      console.error(`[payload] could not remove ${data}: ${error.message}`);
    }
  }
}

/** Every file in the payload with its size and mtime, to prove nothing moved. */
function snapshot() {
  const seen = new Map();
  for (const path of walkFiles(PAYLOAD_DIR)) {
    const stat = statSync(path);
    seen.set(relative(PAYLOAD_DIR, path), `${stat.size}:${stat.mtimeMs}`);
  }
  return seen;
}

// --- main ---------------------------------------------------------------------

if (smokeOnly) {
  const manifest = JSON.parse(readFileSync(join(PAYLOAD_DIR, 'payload.json'), 'utf8'));
  if (manifest.target !== triple || !canRunHere(triple)) throw new Error('Smoke target must match the payload and be runnable on this host');
  await smoke(manifest);
  log('existing payload proof passed (payload not rebuilt or modified)');
  process.exit(0);
}

requireBuilt(join(root, 'apps/web/.next/BUILD_ID'), 'pnpm build');
requireBuilt(join(root, 'apps/server/dist/index.js'), 'pnpm build');
requireBuilt(join(root, 'packages/shared/dist/index.js'), 'pnpm build');

deploy();
await swapNatives();
prune();
const pruning = pruneFromTraces({
  webSource: join(root, 'apps/web'),
  modules: MODULES,
  nativePackages: NATIVE_FAMILIES.flatMap((family) =>
    Object.values(family.flavours).map((flavour) => `${family.scope}/${family.prefix}${flavour}`)),
});
log(`Next traces removed ${pruning.removedFiles} files, ${(pruning.removedBytes / 1024 / 1024).toFixed(1)}MB`);
const size = measure();
const manifest = writeManifest(size, pruning);
log(`${size.files} files, ${(size.bytes / 1024 / 1024).toFixed(0)}MB for ${triple}`);
for (const { name, mb } of size.largest) log(`  ${mb.toString().padStart(6)}MB  ${name}`);

const proof = skipSmoke ? { smoke: 'skipped' } : await smoke(manifest);
writeFileSync(
  join(PAYLOAD_DIR, 'payload.json'),
  `${JSON.stringify({ ...manifest, ...proof }, null, 2)}\n`,
);
log(`wrote ${relative(root, join(PAYLOAD_DIR, 'payload.json'))} (${proof.smoke})`);
