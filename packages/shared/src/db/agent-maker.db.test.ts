import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createAgent,
  findAgentById,
  listAgentEvents,
  listAgentsForWorkspace,
  setAgentName,
} from './agents.js';
import { createTestDb, createTestUser } from './testing.js';

/** An agent another agent made: its owner is still a person, and its maker stays on the row. */
describe('an agent made by an agent', () => {
  async function made() {
    const db = await createTestDb();
    const josh = await createTestUser(db, 'Josh');
    const base = { workspaceId: josh.workspaceId, ownerUserId: josh.id, spriteKey: 'slate' };
    const marvin = await createAgent(db, { ...base, name: 'Marvin' });
    const bob = await createAgent(db, { ...base, name: 'Bob', createdByAgentId: marvin.id });
    return { db, josh, marvin, bob };
  }

  it('names its maker wherever it is read, and a person\'s names nobody', async () => {
    const { db, josh, marvin, bob } = await made();

    const found = await findAgentById(db, bob.id);
    assert.equal(found?.ownerUserId, josh.id, 'owned by the person, not the agent');
    assert.equal(found?.createdByAgentId, marvin.id);
    assert.equal(found?.createdByAgentName, 'Marvin');

    const listed = await listAgentsForWorkspace(db, josh.workspaceId);
    assert.equal(listed.find((agent) => agent.id === bob.id)?.createdByAgentName, 'Marvin');
    assert.equal(listed.find((agent) => agent.id === marvin.id)?.createdByAgentName, null);
    assert.equal((await findAgentById(db, marvin.id))?.createdByAgentName, null);
  });

  it('starts its log with who made it', async () => {
    const { db, josh, marvin, bob } = await made();
    const { events } = await listAgentEvents(db, bob.id, josh.workspaceId);
    const created = events.find((event) => event.kind === 'agent.created');
    assert.equal((created?.payload as { createdByAgentId?: string }).createdByAgentId, marvin.id);
  });

  it('follows a rename of its maker', async () => {
    const { db, marvin, bob } = await made();
    await setAgentName(db, marvin.id, '  Arthur   Dent ');
    assert.equal((await findAgentById(db, marvin.id))?.name, 'Arthur Dent', 'normalised on the way in');
    assert.equal((await findAgentById(db, bob.id))?.createdByAgentName, 'Arthur Dent');
    await assert.rejects(() => setAgentName(db, marvin.id, '   '), /needs a name/);
  });
});
