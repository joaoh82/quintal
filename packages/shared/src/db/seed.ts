import { randomUUID } from 'node:crypto';

import { getDb } from './client.js';
import { users } from './schema.js';
import { ensurePersonalWorkspace, findUserByEmail } from './workspaces.js';

/**
 * Idempotent local seed: one user with their personal workspace, so you can
 * poke at the database without going through the magic-link flow. It creates
 * the user row directly — there is no password to set, and signing in still
 * happens through Better Auth.
 */
export async function seed(): Promise<void> {
  const email = process.env.SEED_EMAIL ?? 'demo@quintal.local';
  const name = process.env.SEED_NAME ?? 'Demo Human';
  const db = getDb();

  const existing = await findUserByEmail(db, email);
  const userId = existing?.id ?? randomUUID();

  if (!existing) {
    await db.insert(users).values({ id: userId, name, email, emailVerified: true });
    console.log(`[seed] created user ${email}`);
  } else {
    console.log(`[seed] user ${email} already exists`);
  }

  const workspace = await ensurePersonalWorkspace(db, {
    userId,
    name: existing?.name ?? name,
    email,
  });
  console.log(`[seed] workspace "${workspace.name}" (/${workspace.slug})`);
}
