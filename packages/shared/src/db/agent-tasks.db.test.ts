import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AgentTask } from '../agent-task.js';
import { endAgentTasks, listAgentTasksForWorkspace, noteAgentTask, taskLinksForBoard } from './agent-tasks.js';
import { createAgent } from './agents.js';
import { createBoardItem, findUnlinkedItemForAgent, getBoardItem } from './board.js';
import { createTestDb, createTestUser } from './testing.js';

/**
 * The ledger is written from `agent:task`, which a harness repeats: on every
 * connect, and whenever its pull request changes. These pin that repeating
 * yourself is one row, that the row keeps the note it began for, and that
 * the board can find a note for a task that named none.
 */

async function office() {
  const db = await createTestDb();
  const owner = await createTestUser(db, 'Josh');
  const marvin = await createAgent(db, {
    workspaceId: owner.workspaceId,
    ownerUserId: owner.id,
    name: 'Marvin',
    spriteKey: 'slate',
  });
  const note = (title: string, assigneeAgentId: string | null = null) =>
    createBoardItem(db, {
      workspaceId: owner.workspaceId,
      title,
      body: '',
      status: 'open',
      color: 'yellow',
      labels: [],
      assigneeAgentId,
      createdBy: { userId: owner.id },
    });
  return { db, owner, marvin, note };
}

const TASK: AgentTask = { title: 'fix the chair', repo: 'office', branch: 'quintal/marvin/fix-the-chair' };
const WITH_PR: AgentTask = {
  ...TASK,
  pr: { number: 12, url: 'https://github.com/acme/office/pull/12', state: 'open' },
};

describe('the ledger of agent tasks', () => {
  it('writes a task once, however many times the harness says it', async () => {
    const { db, owner, marvin } = await office();
    const first = await noteAgentTask(db, { workspaceId: owner.workspaceId, agentId: marvin.id, task: TASK, now: 1000 });
    assert.equal(first.created, true);
    assert.equal(first.record.pr, null);
    assert.equal(first.record.status, 'active');

    const again = await noteAgentTask(db, { workspaceId: owner.workspaceId, agentId: marvin.id, task: WITH_PR, now: 2000 });
    assert.equal(again.created, false);
    assert.equal(again.record.id, first.record.id, 'the same branch is the same row');
    assert.deepEqual(again.record.pr, WITH_PR.pr);
    assert.equal(again.record.startedAt, 1000, 'started when first heard');
    assert.equal(again.record.lastSeenAt, 2000);
    assert.equal(again.merged, false);

    const rows = await listAgentTasksForWorkspace(db, owner.workspaceId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.agentName, 'Marvin');
  });

  it('says once when the pull request merged', async () => {
    const { db, owner, marvin } = await office();
    await noteAgentTask(db, { workspaceId: owner.workspaceId, agentId: marvin.id, task: WITH_PR });
    const merged = { ...WITH_PR, pr: { ...WITH_PR.pr!, state: 'merged' as const } };
    const first = await noteAgentTask(db, { workspaceId: owner.workspaceId, agentId: marvin.id, task: merged });
    assert.equal(first.merged, true);
    const repeat = await noteAgentTask(db, { workspaceId: owner.workspaceId, agentId: marvin.id, task: merged });
    assert.equal(repeat.merged, false, 'a merge is news once');
  });

  it('ends every active task when the agent says it is on nothing, and keeps the rows', async () => {
    const { db, owner, marvin } = await office();
    await noteAgentTask(db, { workspaceId: owner.workspaceId, agentId: marvin.id, task: TASK });
    const ended = await endAgentTasks(db, owner.workspaceId, marvin.id, 5000);
    assert.equal(ended.length, 1);
    assert.equal(ended[0]?.status, 'ended');
    assert.equal(ended[0]?.endedAt, 5000);
    assert.deepEqual(await endAgentTasks(db, owner.workspaceId, marvin.id), [], 'nothing left to end');
    const rows = await listAgentTasksForWorkspace(db, owner.workspaceId);
    assert.equal(rows[0]?.status, 'ended');

    // Said again later — a harness reconnecting with the same book — it is active again.
    const back = await noteAgentTask(db, { workspaceId: owner.workspaceId, agentId: marvin.id, task: TASK });
    assert.equal(back.record.status, 'active');
    assert.equal(back.record.endedAt, null);
  });

  it('reads the board its share of the ledger: every active line and the newest ended ones', async () => {
    const { db, owner, marvin } = await office();
    const on = (branch: string, now: number) =>
      noteAgentTask(db, { workspaceId: owner.workspaceId, agentId: marvin.id, task: { ...TASK, branch }, now });
    await on('first', 1000);
    await endAgentTasks(db, owner.workspaceId, marvin.id, 2000);
    await on('second', 3000);
    await endAgentTasks(db, owner.workspaceId, marvin.id, 4000);
    await on('third', 5000);
    await endAgentTasks(db, owner.workspaceId, marvin.id, 6000);
    await on('current', 7000);
    await on('first', 8000); // said again: active once more, the most recently seen

    const all = await listAgentTasksForWorkspace(db, owner.workspaceId);
    assert.deepEqual(
      all.map((row) => [row.branch, row.status]),
      [
        ['first', 'active'],
        ['current', 'active'],
        ['third', 'ended'],
        ['second', 'ended'],
      ],
    );

    const sent = await listAgentTasksForWorkspace(db, owner.workspaceId, { endedMax: 1 });
    assert.deepEqual(
      sent.map((row) => [row.branch, row.status]),
      [
        ['first', 'active'],
        ['current', 'active'],
        ['third', 'ended'],
      ],
      'both active lines, and only the newest ended one',
    );
    assert.deepEqual(
      (await listAgentTasksForWorkspace(db, owner.workspaceId, { endedMax: 0 })).map((row) => row.branch),
      ['first', 'current'],
    );
  });

  it('links a task to the note it began for, and keeps that note afterwards', async () => {
    const { db, owner, marvin, note } = await office();
    const chair = await note('Fix the chair', marvin.id);
    const other = await note('Water the plants', marvin.id);

    const first = await noteAgentTask(db, { workspaceId: owner.workspaceId, agentId: marvin.id, task: TASK, boardItemId: chair.id });
    assert.equal(first.linked, true);
    assert.deepEqual(first.record.item, { id: chair.id, number: chair.number, title: 'Fix the chair' });

    const again = await noteAgentTask(db, { workspaceId: owner.workspaceId, agentId: marvin.id, task: WITH_PR, boardItemId: other.id });
    assert.equal(again.linked, false);
    assert.equal(again.record.item?.id, chair.id, 'a task is for the note it began for');

    const links = await taskLinksForBoard(db, owner.workspaceId);
    assert.deepEqual(links.get(chair.id), {
      agent: { id: marvin.id, name: 'Marvin' },
      repo: 'office',
      branch: TASK.branch,
      pr: WITH_PR.pr,
      active: true,
    });
    assert.equal(links.has(other.id), false);

    const read = await getBoardItem(db, owner.workspaceId, chair.id);
    assert.deepEqual(read?.task, links.get(chair.id), 'the note carries its task');
    assert.equal((await getBoardItem(db, owner.workspaceId, other.id))?.task, null);
  });

  it('links a later task to a note the first was already on', async () => {
    const { db, owner, marvin, note } = await office();
    const chair = await note('Fix the chair', marvin.id);
    await noteAgentTask(db, { workspaceId: owner.workspaceId, agentId: marvin.id, task: TASK, boardItemId: chair.id });
    const unlinked = await noteAgentTask(db, { workspaceId: owner.workspaceId, agentId: marvin.id, task: { ...TASK, branch: 'quintal/marvin/fix-the-chair-2' } });
    assert.equal(unlinked.linked, false);
    const linked = await noteAgentTask(db, { workspaceId: owner.workspaceId, agentId: marvin.id, task: { ...TASK, branch: 'quintal/marvin/fix-the-chair-2' }, boardItemId: chair.id });
    assert.equal(linked.linked, true, 'a row with no note takes the one it is given');
    // The newest task seen for the note is the one its card shows.
    const links = await taskLinksForBoard(db, owner.workspaceId);
    assert.equal(links.get(chair.id)?.branch, 'quintal/marvin/fix-the-chair-2');
  });

  it('finds the note a task that named none is for: the newest handed to the agent, not done, not yet taken to a branch', async () => {
    const { db, owner, marvin, note } = await office();
    assert.equal(await findUnlinkedItemForAgent(db, owner.workspaceId, marvin.id), null, 'nothing handed to it');
    const old = await note('Old thing', marvin.id);
    const chair = await note('Fix the chair', marvin.id);
    await note('Somebody else’s', null);
    assert.equal((await findUnlinkedItemForAgent(db, owner.workspaceId, marvin.id))?.id, chair.id, 'newest first');

    await noteAgentTask(db, { workspaceId: owner.workspaceId, agentId: marvin.id, task: TASK, boardItemId: chair.id });
    assert.equal((await findUnlinkedItemForAgent(db, owner.workspaceId, marvin.id))?.id, old.id, 'a note on a branch is taken');
  });
});
