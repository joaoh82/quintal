import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createAgent,
  getAgentMemory,
  listAgentEventKinds,
  listAgentEvents,
  listAgentMemorySlugs,
  recordAgentEvent,
  setAgentMemory,
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
