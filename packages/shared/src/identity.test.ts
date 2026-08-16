import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AUTH_PAYLOAD_PREFIX,
  buildAuthPayload,
  displayNameFromPubkey,
  generateSecretKey,
  getPublicKeyHex,
  isNonceHex,
  isPubkeyHex,
  npubDecode,
  npubEncode,
  nsecDecode,
  nsecEncode,
  parseAuthPayload,
  parsePubkey,
  signAuthPayload,
  truncateNpub,
  verifyAuthSignature,
} from './identity.js';

const NONCE = 'a'.repeat(64);

function keypair() {
  const secretKey = generateSecretKey();
  return { secretKey, pubkey: getPublicKeyHex(secretKey) };
}

describe('keys', () => {
  it('produces a 32-byte x-only public key in hex', () => {
    const { pubkey } = keypair();
    assert.ok(isPubkeyHex(pubkey));
  });

  it('round-trips a public key through npub', () => {
    const { pubkey } = keypair();
    const npub = npubEncode(pubkey);
    assert.ok(npub.startsWith('npub1'));
    assert.equal(npubDecode(npub), pubkey);
  });

  it('round-trips a secret key through nsec', () => {
    const { secretKey } = keypair();
    const nsec = nsecEncode(secretKey);
    assert.ok(nsec.startsWith('nsec1'));
    assert.deepEqual(nsecDecode(nsec), secretKey);
  });

  it('refuses an nsec where an npub belongs, and vice versa', () => {
    const { secretKey, pubkey } = keypair();
    assert.throws(() => npubDecode(nsecEncode(secretKey)));
    assert.throws(() => nsecDecode(npubEncode(pubkey)));
  });

  it('rejects a corrupted npub rather than decoding it to something else', () => {
    const npub = npubEncode(keypair().pubkey);
    // bech32 carries a checksum; a single flipped character must not survive it.
    const flipped = `${npub.slice(0, -1)}${npub.at(-1) === 'q' ? 'p' : 'q'}`;
    assert.throws(() => npubDecode(flipped));
  });

  it('accepts either an npub or bare hex when a person pastes a key', () => {
    const { pubkey } = keypair();
    assert.equal(parsePubkey(npubEncode(pubkey)), pubkey);
    assert.equal(parsePubkey(`  ${pubkey}  `), pubkey);
    assert.equal(parsePubkey('not a key'), null);
    assert.equal(parsePubkey('npub1garbage'), null);
  });

  it('names a fresh identity after a recognisable slice of its npub', () => {
    const { pubkey } = keypair();
    const name = displayNameFromPubkey(pubkey);
    const npub = npubEncode(pubkey);
    assert.ok(name.startsWith('npub1'));
    assert.ok(name.endsWith(npub.slice(-6)));
    assert.ok(name.length < npub.length);
    assert.equal(truncateNpub('npub1short'), 'npub1short');
  });
});

describe('auth payload', () => {
  it('round-trips its fields', () => {
    const fields = {
      origin: 'https://office.example.com',
      nonce: NONCE,
      timestamp: 1_700_000_000,
    };
    assert.deepEqual(parseAuthPayload(buildAuthPayload(fields)), fields);
  });

  it('keeps the port on an origin that has one', () => {
    // The whole point of matching from the right: `http://localhost:3000`
    // contains the same separator the payload uses between fields.
    const fields = {
      origin: 'http://localhost:3000',
      nonce: NONCE,
      timestamp: 1_700_000_000,
    };
    const parsed = parseAuthPayload(buildAuthPayload(fields));
    assert.equal(parsed?.origin, 'http://localhost:3000');
    assert.equal(parsed?.nonce, NONCE);
  });

  it('refuses payloads that are not ours', () => {
    assert.equal(parseAuthPayload(null), null);
    assert.equal(parseAuthPayload(''), null);
    assert.equal(
      parseAuthPayload(`quintal-auth:v2:https://x.test:${NONCE}:1700000000`),
      null,
      'a different version must not parse as this one',
    );
    assert.equal(
      parseAuthPayload(`${AUTH_PAYLOAD_PREFIX}:https://x.test:short:1700000000`),
      null,
    );
    assert.equal(
      parseAuthPayload(`${AUTH_PAYLOAD_PREFIX}:https://x.test:${NONCE}:later`),
      null,
    );
    assert.equal(
      parseAuthPayload(`${AUTH_PAYLOAD_PREFIX}::${NONCE}:1700000000`),
      null,
      'an empty origin binds the signature to nothing',
    );
  });

  it('issues nonces the parser recognises', () => {
    assert.ok(isNonceHex(NONCE));
    assert.ok(!isNonceHex('a'.repeat(63)));
    assert.ok(!isNonceHex('A'.repeat(64)), 'hex is lowercase on the wire');
  });
});

describe('signatures', () => {
  const payload = buildAuthPayload({
    origin: 'https://office.example.com',
    nonce: NONCE,
    timestamp: 1_700_000_000,
  });

  it('verifies a signature made by the matching key', () => {
    const { secretKey, pubkey } = keypair();
    const sig = signAuthPayload(secretKey, payload);
    assert.ok(verifyAuthSignature({ pubkey, sig, payload }));
  });

  it('rejects a signature made by a different key', () => {
    const { secretKey } = keypair();
    const other = keypair();
    const sig = signAuthPayload(secretKey, payload);
    assert.ok(!verifyAuthSignature({ pubkey: other.pubkey, sig, payload }));
  });

  it('rejects a signature over a different payload', () => {
    const { secretKey, pubkey } = keypair();
    const sig = signAuthPayload(secretKey, payload);
    const tampered = buildAuthPayload({
      origin: 'https://evil.example.com',
      nonce: NONCE,
      timestamp: 1_700_000_000,
    });
    assert.ok(!verifyAuthSignature({ pubkey, sig, payload: tampered }));
  });

  it('treats malformed input as a failed check, never an exception', () => {
    const { secretKey, pubkey } = keypair();
    const sig = signAuthPayload(secretKey, payload);
    assert.ok(!verifyAuthSignature({ pubkey: 'nope', sig, payload }));
    assert.ok(!verifyAuthSignature({ pubkey, sig: 'nope', payload }));
    assert.ok(!verifyAuthSignature({ pubkey, sig: 'f'.repeat(128), payload }));
  });
});
