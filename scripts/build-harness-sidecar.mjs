/**
 * Compile the harness into the desktop bundle.
 *
 * The app spawns `quintal-acp` to run your agents, and until now it looked for
 * it on PATH — which works from a repo checkout and nowhere else. A bundled app
 * launched from Finder has neither the repo's `node_modules/.bin` nor, on a
 * stock macOS, node itself. So the app shipped without the one thing it spawns.
 *
 * Tauri calls this an external binary: the file lands beside the app's own
 * executable inside `Quintal.app`, and `spawn::harness_path` looks there first.
 * It has to be a real executable, per target triple — hence compiling rather
 * than shipping a script and hoping for a runtime.
 *
 *   node scripts/build-harness-sidecar.mjs
 *
 * Uses `bun build --compile`, which embeds a runtime, so the result needs
 * nothing installed. That makes bun a *build* dependency for producing a
 * bundle; it is not needed to run the app, to develop against it, or in CI,
 * which never bundles.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'apps/desktop/src-tauri/binaries');
const entry = join(root, 'packages/acp-harness/dist/cli.js');

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', ...options });
}

function targetTriple() {
  // The name Tauri expects on the end of the file. Taken from rustc rather than
  // guessed from `process.arch`, so the sidecar and the host binary can never
  // disagree about what machine they are for.
  const shown = run('rustc', ['-vV']);
  const host = shown.split('\n').find((line) => line.startsWith('host:'));
  if (!host) throw new Error('rustc did not report a host triple');
  return host.slice('host:'.length).trim();
}

if (!existsSync(entry)) {
  console.error(
    `No harness build at ${entry}.\nRun: pnpm --filter quintal-acp build`,
  );
  process.exit(1);
}

try {
  run('bun', ['--version']);
} catch {
  console.error(
    'bun is needed to compile the harness into the bundle: https://bun.sh\n' +
      'It is a build dependency only — running Quintal, developing it, and CI do not need it.',
  );
  process.exit(1);
}

const triple = targetTriple();
const outFile = join(outDir, `quintal-acp-${triple}`);
mkdirSync(outDir, { recursive: true });

console.log(`Compiling the harness for ${triple}`);
run('bun', ['build', '--compile', '--minify', '--target=bun', entry, '--outfile', outFile], {
  stdio: 'inherit',
});

// Prove it starts with nothing on PATH. The whole point is a binary that needs
// no runtime installed, and that is exactly the assumption a bundle breaks.
const proof = run(outFile, ['--help'], {
  env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '' },
});
if (!proof.includes('quintal-acp')) {
  console.error('The compiled harness did not answer --help. Not shipping it.');
  process.exit(1);
}

const mb = (statSync(outFile).size / 1024 / 1024).toFixed(0);
console.log(`\n${outFile}\n  ${mb}MB, runs with no runtime installed.`);
