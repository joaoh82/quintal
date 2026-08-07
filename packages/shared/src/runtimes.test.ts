import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  RUNTIMES,
  acpCommandFor,
  isUsable,
  normaliseHostReport,
  runtimeById,
} from './runtimes.js';

describe('the runtime catalogue', () => {
  it('has unique ids and binaries', () => {
    assert.equal(new Set(RUNTIMES.map((r) => r.id)).size, RUNTIMES.length);
    assert.equal(new Set(RUNTIMES.map((r) => r.bin)).size, RUNTIMES.length);
  });

  it('says how every classification was reached', () => {
    for (const runtime of RUNTIMES) {
      assert.ok(runtime.evidence.length > 0, `${runtime.id} needs evidence`);
      assert.ok(runtime.install.length > 0, `${runtime.id} needs an install hint`);
    }
  });

  it('builds a native command from the CLI itself', () => {
    assert.deepEqual(acpCommandFor(runtimeById('goose')!), ['goose', 'acp']);
    assert.deepEqual(acpCommandFor(runtimeById('gemini')!), ['gemini', '--experimental-acp']);
  });

  it('builds an adapter command through npx, which installs nothing', () => {
    assert.deepEqual(acpCommandFor(runtimeById('claude-code')!), [
      'npx',
      '-y',
      '@agentclientprotocol/claude-agent-acp',
    ]);
  });

  it('returns null for a runtime with no ACP surface, rather than a command that fails later', () => {
    assert.equal(acpCommandFor(runtimeById('grok')!), null);
    assert.equal(acpCommandFor(runtimeById('cursor')!), null);
  });

  it('does not consider an installed-but-unsupported runtime usable', () => {
    assert.equal(isUsable({ id: 'grok', installed: true, path: '/usr/bin/grok' }), false);
    assert.equal(isUsable({ id: 'claude-code', installed: true, path: '/usr/bin/claude' }), true);
    assert.equal(isUsable({ id: 'claude-code', installed: false, path: null }), false);
  });
});

describe('a host report off the wire', () => {
  const good = {
    label: 'joshs-mbp',
    reposDir: '/Users/josh/projects',
    runtimes: [{ id: 'claude-code', installed: true, path: '/usr/bin/claude' }],
  };

  it('passes a well-formed report through', () => {
    assert.deepEqual(normaliseHostReport(good), good);
  });

  it('refuses a report with no machine to attribute it to', () => {
    assert.equal(normaliseHostReport({ ...good, label: '  ' }), null);
    assert.equal(normaliseHostReport(null), null);
    assert.equal(normaliseHostReport('nope'), null);
  });

  it('drops runtimes the catalogue does not know, so the UI renders only known things', () => {
    const out = normaliseHostReport({
      ...good,
      runtimes: [...good.runtimes, { id: '<script>', installed: true, path: '/tmp/x' }],
    });
    assert.deepEqual(out?.runtimes?.map((r) => r.id), ['claude-code']);
  });

  it('drops duplicates rather than rendering a runtime twice', () => {
    const out = normaliseHostReport({
      ...good,
      runtimes: [...good.runtimes, { id: 'claude-code', installed: false, path: null }],
    });
    assert.equal(out?.runtimes?.length, 1);
    assert.equal(out?.runtimes?.[0]?.installed, true);
  });

  it('truncates rather than trusting the length of anything', () => {
    const out = normaliseHostReport({
      label: 'x'.repeat(500),
      reposDir: '/'.repeat(5000),
      runtimes: [{ id: 'goose', installed: true, path: 'p'.repeat(5000) }],
    });
    assert.equal(out?.label.length, 64);
    assert.equal(out?.reposDir.length, 512);
    assert.equal(out?.runtimes?.[0]?.path?.length, 512);
  });

  it('leaves runtimes undefined when the report omits them, so a fleet member does not erase the scan', () => {
    const out = normaliseHostReport({ label: 'box', reposDir: '/repos' });
    assert.equal(out?.runtimes, undefined);
    assert.equal(out?.label, 'box');
  });

  it('keeps an explicitly empty list, which means "I looked and found nothing"', () => {
    assert.deepEqual(normaliseHostReport({ label: 'box', reposDir: '', runtimes: [] })?.runtimes, []);
  });
});
