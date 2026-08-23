import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

/**
 * The join gate, against a real database.
 *
 * This is the check standing between a WebSocket and the office, and it is the
 * only one: `OfficeRoom.onAuth` hands a human's token straight to
 * `verifySessionToken` and takes the name from `displayNameFor`. So what is
 * covered here is exactly what the room does.
 *
 * The other half of the chain — that signing a challenge produces a session row
 * of this shape — is covered in `apps/web/src/lib/auth/keypair.test.ts`, which
 * is where the minting lives. Between the two, a key gets you into the room and
 * nothing else does.
 *
 * A temp file rather than `:memory:`, because the module under test reaches for
 * the process-wide connection: `DATABASE_URL` has to be set before anything
 * opens it, which is why it is done here at module scope.
 */

const dir = mkdtempSync(join(tmpdir(), 'quintal-session-test-'));
process.env.DATABASE_URL = `file:${join(dir, 'test.db')}`;

const { getDb, runMigrations, sessions, users } = await import(
  '@quintal/shared/db'
);
const { generateSecretKey, getPublicKeyHex, npubEncode } = await import(
  '@quintal/shared'
);
const { displayNameFor, verifySessionToken } = await import('./session.js');

const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

interface Seeded {
  userId: string;
  pubkey: string;
  token: string;
}

/**
 * A signed-in human. `expiresIn` and `isGuest` are the two things the gate
 * actually reasons about, so they are the two knobs.
 */
async function seedSession(
  options: {
    name?: string;
    expiresInMs?: number;
    isGuest?: boolean;
    description?: string;
  } = {},
): Promise<Seeded> {
  const db = getDb();
  const userId = randomUUID();
  const pubkey = getPublicKeyHex(generateSecretKey());
  const token = randomBytes(32).toString('hex');

  await db.insert(users).values({
    id: userId,
    name: options.name ?? 'Ada',
    pubkey,
    description: options.description ?? '',
  });
  await db.insert(sessions).values({
    id: randomUUID(),
    token,
    userId,
    expiresAt: new Date(Date.now() + (options.expiresInMs ?? THIRTY_DAYS)),
    isGuest: options.isGuest ?? false,
  });

  return { userId, pubkey, token };
}

describe('verifySessionToken', () => {
  before(async () => {
    await runMigrations();
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lets a key-minted session in, carrying the identity behind it', async () => {
    const seeded = await seedSession({ name: 'Ada' });

    const user = await verifySessionToken(seeded.token);

    assert.ok(user, 'a live session is accepted');
    assert.equal(user.userId, seeded.userId);
    assert.equal(user.name, 'Ada');
    assert.equal(user.pubkey, seeded.pubkey);
    assert.equal(user.isGuest, false);
  });

  it('carries the profile description the office renders on a card', async () => {
    const seeded = await seedSession({ description: 'Builds the office.' });

    const user = await verifySessionToken(seeded.token);

    assert.equal(user?.description, 'Builds the office.');
  });

  it('marks a guest session as one', async () => {
    const seeded = await seedSession({ name: 'Visitor', isGuest: true });

    const user = await verifySessionToken(seeded.token);

    assert.equal(user?.isGuest, true, 'the badge survives the join');
  });

  it('turns away an expired session', async () => {
    const seeded = await seedSession({ expiresInMs: -1000 });

    assert.equal(await verifySessionToken(seeded.token), null);
  });

  it('turns away tokens it has never seen', async () => {
    assert.equal(await verifySessionToken(randomBytes(32).toString('hex')), null);
    assert.equal(await verifySessionToken(''), null);
    assert.equal(await verifySessionToken(null), null);
    assert.equal(await verifySessionToken(undefined), null);
    assert.equal(await verifySessionToken(12345), null);
  });
});

describe('displayNameFor', () => {
  it('uses the name when there is one', () => {
    const pubkey = getPublicKeyHex(generateSecretKey());
    assert.equal(
      displayNameFor({ userId: 'u', name: '  Ada  ', pubkey, isGuest: false, description: '' }),
      'Ada',
    );
  });

  it('falls back to a truncated npub, not to a placeholder', () => {
    // An unnamed identity still has to be distinguishable from another one, so
    // "Someone" is not an acceptable answer while a key is available.
    const pubkey = getPublicKeyHex(generateSecretKey());

    const name = displayNameFor({ userId: 'u', name: '', pubkey, isGuest: false, description: '' });

    assert.ok(name.startsWith('npub1'));
    assert.ok(npubEncode(pubkey).endsWith(name.slice(-6)));
  });

  it('never returns an empty label, even for a nonsense key', () => {
    assert.equal(
      displayNameFor({ userId: 'u', name: '', pubkey: 'garbage', isGuest: false, description: '' }),
      'Someone',
    );
  });
});
