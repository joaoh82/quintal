import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createAgent, findAgentIdentityById, revokeAgent, setAgentLaunch } from './agents.js';
import {
  createHostToken,
  fleetForHost,
  findHostByToken,
  hostMayActAs,
  revokeHostToken,
} from './host-tokens.js';
import { createTestDb, createTestUser } from './testing.js';

/**
 * The host-token auth path, against a real database.
 *
 * `host-tokens.test.ts` covers the predicates in isolation; this covers the
 * queries around them. Both are needed and neither substitutes for the other:
 * a correct predicate fed by a query that forgot its `where` clause is still a
 * machine acting as somebody else's agent.
 *
 * These are the tests the office-defined fleet PR shipped without.
 */

async function setup() {
  const db = await createTestDb();
  const josh = await createTestUser(db, 'Josh');
  // A teammate *in the same workspace* — the case that matters. A stranger in
  // another workspace is refused by an easier check.
  const sam = await createTestUser(db, 'Sam', josh.workspaceId);
  return { db, josh, sam };
}

async function makeAgent(
  db: Awaited<ReturnType<typeof createTestDb>>,
  owner: { id: string; workspaceId: string },
  name: string,
  launch?: { runtimeId: string; repoSpec: string; hostLabel: string },
) {
  const agent = await createAgent(db, {
    workspaceId: owner.workspaceId,
    ownerUserId: owner.id,
    name,
    spriteKey: 'slate',
    ...(launch ? { launch } : {}),
  });
  return agent;
}

describe('resolving a host token', () => {
  it('resolves a live token to its owner and workspace', async () => {
    const { db, josh } = await setup();
    const created = await createHostToken(db, {
      workspaceId: josh.workspaceId,
      ownerUserId: josh.id,
      label: 'laptop',
    });

    const host = await findHostByToken(db, created.token);
    assert.equal(host?.ownerUserId, josh.id);
    assert.equal(host?.workspaceId, josh.workspaceId);
    assert.equal(host?.label, 'laptop');
    assert.equal(host?.ownerName, 'Josh');
  });

  it('refuses a revoked token', async () => {
    const { db, josh } = await setup();
    const created = await createHostToken(db, {
      workspaceId: josh.workspaceId,
      ownerUserId: josh.id,
      label: 'laptop',
    });

    await revokeHostToken(db, created.id);
    assert.equal(await findHostByToken(db, created.token), null);
  });

  it('refuses nonsense without touching the database twice', async () => {
    const { db } = await setup();
    assert.equal(await findHostByToken(db, 'qh_not-real'), null);
    // Wrong prefix short-circuits: an agent key must never resolve as a host.
    assert.equal(await findHostByToken(db, 'qa_looks-like-an-agent-key'), null);
    assert.equal(await findHostByToken(db, null), null);
  });

  it('stores only a hash — the plaintext is not recoverable from the row', async () => {
    const { db, josh } = await setup();
    const created = await createHostToken(db, {
      workspaceId: josh.workspaceId,
      ownerUserId: josh.id,
      label: 'laptop',
    });

    const rows = await db.query.hostTokens.findMany();
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0]?.tokenHash, created.token);
    assert.ok(!JSON.stringify(rows[0]).includes(created.token));
  });
});

describe('what a host token may act as, end to end', () => {
  it('lets a machine act as its owner’s agent', async () => {
    const { db, josh } = await setup();
    const created = await createHostToken(db, {
      workspaceId: josh.workspaceId,
      ownerUserId: josh.id,
      label: 'laptop',
    });
    const agent = await makeAgent(db, josh, 'mine');

    const host = await findHostByToken(db, created.token);
    const identity = await findAgentIdentityById(db, agent.id);
    assert.equal(hostMayActAs(host!, { ...identity!, revoked: false }), true);
  });

  it('refuses a teammate’s agent in the same workspace', async () => {
    const { db, josh, sam } = await setup();
    const created = await createHostToken(db, {
      workspaceId: josh.workspaceId,
      ownerUserId: josh.id,
      label: 'laptop',
    });
    const samsAgent = await makeAgent(db, sam, 'sams');

    const host = await findHostByToken(db, created.token);
    const identity = await findAgentIdentityById(db, samsAgent.id);
    assert.equal(identity?.ownerUserId, sam.id);
    assert.equal(hostMayActAs(host!, { ...identity!, revoked: false }), false);
  });

  it('cannot resurrect a revoked agent', async () => {
    const { db, josh } = await setup();
    const agent = await makeAgent(db, josh, 'gone');
    await revokeAgent(db, agent.id, josh.id);

    assert.equal(await findAgentIdentityById(db, agent.id), null);
  });
});

describe('the fleet a host pulls', () => {
  it('returns agents assigned to this machine, with what is needed to launch them', async () => {
    const { db, josh } = await setup();
    const created = await createHostToken(db, {
      workspaceId: josh.workspaceId,
      ownerUserId: josh.id,
      label: 'laptop',
    });
    await makeAgent(db, josh, 'here', {
      runtimeId: 'claude-code',
      repoSpec: 'api',
      hostLabel: 'laptop',
    });

    const host = await findHostByToken(db, created.token);
    const fleet = await fleetForHost(db, host!, 'laptop');
    assert.deepEqual(
      fleet.map((member) => ({ name: member.name, runtimeId: member.runtimeId, repoSpec: member.repoSpec })),
      [{ name: 'here', runtimeId: 'claude-code', repoSpec: 'api' }],
    );
  });

  it('never returns an agent key — the token is the credential', async () => {
    const { db, josh } = await setup();
    const created = await createHostToken(db, {
      workspaceId: josh.workspaceId,
      ownerUserId: josh.id,
      label: 'laptop',
    });
    const agent = await makeAgent(db, josh, 'here', {
      runtimeId: 'claude-code',
      repoSpec: 'api',
      hostLabel: 'laptop',
    });

    const host = await findHostByToken(db, created.token);
    const serialised = JSON.stringify(await fleetForHost(db, host!, 'laptop'));
    assert.ok(!serialised.includes(agent.key));
    assert.ok(!serialised.includes('qa_'));
  });

  it('omits a teammate’s agent even when it names this machine', async () => {
    const { db, josh, sam } = await setup();
    const created = await createHostToken(db, {
      workspaceId: josh.workspaceId,
      ownerUserId: josh.id,
      label: 'laptop',
    });
    await makeAgent(db, sam, 'sams', {
      runtimeId: 'claude-code',
      repoSpec: 'api',
      hostLabel: 'laptop',
    });

    const host = await findHostByToken(db, created.token);
    assert.deepEqual(await fleetForHost(db, host!, 'laptop'), []);
  });

  it('omits agents assigned to another machine', async () => {
    const { db, josh } = await setup();
    const created = await createHostToken(db, {
      workspaceId: josh.workspaceId,
      ownerUserId: josh.id,
      label: 'laptop',
    });
    await makeAgent(db, josh, 'elsewhere', {
      runtimeId: 'claude-code',
      repoSpec: 'api',
      hostLabel: 'build-box',
    });

    const host = await findHostByToken(db, created.token);
    assert.deepEqual(await fleetForHost(db, host!, 'laptop'), []);
  });

  it('omits a revoked agent', async () => {
    const { db, josh } = await setup();
    const created = await createHostToken(db, {
      workspaceId: josh.workspaceId,
      ownerUserId: josh.id,
      label: 'laptop',
    });
    const agent = await makeAgent(db, josh, 'here', {
      runtimeId: 'claude-code',
      repoSpec: 'api',
      hostLabel: 'laptop',
    });
    await revokeAgent(db, agent.id, josh.id);

    const host = await findHostByToken(db, created.token);
    assert.deepEqual(await fleetForHost(db, host!, 'laptop'), []);
  });

  it('leaves per-agent-key agents alone', async () => {
    const { db, josh } = await setup();
    const created = await createHostToken(db, {
      workspaceId: josh.workspaceId,
      ownerUserId: josh.id,
      label: 'laptop',
    });
    await makeAgent(db, josh, 'byhand');

    const host = await findHostByToken(db, created.token);
    assert.deepEqual(await fleetForHost(db, host!, 'laptop'), []);
  });

  it('drops an agent as soon as it is unassigned, and picks it back up', async () => {
    const { db, josh } = await setup();
    const created = await createHostToken(db, {
      workspaceId: josh.workspaceId,
      ownerUserId: josh.id,
      label: 'laptop',
    });
    const agent = await makeAgent(db, josh, 'toggles', {
      runtimeId: 'claude-code',
      repoSpec: 'api',
      hostLabel: 'laptop',
    });
    const host = await findHostByToken(db, created.token);

    assert.equal((await fleetForHost(db, host!, 'laptop')).length, 1);

    await setAgentLaunch(db, agent.id, null);
    assert.deepEqual(await fleetForHost(db, host!, 'laptop'), []);

    // Unassigning keeps the runtime and repo, so turning it back on is one
    // field — the bug that shipped in #14 and was found by hand.
    await setAgentLaunch(db, agent.id, {
      runtimeId: 'claude-code',
      repoSpec: 'api',
      hostLabel: 'laptop',
    });
    const back = await fleetForHost(db, host!, 'laptop');
    assert.equal(back[0]?.repoSpec, 'api');
  });
});
