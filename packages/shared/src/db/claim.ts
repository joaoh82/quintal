import { createHash, randomBytes } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';

import type { Database } from './client.js';
import { instanceSettings, users } from './schema.js';
import { hasInstanceAdmin } from './settings.js';

/**
 * Claim links: how a fresh shared server gets the person in charge.
 *
 * It used to be "the first account to sign in becomes the instance admin". On
 * a server with a public URL that is a race — whoever reaches the sign-in page
 * first owns the place — and the person who stood it up finds out afterwards.
 *
 * So until somebody runs the instance, the server prints a single-use link on
 * boot (and `pnpm admin claim` prints a fresh one). Opening it and signing in
 * is what makes you the admin; signing in without it makes you a member like
 * anybody else. Only the token's hash is stored, the way guest links are, and
 * there is one live link at most: minting replaces the last.
 *
 * The link is good only while nobody is in charge. Once anybody is — through
 * a claim, `QUINTAL_OWNER` or `pnpm admin grant` — the link is spent: every
 * grant clears the stored hash, so revoking the last admin later does not
 * bring an old link back to life.
 */

/** Current token format. Distinct from a guest link's `v2.` so neither is mistaken for the other. */
const TOKEN_PREFIX = 'claim1.';
const TOKEN_BYTES = 32;

/** The single instance-settings row. */
const GLOBAL = 'global';

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Shape-check a token before it costs a database round trip. */
export function parseClaimToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const token = value.trim();
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  // base64url of 32 bytes is 43 unpadded characters.
  if (!/^[A-Za-z0-9_-]{43}$/.test(token.slice(TOKEN_PREFIX.length))) return null;
  return token;
}

/** The address a claim token is opened at. */
export function claimUrl(origin: string, token: string): string {
  return `${origin}/claim?t=${encodeURIComponent(token)}`;
}

/**
 * Make a new claim link, replacing any before it. Returns the plaintext token,
 * which is not recoverable afterwards.
 */
export async function mintClaimToken(db: Database): Promise<string> {
  const token = `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
  const claimTokenHash = hashToken(token);
  await db
    .insert(instanceSettings)
    .values({ id: GLOBAL, claimTokenHash })
    .onConflictDoUpdate({ target: instanceSettings.id, set: { claimTokenHash } });
  return token;
}

/** Forget the live link, if there is one. */
export async function clearClaimToken(db: Database): Promise<void> {
  await db
    .update(instanceSettings)
    .set({ claimTokenHash: null })
    .where(eq(instanceSettings.id, GLOBAL));
}

/**
 * Why a claim link does not work:
 * - `unknown`: not a link of ours, or one a newer link replaced.
 * - `claimed`: the instance already has somebody in charge.
 */
export type ClaimRejection = 'unknown' | 'claimed';

export type ClaimCheck = { ok: true } | { ok: false; reason: ClaimRejection };

/** Is this the live link, on an instance nobody runs yet? Read-only. */
export async function checkClaimToken(db: Database, rawToken: unknown): Promise<ClaimCheck> {
  if (await hasInstanceAdmin(db)) return { ok: false, reason: 'claimed' };
  const token = parseClaimToken(rawToken);
  if (!token) return { ok: false, reason: 'unknown' };

  const rows = await db
    .select({ id: instanceSettings.id })
    .from(instanceSettings)
    .where(and(eq(instanceSettings.id, GLOBAL), eq(instanceSettings.claimTokenHash, hashToken(token))))
    .limit(1);
  return rows.length > 0 ? { ok: true } : { ok: false, reason: 'unknown' };
}

/**
 * Spend the link: make this account the instance admin.
 *
 * The grant carries the whole check in its WHERE clause — the link is the live
 * one *and* nobody is in charge — so two people opening the same link at once
 * cannot both come out as admin: SQLite serialises the writes, and the second
 * finds an admin already there. The hash is cleared afterwards; if that step
 * never happens the link is still dead, because the instance has an admin.
 */
export async function redeemClaimToken(
  db: Database,
  rawToken: unknown,
  userId: string,
): Promise<ClaimCheck> {
  const check = await checkClaimToken(db, rawToken);
  if (!check.ok) return check;
  const hash = hashToken(parseClaimToken(rawToken)!);

  const granted = await db
    .update(users)
    .set({ instanceAdmin: true })
    .where(
      and(
        eq(users.id, userId),
        sql`NOT EXISTS (SELECT 1 FROM ${users} WHERE ${users.instanceAdmin} = 1)`,
        sql`EXISTS (SELECT 1 FROM ${instanceSettings} WHERE ${instanceSettings.id} = ${GLOBAL} AND ${instanceSettings.claimTokenHash} = ${hash})`,
      ),
    )
    .returning({ id: users.id });

  if (granted.length === 0) {
    // Somebody else got there between the check and the grant, or the link was
    // replaced in between. Either way it is not this person's office to claim.
    return (await hasInstanceAdmin(db)) ? { ok: false, reason: 'claimed' } : { ok: false, reason: 'unknown' };
  }
  await clearClaimToken(db);
  return { ok: true };
}

/** What `settleInstanceAdmin` did, for the boot log to say. */
export type AdminSettlement =
  | { kind: 'owner'; pubkey: string; signedIn: boolean }
  | { kind: 'claim'; token: string }
  | { kind: 'settled' };

/**
 * Run on boot of a shared server: make sure somebody can end up in charge.
 *
 * With an owner named in `QUINTAL_OWNER`, that key is the admin — now, if it
 * has an account, or the moment it first signs in — and no link is printed,
 * because there is nothing left to claim. Without one, an instance nobody runs
 * gets a fresh claim link. Fresh on every boot: only the hash is kept, so the
 * last link cannot be printed again, and the newest log line is the one that
 * works.
 */
export async function settleInstanceAdmin(
  db: Database,
  owner: string | null,
): Promise<AdminSettlement> {
  if (owner) {
    await clearClaimToken(db);
    const granted = await db
      .update(users)
      .set({ instanceAdmin: true })
      .where(eq(users.pubkey, owner))
      .returning({ id: users.id });
    return { kind: 'owner', pubkey: owner, signedIn: granted.length > 0 };
  }
  if (await hasInstanceAdmin(db)) {
    await clearClaimToken(db);
    return { kind: 'settled' };
  }
  return { kind: 'claim', token: await mintClaimToken(db) };
}
