import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PERSONAL_OWNER_ENV, personalMode } from './personal.js';

const OWNER = 'ab'.repeat(32);

describe('personalMode', () => {
  it('is off when nothing names an owner', () => {
    assert.equal(personalMode({}), null);
    assert.equal(personalMode({ [PERSONAL_OWNER_ENV]: '' }), null);
    assert.equal(personalMode({ [PERSONAL_OWNER_ENV]: '   ' }), null);
  });

  it('names the owner, normalised to lowercase hex', () => {
    assert.deepEqual(personalMode({ [PERSONAL_OWNER_ENV]: ` ${OWNER.toUpperCase()} ` }), {
      owner: OWNER,
    });
  });

  /// A typo must not quietly turn a private office into a shared one.
  it('refuses a value that is not a public key rather than ignoring it', () => {
    for (const bad of ['npub1notakey', 'ab', OWNER.slice(0, 63), `${OWNER}00`, 'zz'.repeat(32)]) {
      assert.throws(() => personalMode({ [PERSONAL_OWNER_ENV]: bad }), /32-byte/, bad);
    }
  });
});
