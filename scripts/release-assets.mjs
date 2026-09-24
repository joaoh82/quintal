import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, realpathSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const assets = JSON.parse(readFileSync(new URL('./release-assets.json', import.meta.url), 'utf8'));

/**
 * Updater payloads and their signatures are optional; installers are not.
 *
 * A build with no signing key produces neither, and that must still publish —
 * a release without self-update is a smaller problem than no release at all.
 * The manifest is what refuses to exist in that case, so nothing ever ships
 * pointing at a payload that is missing or unsigned.
 */
export function optional(asset) {
  // Signatures, and the macOS tarball that exists only when updater artifacts
  // were asked for. The Linux AppImage and the Windows installer are *also*
  // update payloads — Tauri v2 signs the installer itself rather than wrapping
  // it — but they are installers first and must never be treated as skippable.
  return Boolean(asset.signs || asset.updaterOnly);
}

/**
 * Staging must find the update payloads when this build was signing them.
 *
 * Without this a platform can go green having produced nothing to update with,
 * and the only symptom is a release that quietly carries no manifest. That is
 * exactly what v0.3.0 did on all three platforms at once: the contract asked
 * for filenames Tauri v2 does not emit, every lookup missed, every job passed.
 */
export function requireUpdaterAssets() {
  return Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY);
}

/** The stable names every platform's update payload and signature go out under. */
export function updaterNames() {
  return assets.filter((asset) => asset.updater || asset.signs).map((asset) => asset.name);
}
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)],
  );
}
export function stage(platform, bundleDir, destination) {
  const expected = assets.filter((asset) => asset.platform === platform);
  if (!expected.length) throw new Error(`Unknown platform: ${platform}`);
  mkdirSync(destination, { recursive: true });
  for (const asset of expected) {
    const directory = join(bundleDir, asset.directory);
    const matches = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(asset.extension))
      .map((entry) => join(directory, entry.name));
    if (matches.length === 0 && optional(asset)) {
      if (requireUpdaterAssets()) {
        throw new Error(
          `${asset.name}: this build was signing update payloads, so a missing ${asset.extension} in ${asset.directory}/ is a bug, not an unsigned build`,
        );
      }
      console.log(`No ${asset.extension} to stage (unsigned build); skipping`);
      continue;
    }
    if (matches.length !== 1) throw new Error(`Expected one ${asset.extension}, found ${matches.length}`);
    copyFileSync(matches[0], join(destination, basename(matches[0])));
  }
}
/**
 * The names one asset is published under.
 *
 * Installers go out twice: under the versioned filename Tauri produced, which
 * says what it is, and under a stable name that `releases/latest/download/…`
 * can point at. Update payloads and signatures get the stable name only.
 * Tauri v2 names the macOS tarball for the product alone — `Quintal.app.tar.gz`,
 * no version and no arch — so both architectures produce that one basename and
 * publishing it would collide. Nothing wants it under that name anyway:
 * `latest.json` addresses every payload and signature by its stable name.
 */
function publishedNames(asset) {
  return optional(asset) ? [asset.name] : [basename(asset.source), asset.name];
}
export function collect(staged, destination) {
  const selected = assets.flatMap((asset) => {
    const matches = files(join(staged, asset.platform)).filter((path) => path.endsWith(asset.extension));
    if (matches.length === 0 && optional(asset)) return [];
    if (matches.length !== 1) throw new Error(`Missing or ambiguous installer: ${asset.name}`);
    return [{ ...asset, source: matches[0] }];
  });
  // Validate the whole set before writing anything intended for publication.
  const names = selected.flatMap(publishedNames);
  if (new Set(names).size !== names.length) throw new Error('Installer filenames collide');
  mkdirSync(destination, { recursive: true });
  for (const asset of selected) {
    for (const name of publishedNames(asset)) copyFileSync(asset.source, join(destination, name));
  }
  const sums = names.sort().map((name) =>
    `${createHash('sha256').update(readFileSync(join(destination, name))).digest('hex')}  ${name}`,
  );
  writeFileSync(join(destination, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);
  return [...names, 'SHA256SUMS.txt'];
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'stage') stage(...args);
  else if (command === 'collect') collect(...args);
  else throw new Error('Usage: release-assets.mjs stage <platform> <bundle-dir> <destination> | collect <staged> <destination>');
}
