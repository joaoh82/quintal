/**
 * Emotes: the balloon over an agent's head.
 *
 * The status line under the nameplate says what an agent is doing in words;
 * the balloon says it in a glyph readable from across the room. Kenney's
 * Emotes Pack (CC0) provides the glyphs — see
 * `apps/web/public/assets/CREDITS.md` for how the sheet was derived.
 *
 * Two things feed one field. Most balloons are *derived* from state the
 * harness already has, at no cost: thinking, a tool running, waiting for the
 * owner, a refusal. A few are *chosen* by the model through the `emote` tool,
 * so an agent can react to what was said to it. Either way the office holds
 * the field and only ever accepts a catalogue id — a balloon is a picture,
 * never free text.
 */

/**
 * The catalogue, in sheet order: the index of an id here is its frame on
 * `kenney-emotes-32.png`. Change the order and regenerate the sheet together.
 */
export const EMOTE_FRAMES = [
  'dots1',
  'dots2',
  'dots3',
  'idea',
  'question',
  'cross',
  'alert',
  'sleep',
  'happy',
  'sad',
  'angry',
  'laugh',
  'heart',
  'heartbroken',
  'confused',
  'star',
  'music',
  'sweat',
  'cash',
  'exclamation',
  'cloud',
] as const;

/**
 * What can be asked for. `dots` is the thinking balloon and animates over
 * the three dot frames; the rest are single frames.
 */
export const EMOTE_IDS = [
  'dots',
  ...EMOTE_FRAMES.filter((frame) => !frame.startsWith('dots')),
] as const;
export type EmoteId = (typeof EMOTE_IDS)[number];

export function isEmote(value: unknown): value is EmoteId {
  return typeof value === 'string' && (EMOTE_IDS as readonly string[]).includes(value);
}

/** Frames to show for an emote, cycled in order when there is more than one. */
export function emoteFrames(id: EmoteId): number[] {
  if (id === 'dots') return [0, 1, 2];
  const index = (EMOTE_FRAMES as readonly string[]).indexOf(id);
  return index === -1 ? [] : [index];
}

/**
 * The emotes a model may choose through the `emote` tool.
 *
 * A reaction set, deliberately without the ones the harness derives: an agent
 * that could put up its own "thinking" balloon could look busy while idle.
 */
export const CHOSEN_EMOTES = [
  'happy',
  'sad',
  'angry',
  'laugh',
  'heart',
  'heartbroken',
  'confused',
  'idea',
  'alert',
  'star',
  'music',
  'sweat',
] as const satisfies readonly EmoteId[];

/** How long a chosen balloon stays up unless the agent says otherwise. */
export const EMOTE_TTL_DEFAULT_MS = 6_000;
/** The most any balloon may be asked to stay up. 0 on the wire means "until cleared". */
export const EMOTE_TTL_MAX_MS = 60_000;
/** Agents may change their balloon this often. */
export const AGENT_EMOTE_INTERVAL_MS = 500;

/**
 * The balloon a status line implies.
 *
 * This is the "derived" half: the harness already narrates what it is doing
 * in the status line, and every state worth a balloon is already a distinct
 * status. Mapping here rather than at each call site means one table to read
 * and one table to test. Empty means no balloon.
 */
export function emoteForStatus(status: string): EmoteId | '' {
  const line = status.trim();
  if (line.length === 0 || line === 'idle') return '';
  if (line === 'thinking') return 'dots';
  // A test run is a wait, not a doing: the agent sits back with the
  // thinking balloon while the suite decides, as agent-office draws it.
  if (testRunStatus(line)) return 'dots';
  if (line.startsWith('waiting for ')) return 'question';
  if (line.startsWith('no model ')) return 'cross';
  if (line === 'offline') return 'alert';
  if (line.startsWith("I've stopped")) return 'alert';
  // Anything else the harness writes is a tool at work: "reading foo.ts",
  // "running tests…" — the lightbulb, for "working on it".
  return 'idea';
}

/**
 * A shell command that runs a test suite, by the names people type: the
 * runner is the command, or the one after an `&&`. Not a word anywhere in
 * the line — `git add foo.test.ts` is not a test run — and not a runner
 * past the 32 characters `statusForTool` keeps of a command, which is a
 * miss, and a cheap one. One rule for the balloon and for the desk's
 * act-out, so the two never disagree.
 */
const TEST_RUN =
  /(?:^running |&&\s*)(?:(?:pnpm|npm|yarn|bun|npx)\s+(?:run\s+)?test|vitest|jest|pytest|mocha|rspec|cargo\s+test|go\s+test|tsx\s+--test|node\s+--test)\b/;

export function testRunStatus(status: string): boolean {
  return TEST_RUN.test(status.trim());
}

/**
 * Whether the status line says nothing is running: empty, or "idle". Not
 * the same question as whether the agent may wander (`idleCapable`, in the
 * office): a standing refusal such as "no model … here" is not work, so
 * idle life may walk it about, but it is not an agent that would answer
 * either. A task begun for one would sit on the board with nobody coming.
 */
export function idleStatus(status: string): boolean {
  const line = status.trim();
  return line.length === 0 || line === 'idle';
}
