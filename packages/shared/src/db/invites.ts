import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { and, eq, isNull, sql } from 'drizzle-orm';

import type { Database } from './client.js';
import { inviteLinks, memberships, type InviteLink } from './schema.js';
import type { MembershipRole } from '../workspace.js';

/**
 * Guest links: a way into one office for somebody who has no identity yet.
 *
 * The plaintext token is `v2.` + 32 random bytes, base64url. Only its SHA-256
 * hash is stored, for the same reason agent keys are hashed: a database that
 * leaks should not be a set of working doors. The `v2.` prefix rides outside
 * the hash so a token's format is legible on sight — a later format can be
 * rejected early instead of failing an expensive lookup.
 */

/** Current token format. Bump alongside `parseInviteToken`. */
const TOKEN_PREFIX = 'v2.';
const TOKEN_BYTES = 32;

/** Default lifetime of a guest link. */
export const INVITE_DEFAULT_TTL_MS = 72 * 60 * 60 * 1000;

/**
 * Hard ceiling on how many people one link can let in.
 *
 * A link is pasted into chats and forwarded; without a ceiling, a single
 * forwarded URL is an unbounded standing invitation to an office.
 */
export const INVITE_MAX_USES_LIMIT = 100;

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Shape-check a token before it costs a database round trip. */
export function parseInviteToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const token = value.trim();
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const body = token.slice(TOKEN_PREFIX.length);
  // base64url of 32 bytes is 43 unpadded characters.
  if (!/^[A-Za-z0-9_-]{43}$/.test(body)) return null;
  return token;
}

export interface CreateInviteLinkInput {
  workspaceId: string;
  createdByUserId: string;
  role?: MembershipRole;
  /** Defaults to 72 hours. */
  ttlMs?: number;
  /** Defaults to 1, clamped to `INVITE_MAX_USES_LIMIT`. */
  maxUses?: number;
}

export interface CreatedInviteLink {
  link: InviteLink;
  /** Shown once, at creation. Not recoverable from the row. */
  token: string;
}

export async function createInviteLink(
  db: Database,
  input: CreateInviteLinkInput,
): Promise<CreatedInviteLink> {
  const token = `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
  const ttl = Math.max(1, Math.trunc(input.ttlMs ?? INVITE_DEFAULT_TTL_MS));
  const maxUses = Math.min(
    INVITE_MAX_USES_LIMIT,
    Math.max(1, Math.trunc(input.maxUses ?? 1)),
  );

  const link: InviteLink = {
    id: randomUUID(),
    workspaceId: input.workspaceId,
    tokenHash: hashToken(token),
    role: input.role ?? 'member',
    createdByUserId: input.createdByUserId,
    expiresAt: new Date(Date.now() + ttl),
    maxUses,
    usedCount: 0,
    createdAt: new Date(),
    revokedAt: null,
  };

  await db.insert(inviteLinks).values(link);
  return { link, token };
}

export type InviteRejection = 'unknown' | 'revoked' | 'expired' | 'exhausted';

export type InviteCheck =
  | { ok: true; link: InviteLink }
  | { ok: false; reason: InviteRejection };

/**
 * Is this token good right now? Read-only — call `redeemInviteLink` to actually
 * spend a use, which re-checks everything atomically.
 */
export async function checkInviteLink(
  db: Database,
  rawToken: unknown,
  now: Date = new Date(),
): Promise<InviteCheck> {
  const token = parseInviteToken(rawToken);
  if (!token) return { ok: false, reason: 'unknown' };

  const rows = await db
    .select()
    .from(inviteLinks)
    .where(eq(inviteLinks.tokenHash, hashToken(token)))
    .limit(1);

  const link = rows[0];
  if (!link) return { ok: false, reason: 'unknown' };

  // The lookup was by hash, so this is belt-and-braces rather than the real
  // gate — but a comparison on a secret-derived value has no business being
  // short-circuiting.
  const expected = Buffer.from(link.tokenHash, 'hex');
  const actual = Buffer.from(hashToken(token), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: 'unknown' };
  }

  if (link.revokedAt) return { ok: false, reason: 'revoked' };
  if (link.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: 'expired' };
  }
  if (link.usedCount >= link.maxUses) return { ok: false, reason: 'exhausted' };

  return { ok: true, link };
}

/**
 * Spend one use of a link.
 *
 * The increment carries the whole check in its WHERE clause, so two guests
 * arriving on the last use of a link cannot both get in: SQLite serialises the
 * writes and exactly one of them updates a row.
 */
export async function redeemInviteLink(
  db: Database,
  rawToken: unknown,
  now: Date = new Date(),
): Promise<InviteCheck> {
  const check = await checkInviteLink(db, rawToken, now);
  if (!check.ok) return check;

  const updated = await db
    .update(inviteLinks)
    .set({ usedCount: sql`${inviteLinks.usedCount} + 1` })
    .where(
      and(
        eq(inviteLinks.id, check.link.id),
        isNull(inviteLinks.revokedAt),
        sql`${inviteLinks.usedCount} < ${inviteLinks.maxUses}`,
        sql`${inviteLinks.expiresAt} > ${now.getTime()}`,
      ),
    )
    .returning();

  const row = updated[0];
  if (!row) {
    // Somebody else took the last use between the check and the update.
    return { ok: false, reason: 'exhausted' };
  }
  return { ok: true, link: row };
}

/** Put a redeemed guest into the workspace, if they are not already in it. */
export async function ensureMembership(
  db: Database,
  input: { workspaceId: string; userId: string; role: MembershipRole },
): Promise<void> {
  const existing = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.workspaceId, input.workspaceId),
        eq(memberships.userId, input.userId),
      ),
    )
    .limit(1);

  if (existing.length > 0) return;

  await db.insert(memberships).values({
    id: randomUUID(),
    workspaceId: input.workspaceId,
    userId: input.userId,
    role: input.role,
  });
}

/** Revoke a link without deleting it — a spent link stays explainable. */
export async function revokeInviteLink(
  db: Database,
  id: string,
  workspaceId: string,
): Promise<void> {
  await db
    .update(inviteLinks)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(inviteLinks.id, id), eq(inviteLinks.workspaceId, workspaceId)),
    );
}

/** Every link for a workspace, newest first. Hashes only — never the plaintext. */
export async function listInviteLinks(
  db: Database,
  workspaceId: string,
): Promise<InviteLink[]> {
  return db
    .select()
    .from(inviteLinks)
    .where(eq(inviteLinks.workspaceId, workspaceId));
}
