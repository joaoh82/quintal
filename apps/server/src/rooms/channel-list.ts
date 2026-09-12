import type { AgentTeam, ChannelRef, TeamRef } from '@quintal/shared';

/**
 * A fingerprint of what one person sees of channels: the ones they are in,
 * and the ones they could join. Sent only when it changes.
 *
 * The two halves are kept apart. The first version joined them into one
 * string, and moving a channel from "could join" to "in" left that string
 * exactly as it was — so `/join` on the last channel in the list did its
 * work on the server and told nobody. The client sat showing the channel as
 * open, with no tab for it, until the next unrelated change.
 */
export function channelListSignature(
  channels: readonly ChannelRef[],
  available: readonly ChannelRef[],
  teams: readonly TeamRef[] = [],
): string {
  const part = (list: readonly ChannelRef[]) =>
    list
      .map(
        (channel) =>
          // The read cursor is in the fingerprint and `lastMessageAt` is not,
          // and the difference is who learns things another way. A new line
          // arrives as `channel_chat` on every session that can see it, so a
          // list resent for it would say nothing new. A read has no such
          // broadcast: without this, marking a channel read on the laptop
          // would leave the desktop showing its dot until something else
          // changed — which is the bug this whole cursor exists to fix.
          `${channel.id}:${channel.kind}:${channel.slug}:${channel.name}:${channel.lastReadAt ?? ''}`,
      )
      .join(',');
  // Teams ride on the same message: a renamed team, or a new member, is a
  // change the picker has to hear about.
  const teamPart = teams
    .map((team) => `${team.id}:${team.name}:${team.members.map((member) => member.id).join('+')}`)
    .join(',');
  return `${part(channels)}|${part(available)}|${teamPart}`;
}

/**
 * A fingerprint of what one agent is told about its teams. Everything the
 * prompt is built from is in it — name, description, instructions, the
 * roll — because a changed instruction that nobody re-sent is a team whose
 * rule its members are not following.
 */
export function agentTeamsSignature(teams: readonly AgentTeam[]): string {
  return teams
    .map(
      (team) =>
        `${team.id}:${team.name}:${team.description}:${team.instructions}:${team.members.join('+')}`,
    )
    .join(',');
}
