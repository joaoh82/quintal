/**
 * Owner commands — the `!` verbs you type at an agent.
 *
 * The catalogue lives here rather than in the harness because two things need
 * it and they must not drift: the harness, which executes commands, and the
 * chat box, which offers them. A command the UI advertises but the harness
 * doesn't implement is worse than no palette at all.
 *
 * These are deliberately few. Step 1.8 moves approvals out of chat and into
 * owner-only cards, on the stance that a button beats a typed convention — but
 * `!cancel` stays a command forever, because the moment you want it, reaching
 * for a mouse is already too slow.
 */

import { mentionedNames } from './settings.js';

export interface AgentCommand {
  /** Without the `!`. */
  name: string;
  /** One line, shown in the picker. */
  summary: string;
  /** What actually happens, shown in the help panel. */
  detail: string;
}

export const AGENT_COMMANDS: readonly AgentCommand[] = [
  {
    name: 'cancel',
    summary: 'Stop the turn in flight',
    detail:
      'Aborts whatever the agent is generating and returns it to idle. Anything it already said stays said.',
  },
  {
    name: 'rotate',
    summary: 'Start a fresh session for this zone',
    detail:
      'Drops the conversation context here and begins a new one. Use it when an agent has gone in circles, or before switching it to unrelated work.',
  },
  {
    name: 'shutdown',
    summary: 'Bring the agent home',
    detail:
      'The harness exits and the agent leaves the office. It comes back when you restart it — this does not revoke its key.',
  },
] as const;

export function isAgentCommand(name: string): boolean {
  return AGENT_COMMANDS.some((command) => command.name === name.toLowerCase());
}

/**
 * A parsed command, with who it is aimed at.
 *
 * Targeting matters once you run more than one agent: an untargeted
 * `!shutdown` in a busy Agent Bay stops every agent you own that heard it,
 * which is a surprising amount of damage for eight keystrokes. `!shutdown
 * @claude` stops one. Both forms are kept — the broad one is genuinely useful
 * for "everyone stop" — but the palette offers the targeted form first.
 */
export interface ParsedCommand {
  name: string;
  /** Lowercased name from an `@mention`, or null for "everyone who hears this". */
  target: string | null;
  known: boolean;
}

export function parseAgentCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('!')) return null;

  const name = (/^!([\p{L}\p{N}_-]*)/u.exec(trimmed)?.[1] ?? '').toLowerCase();
  if (name.length === 0) return null;

  return { name, target: mentionedNames(trimmed)[0] ?? null, known: isAgentCommand(name) };
}

/**
 * The partial `!word` the caret sits in, for the picker. Commands are whole
 * messages, so this only fires at the very start — `"see !cancel"` is somebody
 * talking about a command, not issuing one.
 */
export function commandQueryAt(text: string, caret: number): { query: string; start: number } | null {
  if (!text.startsWith('!')) return null;
  if (caret === 0) return null;

  const word = text.slice(1, caret);
  if (/[^\p{L}\p{N}_-]/u.test(word)) return null;

  return { query: word.toLowerCase(), start: 0 };
}

/** Replace the partial command at the start with a full `!name `. */
export function applyCommand(
  text: string,
  caret: number,
  name: string,
): { text: string; caret: number } {
  const next = `!${name} ${text.slice(caret)}`;
  return { text: next, caret: name.length + 2 };
}
