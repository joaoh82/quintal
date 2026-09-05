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
  return normalised.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g)?.map((s) => s.trim()) ?? [
    normalised,
  ];
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
 * stack trace keeps its lines. Over the cap it is split at paragraph breaks,
 * and a single paragraph longer than a post is cut rather than dropped. Past
 * five posts the last one says there is more, as the bubbles do — an agent
 * that stops mid-thought reads as broken, in a channel as much as aloud.
 */
export function toPosts(text: string, maxLength: number = CHANNEL_POST_MAX_LENGTH): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= maxLength) return [trimmed];

  const all: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current.trim().length > 0) all.push(current.trim());
    current = '';
  };

  for (const paragraph of trimmed.split(/\n{2,}/)) {
    const candidate = current.length === 0 ? paragraph : `${current}\n\n${paragraph}`;
    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }

    flush();
    let rest = paragraph;
    while (rest.length > maxLength) {
      all.push(rest.slice(0, maxLength));
      rest = rest.slice(maxLength);
    }
    current = rest;
  }
  flush();

  if (all.length <= MAX_POSTS) return all;

  const kept = all.slice(0, MAX_POSTS);
  const last = kept[MAX_POSTS - 1] ?? '';
  const room = maxLength - CONTINUED_SUFFIX.length - 1;
  kept[MAX_POSTS - 1] =
    last.length > room ? `${last.slice(0, room)}${CONTINUED_SUFFIX}` : `${last} ${CONTINUED_SUFFIX}`;
  return kept;
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
