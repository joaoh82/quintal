import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  AUTH_NONCE_BYTES,
  AUTH_NONCE_TTL_MS,
  AUTH_TIMESTAMP_SKEW_MS,
  buildAuthPayload,
  displayName,
  isNonceHex,
  isPubkeyHex,
  isSignatureHex,
  parseAuthPayload,
  verifyAuthSignature,
} from '@quintal/shared';
import {
  ensurePersonalWorkspace,
  getDb,
  hasInstanceAdmin,
  redeemInviteLink,
  users,
  type Database,
} from '@quintal/shared/db';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import * as z from 'zod';

/**
 * Sign-in by signature.
 *
 * Two round trips. `POST /api/auth/challenge` issues a single-use nonce for a
 * public key; `POST /api/auth/verify` takes a BIP-340 signature over the
 * canonical payload built from that nonce and, if it holds up, mints an
 * ordinary Better Auth session — same table, same cookie, same expiry as any
 * other session in the app. Better Auth stays the session layer; only the proof
 * of identity changed.
 *
 * Written as a plugin rather than a pair of route handlers because minting a
 * session needs the endpoint context: `setSessionCookie` signs and chunks the
 * cookie exactly the way the rest of Better Auth expects to read it, and
 * reimplementing that outside the framework is how the two drift apart.
 *
 * Users are created here directly against Drizzle rather than through
 * `internalAdapter.createUser`, because that path insists on writing an `email`
 * column this schema no longer has.
 */

const challengeBody = z.object({
  /** x-only public key, lowercase hex. */
  pubkey: z.string(),
});

const verifyBody = z.object({
  pubkey: z.string(),
  sig: z.string(),
  payload: z.string(),
  /** Present when arriving through a guest link. */
  inviteToken: z.string().optional(),
});

/** Compare two hex strings without leaking where they first differ. */
function constantTimeHexEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  // timingSafeEqual throws on a length mismatch, which would itself be a leak;
  // the length of a nonce is not secret, so checking it first is safe.
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * The origin a signature must be bound to.
 *
 * Taken from the configured base URL, not from the request's `Origin` header —
 * a header the caller controls cannot be the thing that validates the caller.
 */
function expectedOrigin(baseURL: string): string {
  return new URL(baseURL).origin;
}

/**
 * Refuse a browser request that came from somewhere else.
 *
 * Not the signature check — that is `verifyAuthSignature`, and it is what
 * proves identity. This stops *login CSRF*: a page on another origin making
 * your browser sign in as somebody else, so you go on to type into an office
 * that belongs to them. The signature in that request is perfectly valid; it
 * just isn't yours.
 *
 * A missing `Origin` is allowed through, because a browser always sends one on
 * a cross-origin request — an attacker cannot strip it — while a CLI or the
 * future desktop app sends none. So this closes the browser attack without
 * shutting the door on non-browser clients.
 */
function crossOriginRequest(headers: Headers | undefined, baseURL: string): boolean {
  const origin = headers?.get('origin');
  if (!origin) return false;
  return origin !== expectedOrigin(baseURL);
}

export interface KeypairAuthOptions {
  /**
   * The database to write users and memberships to. Defaults to the process
   * singleton; a test passes its own so the plugin and the Better Auth adapter
   * are looking at the same rows.
   */
  db?: Database;
}

export const keypairAuth = (options: KeypairAuthOptions = {}) => {
  const database = () => options.db ?? getDb();

  return {
    id: 'keypair',

    /**
     * Declared so Better Auth keeps these columns when it filters a row on the
     * way out: anything not in the schema is stripped from `session.user`, and
     * the office needs the key it is rendering an npub from.
     */
    schema: {
      user: {
        fields: {
          pubkey: { type: 'string' as const, required: true, input: false },
        },
      },
      session: {
        fields: {
          isGuest: {
            type: 'boolean' as const,
            required: false,
            input: false,
            defaultValue: false,
          },
        },
      },
    },

    endpoints: {
      /**
       * POST `/api/auth/challenge` — `{ pubkey }` -> `{ nonce }`.
       *
       * Issued to anyone who asks. A nonce is worthless without the secret key
       * that matches the public one, and refusing to issue them for unknown
       * keys would turn this endpoint into an oracle for which keys have
       * accounts here.
       */
      keypairChallenge: createAuthEndpoint(
        '/challenge',
        { method: 'POST', body: challengeBody },
        async (ctx) => {
          const { pubkey } = ctx.body;
          if (!isPubkeyHex(pubkey)) {
            throw new APIError('BAD_REQUEST', {
              message: 'pubkey must be a 32-byte x-only public key in hex.',
            });
          }

          const nonce = randomBytes(AUTH_NONCE_BYTES).toString('hex');

          // Keyed by pubkey, so asking twice replaces the outstanding
          // challenge rather than leaving two live nonces for one identity.
          await ctx.context.internalAdapter.deleteVerificationByIdentifier(
            pubkey,
          );
          await ctx.context.internalAdapter.createVerificationValue({
            identifier: pubkey,
            value: nonce,
            expiresAt: new Date(Date.now() + AUTH_NONCE_TTL_MS),
          });

          return ctx.json({
            nonce,
            origin: expectedOrigin(ctx.context.baseURL),
            expiresInMs: AUTH_NONCE_TTL_MS,
          });
        },
      ),

      /**
       * POST `/api/auth/verify` — `{ pubkey, sig, payload }` -> a session.
       *
       * Every check below is a way this can be abused, in the order it can be:
       * a malformed key, a payload for another deployment, a stale one, a
       * replayed nonce, a nonce issued for somebody else's key, and finally a
       * signature that simply isn't valid.
       */
      keypairVerify: createAuthEndpoint(
        '/verify',
        { method: 'POST', body: verifyBody, requireHeaders: true },
        async (ctx) => {
          const { pubkey, sig, payload, inviteToken } = ctx.body;

          const invalid = (message: string) =>
            new APIError('UNAUTHORIZED', { message });

          if (crossOriginRequest(ctx.headers, ctx.context.baseURL)) {
            throw new APIError('FORBIDDEN', {
              message: 'Sign-in must come from this site.',
            });
          }

          if (!isPubkeyHex(pubkey) || !isSignatureHex(sig)) {
            throw invalid('Malformed public key or signature.');
          }

          const fields = parseAuthPayload(payload);
          if (!fields) throw invalid('Payload is not a Quintal auth challenge.');

          if (fields.origin !== expectedOrigin(ctx.context.baseURL)) {
            throw invalid('That signature was made for a different origin.');
          }

          const skew = Math.abs(Date.now() - fields.timestamp * 1000);
          if (skew > AUTH_TIMESTAMP_SKEW_MS) {
            throw invalid(
              'That signature is stale. Check your clock and try again.',
            );
          }

          if (!isNonceHex(fields.nonce)) throw invalid('Malformed nonce.');

          // Atomic: the row is deleted as it is read, so a replay of the same
          // payload finds nothing. Expired rows are deleted and reported as
          // missing, which is exactly the behaviour we want.
          const stored =
            await ctx.context.internalAdapter.consumeVerificationValue(pubkey);
          if (!stored) {
            throw invalid('That challenge has expired or was already used.');
          }
          if (!constantTimeHexEqual(stored.value, fields.nonce)) {
            throw invalid('That challenge was not issued for this key.');
          }

          if (!verifyAuthSignature({ pubkey, sig, payload })) {
            throw invalid('Signature does not verify against that public key.');
          }

          // --- the caller is who they say they are, from here on ---

          const db = database();
          const existing = await ctx.context.adapter.findOne<{
            id: string;
            name: string;
            pubkey: string;
          }>({
            model: 'user',
            where: [{ field: 'pubkey', value: pubkey }],
          });

          let user = existing;
          if (!user) {
            const id = randomUUID();
            // Blank, not the truncated npub. Nobody has named themselves at
            // this point, and `displayName` says so at render time from the
            // key we already have. Writing the derived string here instead
            // would freeze one rendering into the row forever: it survives
            // every later improvement to how keys are shown, and it makes
            // "has this person picked a name?" unanswerable.
            const name = '';
            // The first account on an instance is the person standing it up,
            // and somebody has to be able to name the place. After that, admin
            // is granted deliberately — see `pnpm admin` — or not at all.
            const instanceAdmin = !(await hasInstanceAdmin(db));
            await db.insert(users).values({ id, name, pubkey, instanceAdmin });
            user = { id, name, pubkey };
          }

          // Solo-first: your own office exists before you first see it. Guests
          // get one too, so a guest who comes back as a full member is not a
          // person without a home.
          await ensurePersonalWorkspace(db, {
            userId: user.id,
            name: user.name,
            pubkey,
          });

          let isGuest = false;
          if (inviteToken !== undefined) {
            const redeemed = await redeemInviteLink(db, inviteToken);
            if (!redeemed.ok) {
              throw new APIError('FORBIDDEN', {
                message:
                  redeemed.reason === 'expired'
                    ? 'That guest link has expired.'
                    : redeemed.reason === 'exhausted'
                      ? 'That guest link has been used too many times.'
                      : redeemed.reason === 'revoked'
                        ? 'That guest link was revoked.'
                        : 'That guest link is not valid.',
              });
            }
            // Deliberately no `memberships` row. A membership outlives the
            // visit, so minting one turns a link bounded by an expiry and a
            // use count into a standing credential — a leaked ephemeral key
            // would walk back in with no invite at all. The grant belongs to
            // the session, which expires on its own; the session-scoped grant
            // and the room gate that reads it land together when offices
            // become workspace-scoped, because a grant nothing checks is
            // decoration. Until then no room is scoped, so there is nothing
            // for a membership to unlock.
            isGuest = true;
          }

          // `overrideAll` is not optional here: without it Better Auth applies
          // the declared default for `isGuest` *after* the override, and every
          // guest session comes out marked as a normal one.
          const session = await ctx.context.internalAdapter.createSession(
            user.id,
            false,
            { isGuest },
            true,
          );
          if (!session) {
            throw new APIError('INTERNAL_SERVER_ERROR', {
              message: 'Could not create a session.',
            });
          }

          await setSessionCookie(ctx, { session, user: user as never });

          return ctx.json({
            token: session.token,
            // The effective name, not the stored one: this field exists to be
            // rendered, and a caller holding a blank string has no way to work
            // out what to show instead.
            user: { id: user.id, name: displayName(user), pubkey: user.pubkey },
            isGuest,
          });
        },
      ),
    },

    /**
     * Signature verification is cheap but not free, and an unauthenticated
     * caller can ask for as many challenges as it likes. Both endpoints are
     * capped per window.
     */
    rateLimit: [
      {
        pathMatcher(path: string) {
          return path === '/challenge' || path === '/verify';
        },
        window: 60,
        max: 20,
      },
    ],
  };
};
