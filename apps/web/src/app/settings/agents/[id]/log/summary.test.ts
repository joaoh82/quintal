import assert from 'node:assert/strict';
import { describe as suite, it } from 'node:test';

import { describe } from './summary';

/**
 * The connect row is the one an owner reads before turning legacy credentials
 * off: it has to say which door each session came through, and a row written
 * before doors were recorded has to read as it always did.
 */

/** A fixed key, so the format an owner reads is pinned rather than recomputed. */
const PUBKEY = 'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9';
const SHORT_NPUB = 'npub1lycg5qvj…6gq266';

suite('what a connect row says', () => {
  it('names the door', () => {
    const tile = { x: 10, y: 17 };
    assert.equal(describe('session.connected', { tile, credential: 'v2' }), 'at 10,17 · own key');
    assert.equal(describe('session.connected', { tile, credential: 'host' }), 'at 10,17 · host token');
    assert.equal(describe('session.connected', { tile, credential: 'key' }), 'at 10,17 · agent key');
    assert.equal(describe('session.connected', { reconnected: true, credential: 'v2' }), 'reconnected · own key');
  });

  it('reads as before for a row with no door recorded, or one it does not know', () => {
    assert.equal(describe('session.connected', { tile: { x: 1, y: 2 } }), 'at 1,2');
    assert.equal(describe('session.connected', { tile: { x: 1, y: 2 }, credential: 'v9' }), 'at 1,2');
    assert.equal(describe('session.connected', { reconnected: true }), 'reconnected');
  });
});

suite('what a registration row says', () => {
  it('shows the short npub and who handed it over', () => {
    assert.equal(
      describe('agent.credential_registered', { pubkey: PUBKEY, via: 'host', hostId: 'h1' }),
      `${SHORT_NPUB} · by this machine`,
    );
    assert.equal(
      describe('agent.credential_registered', { pubkey: PUBKEY, via: 'session', userId: 'u1' }),
      `${SHORT_NPUB} · by its owner`,
    );
  });

  it('names nobody for a registrar it does not know, and survives a key that will not encode', () => {
    assert.equal(describe('agent.credential_registered', { pubkey: PUBKEY, via: 'elsewhere' }), SHORT_NPUB);
    assert.equal(describe('agent.credential_registered', { pubkey: 'not-a-key' }), 'not-a-key');
    assert.equal(describe('agent.credential_registered', { pubkey: 'x'.repeat(40) }), 'x'.repeat(12));
    assert.equal(describe('agent.credential_registered', {}), '?');
  });
});
