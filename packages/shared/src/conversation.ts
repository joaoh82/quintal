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

/**
 * A conversation with members, as a client needs to know it: enough to name
 * it and post to it. Zones are not these — a zone has no members.
 */
export interface ChannelRef {
  id: string;
  kind: 'channel' | 'dm';
  /**
   * A channel's name as written. For a DM, the *other* party's name — a DM
   * has no name of its own, so the office fills this in for whoever is being
   * told about it.
   */
  name: string;
  /** A channel's identifier: `engineering`, rendered `#engineering`. Empty for a DM. */
  slug: string;
}

/** How to print one in a tab or a prompt: `#engineering`, or the other person. */
export function channelLabel(ref: Pick<ChannelRef, 'kind' | 'name' | 'slug'>): string {
  return ref.kind === 'dm' ? ref.name : `#${ref.slug}`;
}

/**
 * The identity of a direct message between two members, stored in `slug`.
 *
 * Deterministic, so opening "the DM with Marvin" twice finds the same row —
 * the unique index on (office, slug) does the finding. Sorted, so it does not
 * matter who opened it. The prefix keeps it out of the namespace a channel
 * name could ever land in, since a slug never contains a colon.
 */
export function dmKey(a: string, b: string): string {
  return `dm:${[a, b].sort().join(':')}`;
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

/** Somebody being added to, or removed from, a channel — or messaged directly. */
export interface ChannelSubject {
  id: string;
  kind: PlayerKind;
  /** For an agent: `users.id` of the person accountable for it. */
  ownerUserId?: string | null;
  /** For an agent: what it is allowed to do. Needed to answer `mayOpenDm`. */
  scopes?: readonly string[];
}

/**
 * May this person open a direct message with this member?
 *
 * With a person: any member of the office, with any member. With an agent:
 * **its owner, and nobody else** — the same rule as adding it to a channel,
 * for the same reason. A DM is the most private place there is, and an agent
 * answers as its owner; a colleague talking to my agent where I cannot see it
 * is exactly what the channel rule exists to prevent, only more so. The agent
 * also has to have the `dm` scope: an owner can make one that lives only in
 * public.
 *
 * Nobody messages themselves, and guests message nobody.
 */
export function mayOpenDm(actor: ChannelActor, subject: ChannelSubject): boolean {
  if (actor.role === null) return false;
  if (subject.id === actor.userId) return false;
  if (subject.kind === 'human') return true;
  if (subject.ownerUserId !== actor.userId) return false;
  return (subject.scopes ?? []).includes('dm');
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
