import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { displayNameFromPubkey } from '../identity.js';
import {
  createAgent,
  findAgentByKey,
  findAgentIdentityById,
  listAgentsForWorkspace,
  revokeAgent,
  setAgentEnabled,
  setAgentLaunch,
} from './agents.js';
import {
  createHostToken,
  fleetForHost,
  findHostByToken,
  hostMayActAs,
  listHostTokens,
  registerMachineForUser,
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

/**
 * Registering the machine you are already signed in from.
 *
 * The behaviour worth pinning is the replacement: only the hash is stored, so a
 * second call cannot hand back the token it issued the first time. Without
 * replacing, a reinstall would quietly grow a duplicate row per machine and the
 * Machines list would stop being something anyone could revoke from with
 * confidence.
 */
describe('registering a machine from a session', () => {
  it('issues a token that authenticates as that machine', async () => {
    const { db, josh } = await setup();

    const machine = await registerMachineForUser(db, {
      workspaceId: josh.workspaceId,
      ownerUserId: josh.id,
      label: 'laptop',
    });

    const found = await findHostByToken(db, machine.token);
    assert.equal(found?.ownerUserId, josh.id);
    assert.equal(found?.label, 'laptop');
    assert.equal(found?.workspaceId, josh.workspaceId);
  });

  it('replaces the machine token rather than adding a second one', async () => {
    const { db, josh } = await setup();
    const input = { workspaceId: josh.workspaceId, ownerUserId: josh.id, label: 'laptop' };

    const first = await registerMachineForUser(db, input);
    const second = await registerMachineForUser(db, input);

    assert.notEqual(first.token, second.token, 'a fresh secret each time');
    assert.equal(
      await findHostByToken(db, first.token),
      null,
      'the superseded token stops working',
    );
    assert.ok(await findHostByToken(db, second.token), 'the new one works');

    const live = (await listHostTokens(db, josh.workspaceId)).filter(
      (row) => row.revokedAt === null,
    );
    assert.equal(live.length, 1, 'one live row per machine, not one per install');
  });

  it('does not disturb another machine belonging to the same person', async () => {
    const { db, josh } = await setup();
    const desktop = await registerMachineForUser(db, {
      workspaceId: josh.workspaceId,
      ownerUserId: josh.id,
      label: 'desktop',
    });

    await registerMachineForUser(db, {
      workspaceId: josh.workspaceId,
      ownerUserId: josh.id,
      label: 'laptop',
    });

    assert.ok(
      await findHostByToken(db, desktop.token),
      're-registering the laptop must not log the desktop out',
    );
  });

  it("does not touch a teammate's machine of the same name", async () => {
    const { db, josh, sam } = await setup();
    const sams = await registerMachineForUser(db, {
      workspaceId: sam.workspaceId,
      ownerUserId: sam.id,
      label: 'laptop',
    });

    await registerMachineForUser(db, {
      workspaceId: josh.workspaceId,
      ownerUserId: josh.id,
      label: 'laptop',
    });

    assert.ok(
      await findHostByToken(db, sams.token),
      "everybody calls their machine 'laptop'; that must not revoke each other's",
    );
  });
});

/**
 * Disabling an agent, end to end.
 *
 * The predicate is covered in `host-tokens.test.ts`; this is the round trip —
 * flip the switch, and the machine stops being told to run it. Without that the
 * toggle would be a checkbox that changes a column and nothing else.
 */
describe('turning an agent off', () => {
  it('drops it from the fleet the machine pulls, and brings it back', async () => {
    const { db, josh } = await setup();
    const machine = await registerMachineForUser(db, {
      workspaceId: josh.workspaceId,
      ownerUserId: josh.id,
      label: 'laptop',
    });
    const host = await findHostByToken(db, machine.token);
    assert.ok(host);

    const agent = await makeAgent(db, josh, 'Bob', {
      runtimeId: 'omp',
      repoSpec: '*',
      hostLabel: 'laptop',
    });

    assert.equal(
      (await fleetForHost(db, host, 'laptop')).length,
      1,
      'it starts out assigned',
    );

    await setAgentEnabled(db, agent.id, false);
    assert.deepEqual(
      await fleetForHost(db, host, 'laptop'),
      [],
      'a disabled agent is not something the machine should start',
    );

    await setAgentEnabled(db, agent.id, true);
    assert.equal(
      (await fleetForHost(db, host, 'laptop')).length,
      1,
      'and it comes back, because disabling is not revoking',
    );
  });

  it('leaves the rest of the fleet alone', async () => {
    const { db, josh } = await setup();
    const machine = await registerMachineForUser(db, {
      workspaceId: josh.workspaceId,
      ownerUserId: josh.id,
      label: 'laptop',
    });
    const host = await findHostByToken(db, machine.token);
    assert.ok(host);

    const launch = { runtimeId: 'omp', repoSpec: '*', hostLabel: 'laptop' };
    const bob = await makeAgent(db, josh, 'Bob', launch);
    await makeAgent(db, josh, 'Alice', launch);

    await setAgentEnabled(db, bob.id, false);

    const fleet = await fleetForHost(db, host, 'laptop');
    assert.deepEqual(
      fleet.map((member) => member.name),
      ['Alice'],
    );
  });
});

describe('the owner name on a joined row', () => {
  /**
   * Every one of these joins renders an owner to somebody. A blank name is not
   * an edge case — it is what *every* account looks like the moment it is
   * created, because sign-up no longer writes a name for you.
   */
  it('falls back to the npub when the owner has not named themselves', async () => {
    const db = await createTestDb();
    const nameless = await createTestUser(db, '');
    const expected = displayNameFromPubkey(nameless.pubkey);

    const host = await createHostToken(db, {
      workspaceId: nameless.workspaceId,
      ownerUserId: nameless.id,
      label: 'laptop',
    });
    const resolved = await findHostByToken(db, host.token);
    assert.equal(resolved?.ownerName, expected);

    const agent = await makeAgent(db, nameless, 'Bob');
    const identity = await findAgentIdentityById(db, agent.id);
    assert.equal(identity?.ownerName, expected);

    const byKey = await findAgentByKey(db, agent.key);
    assert.equal(byKey?.ownerName, expected);
  });

  it('still prefers a name once one is chosen', async () => {
    const db = await createTestDb();
    const josh = await createTestUser(db, 'Josh');
    const agent = await makeAgent(db, josh, 'Bob');

    assert.equal((await findAgentByKey(db, agent.key))?.ownerName, 'Josh');
  });

  it('does not leak the owner key into the agent shape', async () => {
    // The pubkey is joined only to compute the fallback. It is public, so this
    // is about the shape staying about the agent, not about secrecy.
    const db = await createTestDb();
    const josh = await createTestUser(db, 'Josh');
    const agent = await makeAgent(db, josh, 'Bob');

    const listed = await listAgentsForWorkspace(db, josh.workspaceId);
    assert.ok(listed.length > 0);
    for (const row of listed) {
      assert.ok(!('ownerPubkey' in row), 'ownerPubkey should be stripped');
    }
  });
});
