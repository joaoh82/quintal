import { normaliseAgentInstructions } from './agent.js';
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

/** Same rules and cap as an agent's own instructions: they land in the same prompt. */
export const normaliseOfficeCommandInstructions = normaliseAgentInstructions;

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
