import {
  findOfficeCommand,
  officeCommandUsage,
  parseAgentCommand,
  type AgentCommandCall,
  type PlayerKind,
} from '@quintal/shared';
import { officeCommandRef, type OfficeCommandSummary } from '@quintal/shared/db';

import type { Reach } from './mentions.js';

/**
 * A line that is one of the office's own commands, as the room reads it.
 *
 * The text is never rewritten — `!review @engineering <link>` stays that in
 * the transcript — and the line reaches whoever it would have reached
 * without the `!`. Two things are added: the instructions, on the event each
 * agent the line reaches is sent, and the command's default target, as if it
 * had been named, when the line names nobody.
 *
 * Pure, so the spatial path and the channel path read a command the same way
 * and a test can ask what `!review <link>` means with nobody named.
 */

export interface CommandLine {
  command: OfficeCommandSummary;
  /** Everything after the verb and its `@target`, verbatim. */
  args: string;
  /**
   * The names the line is aimed at: the ones it says, or the command's
   * default when it says none. Resolve these instead of the ones read from
   * the text.
   */
  named: string[];
  /** True when the line is for somebody in particular — named, or the default. */
  aimed: boolean;
}

/**
 * Read a line against the office's commands. Null unless a person typed one
 * of them: an agent writing `!review` is talking about the command, and
 * briefing other agents through commands is a loop not worth starting.
 */
export function readCommandLine(
  text: string,
  speakerKind: PlayerKind,
  commands: readonly OfficeCommandSummary[],
  named: readonly string[],
): CommandLine | null {
  if (speakerKind !== 'human') return null;
  const parsed = parseAgentCommand(text);
  const command = findOfficeCommand(parsed, commands);
  if (!parsed || !command) return null;

  // The default only when the line names nobody at all. `!review @nobody`
  // was aimed — at somebody who is not here — and sending it to the default
  // instead would be guessing what a typo meant; kept as said, it resolves to
  // nobody and the sender is told so.
  const aimedAt =
    named.length > 0
      ? [...named]
      : parsed.target !== null
        ? [parsed.target]
        : command.defaultTarget !== null
          ? [command.defaultTarget.name]
          : [];

  return { command, args: parsed.body, named: aimedAt, aimed: aimedAt.length > 0 };
}

/**
 * What one agent is told about the command, or nothing.
 *
 * A line aimed at somebody else carries no command for this agent: it is
 * conversation it overheard, and the harness treats it as an unknown `!`
 * line, which is to say it does nothing with it.
 */
export function commandCallFor(
  line: CommandLine,
  reach: Reach | undefined,
): AgentCommandCall | undefined {
  const addressed = reach !== undefined;
  if (line.aimed && !addressed) return undefined;
  return {
    name: line.command.name,
    instructions: line.command.instructions,
    args: line.args,
    definedBy: line.command.createdByName,
    addressed,
  };
}

/**
 * Who a command is for, out of who the line reaches.
 *
 * Usually the same thing. In a direct message every line reaches the other
 * party whether or not it names them — but a command that was aimed, by
 * name or by its default, is for whoever it was aimed at: `!review @nobody`
 * in a DM with Arthur is a typo, not a request of Arthur. The implicit
 * reach stands in only when the command names nobody.
 */
export function commandReach<T>(
  line: CommandLine,
  named: ReadonlyMap<string, T>,
  implicit: ReadonlyMap<string, T>,
): ReadonlyMap<string, T> {
  return line.aimed ? named : implicit;
}

/**
 * Will the agent start a turn for this call? The room counts a command
 * heard only when it will, so that "reached no agent" is said exactly when
 * nothing happens.
 *
 * Mirrors the harness: an addressed call is taken wherever it arrives; an
 * unaddressed one only as a walk-up — earshot carries the line, but an agent
 * eight tiles off hears it as conversation, not as being asked.
 */
export function commandTaken(
  call: AgentCommandCall,
  delivery: { woken: boolean; withinEarshot: boolean; distance: number; walkUpRadius: number },
): boolean {
  if (call.addressed) return delivery.woken || delivery.withinEarshot;
  return delivery.withinEarshot && delivery.distance <= delivery.walkUpRadius;
}

/**
 * Said to the sender when no agent took the command — a name that is not an
 * agent here, a team with nobody in this conversation, or nobody named and
 * nobody near. Otherwise the line sits in the transcript looking asked.
 */
export function unheardNotice(line: CommandLine): string {
  const usage = officeCommandUsage(officeCommandRef(line.command));
  const where = line.aimed
    ? `${line.named.map((name) => `@${name}`).join(', ')}: no agent of that name is in this conversation.`
    : 'Nobody was named and no agent is near.';
  return `!${line.command.name} reached no agent. ${where} ${usage}`;
}
