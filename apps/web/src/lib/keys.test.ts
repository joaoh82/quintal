import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { generateSecretKey, nsecEncode } from '@quintal/shared';

import { storageActionFor } from './keys';

/**
 * What signing in does to the key this browser is holding.
 *
 * These are destruction tests, not storage tests. A secret key here is the
 * whole identity and nobody can reissue it — we never had it — so a wrongly
 * placed `removeItem` does not lose a preference, it loses an office and
 * everything in it. The rule is small and the wrong version of it reads as
 * obviously correct, which is exactly why it is pinned here.
 */

const nsecFor = () => nsecEncode(generateSecretKey());

const local = (nsec: string) => ({ kind: 'local' as const, nsec });
const extension = { kind: 'extension' as const };

describe('storageActionFor', () => {
  it('saves when the box is ticked', () => {
    const nsec = nsecFor();
    assert.equal(
      storageActionFor({ identity: local(nsec), persist: true, saved: null }),
      'save',
    );
  });

  it('forgets the stored key when the box is unticked for that same key', () => {
    // The original bug: unticking skipped the write but left the key on disk,
    // so the checkbox described a setting it did not enforce.
    const nsec = nsecFor();
    assert.equal(
      storageActionFor({ identity: local(nsec), persist: false, saved: nsec }),
      'forget',
    );
  });

  it('leaves a stored key alone when signing in with an extension', () => {
    // The regression this test exists for. "Use my signing extension" passes
    // persist: false, and a rule keyed only on that wipes a local key the
    // extension has nothing to do with — silently, and with no way back.
    const stored = nsecFor();
    assert.equal(
      storageActionFor({ identity: extension, persist: false, saved: stored }),
      'leave',
    );
    assert.equal(
      storageActionFor({ identity: extension, persist: true, saved: stored }),
      'leave',
      'an extension has no secret for us to save either',
    );
  });

  it('leaves a stored key alone when a different key is pasted', () => {
    // "Don't save this one" is not "destroy the one already here".
    const stored = nsecFor();
    const pasted = nsecFor();
    assert.equal(
      storageActionFor({ identity: local(pasted), persist: false, saved: stored }),
      'leave',
    );
  });

  it('has nothing to forget when nothing was stored', () => {
    const nsec = nsecFor();
    assert.equal(
      storageActionFor({ identity: local(nsec), persist: false, saved: null }),
      'leave',
    );
  });

  it('never reports forget for an identity that carries no secret', () => {
    // Belt and braces: whatever else changes, the destructive branch must be
    // unreachable without a local key in hand.
    for (const persist of [true, false]) {
      for (const saved of [null, nsecFor()]) {
        assert.notEqual(
          storageActionFor({ identity: extension, persist, saved }),
          'forget',
        );
      }
    }
  });
});
