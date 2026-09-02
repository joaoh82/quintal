import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createAgent,
  findAgentIdentityById,
  getAgentMemory,
  listAgentEventKinds,
  listAgentEvents,
  listAgentMemorySlugs,
  recordAgentEvent,
  setAgentMemory,
  setAgentProfile,
} from './agents.js';
import { agentEvents, agentMemory } from './schema.js';
import { createTestDb, createTestUser } from './testing.js';

/**
 * An agent's events and memory belong to an office.
 *
 * They always did, but only transitively: every reader happened to join through
 * `agents`, which carries the workspace. That made isolation a habit rather
 * than a property — one query that forgot the join would read across offices
 * and nothing would catch it.
 *
 * Two halves, and both are tested here. The office is written from the agent,
 * so a row cannot claim one it does not belong to; and every reader filters on
 * it, so an id from elsewhere reads back nothing instead of somebody's log.
 */

async function agentFor(db: Awaited<ReturnType<typeof createTestDb>>, name: string) {
  const owner = await createTestUser(db, name);
  const agent = await createAgent(db, {
    workspaceId: owner.workspaceId,
    ownerUserId: owner.id,
    name: `${name}'s agent`,
    spriteKey: 'slate',
  });
  return { ...agent, workspaceId: owner.workspaceId };
}

describe('an event knows which office it happened in', () => {
  it('takes the office from the agent, not from the caller', async () => {
    const db = await createTestDb();
    const bob = await agentFor(db, 'Josh');

    await recordAgentEvent(db, bob.id, 'command.set_status', { status: 'thinking' });

    const rows = await db.select().from(agentEvents);
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.equal(
        row.workspaceId,
        bob.workspaceId,
        'a row must never claim an office its agent is not in',
      );
    }
  });

  it('reads back nothing for an agent in another office', async () => {
    const db = await createTestDb();
    const bob = await agentFor(db, 'Josh');
    const stranger = await agentFor(db, 'Sam');

    await recordAgentEvent(db, bob.id, 'command.set_status', { status: 'thinking' });

    // The id is real and the office is real; they just are not each other's.
    const wrong = await listAgentEvents(db, bob.id, stranger.workspaceId);
    assert.equal(wrong.events.length, 0, "another office must not read Bob's log");

    const right = await listAgentEvents(db, bob.id, bob.workspaceId);
    assert.ok(right.events.length > 0, 'and his own office still can');
  });

  it('scopes the kind list the same way', async () => {
    const db = await createTestDb();
    const bob = await agentFor(db, 'Josh');
    const stranger = await agentFor(db, 'Sam');

    await recordAgentEvent(db, bob.id, 'command.set_status', { status: 'thinking' });

    assert.deepEqual(await listAgentEventKinds(db, bob.id, stranger.workspaceId), []);
    assert.ok((await listAgentEventKinds(db, bob.id, bob.workspaceId)).length > 0);
  });
});

describe("an agent's memory belongs to its office", () => {
  it('takes the office from the agent', async () => {
    const db = await createTestDb();
    const bob = await agentFor(db, 'Josh');

    await setAgentMemory(db, bob.id, 'core', 'Always greet people in Portuguese.');

    const rows = await db.select().from(agentMemory);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.workspaceId, bob.workspaceId);
  });

  it('is not readable from another office', async () => {
    const db = await createTestDb();
    const bob = await agentFor(db, 'Josh');
    const stranger = await agentFor(db, 'Sam');

    await setAgentMemory(db, bob.id, 'core', 'Always greet people in Portuguese.');

    assert.equal(
      await getAgentMemory(db, bob.id, stranger.workspaceId, 'core'),
      null,
      "another office must not read Bob's memory",
    );

    const mine = await getAgentMemory(db, bob.id, bob.workspaceId, 'core');
    assert.equal(mine?.content, 'Always greet people in Portuguese.');
  });

  it('scopes the slug list the same way', async () => {
    const db = await createTestDb();
    const bob = await agentFor(db, 'Josh');
    const stranger = await agentFor(db, 'Sam');

    await setAgentMemory(db, bob.id, 'core', 'remember this');

    assert.deepEqual(await listAgentMemorySlugs(db, bob.id, stranger.workspaceId), []);
    assert.deepEqual(
      (await listAgentMemorySlugs(db, bob.id, bob.workspaceId)).map((row) => row.slug),
      ['core'],
    );
  });

  /** Overwriting must not orphan the office the row was written with. */
  it('keeps its office when the content is replaced', async () => {
    const db = await createTestDb();
    const bob = await agentFor(db, 'Josh');

    await setAgentMemory(db, bob.id, 'core', 'first');
    await setAgentMemory(db, bob.id, 'core', 'second');

    const rows = await db.select().from(agentMemory);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.content, 'second');
    assert.equal(rows[0]?.workspaceId, bob.workspaceId);
  });
});

describe('what an owner says an agent is', () => {
  it('is stored, normalised, from the moment it is created', async () => {
    const db = await createTestDb();
    const owner = await createTestUser(db, 'Josh');
    const created = await createAgent(db, {
      workspaceId: owner.workspaceId,
      ownerUserId: owner.id,
      name: 'Marvin',
      spriteKey: 'slate',
      description: 'Reviews PRs\nand watches CI',
      instructions: 'Be terse.\nAnswer in Portuguese.',
    });

    const agent = await findAgentIdentityById(db, created.id);
    // The description is one line; the instructions keep theirs.
    assert.equal(agent?.description, 'Reviews PRs and watches CI');
    assert.equal(agent?.instructions, 'Be terse.\nAnswer in Portuguese.');
  });

  it('defaults to empty rather than to a placeholder', async () => {
    const db = await createTestDb();
    const owner = await createTestUser(db, 'Josh');
    const created = await createAgent(db, {
      workspaceId: owner.workspaceId,
      ownerUserId: owner.id,
      name: 'Marvin',
      spriteKey: 'slate',
    });

    const agent = await findAgentIdentityById(db, created.id);
    assert.equal(agent?.description, '');
    assert.equal(agent?.instructions, '');
  });

  it('changes one field without clearing the other', async () => {
    const db = await createTestDb();
    const owner = await createTestUser(db, 'Josh');
    const created = await createAgent(db, {
      workspaceId: owner.workspaceId,
      ownerUserId: owner.id,
      name: 'Marvin',
      spriteKey: 'slate',
      description: 'Reviews PRs',
      instructions: 'Be terse.',
    });

    // An absent field means "leave it alone" — the same rule the office
    // settings form needed, and for the same reason.
    await setAgentProfile(db, created.id, { description: 'Watches CI' });

    const agent = await findAgentIdentityById(db, created.id);
    assert.equal(agent?.description, 'Watches CI');
    assert.equal(agent?.instructions, 'Be terse.', 'a partial save is not a reset');
  });

  it('can be cleared deliberately, which is not the same as omitting it', async () => {
    const db = await createTestDb();
    const owner = await createTestUser(db, 'Josh');
    const created = await createAgent(db, {
      workspaceId: owner.workspaceId,
      ownerUserId: owner.id,
      name: 'Marvin',
      spriteKey: 'slate',
      instructions: 'Be terse.',
    });

    await setAgentProfile(db, created.id, { instructions: '' });
    assert.equal((await findAgentIdentityById(db, created.id))?.instructions, '');
  });

  it('records the change, because being told to be something is auditable', async () => {
    const db = await createTestDb();
    const owner = await createTestUser(db, 'Josh');
    const created = await createAgent(db, {
      workspaceId: owner.workspaceId,
      ownerUserId: owner.id,
      name: 'Marvin',
      spriteKey: 'slate',
    });

    await setAgentProfile(db, created.id, { instructions: 'Be terse.' });

    const kinds = await listAgentEventKinds(db, created.id, owner.workspaceId);
    assert.ok(kinds.includes('agent.profile_changed'));
  });
});
