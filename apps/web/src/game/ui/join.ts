import type { ChannelRef } from '@quintal/shared';

/**
 * `/join`, resolved against what the office says about channels.
 *
 * It used to mean one thing — ask the server to add you to a channel — and
 * so typing `/join #engineering` when you were already in engineering was an
 * error dressed as a command. What people mean by it is "take me there": to
 * a channel you are in, switch; to one you could be in, join and switch; to
 * one that does not exist, say so and list what does.
 */

/** A channel the picker can offer, and whether you are already in it. */
export interface JoinTarget {
  slug: string;
  joined: boolean;
}

/** How to read `/join <what>`, given the channels you are in and could be in. */
export type JoinResolution =
  | { kind: 'switch'; channel: ChannelRef }
  | { kind: 'join'; slug: string }
  | { kind: 'unknown'; slug: string }
  | { kind: 'pick' };

export function normaliseSlug(input: string): string {
  return input.trim().replace(/^#/, '').toLowerCase();
}

export function resolveJoin(
  input: string,
  mine: readonly ChannelRef[],
  available: readonly ChannelRef[],
): JoinResolution {
  const slug = normaliseSlug(input);
  if (slug.length === 0) return { kind: 'pick' };

  const joined = mine.find((channel) => channel.kind === 'channel' && channel.slug === slug);
  if (joined) return { kind: 'switch', channel: joined };

  if (available.some((channel) => channel.kind === 'channel' && channel.slug === slug)) {
    return { kind: 'join', slug };
  }
  return { kind: 'unknown', slug };
}

/**
 * Everything `/join` could take you to: the channels you are in first,
 * because switching is the common case, then the ones you could join.
 */
export function joinTargets(
  mine: readonly ChannelRef[],
  available: readonly ChannelRef[],
): JoinTarget[] {
  const channels = (list: readonly ChannelRef[]) =>
    list.filter((channel) => channel.kind === 'channel');
  return [
    ...channels(mine).map((channel) => ({ slug: channel.slug, joined: true })),
    ...channels(available).map((channel) => ({ slug: channel.slug, joined: false })),
  ];
}

/**
 * The targets matching what has been typed so far. A leading `#` is what
 * people type by habit and means nothing; a match anywhere in the slug beats
 * having to know how a channel starts.
 */
export function matchJoinTargets(
  targets: readonly JoinTarget[],
  query: string,
  limit = 8,
): JoinTarget[] {
  const needle = normaliseSlug(query);
  const hit = (target: JoinTarget) => (needle.length === 0 ? true : target.slug.includes(needle));
  // Prefix matches first, then the rest: `/join en` should put `engineering`
  // above `general-engineering`.
  const matches = targets.filter(hit);
  const starts = matches.filter((target) => target.slug.startsWith(needle));
  const contains = matches.filter((target) => !target.slug.startsWith(needle));
  return [...starts, ...contains].slice(0, limit);
}
