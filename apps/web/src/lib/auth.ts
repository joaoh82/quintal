import 'server-only';

import { devWebPort } from '@quintal/shared';
import { getDb, schema } from '@quintal/shared/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { nextCookies } from 'better-auth/next-js';

import { keypairAuth } from './auth/keypair';

const DEV_SECRET = 'quintal-development-secret-not-for-production';

function resolveSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (secret) return secret;

  // `next build` runs with NODE_ENV=production but never serves a request, and
  // a fresh clone should build without any configuration at all.
  const isBuild = process.env.NEXT_PHASE === 'phase-production-build';

  if (process.env.NODE_ENV === 'production' && !isBuild) {
    throw new Error(
      'BETTER_AUTH_SECRET is required in production. Generate one with: openssl rand -base64 32',
    );
  }

  console.warn(
    '[auth] BETTER_AUTH_SECRET is not set — using a well-known development secret.',
  );
  return DEV_SECRET;
}

export const auth = betterAuth({
  appName: 'Quintal',
  // Follows the dev web port. Sign-in is bound to this origin — see the
  // cross-origin check in the keypair plugin — so a second instance on another
  // port would refuse its own sign-ins if this stayed pinned to 3000.
  baseURL: process.env.BETTER_AUTH_URL ?? `http://localhost:${devWebPort()}`,
  secret: resolveSecret(),

  database: drizzleAdapter(getDb(), {
    provider: 'sqlite',
    schema,
    // Our tables are `users`, `sessions`, `accounts`, `verifications`.
    usePlural: true,
  }),

  // Identity is a keypair. There is no password to leak and no address to
  // send anything to — see `auth/keypair.ts`.
  emailAndPassword: { enabled: false },

  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24, // refresh at most once a day
  },

  plugins: [
    keypairAuth(),
    // Must stay last: lets server actions set the session cookie.
    nextCookies(),
  ],
});

export type Session = typeof auth.$Infer.Session;
