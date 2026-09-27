import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';

import { pruneFromTraces } from './prune-personal-payload.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'quintal-traces-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const webSource = join(root, 'workspace/apps/web');
  const modules = join(root, 'payload/node_modules');
  const write = (path, value) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
    return path;
  };
  const pkg = (path, name, extra = {}) => {
    write(join(path, 'package.json'), { name, version: '1.0.0', ...extra });
    write(join(path, 'index.js'), '// runtime');
    write(join(path, 'unused.js'), '// untraced');
    return path;
  };
  const deployed = (name, extra) => pkg(join(modules, name), name, extra);
  const source = (name, extra) => pkg(join(root, 'workspace/node_modules/.pnpm', name.replace('/', '+'), 'node_modules', name), name, extra);
  const trace = (path, sources, base = dirname(path)) => write(path, { version: 1, files: sources.map((file) => relative(base, file)) });
  const nextTrace = join(webSource, '.next/next-server.js.nft.json');
  const routeTrace = join(webSource, '.next/server/app/settings/profile/page.js.nft.json');
  const required = join(webSource, '.next/required-server-files.json');
  deployed('@quintal/server', { dependencies: { next: '1', '@quintal/shared': '1' } });
  deployed('@quintal/web');
  deployed('@quintal/shared', { dependencies: { libsql: '1' } });
  deployed('next', { peerDependencies: { react: '1' }, optionalDependencies: { '@next/swc-darwin-arm64': '1' } });
  deployed('react');
  deployed('libsql', { optionalDependencies: { '@libsql/darwin-arm64': '1', '@libsql/darwin-x64': '1' } });
  deployed('@libsql/darwin-x64'); // cross-build: source traces describe arm64.
  deployed('@img/sharp-darwin-x64'); // a native package outside the server closure.
  const native = source('@libsql/darwin-arm64');
  trace(nextTrace, [join(native, 'index.js')]);
  trace(routeTrace, []);
  trace(required, [write(join(webSource, '.next/BUILD_ID'), 'build')], webSource);
  return {
    root, modules, webSource, write, pkg, deployed, source, trace, nextTrace, routeTrace, required,
    prune: () => pruneFromTraces({ webSource, modules, nativePackages: ['@libsql/darwin-arm64', '@libsql/darwin-x64', '@img/sharp-darwin-x64'] }),
  };
}

test('prunes only untraced web files; retains server closure, peers and target natives', (t) => {
  const f = fixture(t);
  const phaser = f.deployed('phaser');
  f.deployed('lucide-react');
  const webDep = f.deployed('@web/only');
  const source = f.source('@web/only');
  f.trace(f.routeTrace, [source, join(source, 'index.js')]);
  const requiredDep = f.deployed('required-only');
  f.trace(f.required, [join(f.source('required-only'), 'index.js')], f.webSource);
  const staticFile = f.write(join(f.modules, '@quintal/web/.next/static/client.js'), '// phaser and icons bundled here');
  const report = f.prune();
  assert.ok(report.removedBytes > 0);
  assert.equal(report.traces, 3);
  assert.equal(existsSync(phaser), false);
  assert.equal(existsSync(join(f.modules, 'lucide-react')), false);
  assert.equal(existsSync(join(webDep, 'unused.js')), false);
  assert.ok(existsSync(join(webDep, 'index.js')));
  assert.ok(existsSync(join(webDep, 'package.json')));
  assert.ok(existsSync(join(requiredDep, 'index.js')));
  assert.ok(existsSync(staticFile));
  for (const name of ['next', 'react', '@quintal/shared', 'libsql', '@libsql/darwin-x64', '@img/sharp-darwin-x64']) {
    assert.ok(existsSync(join(f.modules, name, 'unused.js')), `${name} must stay whole`);
  }
});

test('matches versions and retains nested runtime dependencies without retaining unrelated nested packages', (t) => {
  const f = fixture(t);
  const next = join(f.modules, 'next');
  f.pkg(next, 'next', { dependencies: { dep: '2' } });
  const nested = f.pkg(join(next, 'node_modules/dep'), 'dep', { version: '2.0.0' });
  const unused = f.pkg(join(next, 'node_modules/unused'), 'unused');
  const top = f.deployed('dep');
  f.trace(f.routeTrace, [join(f.source('dep'), 'index.js')]);
  f.prune();
  assert.ok(existsSync(join(nested, 'unused.js')));
  assert.ok(existsSync(join(top, 'index.js')));
  assert.equal(existsSync(join(top, 'unused.js')), false);
  assert.equal(existsSync(unused), false);
});

for (const problem of ['missing trace', 'malformed trace', 'missing file', 'wrong version', 'missing server dependency', 'no route traces']) {
  test(`fails before deleting files on ${problem}`, (t) => {
    const f = fixture(t);
    const untouched = join(f.deployed('phaser'), 'index.js');
    let expected;
    switch (problem) {
      case 'missing trace':
        rmSync(f.nextTrace);
        expected = /ENOENT/;
        break;
      case 'malformed trace':
        f.write(f.routeTrace, { files: 'invalid' });
        expected = /Invalid Next file trace/;
        break;
      case 'missing file': {
        const source = f.source('web-dep');
        f.deployed('web-dep');
        f.trace(f.routeTrace, [f.write(join(source, 'absent.js'), '// missing in deployment')]);
        expected = /Traced file is missing/;
        break;
      }
      case 'wrong version':
        f.deployed('web-dep', { version: '2.0.0' });
        f.trace(f.routeTrace, [join(f.source('web-dep'), 'index.js')]);
        expected = /Traced package is missing/;
        break;
      case 'missing server dependency':
        f.pkg(join(f.modules, '@quintal/server'), '@quintal/server', { dependencies: { absent: '1' } });
        expected = /Missing production dependency/;
        break;
      case 'no route traces':
        rmSync(f.routeTrace);
        expected = /No Next route traces/;
    }
    assert.throws(f.prune, expected);
    assert.equal(readFileSync(untouched, 'utf8'), '// runtime');
  });
}
