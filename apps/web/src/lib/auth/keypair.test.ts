import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildAuthPayload,
  displayNameFromPubkey,
  generateSecretKey,
  getPublicKeyHex,
  npubEncode,
  signAuthPayload,
} from '@quintal/shared';
import {
  createInviteLink,
  findMembership,
  listWorkspacesForUser,
  schema,
  sessions,
  users,
  type Database,
} from '@quintal/shared/db';
import { createTestDb, createTestUser } from '@quintal/shared/db/testing';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { eq } from 'drizzle-orm';

import { keypairAuth } from './keypair';

/**
 * The sign-in path, end to end, against a real database.
 *
 * Everything here is a way in that must not work. The happy path is one test;
 * the rest are replay, staleness, a signature made for another deployment, a
 * signature that isn't one, and a nonce issued for somebody else's key. Those
 * are the tests that are worth having — a challenge/response that only ever
 * gets handed correct input is not evidence of anything.
 */

const ORIGIN = 'https://office.example.test';

function buildAuth(db: Database) {
  return betterAuth({
    appName: 'Quintal test',
    baseURL: ORIGIN,
    secret: 'test-secret-not-used-anywhere-at-all',
    database: drizzleAdapter(db, {
      provider: 'sqlite',
      // The same schema production wires up — a test that narrows it is testing
      // a different adapter than the one that ships.
      schema,
      usePlural: true,
    }),
    emailAndPassword: { enabled: false },
    plugins: [keypairAuth({ db })],
  });
}

async function setup() {
  const db = await createTestDb();
  return { db, auth: buildAuth(db) };
}

function keypair() {
  const secretKey = generateSecretKey();
  return { secretKey, pubkey: getPublicKeyHex(secretKey) };
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Ask for a challenge the way the browser does. */
async function challenge(
  auth: ReturnType<typeof buildAuth>,
  pubkey: string,
): Promise<string> {
  const result = (await auth.api.keypairChallenge({
    body: { pubkey },
  })) as { nonce: string };
  return result.nonce;
}

interface VerifyInput {
  pubkey: string;
  sig: string;
  payload: string;
  inviteToken?: string;
}

async function verify(
  auth: ReturnType<typeof buildAuth>,
  body: VerifyInput,
  headers: Headers = new Headers(),
) {
  return auth.api.keypairVerify({ body, headers });
}

/** Run `verify` and report the failure message, or throw if it wrongly passed. */
async function verifyFails(
  auth: ReturnType<typeof buildAuth>,
  body: VerifyInput,
): Promise<string> {
  try {
    await verify(auth, body);
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('verify accepted input it should have refused');
}

describe('challenge', () => {
  it('issues a 32-byte hex nonce and the origin to bind it to', async () => {
    const { auth } = await setup();
    const { pubkey } = keypair();

    const result = (await auth.api.keypairChallenge({ body: { pubkey } })) as {
      nonce: string;
      origin: string;
    };

    assert.match(result.nonce, /^[0-9a-f]{64}$/);
    assert.equal(result.origin, ORIGIN);
  });

  it('refuses anything that is not a public key', async () => {
    const { auth } = await setup();
    await assert.rejects(() => auth.api.keypairChallenge({ body: { pubkey: 'nope' } }));
  });

  it('replaces the outstanding challenge rather than stacking them', async () => {
    // Two live nonces for one identity would mean an unspent older one stays
    // redeemable after the user has visibly started again.
    const { auth } = await setup();
    const { secretKey, pubkey } = keypair();

    const first = await challenge(auth, pubkey);
    const second = await challenge(auth, pubkey);
    assert.notEqual(first, second);

    const stale = buildAuthPayload({
      origin: ORIGIN,
      nonce: first,
      timestamp: nowSeconds(),
    });
    const message = await verifyFails(auth, {
      pubkey,
      sig: signAuthPayload(secretKey, stale),
      payload: stale,
    });
    assert.match(message, /not issued for this key/i);
  });

  it('burns the outstanding nonce even when the attempt fails', async () => {
    // Deliberate: consuming before comparing is what stops an attacker
    // grinding signatures against a nonce that stays alive for its full
    // minute. The cost is that a failed attempt makes you ask again, which is
    // what the browser does anyway.
    const { auth } = await setup();
    const { secretKey, pubkey } = keypair();
    const impostor = keypair();

    const nonce = await challenge(auth, pubkey);
    const payload = buildAuthPayload({
      origin: ORIGIN,
      nonce,
      timestamp: nowSeconds(),
    });

    const first = await verifyFails(auth, {
      pubkey,
      sig: signAuthPayload(impostor.secretKey, payload),
      payload,
    });
    assert.match(first, /does not verify/i);

    // The rightful holder now has to start over — the nonce is gone.
    const second = await verifyFails(auth, {
      pubkey,
      sig: signAuthPayload(secretKey, payload),
      payload,
    });
    assert.match(second, /expired or was already used/i);
  });
});

describe('verify', () => {
  it('creates the user, names them after their npub, and seeds a workspace', async () => {
    const { db, auth } = await setup();
    const { secretKey, pubkey } = keypair();

    const nonce = await challenge(auth, pubkey);
    const payload = buildAuthPayload({
      origin: ORIGIN,
      nonce,
      timestamp: nowSeconds(),
    });
    const result = (await verify(auth, {
      pubkey,
      sig: signAuthPayload(secretKey, payload),
      payload,
    })) as { token: string; user: { id: string; name: string }; isGuest: boolean };

    const row = (await db.select().from(users).where(eq(users.pubkey, pubkey)))[0];
    assert.ok(row, 'a user row exists for the key');

    // Nobody has named themselves yet, and the row says exactly that. It used
    // to store the truncated npub here, which froze a rendering into data and
    // made a generated name impossible to tell from a chosen one.
    assert.equal(row.name, '');

    // The caller still gets something to show, derived from the key.
    assert.equal(result.user.name, displayNameFromPubkey(pubkey));
    assert.ok(result.user.name.startsWith('npub1'));
    assert.ok(npubEncode(pubkey).startsWith(result.user.name.split('…')[0] ?? ''));

    const workspaces = await listWorkspacesForUser(db, row.id);
    assert.equal(workspaces.length, 1);
    assert.equal(workspaces[0]?.role, 'owner');

    assert.equal(result.isGuest, false);

    // A real session row, the same kind any other sign-in would produce.
    const session = (
      await db.select().from(sessions).where(eq(sessions.token, result.token))
    )[0];
    assert.ok(session, 'a session row exists');
    assert.equal(session.userId, row.id);
    assert.equal(session.isGuest, false);
    assert.ok(session.expiresAt.getTime() > Date.now());
  });

  it('signs the same identity back in without creating a second user', async () => {
    const { db, auth } = await setup();
    const { secretKey, pubkey } = keypair();

    for (let i = 0; i < 2; i += 1) {
      const nonce = await challenge(auth, pubkey);
      const payload = buildAuthPayload({
        origin: ORIGIN,
        nonce,
        timestamp: nowSeconds(),
      });
      await verify(auth, {
        pubkey,
        sig: signAuthPayload(secretKey, payload),
        payload,
      });
    }

    const rows = await db.select().from(users).where(eq(users.pubkey, pubkey));
    assert.equal(rows.length, 1, 'one identity, one row');
  });

  it('refuses a replayed nonce', async () => {
    const { auth } = await setup();
    const { secretKey, pubkey } = keypair();

    const nonce = await challenge(auth, pubkey);
    const payload = buildAuthPayload({
      origin: ORIGIN,
      nonce,
      timestamp: nowSeconds(),
    });
    const sig = signAuthPayload(secretKey, payload);

    await verify(auth, { pubkey, sig, payload });

    // Byte-identical request, second time. The nonce was burned on the way in.
    const message = await verifyFails(auth, { pubkey, sig, payload });
    assert.match(message, /expired or was already used/i);
  });

  it('refuses a stale timestamp', async () => {
    const { auth } = await setup();
    const { secretKey, pubkey } = keypair();

    const nonce = await challenge(auth, pubkey);
    const payload = buildAuthPayload({
      origin: ORIGIN,
      nonce,
      timestamp: nowSeconds() - 600,
    });

    const message = await verifyFails(auth, {
      pubkey,
      sig: signAuthPayload(secretKey, payload),
      payload,
    });
    assert.match(message, /stale/i);
  });

  it('refuses a timestamp from the future', async () => {
    const { auth } = await setup();
    const { secretKey, pubkey } = keypair();

    const nonce = await challenge(auth, pubkey);
    const payload = buildAuthPayload({
      origin: ORIGIN,
      nonce,
      timestamp: nowSeconds() + 600,
    });

    const message = await verifyFails(auth, {
      pubkey,
      sig: signAuthPayload(secretKey, payload),
      payload,
    });
    assert.match(message, /stale/i);
  });

  it('refuses a signature made for another origin', async () => {
    const { auth } = await setup();
    const { secretKey, pubkey } = keypair();

    const nonce = await challenge(auth, pubkey);
    // A perfectly valid signature — over a payload naming somebody else's
    // deployment. This is the phishing case.
    const payload = buildAuthPayload({
      origin: 'https://evil.example.test',
      nonce,
      timestamp: nowSeconds(),
    });

    const message = await verifyFails(auth, {
      pubkey,
      sig: signAuthPayload(secretKey, payload),
      payload,
    });
    assert.match(message, /different origin/i);
  });

  it('refuses a bad signature', async () => {
    const { auth } = await setup();
    const { pubkey } = keypair();
    const impostor = keypair();

    const nonce = await challenge(auth, pubkey);
    const payload = buildAuthPayload({
      origin: ORIGIN,
      nonce,
      timestamp: nowSeconds(),
    });

    // Right payload, right nonce, wrong key holding the pen.
    const message = await verifyFails(auth, {
      pubkey,
      sig: signAuthPayload(impostor.secretKey, payload),
      payload,
    });
    assert.match(message, /does not verify/i);
  });

  it('refuses a nonce issued for a different key', async () => {
    const { auth } = await setup();
    const alice = keypair();
    const bob = keypair();

    const alicesNonce = await challenge(auth, alice.pubkey);
    await challenge(auth, bob.pubkey);

    // Bob signs correctly — over Alice's nonce.
    const payload = buildAuthPayload({
      origin: ORIGIN,
      nonce: alicesNonce,
      timestamp: nowSeconds(),
    });

    const message = await verifyFails(auth, {
      pubkey: bob.pubkey,
      sig: signAuthPayload(bob.secretKey, payload),
      payload,
    });
    assert.match(message, /not issued for this key/i);
  });

  it('refuses a browser request from another origin', async () => {
    // Login CSRF: the signature here is valid, it just isn't the victim's.
    // Without this check a page on another site could sign your browser into
    // somebody else's office and watch you type into it.
    const { auth } = await setup();
    const { secretKey, pubkey } = keypair();

    const nonce = await challenge(auth, pubkey);
    const payload = buildAuthPayload({
      origin: ORIGIN,
      nonce,
      timestamp: nowSeconds(),
    });

    let message = '';
    try {
      await verify(
        auth,
        { pubkey, sig: signAuthPayload(secretKey, payload), payload },
        new Headers({ origin: 'https://evil.example.test' }),
      );
      throw new Error('a cross-origin sign-in was accepted');
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.match(message, /must come from this site/i);
  });

  it('still accepts a request with no Origin, for non-browser clients', async () => {
    // A browser always sends Origin cross-origin, so absence means CLI — and
    // locking those out would be a cost with no attacker-facing benefit.
    const { auth } = await setup();
    const { secretKey, pubkey } = keypair();

    const nonce = await challenge(auth, pubkey);
    const payload = buildAuthPayload({
      origin: ORIGIN,
      nonce,
      timestamp: nowSeconds(),
    });

    const result = (await verify(auth, {
      pubkey,
      sig: signAuthPayload(secretKey, payload),
      payload,
    })) as { token: string };
    assert.ok(result.token);
  });

  it('refuses a payload that is not a challenge at all', async () => {
    const { auth } = await setup();
    const { secretKey, pubkey } = keypair();
    await challenge(auth, pubkey);

    const payload = 'please let me in';
    const message = await verifyFails(auth, {
      pubkey,
      sig: signAuthPayload(secretKey, payload),
      payload,
    });
    assert.match(message, /not a Quintal auth challenge/i);
  });
});

describe('guest links', () => {
  async function withHost() {
    const { db, auth } = await setup();
    const host = await createTestUser(db, 'Host');
    return { db, auth, host };
  }

  /** Sign in through a guest link and return the parsed result. */
  async function joinAsGuest(
    auth: ReturnType<typeof buildAuth>,
    token: string,
  ) {
    const { secretKey, pubkey } = keypair();
    const nonce = await challenge(auth, pubkey);
    const payload = buildAuthPayload({
      origin: ORIGIN,
      nonce,
      timestamp: nowSeconds(),
    });
    return {
      pubkey,
      result: (await verify(auth, {
        pubkey,
        sig: signAuthPayload(secretKey, payload),
        payload,
        inviteToken: token,
      })) as { token: string; isGuest: boolean },
    };
  }

  it('lets a guest in and marks the session', async () => {
    const { db, auth, host } = await withHost();
    const { token } = await createInviteLink(db, {
      workspaceId: host.workspaceId,
      createdByUserId: host.id,
    });

    const { pubkey, result } = await joinAsGuest(auth, token);
    assert.equal(result.isGuest, true);

    const session = (
      await db.select().from(sessions).where(eq(sessions.token, result.token))
    )[0];
    assert.equal(session?.isGuest, true, 'the session carries the guest mark');

    const guest = (await db.select().from(users).where(eq(users.pubkey, pubkey)))[0];
    assert.ok(guest, 'a guest is still a person in the room');
  });

  it('does not make a guest a member of the office they visited', async () => {
    // The point of the whole design. A membership outlives the visit, so a
    // leaked ephemeral key would walk back in later with no invite at all.
    // The only durable trace of a visit is the users row the audit log needs.
    const { db, auth, host } = await withHost();
    const { token } = await createInviteLink(db, {
      workspaceId: host.workspaceId,
      createdByUserId: host.id,
    });

    const { pubkey } = await joinAsGuest(auth, token);
    const guest = (await db.select().from(users).where(eq(users.pubkey, pubkey)))[0];
    assert.ok(guest);

    const joined = await listWorkspacesForUser(db, guest.id);
    assert.ok(
      !joined.some((row) => row.workspace.id === host.workspaceId),
      'no membership row in the host workspace',
    );
    assert.ok(
      joined.every((row) => row.role === 'owner'),
      'the only workspace a guest belongs to is the one they own',
    );
  });

  it('carries the grant on the session, and lets it die within a day', async () => {
    const { db, auth, host } = await withHost();
    const { token } = await createInviteLink(db, {
      workspaceId: host.workspaceId,
      createdByUserId: host.id,
    });

    const { result } = await joinAsGuest(auth, token);
    const session = (
      await db.select().from(sessions).where(eq(sessions.token, result.token))
    )[0];
    assert.ok(session);
    assert.equal(session.guestWorkspaceId, host.workspaceId, 'the room gate reads this');

    // A member's session lasts thirty days. A visit that could be resumed for
    // a month is not a visit: the badge and the access should die together.
    const hours = (session.expiresAt.getTime() - Date.now()) / 3_600_000;
    assert.ok(hours <= 25, `a guest session ends on its own, in about a day — got ${hours}h`);
    assert.ok(hours > 1, 'but not before the visit starts');
  });

  it('does not let a key that once visited walk back in without an invite', async () => {
    // The leak case, and the reason a visit is a session rather than a row.
    // Somebody who gets hold of a guest's in-tab key can sign in as them —
    // and must find nothing but that person's own empty office.
    const { db, auth, host } = await withHost();
    const { token } = await createInviteLink(db, {
      workspaceId: host.workspaceId,
      createdByUserId: host.id,
    });
    const { secretKey, pubkey } = keypair();

    // The visit, through the link.
    const first = buildAuthPayload({
      origin: ORIGIN,
      nonce: await challenge(auth, pubkey),
      timestamp: nowSeconds(),
    });
    await verify(auth, {
      pubkey,
      sig: signAuthPayload(secretKey, first),
      payload: first,
      inviteToken: token,
    });

    // Later: the same key, no link.
    const again = buildAuthPayload({
      origin: ORIGIN,
      nonce: await challenge(auth, pubkey),
      timestamp: nowSeconds(),
    });
    const plain = (await verify(auth, {
      pubkey,
      sig: signAuthPayload(secretKey, again),
      payload: again,
    })) as { token: string; isGuest: boolean };

    assert.equal(plain.isGuest, false);
    const session = (await db.select().from(sessions).where(eq(sessions.token, plain.token)))[0];
    assert.equal(session?.guestWorkspaceId ?? null, null, 'no grant without an invite');

    const person = (await db.select().from(users).where(eq(users.pubkey, pubkey)))[0];
    assert.ok(person);
    assert.equal(
      await findMembership(db, person.id, host.workspaceId),
      null,
      'and no membership to fall back on — the office they visited is closed to them',
    );
  });

  it('refuses an expired link', async () => {
    const { db, auth, host } = await withHost();
    const { token } = await createInviteLink(db, {
      workspaceId: host.workspaceId,
      createdByUserId: host.id,
      ttlMs: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const { secretKey, pubkey } = keypair();
    const nonce = await challenge(auth, pubkey);
    const payload = buildAuthPayload({
      origin: ORIGIN,
      nonce,
      timestamp: nowSeconds(),
    });
    const message = await verifyFails(auth, {
      pubkey,
      sig: signAuthPayload(secretKey, payload),
      payload,
      inviteToken: token,
    });
    assert.match(message, /expired/i);
  });

  it('stops letting people in once the link is used up', async () => {
    const { db, auth, host } = await withHost();
    const { token } = await createInviteLink(db, {
      workspaceId: host.workspaceId,
      createdByUserId: host.id,
      maxUses: 2,
    });

    await joinAsGuest(auth, token);
    await joinAsGuest(auth, token);

    const { secretKey, pubkey } = keypair();
    const nonce = await challenge(auth, pubkey);
    const payload = buildAuthPayload({
      origin: ORIGIN,
      nonce,
      timestamp: nowSeconds(),
    });
    const message = await verifyFails(auth, {
      pubkey,
      sig: signAuthPayload(secretKey, payload),
      payload,
      inviteToken: token,
    });
    assert.match(message, /used too many times/i);
  });

  it('refuses a made-up token without touching the database', async () => {
    const { auth } = await setup();
    const { secretKey, pubkey } = keypair();
    const nonce = await challenge(auth, pubkey);
    const payload = buildAuthPayload({
      origin: ORIGIN,
      nonce,
      timestamp: nowSeconds(),
    });
    const message = await verifyFails(auth, {
      pubkey,
      sig: signAuthPayload(secretKey, payload),
      payload,
      inviteToken: 'v2.definitely-not-a-real-token',
    });
    assert.match(message, /not valid/i);
  });
});
