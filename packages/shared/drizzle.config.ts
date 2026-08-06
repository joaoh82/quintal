import { defineConfig } from 'drizzle-kit';

import { loadRootEnv } from './src/db/env.js';
import { resolveDatabaseUrl } from './src/db/url.js';

loadRootEnv();

/**
 * drizzle-kit only needs this for `generate` (schema -> SQL) and the optional
 * `studio`/`push` commands. Self-hosters never run these: `apps/server` applies
 * pending migrations automatically on boot.
 */
export default defineConfig({
  dialect: 'turso', // libSQL — works for both `file:` and `libsql://` URLs
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: resolveDatabaseUrl().url,
    authToken: process.env.DATABASE_AUTH_TOKEN,
  },
  strict: true,
  verbose: true,
});
