/**
 * Fetch the Node runtime the personal office runs on.
 *
 * A personal office is the existing production server — `apps/server`, Next.js
 * and Colyseus in one Node process — started and supervised by the desktop
 * app. Somebody installing the app has no Node, and must not need one, so the
 * app carries its own: the official build from nodejs.org, pinned to one exact
 * version and one exact checksum per platform, placed beside the app's own
 * executable as a Tauri external binary named `quintal-node`.
 *
 *   node scripts/fetch-node-runtime.mjs [target-triple]
 *
 * Pinned rather than "latest" for the same reason the harness is compiled
 * rather than fetched: a bundle has to be reproducible, and a build that
 * downloads whatever is current is one that changes under you. Bumping the
 * runtime is an edit to `NODE_VERSION` and `CHECKSUMS` below, reviewed like
 * any other dependency. `NODE_VERSION` tracks the major the Docker image
 * uses (see `ARG NODE_VERSION` in the Dockerfile) so the two ways of running
 * the server never test different runtimes.
 *
 * The archive is cached under the Rust target directory, which is already
 * ignored by git, so a rebuild does not re-download 30MB. Only `bin/node` is
 * extracted: the rest of the tarball is npm and headers, which the app has
 * no use for.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The runtime the personal office ships with. Bump deliberately, with the checksums. */
export const NODE_VERSION = '22.23.3';

/**
 * SHA-256 of each archive, from `SHASUMS256.txt` of that release. Verified
 * before anything is extracted, so a substituted download fails here rather
 * than becoming the thing every personal office runs on.
 */
const CHECKSUMS = {
  'node-v22.23.3-darwin-arm64.tar.gz': '23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53',
  'node-v22.23.3-darwin-x64.tar.gz': '8a677b0219178efd6eb0e475457c4afb452b521a92f6e67845a73bd85727f2a8',
  'node-v22.23.3-linux-x64.tar.gz': '1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af',
  'node-v22.23.3-win-x64.zip': '2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71',
};

/** Rust target triple → the nodejs.org artifact name for it. */
const ARTIFACTS = {
  'aarch64-apple-darwin': { archive: 'darwin-arm64.tar.gz', binary: 'bin/node' },
  'x86_64-apple-darwin': { archive: 'darwin-x64.tar.gz', binary: 'bin/node' },
  'x86_64-unknown-linux-gnu': { archive: 'linux-x64.tar.gz', binary: 'bin/node' },
  'x86_64-pc-windows-msvc': { archive: 'win-x64.zip', binary: 'node.exe' },
};

export const BINARIES_DIR = join(root, 'apps/desktop/src-tauri/binaries');
const CACHE_DIR = join(root, 'apps/desktop/src-tauri/target/node-runtime');

export function hostTriple() {
  // From rustc rather than `process.arch`, so this binary and the host binary
  // can never disagree about what machine they are for — the same rule the
  // harness sidecar follows.
  const shown = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
  const host = shown.split('\n').find((line) => line.startsWith('host:'));
  if (!host) throw new Error('rustc did not report a host triple');
  return host.slice('host:'.length).trim();
}

/** Where the runtime for a triple lands, in the name Tauri expects. */
export function runtimePath(triple) {
  return join(BINARIES_DIR, `quintal-node-${triple}${triple.includes('windows') ? '.exe' : ''}`);
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function download(url, to) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  const partial = `${to}.partial`;
  writeFileSync(partial, Buffer.from(await response.arrayBuffer()));
  renameSync(partial, to);
}

/**
 * Make sure the runtime for `triple` is in place, fetching it if needed.
 * Returns its path.
 */
/**
 * Pull one member out of `archiveName` into `extractedName`, both named
 * relatively and resolved against CACHE_DIR.
 *
 * Relative names are not tidiness. An absolute Windows path reaches bsdtar as
 * `D:\a\...`, and to it anything whose first colon precedes its first slash
 * is a remote `host:path` — v0.6.0's Windows job died on `tar: Cannot connect
 * to D: resolve failed`. bsdtar has no GNU `--force-local` to turn that off,
 * and forward slashes do not help because the colon still comes first.
 *
 * Which `tar` also matters. The Windows job runs under Git Bash, whose PATH
 * finds MSYS **GNU** tar first, and GNU tar cannot read a zip — v0.6.1 died on
 * `tar: This does not look like a tar archive`. Windows does ship bsdtar, in
 * System32, so name it outright rather than trusting PATH. If it is somehow
 * absent, PowerShell expands the zip instead; it costs the whole archive
 * rather than one member, which on a runner is a second or two.
 */
function extractMember(archiveName, extractedName, member) {
  const run = (file, args) => execFileSync(file, args, { stdio: 'inherit', cwd: CACHE_DIR });
  if (process.platform !== 'win32') {
    run('tar', ['-xf', archiveName, '-C', extractedName, member]);
    return;
  }
  const bsdtar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  if (existsSync(bsdtar)) {
    run(bsdtar, ['-xf', archiveName, '-C', extractedName, member]);
    return;
  }
  run('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath '${archiveName}' -DestinationPath '${extractedName}' -Force`,
  ]);
}

export async function ensureNodeRuntime(triple, { log = console.log } = {}) {
  const spec = ARTIFACTS[triple];
  if (!spec) throw new Error(`No Node runtime is defined for ${triple}`);
  const archiveName = `node-v${NODE_VERSION}-${spec.archive}`;
  const expected = CHECKSUMS[archiveName];
  if (!expected) throw new Error(`No pinned checksum for ${archiveName}; add it to CHECKSUMS`);

  const out = runtimePath(triple);
  const stamp = `${out}.version`;
  if (existsSync(out) && existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === NODE_VERSION) {
    log(`Node ${NODE_VERSION} for ${triple} already at ${out}`);
    return out;
  }

  mkdirSync(CACHE_DIR, { recursive: true });
  mkdirSync(BINARIES_DIR, { recursive: true });
  const archive = join(CACHE_DIR, archiveName);
  if (!existsSync(archive) || sha256(archive) !== expected) {
    const url = `https://nodejs.org/dist/v${NODE_VERSION}/${archiveName}`;
    log(`Fetching ${url}`);
    await download(url, archive);
  }
  const actual = sha256(archive);
  if (actual !== expected) {
    throw new Error(
      `${archiveName} does not match its pinned checksum.\n  expected ${expected}\n  got      ${actual}\nNot extracting it.`,
    );
  }

  const member = `node-v${NODE_VERSION}-${spec.archive.replace(/\.(tar\.gz|zip)$/, '')}/${spec.binary}`;
  const extractedName = `extract-${triple}`;
  const extracted = join(CACHE_DIR, extractedName);
  mkdirSync(extracted, { recursive: true });
  extractMember(archiveName, extractedName, member);
  const binary = join(extracted, member);
  if (!existsSync(binary)) throw new Error(`${member} was not in ${archiveName}`);

  renameSync(binary, out);
  chmodSync(out, 0o755);
  writeFileSync(stamp, `${NODE_VERSION}\n`);

  const mb = (statSync(out).size / 1024 / 1024).toFixed(0);
  log(`Node ${NODE_VERSION} for ${triple}: ${out} (${mb}MB)`);
  return out;
}

/**
 * Prove the runtime starts and is the version it claims, with only OS
 * directories on PATH — the environment a Finder launch actually gets.
 */
export function proveNodeRuntime(path, { log = console.log } = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'),
  );
  env.PATH = process.platform === 'win32'
    ? `${join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')};${process.env.SystemRoot ?? 'C:\\Windows'}`
    : '/usr/bin:/bin';
  const reported = execFileSync(path, ['--version'], { encoding: 'utf8', env }).trim();
  if (reported !== `v${NODE_VERSION}`) {
    throw new Error(`${path} reports ${reported}, not v${NODE_VERSION}. Not shipping it.`);
  }
  log(`${path} answers --version with ${reported} and no PATH to lean on.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const triple = process.argv[2] ?? hostTriple();
  const path = await ensureNodeRuntime(triple);
  const host = hostTriple();
  // The one cross-build is Intel macOS on Apple Silicon, where Rosetta runs
  // the proof — the same allowance the harness sidecar makes.
  if (triple === host || (host === 'aarch64-apple-darwin' && triple === 'x86_64-apple-darwin')) {
    proveNodeRuntime(path);
  } else {
    console.log(`Cannot run a ${triple} binary here; skipping the proof.`);
  }
}
