import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assets } from './release-assets.mjs';

/**
 * The update manifest.
 *
 * One file, published beside the installers, saying what the newest version is
 * and where each platform's payload lives. `tauri.conf.json` points the app at
 * `releases/latest/download/latest.json`, so GitHub's own idea of "latest"
 * decides what installed copies are offered — which is why a prerelease must
 * never produce one (see `shouldPublish`).
 *
 * URLs are written against **this tag**, not against `latest`. A manifest that
 * said `latest/download/…` would keep resolving to somewhere new after it was
 * published, so the signature in it would eventually describe a file it no
 * longer points at.
 */

/** Tauri validates the whole file before it looks at the version, so every field is required. */
export function latestJson(tag, version, notes, pubDate = new Date().toISOString()) {
  const repository = process.env.GITHUB_REPOSITORY ?? 'joaoh82/quintal';
  const payloads = assets.filter((asset) => asset.updater);
  const signatures = new Map(assets.filter((asset) => asset.signs).map((asset) => [asset.signs, asset]));

  const platforms = {};
  for (const payload of payloads) {
    const signature = signatures.get(payload.updater);
    if (!signature) throw new Error(`No signature declared for ${payload.updater}`);
    platforms[payload.updater] = {
      // Read from the collected release directory: an empty or missing
      // signature must fail here, not silently publish a manifest the app
      // will refuse every time it checks.
      signature: readSignature(signature.name),
      url: `https://github.com/${repository}/releases/download/${tag}/${payload.name}`,
    };
  }
  if (Object.keys(platforms).length === 0) throw new Error('No updater payloads declared');

  return { version, notes, pub_date: pubDate, platforms };
}

let releaseDir = 'release';
export function setReleaseDir(directory) {
  releaseDir = directory;
}

function readSignature(name) {
  const text = readFileSync(join(releaseDir, name), 'utf8').trim();
  if (!text) throw new Error(`${name} is empty; the payload was not signed`);
  return text;
}

/**
 * Whether this release should carry the manifest at all.
 *
 * A prerelease must not: `RELEASING.md` rehearses releases with `0.0.1-rc.N`
 * tags, and a manifest published under one would be handed to every installed
 * copy that asks. The same rule already keeps prereleases off the stable
 * download links.
 */
export function shouldPublish(version, becomingLatest) {
  return !version.split('+')[0].includes('-') && becomingLatest;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tag, version, notesFile, destination = 'release'] = process.argv.slice(2);
  setReleaseDir(destination);
  const notes = notesFile ? readFileSync(notesFile, 'utf8') : '';
  writeFileSync(join(destination, 'latest.json'), `${JSON.stringify(latestJson(tag, version, notes), null, 2)}\n`);
}
