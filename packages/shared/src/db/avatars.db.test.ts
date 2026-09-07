import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { LocalObjectStore } from '../storage/index.js';
import { AvatarRejected, assertAvatarPng, clearAvatar, currentAvatarKey, setAvatar } from './avatars.js';
import { createTestDb, createTestUser } from './testing.js';

/**
 * A face, stored and replaced.
 *
 * The rules are the cheap ones the server can check from bytes: a PNG, at
 * the size the client was asked for, under the size cap. And a replacement
 * must leave nothing behind, because nothing sweeps.
 */

/** A PNG header claiming the given size. Enough for the checks; not a real image. */
function pngOf(width: number, height: number, extra = 0): Uint8Array {
  const bytes = new Uint8Array(33 + extra);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

describe('what an avatar may be', () => {
  it('is a 128×128 PNG under the cap, checked from the bytes', () => {
    assert.doesNotThrow(() => assertAvatarPng(pngOf(128, 128)));
    assert.throws(() => assertAvatarPng(pngOf(129, 128)), AvatarRejected);
    assert.throws(() => assertAvatarPng(pngOf(64, 64)), AvatarRejected);
    assert.throws(() => assertAvatarPng(new TextEncoder().encode('GIF89a')), AvatarRejected);
    assert.throws(() => assertAvatarPng(pngOf(128, 128, 70_000)), AvatarRejected);
  });
});

describe('storing a face', () => {
  it('replaces the old one without leaving it behind, and can be cleared', async () => {
    const db = await createTestDb();
    const josh = await createTestUser(db, 'Josh');
    const store = new LocalObjectStore(mkdtempSync(join(tmpdir(), 'quintal-avatars-')));

    assert.equal(await currentAvatarKey(db, josh.id), null);

    const first = await setAvatar(db, store, josh.id, pngOf(128, 128));
    assert.match(first, new RegExp(`^avatars/${josh.id}/[0-9a-f]{16}\\.png$`));
    assert.equal(await currentAvatarKey(db, josh.id), first);
    assert.ok(await store.get(first));

    const second = await setAvatar(db, store, josh.id, pngOf(128, 128));
    assert.notEqual(second, first, 'a new key, so caches never show a stale face');
    assert.equal(await store.get(first), null, 'the old bytes are gone');
    assert.ok(await store.get(second));

    assert.equal(await clearAvatar(db, store, josh.id), true);
    assert.equal(await currentAvatarKey(db, josh.id), null);
    assert.equal(await store.get(second), null);
    assert.equal(await clearAvatar(db, store, josh.id), false, 'nothing left to clear');
  });

  it('stores nothing for bytes it refuses', async () => {
    const db = await createTestDb();
    const josh = await createTestUser(db, 'Josh');
    const store = new LocalObjectStore(mkdtempSync(join(tmpdir(), 'quintal-avatars-')));

    await assert.rejects(setAvatar(db, store, josh.id, pngOf(50, 50)), AvatarRejected);
    assert.equal(await currentAvatarKey(db, josh.id), null);
  });
});
