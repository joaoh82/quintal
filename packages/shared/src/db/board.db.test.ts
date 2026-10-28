import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createAgent, revokeAgent } from './agents.js';
import {
  BoardItemError,
  createBoardItem,
  deleteBoardItem,
  findBoardItemByNumber,
  listBoardAgentsForWorkspace,
  listBoardItemsForWorkspace,
  updateBoardItem,
} from './board.js';
import { createTestDb, createTestUser } from './testing.js';

/**
 * What must hold for the board: a note's number is the office's own and is
 * never reused, a note is for a live agent of this office or for nobody,
 * who wrote it survives as a name, and one office never sees another's.
 */

async function office(name: string) {
  const db = await createTestDb();
  const owner = await createTestUser(db, name);
  const agent = (agentName: string) =>
    createAgent(db, {
      workspaceId: owner.workspaceId,
      ownerUserId: owner.id,
      name: agentName,
      spriteKey: 'slate',
    });
  const note = (title: string, extra: Partial<Parameters<typeof createBoardItem>[1]> = {}) =>
    createBoardItem(db, {
      workspaceId: owner.workspaceId,
      title,
      body: '',
      status: 'open',
      color: 'yellow',
      labels: [],
      assigneeAgentId: null,
      createdBy: { userId: owner.id },
      ...extra,
    });
  return { db, owner, agent, note };
}

describe('writing a note', () => {
  it('numbers notes in order, and never reuses a number', async () => {
    const { db, owner, note } = await office('Ana');
    const first = await note('Add a garden');
    const second = await note('Fix the chair');
    assert.equal(first.number, 1);
    assert.equal(second.number, 2);

    await deleteBoardItem(db, owner.workspaceId, second.id);
    const third = await note('Improve the tunnel');
    // Not 2: "#2" was said out loud and meant the chair.
    assert.equal(third.number, 3);
    assert.equal((await findBoardItemByNumber(db, owner.workspaceId, 3))?.title, 'Improve the tunnel');
  });

  it('reads back whole, newest first, with who wrote it and who it is for', async () => {
    const { db, owner, agent, note } = await office('Ana');
    const marvin = await agent('Marvin');
    await note('Add a garden');
    await note('Fix the chair', {
      body: 'The office chair clips through the desk.',
      status: 'in_progress',
      color: 'pink',
      labels: ['bug', 'furniture'],
      assigneeAgentId: marvin.id,
    });

    const [chair, garden] = await listBoardItemsForWorkspace(db, owner.workspaceId);
    assert.equal(chair?.title, 'Fix the chair');
    assert.equal(chair?.body, 'The office chair clips through the desk.');
    assert.equal(chair?.status, 'in_progress');
    assert.equal(chair?.color, 'pink');
    assert.deepEqual(chair?.labels, ['bug', 'furniture']);
    assert.deepEqual(chair?.assignee, { id: marvin.id, name: 'Marvin' });
    assert.deepEqual(chair?.createdBy, { kind: 'human', id: owner.id, name: 'Ana' });
    assert.equal(garden?.assignee, null);
  });

  it('names an author who never chose a name', async () => {
    const { db, owner, note } = await office('');
    const made = await note('Add a garden');
    assert.equal(made.createdBy?.kind, 'human');
    assert.ok(made.createdBy?.name.startsWith('npub1'), made.createdBy?.name);
  });

  it('can be written by an agent, and says so', async () => {
    const { db, owner, agent } = await office('Ana');
    const marvin = await agent('Marvin');
    const made = await createBoardItem(db, {
      workspaceId: owner.workspaceId,
      title: 'Write the release notes',
      body: '',
      status: 'open',
      color: 'blue',
      labels: [],
      assigneeAgentId: null,
      createdBy: { agentId: marvin.id },
    });
    assert.deepEqual(made.createdBy, { kind: 'agent', id: marvin.id, name: 'Marvin' });
  });

  it('is for a live agent of this office, or for nobody', async () => {
    const { db, owner, agent, note } = await office('Ana');
    const other = await office('Bea');
    const theirs = await other.agent('Codex');
    await assert.rejects(
      note('x', { assigneeAgentId: theirs.id }),
      (error: unknown) => error instanceof BoardItemError && error.reason === 'assignee',
    );
    const gone = await agent('Gone');
    await revokeAgent(db, gone.id, owner.id);
    await assert.rejects(
      note('x', { assigneeAgentId: gone.id }),
      (error: unknown) => error instanceof BoardItemError && error.reason === 'assignee',
    );
    assert.deepEqual(
      (await listBoardAgentsForWorkspace(db, owner.workspaceId)).map((a) => a.name),
      [],
      'a revoked agent is not offered',
    );
  });
});

describe('changing a note', () => {
  it('changes only what is named', async () => {
    const { db, owner, agent, note } = await office('Ana');
    const marvin = await agent('Marvin');
    const made = await note('Fix the chair', { labels: ['bug'] });

    const moved = await updateBoardItem(db, {
      workspaceId: owner.workspaceId,
      itemId: made.id,
      status: 'done',
      assigneeAgentId: marvin.id,
    });
    assert.equal(moved.status, 'done');
    assert.equal(moved.title, 'Fix the chair');
    assert.deepEqual(moved.labels, ['bug']);
    assert.equal(moved.assignee?.name, 'Marvin');
    assert.ok(moved.updatedAt >= made.updatedAt);

    const unassigned = await updateBoardItem(db, {
      workspaceId: owner.workspaceId,
      itemId: made.id,
      assigneeAgentId: null,
    });
    assert.equal(unassigned.assignee, null);
  });

  it("refuses another office's note", async () => {
    const { db, owner, note } = await office('Ana');
    const other = await office('Bea');
    const made = await note('Fix the chair');
    await assert.rejects(
      updateBoardItem(db, { workspaceId: other.owner.workspaceId, itemId: made.id, status: 'done' }),
      (error: unknown) => error instanceof BoardItemError && error.reason === 'not_found',
    );
    assert.equal(await deleteBoardItem(db, other.owner.workspaceId, made.id), false);
    assert.equal((await listBoardItemsForWorkspace(db, owner.workspaceId)).length, 1);
    assert.equal((await listBoardItemsForWorkspace(db, other.owner.workspaceId)).length, 0);
  });

  it('keeps the note when its agent is revoked, for nobody', async () => {
    const { db, owner, agent, note } = await office('Ana');
    const marvin = await agent('Marvin');
    const made = await note('Fix the chair', { assigneeAgentId: marvin.id });
    await revokeAgent(db, marvin.id, owner.id);
    const [kept] = await listBoardItemsForWorkspace(db, owner.workspaceId);
    assert.equal(kept?.id, made.id);
    assert.equal(kept?.assignee, null);
  });
});
