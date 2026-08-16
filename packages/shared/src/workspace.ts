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
