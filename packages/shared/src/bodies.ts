import { sha256 } from '@noble/hashes/sha2.js';

/**
 * Which of the twelve bodies an occupant walks around in.
 *
 * The office used to render everybody with one sprite, which made a crowded
 * room unreadable: you could tell who was who only by reading nameplates. The
 * asset pack ships twelve distinct people, so the room can be read at a
 * glance instead.
 *
 * A person's is derived from their identity, which means it costs no storage
 * and is the same on every screen and across reconnects — the same property
 * the identicon relies on. An agent's is chosen, and kept in `agents.sprite_key`
 * (`bodyOfAgent`); one that predates the choice falls through to the same
 * derivation, so nobody's face changed when choosing arrived.
 *
 * Deliberately the *same* sheets for people and agents: an agent is marked out
 * by its nameplate and ring, never by being given a robot costume. Costumes
 * make them cute; badges make them legible.
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

/**
 * The body an agent walks around in: the one chosen for it, or for a row from
 * before there was a choice (`slate`, `amber`, `violet`, which were never
 * bodies) the one it has always had. The office draws by this same rule.
 */
export function bodyOfAgent(agent: { id: string; spriteKey: string }): BodyId {
  return isBodyId(agent.spriteKey) ? agent.spriteKey : bodyForSeed(agent.id);
}

/** A body for an agent nobody chose one for. */
export function randomBody(random: () => number = Math.random): BodyId {
  return BODIES[Math.floor(random() * BODIES.length) % BODIES.length] as BodyId;
}
