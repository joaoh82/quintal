import { AGENT_PARALLELISM_DEFAULT, AGENT_PARALLELISM_MAX, AGENT_PARALLELISM_MIN,
  AGENT_MENTION_MAX_HOPS,
} from './agent.js';
import { tidyDisplayText } from './workspace.js';

/**
 * Two different things that both used to be called "office settings".
 *
 * `InstanceSettings` belong to the deployment: one name, shown to somebody who
 * has not signed in yet. `OfficeSettings` belong to one office, and describe
 * how its room behaves.
 *
 * They were one row because rooms were keyed by map alone, so every workspace
 * shared one room and there was nowhere coherent to hang a per-office radius.
 * The old comment here said as much, and said this table would grow a
 * `workspace_id` once rooms were scoped. Rooms are scoped now, so it has —
 * how close you stand to be heard is a property of your office, not of the
 * server it happens to run on.
 */

/** Settings that belong to the whole deployment. */
export interface InstanceSettings {
  /**
   * What this deployment calls itself, shown before anybody signs in.
   *
   * Distinct from a *workspace* name, which is also displayed as an office
   * ("Josh's Office") — that one belongs to a person, this one to the whole
   * instance. Somebody arriving at a URL needs to recognise the place before
   * they have an account in it, and "quintal.example.com" is a poor thing to
   * recognise a workplace by.
   *
   * Empty means unnamed, and the address is shown instead.
   */
  name: string;
}

/** Settings that belong to one office, and describe how its room behaves. */
export interface OfficeSettings {
  /** How far speech carries, in tiles. */
  chatRadiusTiles: number;
  /** How close counts as walking up to somebody, for unaddressed remarks. */
  walkUpRadiusTiles: number;
  /**
   * How long after being addressed from out of earshot a reply still finds the
   * person who asked. Zero disables the behaviour entirely.
   */
  replyWindowSeconds: number;
  /**
   * Whether idle agents live a little — wander their zone, doze off, stop
   * for a wordless chat — or stand perfectly still. Costs no tokens either
   * way; this is about what the office looks like, not what it spends.
   */
  idleLife: boolean;
  /**
   * Whether two idle agents that have stopped beside each other may actually
   * say something — one line each, out loud. `rare` is at most one exchange
   * per agent per hour, only while a human is in the office, under a hard
   * daily cap. Off by default because every line is a model turn, and idle
   * agents are most of the day.
   */
  banter: BanterMode;
  /**
   * How many conversations an agent may answer at once, unless its own card
   * says otherwise. See `AGENT_PARALLELISM_DEFAULT` for what the number is.
   */
  agentParallelism: number;
  /**
   * How many agent-to-agent hops a mention may travel before it wakes
   * nobody. A person's line is hop 0. See `AGENT_MENTION_MAX_HOPS` for what
   * the number is and why the default is four; an office that runs long
   * design discussions between agents wants more, a demo wants less.
   */
  mentionMaxHops: number;
}

export const BANTER_MODES = ['off', 'rare'] as const;
export type BanterMode = (typeof BANTER_MODES)[number];

/**
 * Banter: at most this many exchanges per office per day, whatever the
 * setting says. A cap in code, because a setting is a thing somebody can
 * leave on, and an API bill is not. Here rather than in the server so the
 * settings page says the same number the room enforces.
 */
export const BANTER_DAILY_CAP = 24;

/** Long enough for "Rockflow Engineering", short enough to sit on a card. */
export const OFFICE_NAME_MAX_LENGTH = 60;

export const DEFAULT_INSTANCE_SETTINGS: InstanceSettings = { name: '' };

export const DEFAULT_OFFICE_SETTINGS: OfficeSettings = {
  chatRadiusTiles: 12,
  walkUpRadiusTiles: 3,
  replyWindowSeconds: 90,
  idleLife: true,
  banter: 'off',
  agentParallelism: AGENT_PARALLELISM_DEFAULT,
  mentionMaxHops: AGENT_MENTION_MAX_HOPS,
};

/** Bounds the UI enforces and the server re-enforces. */
export const SETTING_LIMITS = {
  chatRadiusTiles: { min: 2, max: 40 },
  walkUpRadiusTiles: { min: 1, max: 10 },
  replyWindowSeconds: { min: 0, max: 600 },
  agentParallelism: { min: AGENT_PARALLELISM_MIN, max: AGENT_PARALLELISM_MAX },
  // One is "an agent may answer a person and name nobody into a turn";
  // sixteen is long past any discussion worth having without a human.
  mentionMaxHops: { min: 1, max: 16 },
} as const;

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Coerce anything into usable instance settings. Never throws. */
export function normaliseInstanceSettings(
  raw: Partial<InstanceSettings> | null | undefined,
): InstanceSettings {
  return {
    // The same containment every other name gets. This one is drawn on a page
    // shown to people who have not signed in, so a stray bidi override here
    // reaches further than most.
    name: tidyDisplayText(
      typeof raw?.name === 'string' ? raw.name : '',
      OFFICE_NAME_MAX_LENGTH,
    ),
  };
}

/** Coerce anything into usable office settings. Never throws. */
export function normaliseSettings(raw: Partial<OfficeSettings> | null | undefined): OfficeSettings {
  return {
    chatRadiusTiles: clamp(
      raw?.chatRadiusTiles,
      DEFAULT_OFFICE_SETTINGS.chatRadiusTiles,
      SETTING_LIMITS.chatRadiusTiles.min,
      SETTING_LIMITS.chatRadiusTiles.max,
    ),
    walkUpRadiusTiles: clamp(
      raw?.walkUpRadiusTiles,
      DEFAULT_OFFICE_SETTINGS.walkUpRadiusTiles,
      SETTING_LIMITS.walkUpRadiusTiles.min,
      SETTING_LIMITS.walkUpRadiusTiles.max,
    ),
    replyWindowSeconds: clamp(
      raw?.replyWindowSeconds,
      DEFAULT_OFFICE_SETTINGS.replyWindowSeconds,
      SETTING_LIMITS.replyWindowSeconds.min,
      SETTING_LIMITS.replyWindowSeconds.max,
    ),
    // Absent means the default, not "off": a row written before the switch
    // existed describes an office that never chose.
    idleLife: raw?.idleLife === undefined ? DEFAULT_OFFICE_SETTINGS.idleLife : Boolean(raw.idleLife),
    // Anything that is not a mode we know is off: a setting that costs
    // tokens does not get to default upwards on a typo.
    banter: raw?.banter === 'rare' ? 'rare' : 'off',
    agentParallelism: clamp(
      raw?.agentParallelism,
      DEFAULT_OFFICE_SETTINGS.agentParallelism,
      SETTING_LIMITS.agentParallelism.min,
      SETTING_LIMITS.agentParallelism.max,
    ),
    mentionMaxHops: clamp(
      raw?.mentionMaxHops,
      DEFAULT_OFFICE_SETTINGS.mentionMaxHops,
      SETTING_LIMITS.mentionMaxHops.min,
      SETTING_LIMITS.mentionMaxHops.max,
    ),
  };
}

// --- addressing -------------------------------------------------------------

/**
 * Addressing somebody requires an `@`.
 *
 * Bare-name matching was ambiguous in exactly the way you'd expect: "the
 * reviewer said no" woke the reviewer, and an agent called Ana had to be
 * defended against "banana". Requiring the sigil makes the intent explicit,
 * matches what everyone already does in Slack, and gives the client something
 * unambiguous to autocomplete against.
 *
 * The leading boundary in the pattern matters just as much: without it
 * `npub1w0rd@relay.example` addresses somebody called "relay", and every
 * identifier pasted into chat becomes a summons. Now that identity is a
 * keypair, pasting one is routine — keys, handles of the form `name@host`,
 * and relay URLs all travel through chat, and none of them are a way to get
 * somebody's attention.
 */
export const MENTION_PATTERN = /(^|[^\p{L}\p{N}_-])@([\p{L}\p{N}][\p{L}\p{N}_-]*)/gu;

/** Every name addressed in a message, lowercased, in order, without repeats. */
export function mentionedNames(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const name = match[2]?.toLowerCase();
    if (name && !found.includes(name)) found.push(name);
  }
  return found;
}

/** A character that may sit inside a mention token; anything else ends one. */
const NAME_CHAR = /[\p{L}\p{N}_-]/u;

/**
 * The names, among these candidates, that the text addresses.
 *
 * Matched against the names themselves rather than by cutting `@word`
 * tokens out of the text and comparing: a name is whatever somebody is
 * called, and that is not always identifier-shaped. The person who has not
 * named themselves is `npub1rww4uhaw…nlarug`, with an ellipsis in it; a
 * person who has may be "Josh Silva". Cutting at the first odd character
 * read the first as `@npub1rww4uhaw` and the second as `@Josh`, and neither
 * reached anybody.
 *
 * So: at each `@` that starts a word, the longest candidate that follows it
 * whole, any case, and ends at a boundary — the end of the text, or a
 * character that could not continue a name. Longest first, so `@Josh Silva`
 * reaches Josh Silva and not Josh when both are here. Returns the
 * candidates as given, in the order the text reached them, once each.
 */
export function addressedNames(text: string, candidates: readonly string[]): string[] {
  const lowered = text.toLowerCase();
  const wanted = [...new Set(candidates)]
    .map((name) => ({ name, key: name.trim().toLowerCase() }))
    .filter((entry) => entry.key.length > 0)
    .sort((a, b) => b.key.length - a.key.length);
  if (wanted.length === 0) return [];

  const found: string[] = [];
  for (let at = lowered.indexOf('@'); at !== -1; at = lowered.indexOf('@', at + 1)) {
    const before = at > 0 ? lowered[at - 1]! : '';
    if (before !== '' && NAME_CHAR.test(before)) continue;
    const rest = lowered.slice(at + 1);
    const hit = wanted.find((entry) => {
      if (!rest.startsWith(entry.key)) return false;
      const after = rest[entry.key.length];
      return after === undefined || !NAME_CHAR.test(after);
    });
    if (hit && !found.includes(hit.name)) found.push(hit.name);
  }
  return found;
}

/** Was this person addressed by name? */
export function isAddressed(text: string, name: string): boolean {
  return addressedNames(text, [name]).length > 0;
}

/**
 * The partial `@name` the caret sits in, for autocomplete. Null when the caret
 * isn't inside one — so typing an email address doesn't open a people picker.
 *
 * The query runs from the `@` to the caret, whatever it holds: a name may
 * carry a space or an ellipsis, and a picker that shut on the first odd
 * character could never complete `npub1rww4uhaw…nlarug`. It shuts instead
 * when nothing matches, which is what a finished mention followed by more
 * words looks like. A line break ends it: nobody's name spans two lines.
 */
export function mentionQueryAt(text: string, caret: number): { query: string; start: number } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at === -1) return null;

  // Must start a word: "a@b" is an address, " @b" is a mention.
  const preceding = at > 0 ? before[at - 1] : ' ';
  if (preceding !== undefined && /[\p{L}\p{N}]/u.test(preceding)) return null;

  const query = before.slice(at + 1);
  if (query.includes('\n')) return null;

  return { query: query.toLowerCase(), start: at };
}

/** Replace the partial mention at `start` with a full `@name `. */
export function applyMention(
  text: string,
  start: number,
  caret: number,
  name: string,
): { text: string; caret: number } {
  const next = `${text.slice(0, start)}@${name} ${text.slice(caret)}`;
  return { text: next, caret: start + name.length + 2 };
}
