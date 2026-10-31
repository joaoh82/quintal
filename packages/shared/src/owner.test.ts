import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { generateSecretKey, getPublicKeyHex, npubEncode } from './identity.js';
import { OWNER_ENV, instanceOwner } from './owner.js';

describe('instanceOwner', () => {
  const pubkey = getPublicKeyHex(generateSecretKey());

  it('is nobody when unset or blank', () => {
    assert.equal(instanceOwner({}), null);
    assert.equal(instanceOwner({ [OWNER_ENV]: '  ' }), null);
  });

  it('takes an npub or hex, the two spellings that get pasted', () => {
    assert.equal(instanceOwner({ [OWNER_ENV]: npubEncode(pubkey) }), pubkey);
    assert.equal(instanceOwner({ [OWNER_ENV]: ` ${pubkey.toUpperCase()} ` }), pubkey);
  });

  it('refuses a typo rather than quietly naming nobody', () => {
    assert.throws(() => instanceOwner({ [OWNER_ENV]: 'npub1notakey' }), /QUINTAL_OWNER must be/);
    assert.throws(() => instanceOwner({ [OWNER_ENV]: pubkey.slice(1) }), /QUINTAL_OWNER must be/);
  });
});
