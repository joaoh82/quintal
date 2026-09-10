import type { AgentViaTeam, PlayerKind } from '@quintal/shared';

/**
 * Who a line addressed, once `@name` may mean a team.
 *
 * A mention resolves by name against everybody who could hear it — a
 * channel's members, or the people in the room — and against the office's
 * teams. A team's name expands to its members: each one the line can reach
 * is addressed as if by name, and told it was one of several, with the
 * others' names, so the three of them can sort out who takes the work
 * rather than all start it. The text is never rewritten; `@engineering`
 * stays `@engineering` in the transcript.
 *
 * Pure, so the channel path and the spatial path resolve the same way and
 * a test can ask what `@engineering` means with two of three members here.
 */

export interface Addressable {
  /** Stable id: `users.id` or `agents.id`. */
  id: string;
  name: string;
  kind: PlayerKind;
}

export interface TeamRoster {
  id: string;
  name: string;
  members: readonly { id: string; name: string }[];
}

export interface Reach {
  /** Set when the line reached this member through a team's name. */
  viaTeam?: AgentViaTeam;
}

export interface Resolution {
  /** Everyone the line addressed and can reach, by stable id. Never the speaker. */
  reached: Map<string, Reach>;
  /** Teams named whose members are, in part or whole, not in the audience. */
  absent: { team: string; names: string[] }[];
}

export function resolveMentions(
  addressed: readonly string[],
  audience: readonly Addressable[],
  teams: readonly TeamRoster[],
  speakerId: string,
): Resolution {
  const wanted = new Set(addressed.map((name) => name.toLowerCase()));
  const present = new Map(audience.map((member) => [member.id, member]));
  const reached = new Map<string, Reach>();
  const absent: Resolution['absent'] = [];

  // By name first: a member addressed directly is addressed directly, even
  // if a team it is on was named in the same breath.
  for (const member of audience) {
    if (member.id === speakerId) continue;
    if (wanted.has(member.name.toLowerCase())) reached.set(member.id, {});
  }

  for (const team of teams) {
    if (!wanted.has(team.name.toLowerCase())) continue;
    const here = team.members.filter((member) => present.has(member.id) && member.id !== speakerId);
    const missing = team.members.filter((member) => !present.has(member.id));
    if (missing.length > 0) absent.push({ team: team.name, names: missing.map((m) => m.name) });
    for (const member of here) {
      if (reached.has(member.id)) continue;
      reached.set(member.id, {
        viaTeam: {
          name: team.name,
          members: here.filter((other) => other.id !== member.id).map((other) => other.name),
        },
      });
    }
  }

  return { reached, absent };
}

/** "Grok is not in #engineering" / "Codex and Grok are not in the office right now". */
export function absentNotice(
  absent: Resolution['absent'],
  where: string,
): string | null {
  if (absent.length === 0) return null;
  return absent
    .map(({ team, names }) => {
      const list =
        names.length === 1
          ? names[0]
          : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
      return `@${team}: ${list} ${names.length === 1 ? 'is' : 'are'} not in ${where}.`;
    })
    .join(' ');
}
