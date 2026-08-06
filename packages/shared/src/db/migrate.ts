import { migrate } from 'drizzle-orm/libsql/migrator';

import { enableWalMode, getDb } from './client.js';
import { MIGRATIONS_FOLDER } from './url.js';

/**
 * Apply pending migrations. Called on every server boot — self-hosters must
 * never have to run a migration command by hand.
 *
 * Keep this module free of top-level `await`: it is imported (transitively) by
 * `next.config.ts`, which Next loads with `require()`.
 */
export async function runMigrations(): Promise<void> {
  await enableWalMode();
  await migrate(getDb(), { migrationsFolder: MIGRATIONS_FOLDER });
}
