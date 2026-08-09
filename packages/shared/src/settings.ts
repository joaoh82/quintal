/**
 * Instance settings — the knobs an owner can turn without editing code.
 *
 * These are **instance-wide, not per-workspace**, and that is a limitation
 * rather than a decision: office rooms are currently keyed by map id alone, so
 * everyone signed in shares one office regardless of which workspace they
 * belong to. Until rooms are workspace-scoped there is no coherent place to
 * hang a per-workspace radius. When that changes, this table grows a
 * `workspace_id` and the room reads its own.
 */

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
}

export const DEFAULT_OFFICE_SETTINGS: OfficeSettings = {
  chatRadiusTiles: 12,
  walkUpRadiusTiles: 3,
  replyWindowSeconds: 90,
};

/** Bounds the UI enforces and the server re-enforces. */
export const SETTING_LIMITS = {
  chatRadiusTiles: { min: 2, max: 40 },
  walkUpRadiusTiles: { min: 1, max: 10 },
  replyWindowSeconds: { min: 0, max: 600 },
} as const;

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Coerce anything into a usable settings object. Never throws. */
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

/** Was this person addressed by name? */
export function isAddressed(text: string, name: string): boolean {
  const wanted = name.trim().toLowerCase();
  if (wanted.length === 0) return false;
  return mentionedNames(text).includes(wanted);
}

/**
 * The partial `@word` the caret sits in, for autocomplete. Null when the caret
 * isn't inside one — so typing an email address doesn't open a people picker.
 */
export function mentionQueryAt(text: string, caret: number): { query: string; start: number } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at === -1) return null;

  // Must start a word: "a@b" is an address, " @b" is a mention.
  const preceding = at > 0 ? before[at - 1] : ' ';
  if (preceding !== undefined && /[\p{L}\p{N}]/u.test(preceding)) return null;

  const query = before.slice(at + 1);
  if (/[^\p{L}\p{N}_-]/u.test(query)) return null;

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
