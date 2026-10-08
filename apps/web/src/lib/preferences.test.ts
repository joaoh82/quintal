import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ALERT_DEFAULTS, isBindableKey, parseAlertPreferences } from './preferences';

describe('alert preferences', () => {
  it('are on until somebody says otherwise', () => {
    assert.deepEqual(parseAlertPreferences(null), ALERT_DEFAULTS);
    assert.deepEqual(ALERT_DEFAULTS, { notify: true, sound: true, done: true });
  });

  it('keep what was chosen and default what was not', () => {
    assert.deepEqual(parseAlertPreferences('{"sound":false}'), {
      notify: true,
      sound: false,
      done: true,
    });
  });

  it('treat anything unreadable as no choice at all', () => {
    for (const stored of ['', 'not json', 'null', '[]', '{"notify":"yes"}']) {
      assert.deepEqual(parseAlertPreferences(stored), ALERT_DEFAULTS, stored);
    }
  });
});

describe('the conversations panel key', () => {
  it('cannot be the key that goes to whoever is waiting', () => {
    assert.equal(isBindableKey('n'), false);
    assert.equal(isBindableKey('N'), false);
    assert.equal(isBindableKey('`'), true);
  });
});
