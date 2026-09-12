import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { generateSecretKey, getPublicKeyHex, signAttestation } from '@quintal/shared';
import { createAgent, createHostToken, findAgentByPubkey, memberships } from '@quintal/shared/db';
import { createTestDb, createTestUser } from '@quintal/shared/db/testing';

import { isHostTokenHeader, isSameOriginRequest, registerAgentCredential } from './agent-credential';

/**
 * Who may hand the office an agent's key — and the one thing neither caller
 * can do, which is vouch for an agent they do not own. The signature check
 * itself is covered in `@quintal/shared`; what is tested here is that every
 * caller is routed through it, and nothing is routed around it.
 */

function keypair() {
  const secretKey = generateSecretKey();
  return { secretKey, pubkey: getPublicKeyHex(secretKey) };
}

async function world() {
  const db = await createTestDb();
  const josh = await createTestUser(db, 'Josh');
  const agent = await createAgent(db, {
    workspaceId: josh.workspaceId,
    ownerUserId: josh.id,
    name: 'buzz',
    spriteKey: 'slate',
  });
  const key = keypair();
  const attestation = signAttestation({
    agentPubkey: key.pubkey,
    ownerPubkey: josh.pubkey,
    ownerSecretKey: josh.secretKey,
  });
  return { db, josh, agent, key, body: { agentPubkey: key.pubkey, attestation } };
}

describe('registering a key for an agent', () => {
  it('works for the owner, signed in', async () => {
    const w = await world();
    const outcome = await registerAgentCredential(w.db, w.agent.id, w.body, {
      via: 'session',
      userId: w.josh.id,
      isGuest: false,
    });
    assert.equal(outcome.status, 200);
    assert.ok('npub' in outcome.body && outcome.body.npub.startsWith('npub1'));
    assert.equal((await findAgentByPubkey(w.db, w.key.pubkey))?.identity.id, w.agent.id);
  });

  it('works for a machine that may act as the agent, with the owner’s signature', async () => {
    const w = await world();
    const host = await createHostToken(w.db, {
      workspaceId: w.josh.workspaceId,
      ownerUserId: w.josh.id,
      label: 'laptop',
    });
    const outcome = await registerAgentCredential(w.db, w.agent.id, w.body, {
      via: 'host',
      token: host.token,
    });
    assert.equal(outcome.status, 200);
  });

  it('refuses a guest, a stranger, and an unknown host token', async () => {
    const w = await world();
    const stranger = await createTestUser(w.db, 'Sam');
    assert.equal(
      (await registerAgentCredential(w.db, w.agent.id, w.body, { via: 'session', userId: w.josh.id, isGuest: true })).status,
      403,
    );
    assert.equal(
      (await registerAgentCredential(w.db, w.agent.id, w.body, { via: 'session', userId: stranger.id, isGuest: false })).status,
      403,
    );
    assert.equal(
      (await registerAgentCredential(w.db, w.agent.id, w.body, { via: 'host', token: 'qh_nope' })).status,
      401,
    );
    assert.equal(await findAgentByPubkey(w.db, w.key.pubkey), null);
  });

  it("refuses a teammate's machine, even inside the same office", async () => {
    const w = await world();
    const teammate = await createTestUser(w.db, 'Sam', { workspaceId: w.josh.workspaceId });
    await w.db.insert(memberships).values({
      id: 'm-sam',
      workspaceId: w.josh.workspaceId,
      userId: teammate.id,
      role: 'member',
    });
    const host = await createHostToken(w.db, {
      workspaceId: w.josh.workspaceId,
      ownerUserId: teammate.id,
      label: 'sams-laptop',
    });
    const outcome = await registerAgentCredential(w.db, w.agent.id, w.body, { via: 'host', token: host.token });
    assert.equal(outcome.status, 403);
  });

  it('lets an admin call, but not vouch: the signature must still be the owner’s', async () => {
    const w = await world();
    const admin = await createTestUser(w.db, 'Admin', { workspaceId: w.josh.workspaceId });
    await w.db.insert(memberships).values({
      id: 'm-admin',
      workspaceId: w.josh.workspaceId,
      userId: admin.id,
      role: 'admin',
    });
    // Owner-signed body, admin calling: fine — the owner agreed.
    assert.equal(
      (await registerAgentCredential(w.db, w.agent.id, w.body, { via: 'session', userId: admin.id, isGuest: false })).status,
      200,
    );
    // Admin-signed body: refused, whoever calls.
    const key = keypair();
    const forged = {
      agentPubkey: key.pubkey,
      attestation: signAttestation({ agentPubkey: key.pubkey, ownerPubkey: admin.pubkey, ownerSecretKey: admin.secretKey }),
    };
    const outcome = await registerAgentCredential(w.db, w.agent.id, forged, { via: 'session', userId: admin.id, isGuest: false });
    assert.equal(outcome.status, 422);
    assert.equal(await findAgentByPubkey(w.db, key.pubkey), null);
  });

  it('answers 400 for a malformed body and 404 for an unknown agent', async () => {
    const w = await world();
    const me = { via: 'session' as const, userId: w.josh.id, isGuest: false };
    assert.equal((await registerAgentCredential(w.db, w.agent.id, null, me)).status, 400);
    assert.equal((await registerAgentCredential(w.db, w.agent.id, { agentPubkey: 1 }, me)).status, 400);
    assert.equal((await registerAgentCredential(w.db, 'nope', w.body, me)).status, 404);
  });
});

describe('a key already in use', () => {
  it('is a 422 with a reason, not a 500', async () => {
    const w = await world();
    const me = { via: 'session' as const, userId: w.josh.id, isGuest: false };
    const other = await createAgent(w.db, {
      workspaceId: w.josh.workspaceId,
      ownerUserId: w.josh.id,
      name: 'ann',
      spriteKey: 'slate',
    });
    assert.equal((await registerAgentCredential(w.db, w.agent.id, w.body, me)).status, 200);
    const outcome = await registerAgentCredential(w.db, other.id, w.body, me);
    assert.equal(outcome.status, 422);
    assert.match('error' in outcome.body ? outcome.body.error : '', /already registered/);
  });
});

describe('a cookie-authenticated request', () => {
  it('must carry our origin — absent is refused, not excused', () => {
    const ours = 'https://office.example.test';
    assert.equal(isSameOriginRequest(ours, ours), true);
    assert.equal(isSameOriginRequest('https://evil.example.test', ours), false);
    assert.equal(isSameOriginRequest(null, ours), false);
    assert.equal(isSameOriginRequest('', ours), false);
  });
});

describe('telling a machine from a browser', () => {
  it('only a qh_ bearer counts as a machine', () => {
    assert.equal(isHostTokenHeader('Bearer qh_abc'), 'qh_abc');
    assert.equal(isHostTokenHeader('Bearer qa_abc'), null);
    assert.equal(isHostTokenHeader(null), null);
  });
});
