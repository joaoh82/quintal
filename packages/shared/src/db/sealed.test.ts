import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isSealed, openSecret, sealingKey, sealSecret } from './sealed.js';

const key = sealingKey({ BETTER_AUTH_SECRET: 'one-secret-that-is-at-least-thirty-two-chars' })!;
const other = sealingKey({ BETTER_AUTH_SECRET: 'two-secret-that-is-at-least-thirty-two-chars' })!;

describe('a sealed secret', () => {
  it('opens with the key and context it was sealed with, and only those', () => {
    const sealed = sealSecret('ghp_secret', 'workspace-a', key);
    assert.ok(isSealed(sealed));
    assert.ok(!sealed.includes('ghp_secret'));
    assert.deepEqual(openSecret(sealed, 'workspace-a', key), { ok: true, value: 'ghp_secret' });
    assert.deepEqual(openSecret(sealed, 'workspace-b', key), { ok: false, reason: 'damaged' });
    assert.deepEqual(openSecret(sealed, 'workspace-a', other), { ok: false, reason: 'other_key' });
    assert.deepEqual(openSecret(sealed, 'workspace-a', null), { ok: false, reason: 'no_key' });
  });

  it('is different every time, for the same value', () => {
    assert.notEqual(sealSecret('ghp_secret', 'w', key), sealSecret('ghp_secret', 'w', key));
  });

  it('refuses a tampered or malformed value', () => {
    const [version, id, iv, body] = sealSecret('ghp_secret', 'w', key).split('.') as [string, string, string, string];
    const flipped = Buffer.from(body, 'base64url');
    flipped[0] = flipped[0]! ^ 1;
    assert.deepEqual(openSecret([version, id, iv, flipped.toString('base64url')].join('.'), 'w', key), { ok: false, reason: 'damaged' });
    for (const bad of ['ghp_plain', 'sealed1.x', `sealed1.${id}.${iv}.`, 'sealed2.a.b.c']) {
      assert.equal(openSecret(bad, 'w', key).ok, false, bad);
    }
  });

  it('needs a secret to derive its key from', () => {
    assert.equal(sealingKey({}), null);
    assert.equal(sealingKey({ BETTER_AUTH_SECRET: '' }), null);
    assert.notEqual(key.id, other.id);
  });
});
