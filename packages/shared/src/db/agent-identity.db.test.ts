import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { signAttestation } from '../attestation.js';
import { generateSecretKey, getPublicKeyHex } from '../identity.js';
import {
  createAgent,
  findAgentByKey,
  findAgentByPubkey,
  findAgentIdentityById,
  setAgentCredential,
} from './agents.js';
import { createTestDb, createTestUser } from './testing.js';

/**
 * What the office told a host to launch travels on the identity.
 *
 * The office puts it on an agent's card, and an agent reaches the room through
 * whichever of three doors its credential opens — a `qa_` key, a host token, or
 * its own keypair. A lookup that forgot to select the columns would leave the
 * card blank for exactly the agents that came through that one door, which is
 * the kind of hole nobody notices until somebody asks why one card is thinner.
 */

async function ownerWithAgent(
  db: Awaited<ReturnType<typeof createTestDb>>,
  launch?: { runtimeId: string; hostLabel: string; modelId?: string | null },
) {
  const owner = await createTestUser(db, 'Josh');
  const agent = await createAgent(db, {
    workspaceId: owner.workspaceId,
    ownerUserId: owner.id,
    name: 'buzz',
    spriteKey: 'slate',
    ...(launch ? { launch } : {}),
  });
  return { owner, agent };
}

describe('an agent identity carries what it runs on', () => {
  it('through all three lookups, for an office-defined agent', async () => {
    const db = await createTestDb();
    const { owner, agent } = await ownerWithAgent(db, {
      runtimeId: 'claude-code',
      hostLabel: 'laptop',
      modelId: 'opus',
    });

    const byKey = await findAgentByKey(db, agent.key);
    assert.equal(byKey?.runtimeId, 'claude-code');
    assert.equal(byKey?.modelId, 'opus');

    const byId = await findAgentIdentityById(db, agent.id);
    assert.equal(byId?.runtimeId, 'claude-code');
    assert.equal(byId?.modelId, 'opus');

    const secretKey = generateSecretKey();
    const pubkey = getPublicKeyHex(secretKey);
    await setAgentCredential(
      db,
      agent.id,
      {
        pubkey,
        attestation: signAttestation({
          agentPubkey: pubkey,
          ownerPubkey: owner.pubkey,
          ownerSecretKey: owner.secretKey,
        }),
      },
      { via: 'session', userId: owner.id },
    );
    const byPubkey = await findAgentByPubkey(db, pubkey);
    assert.equal(byPubkey?.identity.runtimeId, 'claude-code');
    assert.equal(byPubkey?.identity.modelId, 'opus');
  });

  it('and reports null for an agent the office does not define', async () => {
    const db = await createTestDb();
    const { agent } = await ownerWithAgent(db);

    const identity = await findAgentByKey(db, agent.key);
    assert.equal(identity?.runtimeId, null, 'an agent launched by hand runs what it likes');
    assert.equal(identity?.modelId, null);
  });

  it("calls a chosen runtime with no chosen model the runtime's own default", async () => {
    const db = await createTestDb();
    const { agent } = await ownerWithAgent(db, { runtimeId: 'goose', hostLabel: 'laptop' });

    const identity = await findAgentByKey(db, agent.key);
    assert.equal(identity?.runtimeId, 'goose');
    assert.equal(identity?.modelId, null, 'null is the default, not a missing value');
  });
});
