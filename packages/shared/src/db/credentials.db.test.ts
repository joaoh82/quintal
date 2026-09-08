import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { eq } from 'drizzle-orm';

import { signAttestation } from '../attestation.js';
import { generateSecretKey, getPublicKeyHex } from '../identity.js';
import {
  CredentialError,
  createAgent,
  findAgentByPubkey,
  findAgentById,
  listAgentsForWorkspace,
  revokeAgent,
  setAgentCredential,
} from './agents.js';
import { AGENT_CHALLENGES_PER_KEY, consumeAgentChallenge, issueAgentChallenge } from './challenges.js';
import { agents, memberships, verifications } from './schema.js';
import { createTestDb, createTestUser } from './testing.js';

/**
 * Credentials v2 at rest: registering a key, and the nonce an agent spends to
 * use it. Everything here is against a real database because the interesting
 * failures are in the queries — a lookup that forgot to refuse revoked rows, a
 * consume that could be satisfied twice.
 */

function keypair() {
  const secretKey = generateSecretKey();
  return { secretKey, pubkey: getPublicKeyHex(secretKey) };
}

async function agentFor(db: Awaited<ReturnType<typeof createTestDb>>, owner: Awaited<ReturnType<typeof createTestUser>>) {
  return createAgent(db, {
    workspaceId: owner.workspaceId,
    ownerUserId: owner.id,
    name: 'buzz',
    spriteKey: 'slate',
  });
}

describe('registering an agent key', () => {
  it('stores the key and attestation when the owner signed for that key', async () => {
    const db = await createTestDb();
    const josh = await createTestUser(db, 'Josh');
    const agent = await agentFor(db, josh);
    const key = keypair();
    const attestation = signAttestation({
      agentPubkey: key.pubkey,
      ownerPubkey: josh.pubkey,
      ownerSecretKey: josh.secretKey,
    });

    await setAgentCredential(db, agent.id, { pubkey: key.pubkey, attestation }, { via: 'session', userId: josh.id });

    const found = await findAgentByPubkey(db, key.pubkey);
    assert.ok(found);
    assert.equal(found.identity.id, agent.id);
    assert.equal(found.ownerPubkey, josh.pubkey);
    assert.deepEqual(found.attestation, attestation);
    assert.equal((await findAgentById(db, agent.id))?.pubkey, key.pubkey);
  });

  it("refuses an attestation not signed by the agent's owner, whoever is asking", async () => {
    const db = await createTestDb();
    const josh = await createTestUser(db, 'Josh');
    const admin = await createTestUser(db, 'Admin', josh.workspaceId);
    await db.insert(memberships).values({
      id: 'm-admin',
      workspaceId: josh.workspaceId,
      userId: admin.id,
      role: 'admin',
    });
    const agent = await agentFor(db, josh);
    const key = keypair();
    // Signed by the admin, who may administer the agent but is not its owner.
    const attestation = signAttestation({
      agentPubkey: key.pubkey,
      ownerPubkey: admin.pubkey,
      ownerSecretKey: admin.secretKey,
    });

    await assert.rejects(
      setAgentCredential(db, agent.id, { pubkey: key.pubkey, attestation }, { via: 'session', userId: admin.id }),
      CredentialError,
    );
    assert.equal(await findAgentByPubkey(db, key.pubkey), null);
  });

  it("refuses the owner's own key as an agent key", async () => {
    const db = await createTestDb();
    const josh = await createTestUser(db, 'Josh');
    const agent = await agentFor(db, josh);
    await assert.rejects(
      setAgentCredential(
        db,
        agent.id,
        { pubkey: josh.pubkey, attestation: [josh.pubkey, '', '0'.repeat(128)] },
        { via: 'session', userId: josh.id },
      ),
      CredentialError,
    );
  });

  it('refuses a revoked agent, and stops answering for one revoked later', async () => {
    const db = await createTestDb();
    const josh = await createTestUser(db, 'Josh');
    const agent = await agentFor(db, josh);
    const key = keypair();
    const attestation = signAttestation({
      agentPubkey: key.pubkey,
      ownerPubkey: josh.pubkey,
      ownerSecretKey: josh.secretKey,
    });
    await setAgentCredential(db, agent.id, { pubkey: key.pubkey, attestation }, { via: 'session', userId: josh.id });
    assert.ok(await findAgentByPubkey(db, key.pubkey));

    await revokeAgent(db, agent.id, josh.id);
    assert.equal(await findAgentByPubkey(db, key.pubkey), null);
    await assert.rejects(
      setAgentCredential(db, agent.id, { pubkey: keypair().pubkey, attestation }, { via: 'session', userId: josh.id }),
      CredentialError,
    );
  });

  it('rotating replaces the key: the old one stops resolving', async () => {
    const db = await createTestDb();
    const josh = await createTestUser(db, 'Josh');
    const agent = await agentFor(db, josh);
    const first = keypair();
    const second = keypair();
    const attest = (pubkey: string) =>
      signAttestation({ agentPubkey: pubkey, ownerPubkey: josh.pubkey, ownerSecretKey: josh.secretKey });

    await setAgentCredential(db, agent.id, { pubkey: first.pubkey, attestation: attest(first.pubkey) }, { via: 'session', userId: josh.id });
    await setAgentCredential(db, agent.id, { pubkey: second.pubkey, attestation: attest(second.pubkey) }, { via: 'host', hostId: 'h1' });

    assert.equal(await findAgentByPubkey(db, first.pubkey), null);
    assert.equal((await findAgentByPubkey(db, second.pubkey))?.identity.id, agent.id);
  });

  it('never lets two agents share a key, and says so', async () => {
    const db = await createTestDb();
    const josh = await createTestUser(db, 'Josh');
    const a = await agentFor(db, josh);
    const b = await agentFor(db, josh);
    const key = keypair();
    const attestation = signAttestation({ agentPubkey: key.pubkey, ownerPubkey: josh.pubkey, ownerSecretKey: josh.secretKey });
    await setAgentCredential(db, a.id, { pubkey: key.pubkey, attestation }, { via: 'session', userId: josh.id });
    await assert.rejects(
      setAgentCredential(db, b.id, { pubkey: key.pubkey, attestation }, { via: 'session', userId: josh.id }),
      (error: unknown) => error instanceof CredentialError && /already registered/.test(error.message),
    );
    // Re-registering the same key to the same agent is not a conflict.
    await setAgentCredential(db, a.id, { pubkey: key.pubkey, attestation }, { via: 'session', userId: josh.id });
  });

  it('nothing the office lists about an agent can carry a secret', async () => {
    const db = await createTestDb();
    const josh = await createTestUser(db, 'Josh');
    const agent = await agentFor(db, josh);
    const key = keypair();
    const attestation = signAttestation({ agentPubkey: key.pubkey, ownerPubkey: josh.pubkey, ownerSecretKey: josh.secretKey });
    await setAgentCredential(db, agent.id, { pubkey: key.pubkey, attestation }, { via: 'session', userId: josh.id });
    const [row] = await db.select({ hash: agents.apiKeyHash }).from(agents).where(eq(agents.id, agent.id));

    const listed = JSON.stringify(await listAgentsForWorkspace(db, josh.workspaceId));
    const one = JSON.stringify(await findAgentById(db, agent.id));
    const byKey = JSON.stringify(await findAgentByPubkey(db, key.pubkey));
    for (const json of [listed, one, byKey]) {
      assert.equal(json.includes('apiKeyHash'), false, 'no key hash field');
      assert.equal(json.includes(row!.hash!), false, 'no key hash value');
      assert.equal(json.includes(agent.key), false, 'no plaintext key');
      assert.equal(json.includes('nsec'), false, 'no secret key');
    }
  });
});

describe('the challenge an agent spends', () => {
  const key = keypair();

  it('is consumed exactly once, and only with its own value', async () => {
    const db = await createTestDb();
    const nonce = await issueAgentChallenge(db, key.pubkey);
    assert.equal(await consumeAgentChallenge(db, key.pubkey, 'f'.repeat(64)), false);
    assert.equal(await consumeAgentChallenge(db, key.pubkey, nonce), true);
    assert.equal(await consumeAgentChallenge(db, key.pubkey, nonce), false);
  });

  it('asking again does not cancel the one in flight', async () => {
    const db = await createTestDb();
    const first = await issueAgentChallenge(db, key.pubkey);
    const second = await issueAgentChallenge(db, key.pubkey);
    assert.notEqual(first, second);
    assert.equal(await consumeAgentChallenge(db, key.pubkey, first), true);
    assert.equal(await consumeAgentChallenge(db, key.pubkey, second), true);
  });

  it('holds only so many per key: the oldest goes first', async () => {
    const db = await createTestDb();
    const issued: string[] = [];
    for (let i = 0; i < AGENT_CHALLENGES_PER_KEY + 2; i += 1) {
      issued.push(await issueAgentChallenge(db, key.pubkey));
    }
    assert.equal(await consumeAgentChallenge(db, key.pubkey, issued[0]!), false);
    assert.equal(await consumeAgentChallenge(db, key.pubkey, issued[1]!), false);
    assert.equal(await consumeAgentChallenge(db, key.pubkey, issued[2]!), true);
    assert.equal(await consumeAgentChallenge(db, key.pubkey, issued.at(-1)!), true);
  });

  it('an expired one is gone, not merely refused, and sweeps other keys too', async () => {
    const db = await createTestDb();
    const nonce = await issueAgentChallenge(db, key.pubkey);
    const later = new Date(Date.now() + 5 * 60_000);
    assert.equal(await consumeAgentChallenge(db, key.pubkey, nonce, later), false);
    assert.equal((await db.select().from(verifications)).length, 0);

    // Expired rows under any agent identifier are swept when a new one is issued.
    await db.insert(verifications).values({
      id: 'old',
      identifier: 'agent:' + 'c'.repeat(64),
      value: 'stale',
      expiresAt: new Date(Date.now() - 1000),
    });
    await issueAgentChallenge(db, key.pubkey);
    assert.deepEqual(
      (await db.select({ id: verifications.id }).from(verifications)).map((row) => row.id).includes('old'),
      false,
    );
  });

  it("never touches a human's nonce for the same key", async () => {
    const db = await createTestDb();
    await db.insert(verifications).values({
      id: 'human',
      identifier: key.pubkey,
      value: 'human-nonce',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const nonce = await issueAgentChallenge(db, key.pubkey);
    await consumeAgentChallenge(db, key.pubkey, nonce);
    const rows = await db.select().from(verifications);
    assert.deepEqual(rows.map((row) => row.value), ['human-nonce']);
  });
});
