import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { versionLabel, versionParts } from './version.js';

/**
 * The rule worth pinning: one number means the app and the office agree, and
 * two labelled numbers mean they do not. Getting that backwards — a label
 * where there is nothing to contrast, or a bare number hiding a drift — is a
 * version line that misinforms, which is worse than no version line.
 */
describe('which versions are in the room', () => {
  it('says one number when the app and the office agree', () => {
    assert.deepEqual(versionParts('0.1.2', '0.1.2'), [{ label: null, version: '0.1.2' }]);
    assert.equal(versionLabel('0.1.2', '0.1.2'), '0.1.2');
  });

  it('says both, labelled, when they have drifted', () => {
    assert.deepEqual(versionParts('0.1.3', '0.1.2'), [
      { label: 'app', version: '0.1.3' },
      { label: 'server', version: '0.1.2' },
    ]);
    assert.equal(versionLabel('0.1.3', '0.1.2'), 'app 0.1.3 · server 0.1.2');
  });

  it('leaves the lone number unlabelled in a browser, which has no app', () => {
    // Calling it `server` would contrast it with an app version the person
    // looking at a browser tab does not have and cannot get.
    assert.deepEqual(versionParts(null, '0.1.2'), [{ label: null, version: '0.1.2' }]);
    assert.equal(versionLabel(null, '0.1.2'), '0.1.2');
  });

  it('leaves it unlabelled on the picker too, where no server exists yet', () => {
    assert.deepEqual(versionParts('0.1.2', null), [{ label: null, version: '0.1.2' }]);
  });

  it('renders nothing at all when it knows neither, never "unknown"', () => {
    assert.deepEqual(versionParts(null, null), []);
    assert.equal(versionLabel(null, null), '');
  });
});
