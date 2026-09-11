import { normaliseAgentDescription, normaliseAgentInstructions } from './agent.js';
import type { ChannelActor } from './conversation.js';

/**
 * A team: a name for several agents at once.
 *
 * `@engineering` in a message reaches every member as a mention, all of them
 * read the same line and each other's replies, and they sort out among
 * themselves who takes it. Slack and Buzz have this, and it is what turns a
 * roster into a team: to get three reviewers on a pull request you name the
 * team, not three agents by hand.
 *
 * A team is an office object — it belongs to the workspace, not to whoever
 * made it — and it holds agents only. What a client needs to know about one
 * is here; the rows and the rules that need a database are in `db/teams.ts`.
 */

/** A member of a team, as a client shows it: enough to name and link it. */
export interface TeamMemberRef {
  /** `agents.id`. */
  id: string;
  name: string;
}

/** A team as a client sees it: enough to offer it in a picker and explain a chip. */
export interface TeamRef {
  id: string;
  name: string;
  description: string;
  members: TeamMemberRef[];
}

/** Held to the same shape as an agent's name, since the two sit in one list. */
export const TEAM_NAME_MAX_LENGTH = 40;

/**
 * A team name is what people type after `@`, so it has to be one mention
 * token: letters, digits, `-` and `_`, starting with a letter or digit. The
 * same shape `MENTION_PATTERN` reads — a team called "Front End" could be
 * made and never addressed.
 */
const MENTION_NAME = /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u;

export function normaliseTeamName(input: unknown): string {
  return String(input ?? '')
    .trim()
    .slice(0, TEAM_NAME_MAX_LENGTH);
}

/** Whether a (normalised) team name can be written after `@` and be read back. */
export function isMentionableTeamName(name: string): boolean {
  return name.length > 0 && MENTION_NAME.test(name);
}

/** Same caps as an agent's own description and instructions: they land in the same prompt. */
export const normaliseTeamDescription = normaliseAgentDescription;
export const normaliseTeamInstructions = normaliseAgentInstructions;

/**
 * May this person make, change or dissolve teams, and decide who is on them?
 *
 * Office admins, and only them. A team is a workspace object: putting an
 * agent on one means anyone can wake it with a single word, so the decision
 * sits with the people who could also revoke it. The per-owner rule for
 * channels (`mayAddToChannel`) is unchanged and applies when a team is added
 * to a channel member by member.
 */
export function mayManageTeams(actor: ChannelActor): boolean {
  return actor.role === 'owner' || actor.role === 'admin';
}

/** The subtitle under a team in a picker: `team · 3 agents`. */
export function teamPickerSubtitle(team: Pick<TeamRef, 'members'>): string {
  const n = team.members.length;
  return `team · ${n} ${n === 1 ? 'agent' : 'agents'}`;
}
