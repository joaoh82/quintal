import { WORKING_IN_ZONE, workingInTokens, type RosterEntry } from '@quintal/shared';

import { parseKey, type ConversationKey } from './conversationKey';

/**
 * Which agents are working *in the conversation you are looking at*.
 *
 * The map shows an agent's status over its head; a channel showed nothing
 * while an agent answered in it, which read as being ignored. An agent's
 * status carries where the work is — the channel or DM of the turn, or
 * nothing for a zone turn — so a transcript can show the agents answering
 * in it and only those.
 *
 * For a channel or DM: agents whose work is that conversation. For a zone or
 * nearby: agents standing in that zone doing spatial work — a channel reply
 * is not happening in the room, even if the agent is.
 *
 * An agent may be answering several conversations at once, so `workingIn`
 * is a list: it shows in every conversation it names, and in its zone only
 * when some of the work is spatial.
 */
export interface Working {
  name: string;
  status: string;
  emote: string;
}

export function workingHere(
  roster: readonly RosterEntry[],
  active: ConversationKey,
  myZone: string,
): Working[] {
  return agentsIn(roster, active, myZone)
    .filter((entry) => entry.status.length > 0 || entry.emote.length > 0)
    .map((entry) => ({ name: entry.name, status: entry.status, emote: entry.emote }));
}

/**
 * The clock on a conversation's row: how long agents have been working in
 * it, and which ones.
 *
 * `anchorAt` is the earliest start among them, so a second agent joining
 * does not reset a timer somebody has been watching. Only agents with a
 * clock count — a balloon alone is not work — and the answer is null when
 * nobody is working here, so a row can show nothing rather than `0s`.
 */
export interface ActiveWork {
  /** ms since epoch, on the office's clock. */
  anchorAt: number;
  agents: string[];
}

export function activeWorkFor(
  roster: readonly RosterEntry[],
  key: ConversationKey,
  myZone: string,
): ActiveWork | null {
  const working = agentsIn(roster, key, myZone).filter((entry) => entry.workingSince > 0);
  if (working.length === 0) return null;
  return {
    anchorAt: Math.min(...working.map((entry) => entry.workingSince)),
    agents: working.map((entry) => entry.name),
  };
}

/** Agents whose work is in this conversation, whatever else is true of them. */
function agentsIn(
  roster: readonly RosterEntry[],
  key: ConversationKey,
  myZone: string,
): RosterEntry[] {
  const { channelId, zoneId } = parseKey(key);
  const here = zoneId ?? myZone;

  return roster
    .filter((entry) => entry.kind === 'agent')
    .filter((entry) => {
      const where = workingInTokens(entry.workingIn);
      return channelId
        ? where.includes(channelId)
        : where.includes(WORKING_IN_ZONE) && entry.zoneId === here;
    });
}
