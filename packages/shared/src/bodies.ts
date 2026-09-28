import { sha256 } from '@noble/hashes/sha2.js';

/**
 * Which of the twelve bodies an occupant walks around in.
 *
 * The office used to render everybody with one sprite, which made a crowded
 * room unreadable: you could tell who was who only by reading nameplates. The
 * asset pack ships twelve distinct people, so the room can be read at a
 * glance instead.
 *
 * Nobody picks one yet. The body is derived from the identity, which means it
 * costs no storage, needs no migration, and is the same on every screen and
 * across reconnects — the same property the identicon relies on. A chooser can
 * be added later without moving this: it would supply the id that this
 * function currently guesses.
 */
export const BODIES = [
  'aria',
  'milo',
  'sora',
  'nadia',
  'theo',
  'imani',
  'hugo',
  'priya',
  'luca',
  'mei',
  'sam',
  'rosa',
] as const;

export type BodyId = (typeof BODIES)[number];

export function isBodyId(value: string): value is BodyId {
  return (BODIES as readonly string[]).includes(value);
}

/**
 * A body for a seed, stably.
 *
 * SHA-256 rather than a cheap string hash because the seeds are short and
 * structured — sequential session ids, names differing in one letter — and a
 * weak hash clusters those onto the same body, which is exactly the case this
 * exists to avoid. Two people in a room of twelve may still collide; that is
 * the birthday problem, not a bug, and the nameplate still separates them.
 */
export function bodyForSeed(seed: string): BodyId {
  const hash = sha256(new TextEncoder().encode(seed || 'anonymous'));
  const index = (((hash[0] ?? 0) << 8) | (hash[1] ?? 0)) % BODIES.length;
  return BODIES[index] as BodyId;
}
