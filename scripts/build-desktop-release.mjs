import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { signPayload } from './sign-payload.mjs';

const [target, bundles, platform] = process.argv.slice(2);
if (!target || !bundles || !platform) throw new Error('Expected target, bundles, platform');
// Tauri's DMG bundler reads CI separately from the CLI's --ci flag.
const env = { ...process.env, CI: 'true' };
let signing = 'Unsigned';
if (process.platform === 'darwin') {
  const keys = ['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY', 'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID'];
  if (keys.every((key) => env[key])) {
    if (!env.APPLE_SIGNING_IDENTITY.startsWith('Developer ID Application:')) {
      throw new Error('Release signing requires a Developer ID Application identity');
    }
    signing = 'Developer ID signed and notarized';
  } else {
    for (const key of keys) delete env[key];
    // Sign ad hoc so embedded Bun receives the JIT entitlements even without
    // Developer ID credentials. This is still an unsigned download to Gatekeeper.
    env.APPLE_SIGNING_IDENTITY = '-';
    signing = 'UNSIGNED: no Developer ID signature or notarization (Apple secrets absent/incomplete)';
    console.log(`::warning::${platform}: ${signing}`);
  }
}
// Updater payloads are produced only when there is a key to sign them with.
//
// Not a nicety: once `plugins.updater.pubkey` is in the config, asking for
// updater artifacts without `TAURI_SIGNING_PRIVATE_KEY` makes the bundler exit
// with "A public key has been found, but no private key" — it does not skip
// them. That took the whole Linux packaging job down, on a workflow that has no
// business holding the production signing secret. Staging and collection treat
// the payloads as optional (see release-assets.mjs), but that code never runs
// if the bundler dies first, so the decision has to be made here.
const signsUpdates = Boolean(env.TAURI_SIGNING_PRIVATE_KEY);
const updaterConfig = signsUpdates ? ['--config', 'src-tauri/tauri.updater.conf.json'] : [];
const updates = signsUpdates
  ? 'Updater payloads signed'
  : 'NO updater payloads (no signing key): this build cannot publish an update manifest';
if (!signsUpdates) console.log(`::warning::${platform}: ${updates}`);

mkdirSync('stage', { recursive: true });
writeFileSync('stage/signing.txt', `${signing}\n`);
if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `## ${platform}\n**${signing}**\n\n${updates}\n`);
// On Windows, pnpm is a .cmd shim. All interpolated arguments below are fixed
// workflow matrix values, never tag or dispatch input.
// A failed AppImage bundle reports `failed to run linuxdeploy` and nothing
// else: Tauri keeps the tool's own stderr unless the CLI is verbose. Opt in
// per job rather than always, so release logs stay readable.
const verbose = env.QUINTAL_TAURI_VERBOSE === '1' ? ['--verbose'] : [];

// The personal office's payload must exist before anything is bundled: it is
// a resource of every bundle, and a release without it is an app whose
// first-launch "Create a personal office" button cannot work. Built by
// scripts/build-personal-payload.mjs, which also boots it once as proof.
const payloadManifest = 'apps/desktop/personal-payload/payload.json';
if (!existsSync(payloadManifest)) {
  throw new Error(`No personal office payload at ${payloadManifest}. Run: node scripts/build-personal-payload.mjs ${target}`);
}
const payload = JSON.parse(readFileSync(payloadManifest, 'utf8'));
if (payload.target !== target) {
  throw new Error(`The payload at ${payloadManifest} was built for ${payload.target}, not ${target}`);
}
if (payload.smoke !== 'passed' && payload.smoke !== 'skipped') {
  throw new Error(`The payload at ${payloadManifest} did not pass its smoke (${payload.smoke})`);
}
writeFileSync('stage/payload.txt', `${payload.files} files, ${(payload.bytes / 1024 / 1024).toFixed(0)}MB, Node ${payload.node}, smoke ${payload.smoke}\n`);

// On macOS the payload's native modules are signed with the app's identity
// before Tauri copies them into Resources: the hardened runtime will not let
// quintal-node load them otherwise, and notarization will not accept them.
if (process.platform === 'darwin') signPayload(env.APPLE_SIGNING_IDENTITY);

// `sidecar` decides whether externalBin and the personal payload are applied
// to this bundle — both are things linuxdeploy must not see, see below.
function build(bundleArg, sidecar) {
  execFileSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', [
    '--filter', '@quintal/desktop', 'exec', 'tauri', 'build', ...verbose, '--ci', '--target', target,
    '--bundles', bundleArg,
    ...(sidecar ? ['--config', 'src-tauri/tauri.bundle.conf.json', '--config', 'src-tauri/tauri.personal.conf.json'] : []),
    '--config', 'src-tauri/tauri.release.conf.json',
    ...updaterConfig, '--', '--locked',
  ], { env, stdio: 'inherit', shell: process.platform === 'win32' });
}

// linuxdeploy resolves dependencies for every ELF it finds in the AppDir. On
// the Bun-compiled harness its `ldd` call exits 1, which linuxdeploy raises as
// an uncaught std::runtime_error — it aborts, and the bundle dies reporting
// only `failed to run linuxdeploy`. So the AppImage is bundled *without*
// externalBin and fix-appimage.sh installs the harness into usr/bin during the
// repack it already performs. The personal office payload has the same problem
// — its native modules are ELF files linuxdeploy runs `ldd` over, and one of
// them exits 1 — so it is left out of the AppImage the same way and copied
// into usr/lib/Quintal/personal by the repack. Nothing else needs this: the
// deb bundler does not use linuxdeploy and keeps both the ordinary way.
//
// The AppImage goes first so the deb left in `bundle/deb` at the end is always
// the sidecar-carrying one, whatever Tauri does with its intermediate copy.
const requested = bundles.split(',');
const withoutAppimage = requested.filter((name) => name !== 'appimage');
if (requested.includes('appimage')) build('appimage', false);
if (withoutAppimage.length) build(withoutAppimage.join(','), true);

if (process.platform === 'darwin') {
  // A DMG-only build removes its intermediate .app. Verify the actual download.
  const directory = `apps/desktop/src-tauri/target/${target}/release/bundle/dmg`;
  const dmgs = readdirSync(directory).filter((name) => name.endsWith('.dmg'));
  if (dmgs.length !== 1) throw new Error(`Expected one DMG, found ${dmgs.length}`);
  const mount = mkdtempSync(join(tmpdir(), 'quintal-dmg-'));
  let mounted = false;
  try {
    execFileSync('hdiutil', ['attach', join(directory, dmgs[0]), '-readonly', '-nobrowse', '-mountpoint', mount], { stdio: 'inherit' });
    mounted = true;
    const app = join(mount, 'Quintal.app');
    const sidecar = join(app, 'Contents/MacOS/quintal-acp');
    const entitlements = execFileSync('codesign', ['-d', '--entitlements', ':-', sidecar], { encoding: 'utf8' });
    if (!/<key>com\.apple\.security\.cs\.allow-jit<\/key>\s*<true\s*\/>/.test(entitlements)) {
      throw new Error('Signed sidecar lost its JIT entitlement');
    }
    execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
    const proof = execFileSync(sidecar, ['--help'], { encoding: 'utf8', env: { ...env, PATH: '/usr/bin:/bin' } });
    if (!proof.includes('quintal-acp')) throw new Error('Signed sidecar did not start');
    // The personal office's two halves, as packaged: the runtime beside the
    // executable answers, and the payload landed under Resources with the
    // server entry the manifest names.
    const node = join(app, 'Contents/MacOS/quintal-node');
    const nodeVersion = execFileSync(node, ['--version'], { encoding: 'utf8', env: { ...env, PATH: '/usr/bin:/bin' } }).trim();
    if (nodeVersion !== `v${payload.node}`) throw new Error(`Packaged Node reports ${nodeVersion}, payload expects v${payload.node}`);
    const packagedPayload = join(app, 'Contents/Resources/personal');
    for (const file of ['payload.json', payload.entry, `${payload.webDir}/.next/BUILD_ID`]) {
      if (!existsSync(join(packagedPayload, file))) throw new Error(`Packaged payload is missing ${file}`);
    }
    if (signing === 'Developer ID signed and notarized') {
      execFileSync('xcrun', ['stapler', 'validate', app], { stdio: 'inherit' });
    }
    console.log(`PASS: DMG app signature verifies; packaged sidecar retains allow-jit and answers --help; packaged Node is ${nodeVersion} and the personal payload is in Resources`);
  } finally {
    if (mounted) execFileSync('hdiutil', ['detach', mount], { stdio: 'inherit' });
    rmSync(mount, { recursive: true, force: true });
  }
}
