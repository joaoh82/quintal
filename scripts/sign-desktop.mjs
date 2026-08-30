/**
 * Give the desktop app a stable code identity on macOS.
 *
 * The keychain prompt every launch is not a bug in key custody — it is what an
 * ad-hoc signature means. `cargo build` signs ad-hoc, and an ad-hoc signature's
 * designated requirement is the code hash itself, so every rebuild is a
 * *different program* as far as macOS is concerned. "Always Allow" grants
 * access to a program that ceases to exist the moment you change a line.
 *
 * Signing with a real certificate replaces that requirement with one that does
 * not move:
 *
 *   identifier "sh.quintal.desktop" and anchor apple generic
 *     and certificate leaf[subject.CN] = "Apple Development: …"
 *
 * The identifier is forced to the bundle's, so the debug binary and the bundled
 * app satisfy the *same* requirement and share one keychain grant.
 *
 *   node scripts/sign-desktop.mjs [path-to-binary]
 *
 * Identity comes from QUINTAL_SIGNING_IDENTITY or APPLE_SIGNING_IDENTITY, or —
 * when exactly one codesigning identity exists — that one, named out loud
 * rather than chosen silently.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { resolveIdentity } from './signing-identity.mjs';

function identity() {
  const { identity: chosen, problem } = resolveIdentity();
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  return chosen;
}

const BUNDLE_ID = 'sh.quintal.desktop';
const DEFAULT_BINARY = 'apps/desktop/src-tauri/target/debug/quintal-desktop';

if (process.platform !== 'darwin') {
  console.log('Not macOS — nothing to sign.');
  process.exit(0);
}

// Prints the chosen certificate, for looking it up by hand. Nothing builds on
// it: a shell substitution that fails still assigns an empty string and lets
// the build carry on, which is how a clear message became `Signing with
// identity ""` several screens later.
if (process.argv.includes('--print-identity')) {
  process.stdout.write(identity());
  process.exit(0);
}

const binary = resolve(process.argv[2] ?? DEFAULT_BINARY);
if (!existsSync(binary)) {
  console.error(
    `Nothing at ${binary}.\nBuild it first: cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml`,
  );
  process.exit(1);
}

const chosen = identity();
console.log(`Signing ${binary}\n  as ${chosen}\n  identifier ${BUNDLE_ID}`);

execFileSync(
  'codesign',
  ['--force', '--sign', chosen, '--identifier', BUNDLE_ID, binary],
  { stdio: 'inherit' },
);

const requirement = execFileSync('codesign', ['-d', '--requirements', '-', binary], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
const designated = requirement
  .split('\n')
  .find((line) => line.startsWith('designated =>'));

console.log(`\n${designated ?? '(no designated requirement reported)'}`);
console.log(
  '\nThat requirement does not change when you rebuild, so "Always Allow" will stick.\n' +
    'A rebuild replaces the signature — re-run this, or use the bundled app (pnpm desktop:bundle).',
);
