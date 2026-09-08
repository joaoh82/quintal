import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildAuthPayload,
  generateSecretKey,
  getPublicKeyHex,
  signAttestation,
  signAuthPayload,
} from '@quintal/shared';
import {
  createAgent,
  issueAgentChallenge,
  memberships,
  revokeAgent,
  setAgentCredential,
  users,
  type Database,
} from '@quintal/shared/db';
import { createTestDb, createTestUser } from '@quintal/shared/db/testing';
import { and, eq } from 'drizzle-orm';

import { authenticateAgentKeypair } from './keypair.js';
import { legacyKeysEnabled } from '../config.js';

/**
 * The fourth door, against a real database.
 *
 * One test walks in. Every other test is a way in that must not work, in the
 * order the door checks them: a malformed credential, a stale one, a bad
 * signature, a signature for another deployment, a replayed nonce, a nonce
 * issued for another key, a key nobody registered, an agent from another
 * office, an attestation the owner's current key did not sign, a revoked
 * agent, and an owner who left. The message for each is asserted, because a
 * documented protocol owes its callers a reason.
 */

const ORIGIN = 'https://office.example.test';

function keypair() {
  const secretKey = generateSecretKey();
  return { secretKey, pubkey: getPublicKeyHex(secretKey) };
}

interface World {
  db: Database;
  owner: Awaited<ReturnType<typeof createTestUser>>;
  agentId: string;
  key: ReturnType<typeof keypair>;
}

async function world(): Promise<World> {
  const db = await createTestDb();
  const owner = await createTestUser(db, 'Josh');
  const agent = await createAgent(db, {
    workspaceId: owner.workspaceId,
    ownerUserId: owner.id,
    name: 'buzz',
    spriteKey: 'slate',
  });
  const key = keypair();
  await setAgentCredential(
    db,
    agent.id,
    {
      pubkey: key.pubkey,
      attestation: signAttestation({
        agentPubkey: key.pubkey,
        ownerPubkey: owner.pubkey,
        ownerSecretKey: owner.secretKey,
      }),
    },
    { via: 'session', userId: owner.id },
  );
  return { db, owner, agentId: agent.id, key };
}

/** What a well-behaved harness sends: a fresh nonce, signed now, for this origin. */
async function join(
  w: World,
  overrides: {
    origin?: string;
    at?: number;
    key?: ReturnType<typeof keypair>;
    nonce?: string;
  } = {},
) {
  const key = overrides.key ?? w.key;
  const nonce = overrides.nonce ?? (await issueAgentChallenge(w.db, key.pubkey));
  const timestamp = Math.floor((overrides.at ?? Date.now()) / 1000);
  const payload = buildAuthPayload({ origin: overrides.origin ?? ORIGIN, nonce, timestamp });
  return {
    agentPubkey: key.pubkey,
    sig: signAuthPayload(key.secretKey, payload),
    nonce,
    timestamp,
  };
}

function open(w: World, options: Parameters<typeof authenticateAgentKeypair>[0], workspaceId = w.owner.workspaceId) {
  return authenticateAgentKeypair(options, workspaceId, { db: w.db, origin: ORIGIN });
}

async function refused(result: Promise<Awaited<ReturnType<typeof authenticateAgentKeypair>>>, fragment: string) {
  const outcome = await result;
  assert.equal(outcome.ok, false, `expected refusal mentioning "${fragment}"`);
  if (!outcome.ok) assert.match(outcome.message, new RegExp(fragment));
}

describe('an agent at the door with its own key', () => {
  it('is admitted as the agent, attributed to its owner', async () => {
    const w = await world();
    const result = await open(w, await join(w));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.identity.id, w.agentId);
      assert.equal(result.identity.ownerUserId, w.owner.id);
      assert.equal(result.ownerPubkey, w.owner.pubkey);
    }
  });

  it('is refused for a malformed credential', async () => {
    const w = await world();
    await refused(open(w, { agentPubkey: 'nope', sig: 'x', nonce: 'y', timestamp: 'z' }), 'Malformed');
    await refused(open(w, { ...(await join(w)), timestamp: '12' }), 'Malformed');
  });

  it('is refused for a stale signature, before any nonce is spent', async () => {
    const w = await world();
    const credential = await join(w, { at: Date.now() - 10 * 60_000 });
    await refused(open(w, credential), 'stale');
    // The nonce is still there: a fresh signature over it walks in.
    const fresh = await join(w, { nonce: credential.nonce });
    assert.equal((await open(w, fresh)).ok, true);
  });

  it('is refused for a signature by another key, and the nonce survives', async () => {
    const w = await world();
    const credential = await join(w);
    const impostor = keypair();
    const forged = {
      ...credential,
      sig: signAuthPayload(
        impostor.secretKey,
        buildAuthPayload({ origin: ORIGIN, nonce: credential.nonce, timestamp: credential.timestamp }),
      ),
    };
    await refused(open(w, forged), 'Signature does not verify');
    assert.equal((await open(w, credential)).ok, true);
  });

  it('is refused for a signature made for another deployment', async () => {
    const w = await world();
    await refused(open(w, await join(w, { origin: 'https://evil.example.test' })), 'Signature does not verify');
  });

  it('cannot replay a nonce', async () => {
    const w = await world();
    const credential = await join(w);
    assert.equal((await open(w, credential)).ok, true);
    await refused(open(w, credential), 'already used');
  });

  it('cannot use a nonce issued for another key, and spends nothing trying', async () => {
    const w = await world();
    const other = keypair();
    const nonce = await issueAgentChallenge(w.db, other.pubkey);
    const mine = await join(w);
    // Signed correctly by our key, over a nonce the office issued to another.
    await refused(open(w, await join(w, { nonce })), 'not issued for this key');
    // Our own outstanding challenge is untouched by the mistake.
    assert.equal((await open(w, mine)).ok, true);
  });

  it('is not locked out by somebody else asking for challenges under its key', async () => {
    const w = await world();
    const mine = await join(w);
    // Anyone can ask: the key is on the agent's card. Asking must not cancel
    // the join in flight.
    await issueAgentChallenge(w.db, w.key.pubkey);
    await issueAgentChallenge(w.db, w.key.pubkey);
    assert.equal((await open(w, mine)).ok, true);
  });

  it('is refused for a key nobody registered', async () => {
    const w = await world();
    await refused(open(w, await join(w, { key: keypair() })), 'No agent has that key');
  });

  it('is refused at another office', async () => {
    const w = await world();
    const elsewhere = await createTestUser(w.db, 'Sam');
    await refused(open(w, await join(w), elsewhere.workspaceId), 'another office');
  });

  it('is refused once the owner rotated their own key', async () => {
    const w = await world();
    // The attestation on file was signed by the old owner key.
    await w.db
      .update(users)
      .set({ pubkey: getPublicKeyHex(generateSecretKey()) })
      .where(eq(users.id, w.owner.id));
    await refused(open(w, await join(w)), 'attestation');
  });

  it('is refused with an attestation that was tampered with in the database', async () => {
    const w = await world();
    const { agents } = await import('@quintal/shared/db');
    const [row] = await w.db.select({ attestation: agents.attestation }).from(agents).where(eq(agents.id, w.agentId));
    const tag = row!.attestation as [string, string, string];
    tag[1] = 'scope=all';
    await w.db.update(agents).set({ attestation: tag }).where(eq(agents.id, w.agentId));
    await refused(open(w, await join(w)), 'attestation');
  });

  it('is refused once revoked', async () => {
    const w = await world();
    await revokeAgent(w.db, w.agentId, w.owner.id);
    await refused(open(w, await join(w)), 'revoked');
  });

  it('is refused once its owner is no longer a member', async () => {
    const w = await world();
    await w.db
      .delete(memberships)
      .where(and(eq(memberships.userId, w.owner.id), eq(memberships.workspaceId, w.owner.workspaceId)));
    await refused(open(w, await join(w)), 'no longer a member');
  });
});

describe('the legacy switch', () => {
  it('is on unless told otherwise, and understands the usual spellings of off', () => {
    assert.equal(legacyKeysEnabled(undefined), true);
    assert.equal(legacyKeysEnabled('true'), true);
    assert.equal(legacyKeysEnabled('yes'), true);
    assert.equal(legacyKeysEnabled('false'), false);
    assert.equal(legacyKeysEnabled(' FALSE '), false);
    assert.equal(legacyKeysEnabled('0'), false);
    assert.equal(legacyKeysEnabled('off'), false);
  });
});
