/**
 * Build the signed desktop bundle.
 *
 * A script rather than a shell line, because the shell line was wrong in a way
 * that only showed up once somebody had two certificates:
 *
 *     APPLE_SIGNING_IDENTITY="$(node scripts/sign-desktop.mjs --print-identity)" tauri build
 *
 * When the substitution fails, the assignment still happens — with an empty
 * value — and the build carries on to `Signing with identity ""` and a
 * `no identity found` from codesign, several screens after the message that
 * actually explained the problem. A failing step has to stop the build.
 */
import { execFileSync } from 'node:child_process';

import { resolveIdentity } from './signing-identity.mjs';

if (process.platform !== 'darwin') {
  console.error('Bundling with a signature is macOS-only for now.');
  process.exit(1);
}

const { identity, problem } = resolveIdentity();
if (problem) {
  console.error(problem);
  process.exit(1);
}

console.log(`Signing as ${identity}`);
execFileSync(
  'pnpm',
  [
    '--filter',
    '@quintal/desktop',
    'exec',
    'tauri',
    'build',
    '--bundles',
    'app',
    '--config',
    'src-tauri/tauri.bundle.conf.json',
  ],
  { stdio: 'inherit', env: { ...process.env, APPLE_SIGNING_IDENTITY: identity } },
);
