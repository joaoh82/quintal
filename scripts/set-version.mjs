import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// SemVer 2.0: numeric identifiers cannot have leading zeroes.
const number = '(0|[1-9][0-9]*)';
const identifier = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const semver = new RegExp(`^${number}\\.${number}\\.${number}(?:-${identifier}(?:\\.${identifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
export function validateVersion(version) {
  if (typeof version !== 'string' || version.trim() !== version || !semver.test(version)) {
    throw new Error(`Invalid semver: ${version}`);
  }
  return version;
}

export function manifests(directory = root) {
  return ['package.json', ...['apps', 'packages'].flatMap((parent) =>
    readdirSync(join(directory, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${parent}/${entry.name}/package.json`)
      .filter((path) => existsSync(join(directory, path))),
  ), 'apps/desktop/src-tauri/tauri.conf.json'];
}

export function setVersion(version, directory = root) {
  validateVersion(version);
  const cargo = 'apps/desktop/src-tauri/Cargo.toml';
  const lock = 'apps/desktop/src-tauri/Cargo.lock';
  const originals = new Map([...manifests(directory), cargo, lock].map((path) =>
    [path, readFileSync(join(directory, path), 'utf8')],
  ));
  try {
    for (const path of manifests(directory)) {
      const value = JSON.parse(originals.get(path));
      value.version = version;
      writeFileSync(join(directory, path), `${JSON.stringify(value, null, 2)}\n`);
    }
    const toml = originals.get(cargo);
    const updated = toml.replace(/(\[package\][\s\S]*?^version\s*=\s*)"[^"]+"/m, `$1"${version}"`);
    if (updated === toml && !toml.includes(`version = "${version}"`)) {
      throw new Error('Could not locate Cargo package version');
    }
    writeFileSync(join(directory, cargo), updated);
    execFileSync('cargo', ['update', '-w', '--manifest-path', join(directory, cargo)], { stdio: 'inherit' });
  } catch (error) {
    for (const [path, contents] of originals) writeFileSync(join(directory, path), contents);
    throw error;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/set-version.mjs <semver>');
  setVersion(process.argv[2]);
}
