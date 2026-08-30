/** Membership roles, ordered from most to least privileged. */
export const MEMBERSHIP_ROLES = ['owner', 'admin', 'member'] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

/**
 * Quintal is solo-first: the first workspace is created for you, named after
 * you, the moment you sign in. There is no team-setup screen.
 */
export function personalWorkspaceName(displayName: string): string {
  const name = displayName.trim();
  return name.endsWith('s') ? `${name}' Office` : `${name}'s Office`;
}

/** URL-safe slug. Not unique on its own — see `ensurePersonalWorkspace`. */
export function slugify(input: string): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'workspace';
}

// --- profiles ---------------------------------------------------------------

/**
 * A display name is self-asserted, Slack-style: duplicates are allowed and
 * nobody has to prove anything, because the key is what identifies a person.
 * That is a deliberate choice, and it puts the whole weight on *where* the key
 * is shown — beside every name in the mention picker, and on the profile card.
 * A name is a label; it is never the identity.
 */
export const DISPLAY_NAME_MAX_LENGTH = 40;
export const PROFILE_DESCRIPTION_MAX_LENGTH = 280;
export const WORKSPACE_NAME_MAX_LENGTH = 60;

/**
 * Collapse whitespace and clamp.
 *
 * Control characters are stripped rather than trimmed, because a name is drawn
 * over somebody's head and inside a roster row: a stray newline or a bidi
 * control does not just look wrong, it lets one person's label reach into
 * another's. Same reason the length is capped rather than merely discouraged.
 *
 * The class covers all of it, not just the famous one. `U+202E` (RLO) is the
 * override everybody knows; `U+2066`–`U+2069` are the newer *isolates*, which
 * reorder surrounding text just as effectively, and `U+061C` and `U+FEFF` are
 * invisible marks that do the same quietly.
 *
 * Clamped by code point rather than by `String.prototype.slice`, which counts
 * UTF-16 units and will happily cut an emoji in half and leave a lone
 * surrogate behind.
 */
export function tidyDisplayText(input: string, max: number): string {
  const collapsed = input
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
  const points = Array.from(collapsed);
  return points.length > max ? points.slice(0, max).join('') : collapsed;
}

/**
 * A display name fit to render, or null when the input has nothing in it.
 *
 * Null rather than a fallback: the caller knows what a name falls back *to* —
 * a truncated npub — and this module cannot see the key.
 */
export function normaliseDisplayName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const name = tidyDisplayText(input, DISPLAY_NAME_MAX_LENGTH);
  return name.length > 0 ? name : null;
}

/** A profile description fit to render. Empty means "not set". */
export function normaliseProfileDescription(input: unknown): string {
  if (typeof input !== 'string') return '';
  return tidyDisplayText(input, PROFILE_DESCRIPTION_MAX_LENGTH);
}

/**
 * An office name fit to render, or null when the input is empty.
 *
 * An office is a place, not a person: it starts out named after whoever owns
 * it because that is the only thing we know at first sight, but it is allowed
 * to become "Acme" or "The Lab" and stop referring to anybody. Same containment
 * as a display name — it is drawn in a header other people read.
 */
export function normaliseWorkspaceName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const name = tidyDisplayText(input, WORKSPACE_NAME_MAX_LENGTH);
  return name.length > 0 ? name : null;
}

/**
 * Is this office still wearing the name it was given at creation?
 *
 * Used to decide whether renaming yourself should carry the office along.
 * Comparing against the name the owner had a moment ago is exact rather than a
 * guess: an office someone deliberately called "Acme" cannot match, so it is
 * never quietly renamed out from under them.
 */
export function workspaceNameFollows(
  workspaceName: string,
  ownerDisplayName: string,
): boolean {
  return workspaceName.trim() === personalWorkspaceName(ownerDisplayName);
}
