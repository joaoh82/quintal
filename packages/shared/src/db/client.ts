import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { createClient, type Client } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';

import * as schema from './schema.js';
import { resolveDatabaseUrl } from './url.js';

export type Database = LibSQLDatabase<typeof schema>;

interface Connection {
  client: Client;
  db: Database;
  /** Absolute path for local databases, `null` for remote libSQL. */
  filePath: string | null;
}

let connection: Connection | undefined;

function connect(): Connection {
  const { url, filePath, isRemote } = resolveDatabaseUrl();

  if (filePath) {
    // Self-hosters shouldn't have to mkdir before first boot.
    mkdirSync(dirname(filePath), { recursive: true });
  }

  const client = createClient({
    url,
    ...(isRemote && process.env.DATABASE_AUTH_TOKEN
      ? { authToken: process.env.DATABASE_AUTH_TOKEN }
      : {}),
  });

  return { client, db: drizzle(client, { schema }), filePath };
}

/** Process-wide singleton. Safe to call from anywhere, including Next route handlers. */
export function getDb(): Database {
  connection ??= connect();
  return connection.db;
}

/** Raw libSQL client, for pragmas and migrations. */
export function getClient(): Client {
  connection ??= connect();
  return connection.client;
}

export function getDatabaseFilePath(): string | null {
  connection ??= connect();
  return connection.filePath;
}

/**
 * WAL gives us concurrent readers alongside the writer, which matters once the
 * game loop and the web app share one process. It is a persistent property of
 * the database file, so setting it on boot is enough. Remote libSQL manages its
 * own journaling — skip it there.
 */
export async function enableWalMode(): Promise<void> {
  if (getDatabaseFilePath() === null) return;
  await getClient().execute('PRAGMA journal_mode = WAL;');
  await getClient().execute('PRAGMA foreign_keys = ON;');
}

export async function closeDb(): Promise<void> {
  connection?.client.close();
  connection = undefined;
}

export { schema };
