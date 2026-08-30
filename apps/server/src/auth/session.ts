import { and, eq, gt } from 'drizzle-orm';

import { displayName } from '@quintal/shared';
import { getDb, sessions, users } from '@quintal/shared/db';

/**
 * Session verification for WebSocket joins.
 *
 * The HTTP side of the app is Better Auth's business; a Colyseus join isn't an
 * HTTP request with cookies attached, so the client hands over its session
 * token explicitly and we check it here against the same table Better Auth
 * writes. No second source of truth, and revoking a session (signing out) kills
 * the game connection's ability to reconnect too.
 */

export interface AuthenticatedUser {
  userId: string;
  name: string;
  /** x-only public key, hex. The identity behind the session. */
  pubkey: string;
  /** True when this session was minted by walking in through a guest link. */
  isGuest: boolean;
  /** Profile line, shown on this person's card in the office. */
  description: string;
}

/**
 * Look up a session token. Returns null for anything that isn't a live session
 * — unknown, expired, or belonging to a deleted user.
 */
export async function verifySessionToken(
  token: unknown,
): Promise<AuthenticatedUser | null> {
  if (typeof token !== 'string' || token.length === 0) return null;

  const rows = await getDb()
    .select({
      userId: users.id,
      name: users.name,
      pubkey: users.pubkey,
      description: users.description,
      isGuest: sessions.isGuest,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    // Expiry is checked in SQL rather than in JS so a clock-skewed row can't
    // slip through a later comparison.
    .where(and(eq(sessions.token, token), gt(sessions.expiresAt, new Date())))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Display name for the office, never empty.
 *
 * Falls back to a truncated npub rather than anything derived from the key's
 * bytes directly: two people who have not named themselves should still be
 * told apart on sight, and the npub is the string they will recognise as
 * theirs.
 *
 * The rule now lives in `@quintal/shared` because the office was not the only
 * place that needed it — the web app rendered the same blank in a header, and
 * the sign-up path sidestepped it entirely by pre-filling the column.
 */
export function displayNameFor(user: AuthenticatedUser): string {
  return displayName(user);
}
