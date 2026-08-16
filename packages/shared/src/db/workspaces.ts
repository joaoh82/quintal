import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import type { Database } from './client.js';
import { memberships, users, workspaces, type Workspace } from './schema.js';
import { displayNameFromPubkey } from '../identity.js';
import { personalWorkspaceName, slugify } from '../workspace.js';

/** Find a free slug by appending `-2`, `-3`, … to the base. */
async function uniqueSlug(db: Database, base: string): Promise<string> {
  const root = slugify(base);
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const candidate = attempt === 1 ? root : `${root}-${attempt}`;
    const existing = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.slug, candidate))
      .limit(1);
    if (existing.length === 0) return candidate;
  }
  return `${root}-${randomUUID().slice(0, 8)}`;
}

export interface EnsurePersonalWorkspaceInput {
  userId: string;
  /** Falls back to a truncated npub when the identity has not been named yet. */
  name?: string | null;
  pubkey?: string | null;
}

/**
 * Solo-first onboarding: give the user an office of their own the first time
 * they sign in. Idempotent — returns the same workspace on every call, so it is
 * safe to run on every request.
 *
 * "Personal" means *the one they own*, and the query says so. It used to take
 * whichever membership came back first, which was indistinguishable from this
 * for as long as everybody had exactly one. Guests broke that assumption: they
 * hold a membership in the office that invited them as well as their own, and
 * an unordered `limit(1)` across both is a coin toss decided by insertion
 * order. Landing on the wrong side of it hands a visitor the host's settings
 * page — their agents, their guest links — because every caller treats what
 * comes back as "your office, which you administer".
 *
 * Teams will make multiple memberships normal rather than exceptional, so this
 * has to be precise about which one it means rather than correct by accident.
 */
export async function ensurePersonalWorkspace(
  db: Database,
  input: EnsurePersonalWorkspaceInput,
): Promise<Workspace> {
  const existing = await db
    .select({ workspace: workspaces })
    .from(memberships)
    .innerJoin(workspaces, eq(memberships.workspaceId, workspaces.id))
    .where(
      and(
        eq(memberships.userId, input.userId),
        eq(memberships.role, 'owner'),
      ),
    )
    .limit(1);

  const found = existing[0];
  if (found) return found.workspace;

  const displayName =
    input.name?.trim() ||
    (input.pubkey ? displayNameFromPubkey(input.pubkey) : null) ||
    'Quintal';

  const workspace: Workspace = {
    id: randomUUID(),
    name: personalWorkspaceName(displayName),
    slug: await uniqueSlug(db, displayName),
    createdAt: new Date(),
  };

  await db.insert(workspaces).values(workspace);
  await db.insert(memberships).values({
    id: randomUUID(),
    workspaceId: workspace.id,
    userId: input.userId,
    role: 'owner',
  });

  return workspace;
}

/** Every workspace the user belongs to, with their role in it. */
export async function listWorkspacesForUser(
  db: Database,
  userId: string,
): Promise<Array<{ workspace: Workspace; role: string }>> {
  const rows = await db
    .select({ workspace: workspaces, role: memberships.role })
    .from(memberships)
    .innerJoin(workspaces, eq(memberships.workspaceId, workspaces.id))
    .where(eq(memberships.userId, userId));
  return rows;
}

/** Membership lookup used to gate room joins. */
export async function findMembership(
  db: Database,
  userId: string,
  workspaceId: string,
) {
  const rows = await db
    .select()
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Look somebody up by the key they sign with. Hex, never an npub. */
export async function findUserByPubkey(db: Database, pubkey: string) {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.pubkey, pubkey))
    .limit(1);
  return rows[0] ?? null;
}
