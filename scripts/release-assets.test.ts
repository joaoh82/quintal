import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const assets: { platform: string; extension: string; name: string; directory: string; updater?: string; signs?: string; updaterOnly?: boolean }[] = JSON.parse(readFileSync('scripts/release-assets.json', 'utf8'));
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
  // An installer lands twice — under the name the bundler chose and under the
  // stable one the download page links. An update payload or a signature lands
  // only under its stable name, which is what `latest.json` addresses it by.
  const optional = (asset: typeof assets[number]) => Boolean(asset.signs || asset.updaterOnly);
  const published = assets.reduce((total, asset) => total + (optional(asset) ? 1 : 2), 0);
  assert.equal(readdirSync(join(dir, 'release')).length, published + 1);
  for (const asset of assets) assert.equal(readFileSync(join(dir, 'release', asset.name), 'utf8'), `binary for ${asset.name}`);
  const sums = readFileSync(join(dir, 'release/SHA256SUMS.txt'), 'utf8').trim().split('\n');
  assert.equal(sums.length, published);
  for (const line of sums) {
    const [hash, name] = line.split('  ');
    assert.ok(name);
    assert.equal(hash, createHash('sha256').update(readFileSync(join(dir, 'release', name))).digest('hex'));
  }
  rmSync(join(dir, 'staged/windows-x64'), { recursive: true });
  assert.notEqual(collect('incomplete').status, 0);
});

test('the macOS payloads both arrive as Quintal.app.tar.gz and still publish', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'quintal-collide-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Tauri v2 names the macOS tarball for the product alone, so arm64 and x64
  // produce the same basename. v0.4.0 staged four such files and `collect`
  // refused the whole release; the fixtures above never caught it because they
  // spell the platform into every filename, which Tauri does not.
  for (const asset of assets) {
    const platform = join(dir, 'staged', asset.platform);
    mkdirSync(platform, { recursive: true });
    const name = asset.extension.startsWith('.app.tar.gz')
      ? `Quintal${asset.extension}`
      : `Quintal_1.2.3_${asset.platform}${asset.extension}`;
    writeFileSync(join(platform, name), `binary for ${asset.name}`);
  }
  const result = spawnSync(process.execPath, [script, 'collect', join(dir, 'staged'), join(dir, 'release')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  // Each architecture's payload and signature is there, under its own stable
  // name, carrying its own bytes — never one arch's tarball serving both.
  for (const asset of assets) assert.equal(readFileSync(join(dir, 'release', asset.name), 'utf8'), `binary for ${asset.name}`);
  // And the colliding basename is published under no name at all.
  assert.ok(!readdirSync(join(dir, 'release')).includes('Quintal.app.tar.gz'));
});

test('staging selects final installers and ignores intermediate images left by failed builds', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'quintal-stage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bundle = join(dir, 'bundle');
  mkdirSync(join(bundle, 'dmg'), { recursive: true });
  mkdirSync(join(bundle, 'macos'));
  writeFileSync(join(bundle, 'macos/rw.incomplete.dmg'), 'unfinished');
  writeFileSync(join(bundle, 'dmg/Quintal_1.2.3_aarch64.dmg'), 'finished');
  // The updater payload sits beside the half-written image in `macos/`, which
  // is exactly why staging matches on the full compound extension.
  writeFileSync(join(bundle, 'macos/Quintal.app.tar.gz'), 'updater payload');
  writeFileSync(join(bundle, 'macos/Quintal.app.tar.gz.sig'), 'signature');
  const stage = () => spawnSync(process.execPath, [script, 'stage', 'macos-arm64', bundle, join(dir, 'stage')], { encoding: 'utf8' });
  const result = stage();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(join(dir, 'stage')).sort(), [
    'Quintal.app.tar.gz',
    'Quintal.app.tar.gz.sig',
    'Quintal_1.2.3_aarch64.dmg',
  ]);
  writeFileSync(join(bundle, 'dmg/Quintal_0.0.1_aarch64.dmg'), 'stale version');
  assert.notEqual(stage().status, 0, 'multiple final installers must fail closed');
});

test('the update manifest names every platform, carries its signature, and refuses an unsigned one', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'quintal-manifest-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'release'), { recursive: true });
  for (const asset of assets) {
    writeFileSync(join(dir, 'release', asset.name), asset.signs ? `signature-for-${asset.signs}` : 'payload');
  }

  const built = spawnSync(
    process.execPath,
    ['-e', `
      import('${resolve('scripts/latest-json.mjs')}').then((m) => {
        m.setReleaseDir(${JSON.stringify(join(dir, 'release'))});
        console.log(JSON.stringify(m.latestJson('v1.2.3', '1.2.3', 'notes', '2026-01-01T00:00:00Z')));
      });
    `],
    { encoding: 'utf8' },
  );
  assert.equal(built.status, 0, built.stderr);
  const manifest = JSON.parse(built.stdout);

  assert.equal(manifest.version, '1.2.3');
  assert.ok(manifest.pub_date, 'Tauri validates the whole file before the version');
  // Every declared payload must appear, or a platform silently stops receiving
  // updates while every other one keeps working — the failure nobody notices.
  const declared = assets.filter((asset) => asset.updater).map((asset) => asset.updater);
  assert.deepEqual(Object.keys(manifest.platforms).sort(), [...declared].sort());
  for (const target of declared) {
    assert.equal(manifest.platforms[target!].signature, `signature-for-${target}`);
    assert.match(
      manifest.platforms[target!].url,
      /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/v1\.2\.3\//,
      'pinned to this tag, never to /latest, or the signature outlives what it describes',
    );
  }

  // An empty signature file means the payload went out unsigned. Publishing
  // that manifest would make every update attempt fail verification, quietly,
  // for everybody — so it has to fail here instead.
  writeFileSync(join(dir, 'release', assets.find((asset) => asset.signs)!.name), '   ');
  const unsigned = spawnSync(
    process.execPath,
    ['-e', `
      import('${resolve('scripts/latest-json.mjs')}').then((m) => {
        m.setReleaseDir(${JSON.stringify(join(dir, 'release'))});
        m.latestJson('v1.2.3', '1.2.3', 'notes');
      }).catch((error) => { console.error(error.message); process.exit(1); });
    `],
    { encoding: 'utf8' },
  );
  assert.notEqual(unsigned.status, 0, 'an unsigned payload must not reach a manifest');
});

test('a prerelease never becomes the manifest installed copies read', async () => {
  const { shouldPublish } = await import(resolve('scripts/latest-json.mjs'));
  // RELEASING.md rehearses with `0.0.1-rc.N`. One of those writing latest.json
  // would hand a release candidate to every machine that asks.
  assert.equal(shouldPublish('0.0.1-rc.1', true), false);
  assert.equal(shouldPublish('1.2.3', true), true);
  // Re-running an older tag must not walk anybody backwards.
  assert.equal(shouldPublish('1.2.3', false), false);
});

test('an unsigned build still ships installers, and simply carries no update payloads', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'quintal-unsigned-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // What a runner with no signing key produces: every installer, no payloads,
  // no signatures. That must publish — a release without self-update beats no
  // release — while `publish-release.mjs` withholds the manifest.
  for (const asset of assets.filter((entry) => !entry.signs && !entry.updaterOnly)) {
    const platform = join(dir, 'staged', asset.platform);
    mkdirSync(platform, { recursive: true });
    writeFileSync(join(platform, `Quintal_1.2.3_${asset.platform}${asset.extension}`), `binary for ${asset.name}`);
  }
  const result = spawnSync(
    process.execPath,
    [script, 'collect', join(dir, 'staged'), join(dir, 'release')],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const installers = assets.filter((entry) => !entry.signs && !entry.updaterOnly);
  assert.equal(readdirSync(join(dir, 'release')).length, installers.length * 2 + 1);
  for (const asset of assets.filter((entry) => entry.signs || entry.updaterOnly)) {
    assert.ok(
      !readdirSync(join(dir, 'release')).includes(asset.name),
      `${asset.name} must not be invented when nothing signed it`,
    );
  }
});

test('a signing build refuses to stage a platform that produced no update payload', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'quintal-guard-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // v0.3.0's actual failure: the contract asked for filenames Tauri v2 does
  // not emit, every lookup missed, and all three platforms went green having
  // produced nothing to update with. Silence there costs a whole release, so a
  // build that *was* signing must fail when a payload is absent.
  const bundle = join(dir, 'bundle');
  mkdirSync(join(bundle, 'nsis'), { recursive: true });
  writeFileSync(join(bundle, 'nsis/Quintal_1.2.3_x64-setup.exe'), 'installer');

  const stage = (env: NodeJS.ProcessEnv) =>
    spawnSync(process.execPath, [script, 'stage', 'windows-x64', bundle, join(dir, 'out')], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });

  const unsigned = stage({ TAURI_SIGNING_PRIVATE_KEY: '' });
  assert.equal(unsigned.status, 0, 'an unsigned build still stages its installer');

  rmSync(join(dir, 'out'), { recursive: true, force: true });
  const signing = stage({ TAURI_SIGNING_PRIVATE_KEY: 'pretend-key' });
  assert.notEqual(signing.status, 0, 'a signing build with no .sig must fail');
  assert.match(signing.stderr, /is a bug, not an unsigned build/);
});
