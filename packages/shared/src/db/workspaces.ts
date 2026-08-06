import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import type { Database } from './client.js';
import { memberships, users, workspaces, type Workspace } from './schema.js';
import {
  displayNameFromEmail,
  personalWorkspaceName,
  slugify,
} from '../workspace.js';

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
  /** Falls back to the email local part when a magic-link signup carries no name. */
  name?: string | null;
  email?: string | null;
}

/**
 * Solo-first onboarding: give the user an office of their own the first time
 * they sign in. Idempotent — returns the existing workspace if they already
 * belong to one, so it is safe to call on every request.
 */
export async function ensurePersonalWorkspace(
  db: Database,
  input: EnsurePersonalWorkspaceInput,
): Promise<Workspace> {
  const existing = await db
    .select({ workspace: workspaces })
    .from(memberships)
    .innerJoin(workspaces, eq(memberships.workspaceId, workspaces.id))
    .where(eq(memberships.userId, input.userId))
    .limit(1);

  const found = existing[0];
  if (found) return found.workspace;

  const displayName =
    input.name?.trim() ||
    (input.email ? displayNameFromEmail(input.email) : null) ||
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

/** Convenience for the seed script and future CLI tooling. */
export async function findUserByEmail(db: Database, email: string) {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return rows[0] ?? null;
}
