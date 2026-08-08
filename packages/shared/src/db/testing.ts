import { randomBytes } from 'node:crypto';

import { createClient } from '@libsql/client';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { drizzle } from 'drizzle-orm/libsql';

import * as schema from './schema.js';
import { MIGRATIONS_FOLDER } from './url.js';
import type { Database } from './client.js';
import { ensurePersonalWorkspace } from './workspaces.js';
import { users } from './schema.js';

/**
 * A real database, in memory, for tests.
 *
 * Deliberately not a mock. The things worth testing down here — that a host
 * token cannot act as a teammate's agent, that a revoked one is refused — are
 * exactly the things a hand-written fake would get right by construction while
 * the real query got them wrong. A fake that agrees with your assumptions is
 * not evidence.
 *
 * `:memory:` rather than a temp file: migrations against SQLite in memory take
 * a few milliseconds, so every test can have a database nobody else has
 * touched, and there is nothing to clean up when one fails halfway.
 *
 * Not exported from the package index — importing `@quintal/shared/db` should
 * never pull the migrator into a production bundle.
 */
export async function createTestDb(): Promise<Database> {
  const client = createClient({ url: ':memory:' });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

export interface TestUser {
  id: string;
  name: string;
  email: string;
  workspaceId: string;
}

/**
 * A signed-up human with their personal workspace, the way the app makes one.
 *
 * Goes through `ensurePersonalWorkspace` rather than inserting rows directly,
 * so a test is exercising the same shape the product produces.
 */
export async function createTestUser(
  db: Database,
  name: string,
  workspaceId?: string,
): Promise<TestUser> {
  const id = randomBytes(8).toString('hex');
  const email = `${name.toLowerCase()}-${id}@example.test`;

  await db.insert(users).values({ id, name, email, emailVerified: true });

  if (workspaceId) return { id, name, email, workspaceId };

  const workspace = await ensurePersonalWorkspace(db, { userId: id, name, email });
  return { id, name, email, workspaceId: workspace.id };
}
