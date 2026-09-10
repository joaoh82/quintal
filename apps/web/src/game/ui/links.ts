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
  | { kind: 'link'; text: string; href: string };

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
 */
export function segments(line: string): Segment[] {
  const out: Segment[] = [];
  let cursor = 0;
  for (const match of line.matchAll(ADDRESS)) {
    const start = match.index;
    // `www.` inside a word (`notwww.x`) or right after a letter is not a link.
    if (start > 0 && /[a-z0-9]/i.test(line[start - 1]!)) continue;
    const text = trimEnd(match[0]);
    if (!isAddress(text)) continue;
    if (start > cursor) out.push({ kind: 'text', text: line.slice(cursor, start) });
    const href = /^www\./i.test(text) ? `https://${text}` : text;
    out.push({ kind: 'link', text, href });
    cursor = start + text.length;
  }
  if (cursor < line.length) out.push({ kind: 'text', text: line.slice(cursor) });
  return out;
}
