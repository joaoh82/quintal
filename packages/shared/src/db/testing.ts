import { randomBytes } from 'node:crypto';

import { createClient } from '@libsql/client';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { drizzle } from 'drizzle-orm/libsql';

import * as schema from './schema.js';
import { MIGRATIONS_FOLDER } from './url.js';
import type { Database } from './client.js';
import { ensurePersonalWorkspace } from './workspaces.js';
import { users } from './schema.js';
import { generateSecretKey, getPublicKeyHex } from '../identity.js';

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
  /** x-only public key, hex — what the `users` row is keyed by. */
  pubkey: string;
  /** The secret half, so a test can sign a real challenge with this identity. */
  secretKey: Uint8Array;
  workspaceId: string;
}

/**
 * A signed-up human with their personal workspace, the way the app makes one.
 *
 * Every test user gets a real keypair rather than a fixture string: the login
 * flow is signature verification all the way down, so a test identity that
 * cannot sign is not an identity the product would accept.
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
  const secretKey = generateSecretKey();
  const pubkey = getPublicKeyHex(secretKey);

  await db.insert(users).values({ id, name, pubkey });

  if (workspaceId) return { id, name, pubkey, secretKey, workspaceId };

  const workspace = await ensurePersonalWorkspace(db, { userId: id, name, pubkey });
  return { id, name, pubkey, secretKey, workspaceId: workspace.id };
}
