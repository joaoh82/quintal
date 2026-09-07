import { randomBytes } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { AVATAR_SIZE } from '../identicon.js';
import { AVATAR_MAX_BYTES, pngDimensions, putReplacing, sniffImageType } from '../storage/index.js';
import type { ObjectStore } from '../storage/index.js';
import type { Database } from './client.js';
import { users } from './schema.js';

/**
 * A person's face: the one object the office stores on their behalf.
 *
 * `users.image` holds the object's key, or null. The bytes live in the
 * object store, under a key namespaced by the user, and replacing a face
 * removes the previous one — there is no sweep, so nothing may be left
 * behind by design.
 */

export class AvatarRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AvatarRejected';
  }
}

/**
 * Only a PNG, only small, only square at the size the client was asked to
 * produce. The client re-encodes with a canvas — which is also what strips
 * the metadata a camera leaves in a photograph — and the server checks the
 * result is exactly that, from the bytes rather than the request.
 */
export function assertAvatarPng(body: Uint8Array): void {
  if (body.byteLength > AVATAR_MAX_BYTES) {
    throw new AvatarRejected(`an avatar is at most ${AVATAR_MAX_BYTES} bytes`);
  }
  if (sniffImageType(body) !== 'image/png') throw new AvatarRejected('an avatar is a PNG');
  const dims = pngDimensions(body);
  if (!dims || dims.width !== AVATAR_SIZE || dims.height !== AVATAR_SIZE) {
    throw new AvatarRejected(`an avatar is ${AVATAR_SIZE}×${AVATAR_SIZE} pixels`);
  }
}

export function avatarKeyFor(userId: string): string {
  return `avatars/${userId}/${randomBytes(8).toString('hex')}.png`;
}

/** Store a new face and forget the old one. Returns the new key. */
export async function setAvatar(
  db: Database,
  store: ObjectStore,
  userId: string,
  body: Uint8Array,
): Promise<string> {
  assertAvatarPng(body);
  const previous = await currentAvatarKey(db, userId);
  const key = avatarKeyFor(userId);
  await putReplacing(store, previous, key, body, { contentType: 'image/png' });
  await db.update(users).set({ image: key }).where(eq(users.id, userId));
  return key;
}

/** Back to the derived face. Returns whether there was one to remove. */
export async function clearAvatar(
  db: Database,
  store: ObjectStore,
  userId: string,
): Promise<boolean> {
  const previous = await currentAvatarKey(db, userId);
  await db.update(users).set({ image: null }).where(eq(users.id, userId));
  if (previous === null) return false;
  await store.delete(previous);
  return true;
}

export async function currentAvatarKey(db: Database, userId: string): Promise<string | null> {
  const row = (
    await db.select({ image: users.image }).from(users).where(eq(users.id, userId)).limit(1)
  )[0];
  return row?.image ?? null;
}
