import type { RosterEntry } from '@quintal/shared';

import { parseKey, type ConversationKey } from './useConversations';

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
  const { channelId, zoneId } = parseKey(active);
  const here = zoneId ?? myZone;

  return roster
    .filter((entry) => entry.kind === 'agent')
    .filter((entry) => entry.status.length > 0 || entry.emote.length > 0)
    .filter((entry) =>
      channelId ? entry.workingIn === channelId : entry.workingIn === '' && entry.zoneId === here,
    )
    .map((entry) => ({ name: entry.name, status: entry.status, emote: entry.emote }));
}
