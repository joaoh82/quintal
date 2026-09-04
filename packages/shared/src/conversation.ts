import type { PlayerKind } from './player.js';
import { slugify, type MembershipRole } from './workspace.js';

/**
 * Where a thing is said.
 *
 * One model for three shapes of conversation. A `zone` is a room on the map —
 * whoever stands in it is in the conversation, nobody is a member. A `channel`
 * names its members. A `dm` is a channel nobody can find: members fixed at
 * creation, never listed. Zones and channels exist; a DM is the same table
 * with a `hidden` rule.
 */
export const CONVERSATION_KINDS = ['zone', 'channel', 'dm'] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];

/**
 * The zone a tile outside every zone belongs to.
 *
 * Most of an office is corridor and open floor, and a conversation held there
 * is still a conversation: an agent asked to "come here" is usually asked from
 * the middle of the room, not from inside one. Rather than leave those words
 * with nowhere to go, every map has one implicit zone for everything that is
 * not otherwise a zone.
 */
export const FLOOR_ZONE_ID = 'floor';
export const FLOOR_ZONE_LABEL = 'the open floor';

// --- channels --------------------------------------------------------------

/** A channel as a client needs to know it: enough to name it and post to it. */
export interface ChannelRef {
  id: string;
  name: string;
  /** What it is called in an `@`-less world: `engineering`, rendered `#engineering`. */
  slug: string;
}

export const CHANNEL_NAME_MAX_LENGTH = 40;

/**
 * A channel's identifier from its name: `Engineering & Ops` → `engineering-ops`.
 *
 * Empty when nothing survives — a name that is all punctuation is not a name.
 * Same slug rules as workspaces so nobody has to learn two.
 */
export function channelSlug(name: string): string {
  const slug = slugify(name.trim().slice(0, CHANNEL_NAME_MAX_LENGTH));
  return slug === 'workspace' && !/workspace/i.test(name) ? '' : slug;
}

/** Somebody acting on a channel: who they are, and what they are in the office. */
export interface ChannelActor {
  userId: string;
  /** Their membership in the office, or null for a guest. */
  role: MembershipRole | null;
}

/** Somebody being added to, or removed from, a channel. */
export interface ChannelSubject {
  id: string;
  kind: PlayerKind;
  /** For an agent: `users.id` of the person accountable for it. */
  ownerUserId?: string | null;
}

/**
 * May this person put this member into a channel?
 *
 * People may be added by any member of the office. An agent may be added
 * **only by its owner**: a colleague who could pull my agent into their
 * channel could put words in front of it that I never see, and it answers as
 * me. Same shape as `hostMayActAs` — the owner is the one accountable, so the
 * owner is the one who decides where it goes.
 *
 * Guests may not add anybody, themselves included: a visit is not a
 * membership, and a channel outlives the visit.
 */
export function mayAddToChannel(actor: ChannelActor, subject: ChannelSubject): boolean {
  if (actor.role === null) return false;
  if (subject.kind === 'human') return true;
  return subject.ownerUserId === actor.userId;
}

/**
 * May this person take this member out of a channel?
 *
 * Anyone may leave. An agent goes at its owner's word, or an office
 * admin's — the same people who could revoke it. Another person goes at the
 * word of whoever made the channel, or an office admin.
 */
export function mayRemoveFromChannel(
  actor: ChannelActor,
  channel: { createdBy: string | null },
  subject: ChannelSubject,
): boolean {
  if (actor.role === null) return false;
  if (subject.kind === 'human' && subject.id === actor.userId) return true;
  const admin = actor.role === 'owner' || actor.role === 'admin';
  if (subject.kind === 'agent') return admin || subject.ownerUserId === actor.userId;
  return admin || channel.createdBy === actor.userId;
}
