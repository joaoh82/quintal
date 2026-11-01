import {
  FLOOR_ZONE_ID,
  FLOOR_ZONE_LABEL,
  WORKING_IN_ZONE,
  activityTerminal,
  mergeActivity,
  workingInTokens,
  type ChannelRef,
  type MapZone,
  type PublicActivity,
  type RosterEntry,
} from '@quintal/shared';

import { NEARBY, channelKey, parseKey, zoneKey, type ConversationKey } from '../conversationKey';
import type { Transcript } from '../useConversations';

/**
 * What the desk panel shows of an agent's work, from what this client
 * already holds. Pure, so the two decisions it makes — which turn is the
 * one on the screen, and where "go to the conversation" goes — are pinned
 * without a browser.
 */

export interface FoundTurn {
  /** The transcript the turn was read from, which is a conversation that can be opened. */
  key: ConversationKey;
  activity: PublicActivity;
}

/**
 * The agent's turn to put on the screen: one still running, else the most
 * recently touched. From whichever transcripts this client has, which is
 * the privacy rule applied already: the office sends a step only to those
 * who may read the conversation it is in. A zone turn lands in the zone's
 * transcript and, when heard, in `nearby` too; the zone's wins, because
 * nearby is wherever you happened to be standing.
 */
export function currentTurn(
  transcripts: Record<ConversationKey, Transcript>,
  agentId: string,
): FoundTurn | null {
  let best: FoundTurn | null = null;
  const keys = Object.keys(transcripts).sort((a, b) => Number(a === NEARBY) - Number(b === NEARBY));
  for (const key of keys) {
    for (const line of transcripts[key]?.messages ?? []) {
      const activity = line.activity;
      if (!activity || activity.agentId !== agentId) continue;
      if (!best || newer(activity, best.activity)) best = { key, activity };
    }
  }
  return best;
}

function newer(candidate: PublicActivity, held: PublicActivity): boolean {
  const candidateOpen = !activityTerminal(candidate.state);
  const heldOpen = !activityTerminal(held.state);
  if (candidateOpen !== heldOpen) return candidateOpen;
  return candidate.updatedAt > held.updatedAt;
}

/** The conversation a turn is in, as this client names it. */
export function keyOf(activity: PublicActivity): ConversationKey {
  if (activity.channelId) return channelKey(activity.channelId);
  if (activity.zoneId) return zoneKey(activity.zoneId);
  return NEARBY;
}

/**
 * The better of two turns to hold: the same turn by sequence, as every
 * transcript merges it; otherwise the one the screen would show. Returns
 * one of its arguments, never a copy, so a caller can tell which won.
 */
export function preferTurn(held: PublicActivity | null, candidate: PublicActivity): PublicActivity {
  if (!held) return candidate;
  if (held.turnId === candidate.turnId) return mergeActivity(held, candidate);
  return newer(candidate, held) ? candidate : held;
}

/**
 * What goes on the screen: the turn held since the panel opened (see
 * `useScreenTurn`), or the transcripts' — whichever `preferTurn` picks.
 * The held copy is there for the turn a transcript has let go of; the
 * transcripts are there for the turn that ended before the panel opened.
 */
export function screenTurn(
  held: PublicActivity | null,
  transcripts: Record<ConversationKey, Transcript>,
  agentId: string,
): FoundTurn | null {
  const found = currentTurn(transcripts, agentId);
  if (!held) return found;
  if (!found) return { key: keyOf(held), activity: held };
  const best = preferTurn(held, found.activity);
  return best === found.activity ? found : { key: keyOf(held), activity: best };
}

export interface Destination {
  key: ConversationKey;
  /** As the button reads it: `#engineering`, `Josh`, `Agent Bay`. */
  label: string;
}

/**
 * Where to go to read this agent: the conversation its shown turn is in,
 * and the ones its work says it is answering — of those, only the ones
 * this client can open. A channel the client is not in is not offered,
 * and not named: the office withholds that, and so does this.
 */
export function destinations(
  entry: RosterEntry,
  turn: FoundTurn | null,
  channels: readonly ChannelRef[],
  zones: readonly MapZone[],
): Destination[] {
  const found = new Map<ConversationKey, string>();
  const offer = (key: ConversationKey): void => {
    if (!found.has(key)) found.set(key, labelFor(key, channels, zones));
  };
  if (turn) offer(turn.key);
  if (entry.workingSince > 0) {
    for (const token of workingInTokens(entry.workingIn)) {
      if (token === WORKING_IN_ZONE) offer(zoneKey(entry.zoneId));
      else if (channels.some((channel) => channel.id === token)) offer(channelKey(token));
    }
  }
  return [...found].map(([key, label]) => ({ key, label }));
}

export function labelFor(
  key: ConversationKey,
  channels: readonly ChannelRef[],
  zones: readonly MapZone[],
): string {
  if (key === NEARBY) return 'nearby';
  const { channelId, zoneId } = parseKey(key);
  if (channelId) {
    const channel = channels.find((candidate) => candidate.id === channelId);
    if (!channel) return 'a channel';
    return channel.kind === 'dm' ? channel.name : `#${channel.slug}`;
  }
  if (zoneId === FLOOR_ZONE_ID) return FLOOR_ZONE_LABEL;
  return zones.find((zone) => zone.id === zoneId)?.label ?? zoneId ?? 'somewhere';
}
