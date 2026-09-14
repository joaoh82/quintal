import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifests, root, validateVersion } from './set-version.mjs';

export function checkReleaseVersion(tag, directory = root) {
  if (!tag?.startsWith('v')) throw new Error('Release tag must start with v');
  const version = validateVersion(tag.slice(1));
  for (const path of manifests(directory)) {
    const actual = JSON.parse(readFileSync(join(directory, path), 'utf8')).version;
    if (actual !== version) throw new Error(`${tag}: ${path} reports ${actual}, expected ${version}`);
  }
  const cargo = readFileSync(join(directory, 'apps/desktop/src-tauri/Cargo.toml'), 'utf8');
  const actual = cargo.match(/\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1];
  if (actual !== version) throw new Error(`${tag}: Cargo.toml reports ${actual}`);
  const lock = readFileSync(join(directory, 'apps/desktop/src-tauri/Cargo.lock'), 'utf8');
  const locked = lock.match(/\[\[package\]\]\nname = "quintal-desktop"\nversion = "([^"]+)"/)?.[1];
  if (locked !== version) throw new Error(`${tag}: Cargo.lock reports ${locked}`);
  return version;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(checkReleaseVersion(process.argv[2]));
}
