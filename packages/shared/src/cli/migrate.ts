import { closeDb } from '../db/client.js';
import { loadRootEnv } from '../db/env.js';
import { runMigrations } from '../db/migrate.js';
import { resolveDatabaseUrl } from '../db/url.js';

/**
 * `pnpm db:migrate` — the same code path the server runs on boot. You only need
 * this to prepare a database without starting anything.
 */
async function main(): Promise<void> {
  loadRootEnv();
  console.log(`[db] migrating ${resolveDatabaseUrl().url}`);
  await runMigrations();
  console.log('[db] up to date');
  await closeDb();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
