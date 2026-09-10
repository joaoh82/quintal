/**
 * Where the links are in a line of chat.
 *
 * Message text is whatever a person or an agent typed, so it is never HTML;
 * the transcript renders it as text. But a pasted address is meant to be
 * opened, and a reader should not have to select it by hand. This finds the
 * web addresses in a line and hands back the pieces in order — plain text,
 * link, plain text — so the renderer can wrap each link in an anchor and
 * leave everything else exactly as written.
 *
 * Only `http://`, `https://` and a bare `www.` count. Anything else that
 * looks like a scheme — `javascript:`, `data:`, `file:` — stays text: the
 * desktop webview sits next to a keychain bridge and refuses those anyway,
 * but the renderer should never produce them in the first place.
 */

export type Segment =
  /** Words, as written. */
  | { kind: 'text'; text: string }
  /** An address: `text` as written, `href` where it goes. */
  | { kind: 'link'; text: string; href: string }
  /** `@team`, as written; `name` is the team's name as the office spells it. */
  | { kind: 'team'; text: string; name: string };

/**
 * `@word` at a word boundary — the same shape `MENTION_PATTERN` reads, so a
 * chip appears exactly where the office would have resolved a team.
 */
const MENTION = /(^|[^\p{L}\p{N}_-])@([\p{L}\p{N}][\p{L}\p{N}_-]*)/gu;

/**
 * A scheme or a `www.` at a word boundary, then everything up to whitespace
 * or a character that ends a URL in prose. Trailing punctuation is trimmed
 * afterwards, since the pattern cannot tell a sentence's full stop from a
 * path's.
 */
const ADDRESS = /(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;

/** A sentence's punctuation, not the address's. */
const TRAILING = new Set(['.', ',', ';', ':', '!', '?', "'", '"', '*', '_', '~']);

/** Closers that belong to the address only if it opened them. */
const BRACKETS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

function count(haystack: string, needle: string): number {
  let n = 0;
  for (const char of haystack) if (char === needle) n += 1;
  return n;
}

/**
 * Take the prose punctuation off the end of a match. `https://x.y/a.` loses
 * the stop; `https://en.wikipedia.org/wiki/Foo_(bar)` keeps its bracket
 * because the address opened it, while `(see https://x.y)` gives it back.
 */
function trimEnd(raw: string): string {
  let end = raw.length;
  while (end > 0) {
    const last = raw[end - 1]!;
    if (TRAILING.has(last)) {
      end -= 1;
      continue;
    }
    const opener = BRACKETS[last];
    if (opener !== undefined && count(raw.slice(0, end), last) > count(raw.slice(0, end), opener)) {
      end -= 1;
      continue;
    }
    break;
  }
  return raw.slice(0, end);
}

/** An address needs something after its scheme or its `www.` to be one. */
function isAddress(text: string): boolean {
  const rest = text.replace(/^(?:https?:\/\/|www\.)/i, '');
  return rest.length > 0 && /[a-z0-9]/i.test(rest[0]!);
}

/**
 * The line, split into text and links, in order. A line with no address
 * comes back as a single text segment; an empty line as nothing at all.
 *
 * With `teams` — the office's team names — an `@team` in the text becomes a
 * segment of its own, so the transcript can show it as a chip that says who
 * it reached. Names are matched the way the office matches them: whole
 * word, any case. `@Marvin` stays text; only teams get chips, because a
 * person's name reads fine as written and a team's does not say who it is.
 */
export function segments(line: string, teams: readonly string[] = []): Segment[] {
  const out: Segment[] = [];
  let cursor = 0;
  for (const match of line.matchAll(ADDRESS)) {
    const start = match.index;
    // `www.` inside a word (`notwww.x`) or right after a letter is not a link.
    if (start > 0 && /[a-z0-9]/i.test(line[start - 1]!)) continue;
    const text = trimEnd(match[0]);
    if (!isAddress(text)) continue;
    if (start > cursor) out.push(...textOrTeams(line.slice(cursor, start), teams));
    const href = /^www\./i.test(text) ? `https://${text}` : text;
    out.push({ kind: 'link', text, href });
    cursor = start + text.length;
  }
  if (cursor < line.length) out.push(...textOrTeams(line.slice(cursor), teams));
  return out;
}

/** A stretch of prose, with its `@team`s picked out. */
function textOrTeams(text: string, teams: readonly string[]): Segment[] {
  if (teams.length === 0) return [{ kind: 'text', text }];
  const byLower = new Map(teams.map((name) => [name.toLowerCase(), name]));
  const out: Segment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(MENTION)) {
    const name = byLower.get(match[2]!.toLowerCase());
    if (name === undefined) continue;
    const start = match.index + match[1]!.length;
    if (start > cursor) out.push({ kind: 'text', text: text.slice(cursor, start) });
    out.push({ kind: 'team', text: `@${match[2]!}`, name });
    cursor = start + 1 + match[2]!.length;
  }
  if (cursor < text.length) out.push({ kind: 'text', text: text.slice(cursor) });
  return out;
}
