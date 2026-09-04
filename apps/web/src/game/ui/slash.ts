/**
 * `/` commands — the things you type at the office, as opposed to `!`, which
 * you type at an agent.
 *
 * Three verbs, all about where you are talking rather than what you are
 * saying. Kept tiny on purpose: a slash command is a typed convention, and
 * every one added is one more thing nobody discovers without the help panel.
 */

export interface SlashCommand {
  /** Without the slash. */
  name: 'msg' | 'join' | 'leave';
  /** What to type after it, for the picker. Empty for none. */
  argument: string;
  summary: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: 'msg', argument: 'name', summary: 'Open a direct message' },
  { name: 'join', argument: 'channel', summary: 'Join a channel' },
  { name: 'leave', argument: '', summary: 'Leave this channel' },
] as const;

export type ParsedSlash =
  | { kind: 'msg'; name: string }
  | { kind: 'join'; slug: string }
  | { kind: 'leave' }
  | { kind: 'unknown'; name: string };

/**
 * A line that begins with `/` is a command, never chat. Returns null for
 * ordinary text — and for `//`, which is how you say a literal slash.
 */
export function parseSlashCommand(text: string): ParsedSlash | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return null;

  const [head = '', ...rest] = trimmed.slice(1).split(/\s+/);
  const name = head.toLowerCase();
  if (name.length === 0) return null;
  const argument = rest.join(' ').trim();

  switch (name) {
    case 'msg':
    case 'dm':
      return { kind: 'msg', name: argument.replace(/^@/, '') };
    case 'join':
      return { kind: 'join', slug: argument.replace(/^#/, '').toLowerCase() };
    case 'leave':
    case 'part':
      return { kind: 'leave' };
    default:
      return { kind: 'unknown', name };
  }
}

/**
 * What the picker should offer at the caret, if the draft is a slash command
 * in progress: the verb while the verb is being typed, then that verb's
 * argument. Null once the line has moved past anything completable.
 */
export function slashQueryAt(
  text: string,
  caret: number,
): { part: 'verb' | 'argument'; verb: string; query: string; start: number } | null {
  if (!text.startsWith('/') || text.startsWith('//')) return null;
  const upToCaret = text.slice(0, caret);
  const space = upToCaret.indexOf(' ');
  if (space === -1) {
    return { part: 'verb', verb: '', query: upToCaret.slice(1).toLowerCase(), start: 1 };
  }
  const verb = upToCaret.slice(1, space).toLowerCase();
  const argument = upToCaret.slice(space + 1);
  if (argument.includes(' ')) return null;
  return { part: 'argument', verb, query: argument.toLowerCase(), start: space + 1 };
}
