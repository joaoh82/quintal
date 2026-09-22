import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compareVersions, decideOffer, isPrerelease, type Available } from './update.js';

const offered = (over: Partial<Available> = {}): Available => ({
  version: '0.3.0',
  current: '0.2.0',
  notes: null,
  date: null,
  canInstall: true,
  blocked: null,
  ...over,
});

describe('ordering versions', () => {
  it('compares the three numbers, not the strings', () => {
    assert.ok(compareVersions('0.10.0', '0.9.0') > 0, '10 is after 9');
    assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
    assert.equal(compareVersions('0.2.0', '0.2.0'), 0);
    assert.ok(compareVersions('0.2.0', '0.3.0') < 0);
  });

  it('puts a prerelease before the release it leads to', () => {
    // The half a string compare gets backwards, and the half that decides
    // whether a rehearsal tag stampedes every stable install.
    assert.ok(compareVersions('0.3.0-rc.1', '0.3.0') < 0);
    assert.ok(compareVersions('0.3.0-rc.1', '0.2.0') > 0);
    assert.ok(compareVersions('0.3.0-rc.2', '0.3.0-rc.1') > 0);
  });

  it('knows a prerelease when it sees one', () => {
    assert.equal(isPrerelease('0.0.1-rc.1'), true);
    assert.equal(isPrerelease('v0.3.0-beta'), true);
    assert.equal(isPrerelease('0.3.0'), false);
  });
});

describe('what to do about an available update', () => {
  it('asks when there is something newer nobody has declined', () => {
    assert.deepEqual(decideOffer(offered(), null), {
      kind: 'prompt',
      update: offered(),
    });
  });

  it('says nothing when the host offers nothing', () => {
    assert.deepEqual(decideOffer(null, null), { kind: 'none' });
    assert.deepEqual(decideOffer(null, '0.1.0'), { kind: 'none' });
  });

  it('offers quietly, without asking again, once declined', () => {
    const offer = decideOffer(offered(), '0.3.0');
    assert.equal(offer.kind, 'badge', 'declining is an answer, not a snooze');
  });

  it('asks again when a version newer than the declined one arrives', () => {
    const offer = decideOffer(offered({ version: '0.4.0' }), '0.3.0');
    assert.equal(offer.kind, 'prompt');
  });

  it('never offers a prerelease to a stable install', () => {
    // RELEASING.md rehearses releases with `0.0.1-rc.N` tags. SemVer ranks
    // those above the stable release before them, so without this rule a
    // rehearsal would push every installed copy onto a release candidate.
    assert.deepEqual(
      decideOffer(offered({ version: '0.3.0-rc.1', current: '0.2.0' }), null),
      { kind: 'none' },
    );
  });

  it('does offer the next prerelease to somebody already running one', () => {
    const offer = decideOffer(
      offered({ version: '0.3.0-rc.2', current: '0.3.0-rc.1' }),
      null,
    );
    assert.equal(offer.kind, 'prompt', 'they opted in; keep them moving');
  });

  it('refuses to offer a downgrade, whatever the manifest claims', () => {
    assert.deepEqual(decideOffer(offered({ version: '0.1.0', current: '0.2.0' }), null), {
      kind: 'none',
    });
    assert.deepEqual(decideOffer(offered({ version: '0.2.0', current: '0.2.0' }), null), {
      kind: 'none',
    });
  });

  it('still offers where the copy cannot install, so the reason can be shown', () => {
    // A .deb or a copy running from its DMG: the offer is real, the button is
    // not. Suppressing it here would leave somebody on an old version with no
    // hint that a new one exists.
    const offer = decideOffer(
      offered({ canInstall: false, blocked: 'Installed by your package manager.' }),
      null,
    );
    assert.equal(offer.kind, 'prompt');
    assert.equal(offer.kind === 'prompt' && offer.update.canInstall, false);
  });
});
