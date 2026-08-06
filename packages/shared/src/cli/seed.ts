import { closeDb } from '../db/client.js';
import { loadRootEnv } from '../db/env.js';
import { runMigrations } from '../db/migrate.js';
import { seed } from '../db/seed.js';
import { resolveDatabaseUrl } from '../db/url.js';

/** `pnpm db:seed` — safe to run repeatedly. */
async function main(): Promise<void> {
  loadRootEnv();
  console.log(`[seed] using ${resolveDatabaseUrl().url}`);
  await runMigrations();
  await seed();
  await closeDb();
  console.log('[seed] done');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
