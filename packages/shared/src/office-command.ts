import { normalisePromptProse } from './agent.js';
import { isAgentCommand, type ParsedCommand } from './commands.js';
import type { ChannelActor } from './conversation.js';
import { tidyDisplayText } from './workspace.js';

/**
 * Office commands: `!` verbs the people in an office make for themselves.
 *
 * `!review @engineering https://github.com/…/pull/155` is what somebody
 * would otherwise type as "@engineering can you review this, and here is how
 * we review" for the hundredth time. The office keeps the "how" — the
 * command's instructions — and every agent the line reaches gets them with
 * it, the way a team's members get the team's.
 *
 * These are not the owner commands in `commands.ts`, and the difference is
 * the point. `!cancel` and friends are the harness acting on its agent with
 * no model call, and only the agent's owner is obeyed. An office command is
 * a message with a standing brief attached: it starts an ordinary turn, and
 * it reaches exactly who the same line without the `!` would have reached.
 * It grants nobody anything they could not already do by asking in words, so
 * anyone in the office may use one, and any member may make one.
 *
 * A command belongs to the office, like a team. What a client needs to know
 * about one is here; the rows and the rules that need a database are in
 * `db/commands.ts`.
 */

/** Who a command goes to when the line names nobody. */
export interface OfficeCommandTarget {
  kind: 'agent' | 'team';
  /** `agents.id` or `teams.id`. */
  id: string;
  /** As it is called now: what a mention of it would say. */
  name: string;
}

/** A command as a client sees it: enough to offer it in the picker and explain it. */
export interface OfficeCommandRef {
  id: string;
  /** Without the `!`, lowercase. */
  name: string;
  /** One line, shown in the picker. */
  summary: string;
  /** What to type after it, as the picker shows it: `<pull request link>`. Empty when it takes nothing. */
  argumentHint: string;
  /** Null: whoever the line names, or walks up to. */
  defaultTarget: OfficeCommandTarget | null;
}

/**
 * Held to a mention token's shape and lowercased: it is typed after `!`, and
 * `parseAgentCommand` reads the same characters and lowercases what it reads.
 */
export const OFFICE_COMMAND_NAME_MAX_LENGTH = 32;
export const OFFICE_COMMAND_SUMMARY_MAX_LENGTH = 120;
export const OFFICE_COMMAND_ARGUMENT_HINT_MAX_LENGTH = 60;
/**
 * Far more than an agent's own instructions (`AGENT_INSTRUCTIONS_MAX_LENGTH`):
 * those ride on every priming turn, while a command's are sent only on the
 * turn it starts — and a brief worth keeping, a review checklist say, runs
 * to pages.
 */
export const OFFICE_COMMAND_INSTRUCTIONS_MAX_LENGTH = 16_000;

const COMMAND_NAME = /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u;

/** Lowercased and trimmed, with a leading `!` forgiven: people type it. */
export function normaliseOfficeCommandName(input: unknown): string {
  return String(input ?? '')
    .trim()
    .replace(/^!/, '')
    .toLowerCase()
    .slice(0, OFFICE_COMMAND_NAME_MAX_LENGTH);
}

/** Whether a (normalised) name can be typed after `!` and be read back. */
export function isOfficeCommandName(name: string): boolean {
  return name.length > 0 && COMMAND_NAME.test(name);
}

/**
 * A built-in verb's name is not free. `!cancel` has to mean stop, in every
 * office, forever — a command that took its name would take the one word you
 * reach for when something is going wrong.
 */
export function isReservedCommandName(name: string): boolean {
  return isAgentCommand(name);
}

export function normaliseOfficeCommandSummary(input: unknown): string {
  return typeof input === 'string' ? tidyDisplayText(input, OFFICE_COMMAND_SUMMARY_MAX_LENGTH) : '';
}

export function normaliseOfficeCommandArgumentHint(input: unknown): string {
  return typeof input === 'string'
    ? tidyDisplayText(input, OFFICE_COMMAND_ARGUMENT_HINT_MAX_LENGTH)
    : '';
}

/** Same rules as an agent's own instructions — they land in the same prompt — with a cap of their own. */
export function normaliseOfficeCommandInstructions(input: unknown): string {
  return normalisePromptProse(input, OFFICE_COMMAND_INSTRUCTIONS_MAX_LENGTH);
}

/** Any member may make one. A guest is passing through and has no agents to brief. */
export function mayCreateOfficeCommands(actor: ChannelActor): boolean {
  return actor.role !== null;
}

/**
 * Whoever made it may change or delete it, and office admins may change or
 * delete any — a command is shared vocabulary, and somebody has to be able to
 * tidy it after its author has gone.
 */
export function mayEditOfficeCommand(
  actor: ChannelActor,
  command: { createdBy: string | null },
): boolean {
  if (actor.role === 'owner' || actor.role === 'admin') return true;
  return actor.role !== null && command.createdBy === actor.userId;
}

/**
 * Who a command is said to be by, wherever that is read: in the brief's
 * heading an agent sees, and beside the command in Settings.
 *
 * Whose it is, then whose words are in it when that is somebody else. A
 * command its maker wrote is "Ana". One Ana's agent wrote for her is "Ana,
 * via Marvin": she answers for it, and the agents it reaches can tell a
 * brief a colleague wrote from one a person did. One an admin rewrote — by
 * hand or through an agent of theirs — is "Ana, changed by Josh" or "Ana,
 * changed by Josh, via Arthur", because the brief is now Josh's and Ana's
 * name alone over it would be a lie. Empty when nobody is left to name.
 */
export function officeCommandAuthorLabel(command: {
  createdBy: string | null;
  createdByName: string;
  writtenBy?: string | null;
  writtenByName?: string | null;
  writtenByAgentName?: string | null;
}): string {
  const owner = command.createdByName.trim();
  const writer = (command.writtenByName ?? '').trim();
  const agent = (command.writtenByAgentName ?? '').trim();
  const via = agent.length > 0 ? `, via ${agent}` : '';
  const sameHand = command.writtenBy === null || command.writtenBy === undefined || command.writtenBy === command.createdBy;
  if (sameHand) {
    if (owner.length > 0) return `${owner}${via}`;
    return agent.length > 0 ? `${agent}, an agent` : '';
  }
  const by = writer.length > 0 ? `${writer}${via}` : agent.length > 0 ? `${agent}, an agent` : '';
  if (by.length === 0) return owner;
  return owner.length > 0 ? `${owner}, changed by ${by}` : by;
}

/** The office command a parsed `!` line names, if it names one. */
export function findOfficeCommand<T extends Pick<OfficeCommandRef, 'name'>>(
  parsed: ParsedCommand | null,
  commands: readonly T[],
): T | null {
  if (!parsed || parsed.known) return null;
  return commands.find((command) => command.name === parsed.name) ?? null;
}

/** The picker's and help panel's way of writing it: `!review @reviewers <pull request link>`. */
export function officeCommandUsage(command: OfficeCommandRef): string {
  return [
    `!${command.name}`,
    command.defaultTarget ? `[@${command.defaultTarget.name}]` : '@name',
    command.argumentHint,
  ]
    .filter((part) => part.length > 0)
    .join(' ');
}
