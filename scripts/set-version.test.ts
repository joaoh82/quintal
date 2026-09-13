import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';

const scriptRoot = resolve('scripts');
const paths = ['package.json', 'apps/server/package.json', 'apps/desktop/package.json',
  'apps/web/package.json', 'apps/website/package.json', 'packages/shared/package.json',
  'packages/acp-harness/package.json', 'apps/desktop/src-tauri/tauri.conf.json'];
const cargo = 'apps/desktop/src-tauri/Cargo.toml';
const lock = 'apps/desktop/src-tauri/Cargo.lock';
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'quintal-version-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const path of paths) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), JSON.stringify({ name: path, version: '0.0.1', private: true }) + '\n');
  }
  mkdirSync(join(dir, 'scripts'));
  for (const name of ['set-version.mjs', 'check-release-version.mjs', 'release.mjs']) {
    cpSync(join(scriptRoot, name), join(dir, 'scripts', name));
  }
  writeFileSync(join(dir, cargo), '[package]\nname = "quintal-desktop"\nversion = "0.0.1"\nedition = "2021"\n');
  mkdirSync(join(dir, 'apps/desktop/src-tauri/src'));
  writeFileSync(join(dir, 'apps/desktop/src-tauri/src/lib.rs'), '');
  writeFileSync(join(dir, lock), 'version = 3\n\n[[package]]\nname = "quintal-desktop"\nversion = "0.0.1"\n');
  return dir;
}
function node(dir: string, script: string, ...args: string[]) {
  return spawnSync(process.execPath, [join(dir, 'scripts', script), ...args], { cwd: dir, encoding: 'utf8' });
}
for (const version of ['1.2.3', '1.2.3-rc.1']) {
  test(`set-version ${version} updates every manifest and the real Cargo lock`, (t) => {
    const dir = fixture(t);
    const result = node(dir, 'set-version.mjs', version);
    assert.equal(result.status, 0, result.stderr);
    for (const path of paths) assert.equal(JSON.parse(readFileSync(join(dir, path), 'utf8')).version, version, path);
    assert.ok(readFileSync(join(dir, cargo), 'utf8').includes(`version = "${version}"`));
    assert.ok(readFileSync(join(dir, lock), 'utf8').includes(`version = "${version}"`));
    assert.equal(node(dir, 'check-release-version.mjs', `v${version}`).status, 0);
    const mismatch = node(dir, 'check-release-version.mjs', 'v9.9.9');
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /expected 9\.9\.9/);
  });
}
test('malformed versions are refused without changing files', (t) => {
  const dir = fixture(t);
  const before = [...paths, cargo, lock].map((path) => readFileSync(join(dir, path), 'utf8'));
  for (const version of ['v1.2.3', '1.2', '01.2.3', '1.2.3-01', '1.2.3-', '1.2.3\n', '1.2.3;echo nope']) {
    assert.notEqual(node(dir, 'set-version.mjs', version).status, 0, version);
  }
  assert.deepEqual([...paths, cargo, lock].map((path) => readFileSync(join(dir, path), 'utf8')), before);
});
test('a failed Cargo update restores all manifests', (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, cargo), readFileSync(join(dir, cargo), 'utf8') + '\nnot valid TOML\n');
  const before = [...paths, cargo, lock].map((path) => readFileSync(join(dir, path), 'utf8'));
  assert.notEqual(node(dir, 'set-version.mjs', '1.2.3').status, 0);
  assert.deepEqual([...paths, cargo, lock].map((path) => readFileSync(join(dir, path), 'utf8')), before);
});
test('release signs off and atomically pushes one matching version and tag to a local remote', (t) => {
  const dir = fixture(t);
  const remote = mkdtempSync(join(tmpdir(), 'quintal-release-remote-'));
  t.after(() => rmSync(remote, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Release Test');
  git('config', 'user.email', 'release@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  git('add', '.');
  git('commit', '-m', 'fixture');
  git('init', '--bare', remote);
  git('remote', 'add', 'origin', remote);
  git('push', '-u', 'origin', 'main');
  git('switch', '-c', 'feature');
  assert.match(node(dir, 'release.mjs', '1.2.3').stderr, /must start on main/);
  git('switch', 'main');
  writeFileSync(join(dir, 'untracked'), 'dirty');
  assert.match(node(dir, 'release.mjs', '1.2.3').stderr, /clean tree/);
  rmSync(join(dir, 'untracked'));
  const result = node(dir, 'release.mjs', '1.2.3');
  assert.equal(result.status, 0, result.stderr);
  assert.match(git('log', '-1', '--format=%B'), /release: v1.2.3[\s\S]*Signed-off-by: Release Test/);
  assert.equal(git('rev-parse', 'HEAD'), git('rev-parse', 'v1.2.3^{commit}'));
  assert.equal(git('rev-parse', 'HEAD'), git('rev-parse', 'origin/main'));
  assert.match(git('ls-remote', 'origin', 'refs/tags/v1.2.3'), /refs\/tags\/v1.2.3/);
  assert.equal(node(dir, 'check-release-version.mjs', 'v1.2.3').status, 0);
  assert.match(node(dir, 'release.mjs', '1.2.3').stderr, /already exists/);
});
