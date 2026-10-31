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
  instanceOwner,
  PERSONAL_REFUSALS,
  personalMode,
  verifyAuthSignature,
  normaliseDisplayName,
  type PersonalMode,
} from '@quintal/shared';
import {
  ensurePersonalWorkspace,
  getDb,
  redeemClaimToken,
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
  /** Present when arriving through the claim link of an instance nobody runs. */
  claimToken: z.string().optional(),
  /**
   * With a guest link: what to call the person walking in. A guest keeps the
   * name they arrived with, so arrival is the one moment they choose it.
   * Ignored without a token, and for a key the office already knows.
   */
  name: z.string().max(200).optional(),
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
function crossOriginRequest(headers: Headers | undefined, baseURL: string): string | null {
  const origin = headers?.get('origin');
  if (!origin || origin === expectedOrigin(baseURL)) return null;
  return origin;
}

/**
 * What to say when a sign-in arrives from an origin this server is not set up
 * for. Usually not an attack at all but a deployment whose `BETTER_AUTH_URL`
 * is not the address people type — and then the person reading this is the
 * one who can fix it, so it names both values and the variable.
 */
export function wrongOriginMessage(origin: string, expected: string): string {
  return (
    `This office is set up for ${expected}, but this page is at ${origin}. ` +
    `Open ${expected} instead — or, if ${origin} is the right address, ` +
    `set BETTER_AUTH_URL=${origin} on the server and restart it.`
  );
}

/** Why a claim link was refused, in words for the person holding it. */
export const CLAIM_REFUSALS = {
  unknown:
    'That claim link is not the current one. Each restart prints a new link, and `pnpm admin claim` makes another.',
  claimed: 'This office already has somebody in charge. Ask them, or use `pnpm admin grant` on the server.',
  personal: 'This is a personal office. Its owner already runs it.',
  guest: 'A guest link and a claim link cannot be used together.',
} as const;

export interface KeypairAuthOptions {
  /**
   * The database to write users and memberships to. Defaults to the process
   * singleton; a test passes its own so the plugin and the Better Auth adapter
   * are looking at the same rows.
   */
  db?: Database;
  /**
   * Whether this server is one person's private office, and whose. Defaults
   * to what the environment says — see `personalMode` — so a test can hand in
   * an owner without setting a process-wide variable.
   */
  personal?: PersonalMode | null;
  /**
   * The key named in `QUINTAL_OWNER`, if any — see `instanceOwner`. Defaults
   * to the environment, for the same reason as `personal`.
   */
  owner?: string | null;
}

export const keypairAuth = (options: KeypairAuthOptions = {}) => {
  const database = () => options.db ?? getDb();
  const personal = () => (options.personal === undefined ? personalMode() : options.personal);
  const owner = () => (options.owner === undefined ? instanceOwner() : options.owner);

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
          /** The one office a guest link admits them to. Null for a member. */
          guestWorkspaceId: {
            type: 'string' as const,
            required: false,
            input: false,
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
          // The same refusal `verify` makes, made before anybody is asked to
          // sign: a misconfigured origin should not cost an extension prompt.
          const elsewhere = crossOriginRequest(ctx.headers, ctx.context.baseURL);
          if (elsewhere) {
            throw new APIError('FORBIDDEN', {
              message: wrongOriginMessage(elsewhere, expectedOrigin(ctx.context.baseURL)),
            });
          }
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
          const { pubkey, sig, payload, inviteToken, claimToken, name: askedName } = ctx.body;

          const invalid = (message: string) =>
            new APIError('UNAUTHORIZED', { message });

          const elsewhere = crossOriginRequest(ctx.headers, ctx.context.baseURL);
          if (elsewhere) {
            throw new APIError('FORBIDDEN', {
              message: wrongOriginMessage(elsewhere, expectedOrigin(ctx.context.baseURL)),
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

          // A personal office has one person in it. Loopback is where the
          // desktop app puts it, and loopback is reachable by every process
          // on the machine, so "first key in becomes the admin" would let
          // whatever asked first claim somebody's office. The owner is named
          // before the server starts, and nobody else gets an account — not
          // even as a guest, because there is no door for one to come in by.
          const mode = personal();
          if (mode) {
            if (inviteToken !== undefined) {
              throw new APIError('FORBIDDEN', { message: PERSONAL_REFUSALS.noGuests });
            }
            if (pubkey !== mode.owner) {
              throw new APIError('FORBIDDEN', { message: PERSONAL_REFUSALS.notOwner });
            }
            if (claimToken !== undefined) {
              throw new APIError('FORBIDDEN', { message: CLAIM_REFUSALS.personal });
            }
          }
          if (claimToken !== undefined && inviteToken !== undefined) {
            throw new APIError('FORBIDDEN', { message: CLAIM_REFUSALS.guest });
          }

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
            //
            // Except a guest, who was asked on the way in. A guest cannot
            // rename later — a forwarded link arriving as "Josh" is an
            // attack, not a preference — so the one name they get is the one
            // they give here, and the Guest badge says the rest.
            const name =
              inviteToken !== undefined ? (normaliseDisplayName(askedName) ?? '') : '';
            // Not "the first account in", any more: on a public URL that was a
            // race won by whoever found the sign-in page first. The admin is
            // named — the personal office's owner, or `QUINTAL_OWNER` — or
            // arrives through the claim link below, or is granted later with
            // `pnpm admin`.
            const instanceAdmin = pubkey === (mode?.owner ?? owner());
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

          // After the account exists, because the claim is a grant to it — and
          // before the session, so a refused link refuses the sign-in it came
          // with rather than quietly signing somebody in as a member.
          if (claimToken !== undefined) {
            const claimed = await redeemClaimToken(db, claimToken, user.id);
            if (!claimed.ok) {
              throw new APIError('FORBIDDEN', { message: CLAIM_REFUSALS[claimed.reason] });
            }
          }

          let isGuest = false;
          let guestWorkspaceId: string | null = null;
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
            // the session, which expires on its own, and the room gate reads
            // it — `mayEnterOffice` — so a guest is in exactly one office for
            // exactly as long as the session lasts.
            isGuest = true;
            // The grant the room gate reads. Bounded by the session, so a
            // forwarded link cannot become a standing key to the place.
            guestWorkspaceId = redeemed.link.workspaceId;
          }

          // `overrideAll` is not optional here: without it Better Auth applies
          // the declared default for `isGuest` *after* the override, and every
          // guest session comes out marked as a normal one.
          //
          // The second argument is Better Auth's "don't remember me": a guest
          // session lasts a day rather than the thirty a member's does. The
          // badge and the access should die together, and a visit that could
          // be resumed for a month is not a visit.
          const session = await ctx.context.internalAdapter.createSession(
            user.id,
            isGuest,
            { isGuest, guestWorkspaceId },
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
