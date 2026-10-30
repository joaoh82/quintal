import { CHANNEL_POST_MAX_LENGTH } from '@quintal/shared';

/**
 * Turning agent output into things an office can hold.
 *
 * A terminal can take a thousand-line answer. A room full of people cannot: a
 * speech bubble the size of a wall is worse than useless, and an agent that
 * fills the nearby-chat log drowns out the humans. So streamed text is chunked
 * at sentence boundaries into at most three bubbles, and the rest is left for
 * whoever wants it — they can ask.
 *
 * A channel is not a room. A review asked for in `#engineering` is read as a
 * transcript, and cutting it into three bubbles is how one arrived as a
 * 280-character fragment starting mid-word. So a post keeps its paragraphs
 * and its length, and is only split when it will not fit the office's cap.
 */

/** Most bubbles one response may produce. */
export const MAX_BUBBLES = 3;

/** Longest single bubble, matching the server's CHAT_MAX_LENGTH. */
export const MAX_BUBBLE_LENGTH = 280;

export const CONTINUED_SUFFIX = '…(continued — ask me for more)';

/** Split text into sentence-ish pieces, keeping their terminators. */
export function splitSentences(text: string): string[] {
  const normalised = text.replace(/\s+/g, ' ').trim();
  if (normalised.length === 0) return [];
  // A cut is a terminator, any closing quote or bracket, then a space. Text
  // is only ever divided, never matched-and-kept: the previous version
  // collected `[^.!?]+[.!?]+\s` matches, and a full stop followed by a
  // closing quote — `He said "stop."` — or a `!` inside a code span was a
  // sentence the pattern could not see, so everything up to it was dropped
  // on the way to the bubble.
  return normalised
    .split(/(?<=[.!?]["')\]»]*)\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * Pack a full response into bubbles.
 *
 * Sentences are greedily filled up to the length cap so a short answer stays
 * one bubble; if it doesn't fit in three, the third ends with a pointer rather
 * than being silently cut off — an agent that appears to stop mid-thought reads
 * as broken.
 */
export function toBubbles(text: string): string[] {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return [];

  const all: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current.length > 0) all.push(current);
    current = '';
  };

  for (const sentence of sentences) {
    const candidate = current.length === 0 ? sentence : `${current} ${sentence}`;
    if (candidate.length <= MAX_BUBBLE_LENGTH) {
      current = candidate;
      continue;
    }

    flush();
    // A single sentence longer than a bubble gets hard-wrapped rather than
    // dropped — losing the end of a sentence silently is worse than an ugly cut.
    let rest = sentence;
    while (rest.length > MAX_BUBBLE_LENGTH) {
      all.push(rest.slice(0, MAX_BUBBLE_LENGTH));
      rest = rest.slice(MAX_BUBBLE_LENGTH);
    }
    current = rest;
  }
  flush();

  if (all.length <= MAX_BUBBLES) return all;

  const kept = all.slice(0, MAX_BUBBLES);
  const last = kept[MAX_BUBBLES - 1] ?? '';
  const room = MAX_BUBBLE_LENGTH - CONTINUED_SUFFIX.length - 1;
  kept[MAX_BUBBLES - 1] =
    last.length > room
      ? `${last.slice(0, room)}${CONTINUED_SUFFIX}`
      : `${last} ${CONTINUED_SUFFIX}`;
  return kept;
}

/** Most posts one response may make in a channel or DM. */
export const MAX_POSTS = 5;

/**
 * Pack a full response into channel posts.
 *
 * One post whenever it fits, whitespace and all: a review keeps its list, a
 * stack trace keeps its lines. Over the cap it is split between Markdown
 * blocks, because each post is rendered on its own: a cut at a blank line
 * inside a fenced block left the second post opening with bare code and a
 * stray fence that swallowed everything after it. So a fence or a table is
 * one block whatever blank lines it holds, and one too long for a post is
 * cut between its lines — a fence closed and reopened, a table with its
 * header again — so every post is Markdown that stands up alone. A line
 * longer than a post is cut rather than dropped. A block that starts a post
 * starts it at column 0, all its lines moved together: a fence nested in a
 * list item arrives as a fence, not as an opening line with its indent
 * trimmed off and a closing line that, still indented, closes nothing. Past
 * five posts the last
 * one says there is more, as the bubbles do — an agent that stops
 * mid-thought reads as broken, in a channel as much as aloud.
 */
export function toPosts(text: string, maxLength: number = CHANNEL_POST_MAX_LENGTH): string[] {
  // Blank lines off the front and whitespace off the end, but not the first
  // line's indent: it is how the block that line opens is read.
  const trimmed = text.replace(/^(?:[ \t]*\n)+/, '').trimEnd();
  if (trimmed.trim().length === 0) return [];
  if (trimmed.length <= maxLength && !/^\s/.test(trimmed)) return [trimmed];

  const all: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current.trim().length > 0) all.push(current.trimEnd());
    current = '';
  };

  for (const found of markdownBlocks(trimmed)) {
    const candidate = `${current}${found.before}${found.lines.join('\n')}`;
    if (current.length > 0 && candidate.length <= maxLength) {
      current = candidate;
      continue;
    }

    // From here the block starts a post, or is cut into pieces that do.
    const block = atColumnZero(found);
    const body = block.lines.join('\n');
    if (body.length <= maxLength) {
      flush();
      current = body;
      continue;
    }
    // A block that has to be cut anyway starts in the post already going,
    // its first piece sized to what is left there: "Summary." alone is a
    // post spent, and there are only five.
    const lead = current.length > 0 ? `${current}${block.before}` : '';
    const { first, rest } = cutBlock(block, maxLength, maxLength - lead.length);
    if (first !== null) current = `${lead}${first}`;
    flush();
    all.push(...rest.slice(0, -1));
    current = rest[rest.length - 1] ?? '';
  }
  flush();

  if (all.length <= MAX_POSTS) return all;

  const kept = all.slice(0, MAX_POSTS);
  kept[MAX_POSTS - 1] = withContinued(kept[MAX_POSTS - 1] ?? '', maxLength);
  return kept;
}

/**
 * A run of Markdown that has to arrive in one post, or be cut its own way:
 * prose (a paragraph, a list, a quote), a fenced block, or a table. `before`
 * is the line breaks that separated it from the block above.
 */
interface Block {
  kind: 'prose' | 'fence' | 'table';
  lines: string[];
  before: string;
}

/**
 * A fence's opening line: its indent and its run of backticks or tildes.
 * Any indent counts, not CommonMark's three spaces — an agent nests fences in
 * list items, and a fence missed is a fence cut in half.
 */
function fenceOpening(line: string): { indent: string; fence: string } | null {
  const match = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  // A backtick fence's info string cannot hold a backtick: "```js` is code.
  if (match[2]!.startsWith('`') && match[3]!.includes('`')) return null;
  return { indent: match[1]!, fence: match[2]! };
}

/** The line that ends a fence: the same character, at least as many, nothing else. */
function closesFence(line: string, fence: string): boolean {
  const match = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
  return match !== null && match[1]![0] === fence[0] && match[1]!.length >= fence.length;
}

/** A GFM table's second line: `| --- | :-: |`. */
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

function startsTable(lines: readonly string[], index: number): boolean {
  const header = lines[index];
  const delimiter = lines[index + 1];
  return (
    header !== undefined &&
    delimiter !== undefined &&
    header.includes('|') &&
    delimiter.includes('|') &&
    TABLE_DELIMITER.test(delimiter)
  );
}

/**
 * A block moved to the left margin as a whole: every line loses the first
 * line's indent, as far as it has it, and a fence's closing line is put at
 * the margin with its opening line. Read alone, an indent four spaces deep
 * makes a fence into an indented code block, and a closing fence into code.
 */
function atColumnZero(block: Block): Block {
  const indent = /^[ \t]*/.exec(block.lines[0]!)![0].length;
  const lines = indent === 0 ? [...block.lines] : block.lines.map((line) => {
    const lead = /^[ \t]*/.exec(line)![0].length;
    return line.slice(Math.min(lead, indent));
  });
  if (block.kind === 'fence' && lines.length > 1) {
    const fence = fenceOpening(lines[0]!)!.fence;
    const last = lines.length - 1;
    if (closesFence(lines[last]!, fence)) lines[last] = lines[last]!.trimStart();
  }
  return { ...block, lines };
}

/** The text, as the blocks it is made of, in order. */
function markdownBlocks(text: string): Block[] {
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let blanks = 0;
  const push = (kind: Block['kind'], from: number, to: number): void => {
    const before = blocks.length === 0 ? '' : '\n'.repeat(blanks + 1);
    blocks.push({ kind, lines: lines.slice(from, to), before });
    blanks = 0;
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.trim().length === 0) {
      blanks += 1;
      index += 1;
      continue;
    }

    const opening = fenceOpening(line);
    if (opening) {
      let end = index + 1;
      while (end < lines.length && !closesFence(lines[end]!, opening.fence)) end += 1;
      // Closed, the closing line is the block's; unclosed, the rest is.
      end = Math.min(end + 1, lines.length);
      push('fence', index, end);
      index = end;
      continue;
    }

    if (startsTable(lines, index)) {
      let end = index + 2;
      while (
        end < lines.length &&
        lines[end]!.trim().length > 0 &&
        lines[end]!.includes('|') &&
        !fenceOpening(lines[end]!)
      ) {
        end += 1;
      }
      push('table', index, end);
      index = end;
      continue;
    }

    let end = index + 1;
    while (
      end < lines.length &&
      lines[end]!.trim().length > 0 &&
      !fenceOpening(lines[end]!) &&
      !startsTable(lines, end)
    ) {
      end += 1;
    }
    push('prose', index, end);
    index = end;
  }
  return blocks;
}

/**
 * A block cut to fit: `first`, sized to what was left of the post already
 * going (null when nothing fitted there), then whole posts.
 */
interface Cut {
  first: string | null;
  rest: string[];
}

/**
 * A block too long for one post, as posts. A fence is closed at the end of
 * each piece and reopened, info string and all, at the start of the next; a
 * table repeats its header and delimiter, so each piece is still a table.
 * Prose is cut between lines, which a list or a quote survives.
 */
function cutBlock(block: Block, maxLength: number, firstRoom: number): Cut {
  const framed = (cut: Cut, frame: (piece: string) => string): Cut => ({
    first: cut.first === null ? null : frame(cut.first),
    rest: cut.rest.map(frame),
  });
  if (block.kind === 'fence') {
    const open = block.lines[0]!;
    const opening = fenceOpening(open)!;
    const last = block.lines[block.lines.length - 1]!;
    const closed = block.lines.length > 1 && closesFence(last, opening.fence);
    // The block is at column 0 by now, so the close is too.
    const close = closed ? last : opening.fence;
    const inside = block.lines.slice(1, closed ? -1 : undefined);
    const frame = open.length + close.length + 2;
    if (maxLength - frame > 0 && inside.length > 0) {
      return framed(
        packLines(inside, maxLength - frame, firstRoom - frame),
        (piece) => `${open}\n${piece}\n${close}`,
      );
    }
  }
  if (block.kind === 'table') {
    const header = `${block.lines[0]!}\n${block.lines[1]!}`;
    const frame = header.length + 1;
    const rows = block.lines.slice(2);
    if (maxLength - frame > 0 && rows.length > 0) {
      return framed(
        packLines(rows, maxLength - frame, firstRoom - frame),
        (piece) => `${header}\n${piece}`,
      );
    }
  }
  return packLines(block.lines, maxLength, firstRoom);
}

/**
 * Lines, greedily joined into pieces no longer than `room`; a longer line is
 * cut. The first piece has only `firstRoom`, and is null if not even its
 * first line fits there.
 */
function packLines(lines: readonly string[], room: number, firstRoom: number): Cut {
  let first: string | null = null;
  const rest: string[] = [];
  let filling = true;
  let current: string | null = null;
  for (const line of lines) {
    const candidate: string = current === null ? line : `${current}\n${line}`;
    if (candidate.length <= (filling ? firstRoom : room)) {
      current = candidate;
      continue;
    }
    if (filling) first = current;
    else if (current !== null) rest.push(current);
    filling = false;
    let tail = line;
    while (tail.length > room) {
      rest.push(tail.slice(0, room));
      tail = tail.slice(room);
    }
    current = tail;
  }
  if (filling) first = current;
  else if (current !== null) rest.push(current);
  return { first, rest };
}

/** The closing line a text still needs, if it ends inside a fence. */
function openFence(text: string): string | null {
  let open: { indent: string; fence: string } | null = null;
  for (const line of text.split('\n')) {
    if (open === null) open = fenceOpening(line);
    else if (closesFence(line, open.fence)) open = null;
  }
  return open === null ? null : `${open.indent}${open.fence}`;
}

/** Cut at the last line break that fits, or hard at `room` if there is none. */
function cutAtLine(text: string, room: number): string {
  if (text.length <= room) return text;
  const at = text.lastIndexOf('\n', room);
  return at > 0 ? text.slice(0, at).trimEnd() : text.slice(0, room);
}

/**
 * The last post, with the note that there is more. The note is a paragraph
 * of its own — on the last line of a fence or a table it would be code, or a
 * cell — and a fence the cut left open is closed before it.
 */
function withContinued(post: string, maxLength: number): string {
  const note = `\n\n${CONTINUED_SUFFIX}`;
  const room = maxLength - note.length;
  let cut = cutAtLine(post, room);
  const close = openFence(cut);
  if (close !== null) {
    cut = cutAtLine(post, room - close.length - 1);
    const stillOpen = openFence(cut);
    if (stillOpen !== null) cut = `${cut}\n${stillOpen}`;
  }
  return `${cut}${note}`;
}

/**
 * Compact status line for a tool call: "editing auth.ts", "running pnpm test".
 *
 * The status line is glanceable presence, not a log. It answers "what is this
 * thing doing right now" from across the room, and nothing more.
 */
export function statusForTool(toolName: string, input: unknown): string {
  const verb = verbFor(toolName);
  // What counts as "the target" depends on the verb: a shell tool is described
  // by its command, an edit by its file. Reading the wrong one gives you
  // "running auth.ts", which is not what is happening.
  const target = describeTarget(input, verb === 'running' || verb === 'searching');
  const line = target ? `${verb} ${target}` : verb;
  return line.slice(0, 60);
}

function verbFor(toolName: string): string {
  const name = toolName.toLowerCase();
  if (/(^|_)(edit|write|apply|patch|create)/.test(name)) return 'editing';
  if (/(^|_)(read|view|open|cat)/.test(name)) return 'reading';
  if (/(^|_)(bash|shell|exec|run|terminal)/.test(name)) return 'running';
  if (/(^|_)(search|grep|glob|find)/.test(name)) return 'searching';
  if (/(^|_)(fetch|web|http)/.test(name)) return 'fetching';
  if (/(^|_)(think|plan)/.test(name)) return 'thinking';
  return `using ${toolName}`;
}

function describeTarget(input: unknown, preferCommand: boolean): string {
  if (typeof input !== 'object' || input === null) return '';
  const data = input as Record<string, unknown>;

  const fileKeys = ['file_path', 'path', 'filePath', 'file', 'notebook_path'];
  const commandKeys = ['command', 'cmd', 'query', 'pattern'];
  const order = preferCommand ? [commandKeys, fileKeys] : [fileKeys, commandKeys];

  for (const [index, keys] of order.entries()) {
    const isCommandGroup = preferCommand ? index === 0 : index === 1;
    for (const key of keys) {
      const value = data[key];
      if (typeof value !== 'string' || value.length === 0) continue;
      if (isCommandGroup) return value.length > 32 ? `${value.slice(0, 32)}…` : value;
      return basename(value);
    }
  }
  return '';
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/**
 * A line the agent adapter wrote, not the model.
 *
 * `codex-acp` renders Codex's own notices — "Warning: Skill descriptions
 * were shortened…", "Config warning: …" — as an `agent_message_chunk`, one
 * whole paragraph in one chunk, ahead of the model's reply (see
 * `createWarningEvent` in its bundle). Spoken aloud, that is an agent
 * announcing its runtime's housekeeping to the room. A model's own text
 * arrives as token deltas, never as a complete "Warning: …" paragraph in a
 * single chunk, so the shape is safe to recognise.
 */
export function isHarnessNotice(chunk: string): boolean {
  return /^(?:Config warning|Warning): [\s\S]*\n\n$/.test(chunk);
}
