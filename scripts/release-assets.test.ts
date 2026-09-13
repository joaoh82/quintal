import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const assets: { platform: string; extension: string; name: string }[] = JSON.parse(readFileSync('scripts/release-assets.json', 'utf8'));
const script = resolve('scripts/release-assets.mjs');
test('all installers have stable copies and verifiable checksums; incomplete sets are refused', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'quintal-assets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const asset of assets) {
    const platform = join(dir, 'staged', asset.platform);
    mkdirSync(platform, { recursive: true });
    writeFileSync(join(platform, `Quintal_1.2.3_${asset.platform}${asset.extension}`), `binary for ${asset.name}`);
  }
  const collect = (out: string) => spawnSync(process.execPath, [script, 'collect', join(dir, 'staged'), join(dir, out)], { encoding: 'utf8' });
  const result = collect('release');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readdirSync(join(dir, 'release')).length, 11);
  for (const asset of assets) assert.equal(readFileSync(join(dir, 'release', asset.name), 'utf8'), `binary for ${asset.name}`);
  const sums = readFileSync(join(dir, 'release/SHA256SUMS.txt'), 'utf8').trim().split('\n');
  assert.equal(sums.length, 10);
  for (const line of sums) {
    const [hash, name] = line.split('  ');
    assert.ok(name);
    assert.equal(hash, createHash('sha256').update(readFileSync(join(dir, 'release', name))).digest('hex'));
  }
  rmSync(join(dir, 'staged/windows-x64'), { recursive: true });
  assert.notEqual(collect('incomplete').status, 0);
});

test('staging selects final installers and ignores intermediate images left by failed builds', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'quintal-stage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bundle = join(dir, 'bundle');
  mkdirSync(join(bundle, 'dmg'), { recursive: true });
  mkdirSync(join(bundle, 'macos'));
  writeFileSync(join(bundle, 'macos/rw.incomplete.dmg'), 'unfinished');
  writeFileSync(join(bundle, 'dmg/Quintal_1.2.3_aarch64.dmg'), 'finished');
  const stage = () => spawnSync(process.execPath, [script, 'stage', 'macos-arm64', bundle, join(dir, 'stage')], { encoding: 'utf8' });
  const result = stage();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(join(dir, 'stage')), ['Quintal_1.2.3_aarch64.dmg']);
  writeFileSync(join(bundle, 'dmg/Quintal_0.0.1_aarch64.dmg'), 'stale version');
  assert.notEqual(stage().status, 0, 'multiple final installers must fail closed');
});
