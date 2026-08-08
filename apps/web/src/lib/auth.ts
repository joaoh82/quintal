import 'server-only';

import { displayNameFromEmail } from '@quintal/shared';
import { ensurePersonalWorkspace, getDb, schema } from '@quintal/shared/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { nextCookies } from 'better-auth/next-js';
import { magicLink } from 'better-auth/plugins';

import { sendMagicLinkEmail } from './mailer';

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

/**
 * Origins allowed to complete a sign-in.
 *
 * Better Auth trusts only `baseURL` by default, which is right — an open
 * origin list is how a magic link gets completed against somebody else's
 * page. But a spatial office is a thing you naturally test from a second
 * machine on the same desk, and `http://192.168.1.89:3000` is not
 * `http://localhost:3000`.
 *
 * So: **in development only**, private-network addresses are trusted too.
 * Production trusts `baseURL` and whatever `BETTER_AUTH_TRUSTED_ORIGINS`
 * names explicitly, and nothing else. The dev branch cannot widen a
 * production deployment because it is gated on NODE_ENV, and RFC1918
 * addresses are not reachable from the internet in the first place.
 */
const PRIVATE_HOST =
  /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[::1\]|[\w-]+\.local)$/;

function trustedOrigins(): string[] | ((request?: Request) => string[]) {
  const configured = (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  if (process.env.NODE_ENV === 'production') return configured;

  return (request?: Request) => {
    if (!request) return configured;
    // The `Origin` header, not `request.url`: Next rewrites the request URL
    // internally, so it reports localhost even when the browser arrived at a
    // LAN address — which is exactly the case this exists to allow.
    const header = request.headers.get('origin');
    if (!header) return configured;
    try {
      const { hostname } = new URL(header);
      return PRIVATE_HOST.test(hostname) ? [...configured, header] : configured;
    } catch {
      return configured;
    }
  };
}

export const auth = betterAuth({
  appName: 'Quintal',
  baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3000',
  secret: resolveSecret(),
  trustedOrigins: trustedOrigins(),

  database: drizzleAdapter(getDb(), {
    provider: 'sqlite',
    schema,
    // Our tables are `users`, `sessions`, `accounts`, `verifications`.
    usePlural: true,
  }),

  // Magic link only — no passwords to leak, nothing for a self-hoster to rotate.
  emailAndPassword: { enabled: false },

  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24, // refresh at most once a day
  },

  databaseHooks: {
    user: {
      create: {
        // Magic-link signups carry no name — derive one so the office has
        // something to put under your avatar.
        before: (user) => {
          const name = user.name?.trim()
            ? user.name
            : displayNameFromEmail(user.email);
          return Promise.resolve({ data: { ...user, name } });
        },
        after: async (user) => {
          // Solo-first onboarding: your office exists before you first see it.
          await ensurePersonalWorkspace(getDb(), {
            userId: user.id,
            name: user.name,
            email: user.email,
          });
        },
      },
    },
  },

  plugins: [
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        await sendMagicLinkEmail({ to: email, url });
      },
    }),
    // Must stay last: lets server actions set the session cookie.
    nextCookies(),
  ],
});

export type Session = typeof auth.$Infer.Session;
