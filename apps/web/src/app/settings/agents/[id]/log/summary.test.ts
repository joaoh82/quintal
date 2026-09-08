import assert from 'node:assert/strict';
import { describe as suite, it } from 'node:test';

import { generateSecretKey, getPublicKeyHex, npubEncode, truncateNpub } from '@quintal/shared';

import { describe } from './summary';

/**
 * The connect row is the one an owner reads before turning legacy credentials
 * off: it has to say which door each session came through, and a row written
 * before doors were recorded has to read as it always did.
 */
suite('what a connect row says', () => {
  it('names the door', () => {
    const tile = { x: 10, y: 17 };
    assert.equal(describe('session.connected', { tile, credential: 'v2' }), 'at 10,17 · own key');
    assert.equal(describe('session.connected', { tile, credential: 'host' }), 'at 10,17 · host token');
    assert.equal(describe('session.connected', { tile, credential: 'key' }), 'at 10,17 · agent key');
  });

  it('reads as before for a row with no door recorded, and for a reconnect', () => {
    assert.equal(describe('session.connected', { tile: { x: 1, y: 2 } }), 'at 1,2');
    assert.equal(describe('session.connected', { reconnected: true }), 'reconnected');
  });

  it('shows a registration as a short npub and who did it', () => {
    const pubkey = getPublicKeyHex(generateSecretKey());
    assert.equal(
      describe('agent.credential_registered', { pubkey, via: 'host', hostId: 'h1' }),
      `${truncateNpub(npubEncode(pubkey))} · by this machine`,
    );
    assert.match(describe('agent.credential_registered', { pubkey, via: 'session' }), /by its owner$/);
  });
});
