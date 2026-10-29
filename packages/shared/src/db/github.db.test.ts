import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PullRequestFacts } from '../github.js';
import { noteAgentTask } from './agent-tasks.js';
import { createAgent } from './agents.js';
import {
  clearOfficeGithub,
  describeOfficeGithub,
  getOfficeGithub,
  listBoardEvents,
  noteOfficeGithubCheck,
  pullRequestStatusesForWorkspace,
  recordBoardEvent,
  savePullRequestStatus,
  setAgentTaskPullRequestState,
  setOfficeGithub,
} from './github.js';
import { createTestDb, createTestUser } from './testing.js';

async function office() {
  const db = await createTestDb();
  const owner = await createTestUser(db, 'Josh');
  const marvin = await createAgent(db, { workspaceId: owner.workspaceId, ownerUserId: owner.id, name: 'Marvin', spriteKey: 'slate' });
  const task = await noteAgentTask(db, {
    workspaceId: owner.workspaceId,
    agentId: marvin.id,
    task: { title: 'fix the chair', repo: 'office', branch: 'quintal/marvin/chair', pr: { number: 12, url: 'https://github.com/acme/office/pull/12', state: 'open' } },
    now: 1000,
  });
  return { db, owner, marvin, taskId: task.record.id };
}

const FACTS: PullRequestFacts = {
  state: 'open',
  draft: false,
  title: 'Fix the chair',
  headSha: 'abc123',
  headRef: 'quintal/marvin/chair',
  baseRef: 'main',
  mergeable: true,
  mergeableState: 'clean',
  checks: { summary: 'passing', total: 1, passed: 1, failed: 0, pending: 0, runs: [{ name: 'build', status: 'completed', conclusion: 'success', url: null }] },
  reviewDecision: 'approved',
};

describe('the office’s GitHub token', () => {
  it('is kept with whose it is, and described without it', async () => {
    const { db, owner } = await office();
    assert.equal(await getOfficeGithub(db, owner.workspaceId), null);
    assert.equal((await describeOfficeGithub(db, owner.workspaceId)).connected, false);

    await setOfficeGithub(db, { workspaceId: owner.workspaceId, token: 'ghp_secret', login: 'josh', setByUserId: owner.id });
    const row = await getOfficeGithub(db, owner.workspaceId);
    assert.equal(row?.token, 'ghp_secret');
    const described = await describeOfficeGithub(db, owner.workspaceId);
    assert.equal(described.connected, true);
    assert.equal(described.login, 'josh');
    assert.equal(described.setByName, 'Josh');
    assert.ok(!JSON.stringify(described).includes('ghp_secret'), 'the description never carries the token');
  });

  it('replaces a token cleanly, remembers a refusal, and can be taken out', async () => {
    const { db, owner } = await office();
    await setOfficeGithub(db, { workspaceId: owner.workspaceId, token: 'ghp_one', login: 'josh', setByUserId: owner.id });
    await noteOfficeGithubCheck(db, owner.workspaceId, 'Bad credentials', 5000);
    assert.equal((await describeOfficeGithub(db, owner.workspaceId)).lastError, 'Bad credentials');

    await setOfficeGithub(db, { workspaceId: owner.workspaceId, token: 'ghp_two', login: 'ana', setByUserId: owner.id });
    const replaced = await describeOfficeGithub(db, owner.workspaceId);
    assert.equal(replaced.login, 'ana');
    assert.equal(replaced.lastError, null, 'a new token starts with a clean record');

    assert.equal(await clearOfficeGithub(db, owner.workspaceId), true);
    assert.equal(await clearOfficeGithub(db, owner.workspaceId), false);
    assert.equal(await getOfficeGithub(db, owner.workspaceId), null);
  });
});

describe('what GitHub last said about a pull request', () => {
  it('is kept per task and read back for the board', async () => {
    const { db, owner, taskId } = await office();
    await savePullRequestStatus(db, { workspaceId: owner.workspaceId, taskId, facts: FACTS, now: 2000 });
    const statuses = await pullRequestStatusesForWorkspace(db, owner.workspaceId);
    const status = statuses.get(taskId);
    assert.equal(status?.known, true);
    assert.equal(status?.checks.summary, 'passing');
    assert.equal(status?.reviewDecision, 'approved');
    assert.equal(status?.mergeable, true);
    assert.equal(status?.fetchedAt, 2000);
    assert.equal(status?.error, null);
    assert.equal(status?.lastAction, null);
  });

  it('keeps the last good facts when a later fetch fails, and says so', async () => {
    const { db, owner, taskId } = await office();
    await savePullRequestStatus(db, { workspaceId: owner.workspaceId, taskId, facts: FACTS, now: 2000 });
    await savePullRequestStatus(db, { workspaceId: owner.workspaceId, taskId, error: 'rate limit', now: 3000 });
    const status = (await pullRequestStatusesForWorkspace(db, owner.workspaceId)).get(taskId);
    assert.equal(status?.headSha, 'abc123', 'the facts stay');
    assert.equal(status?.error, 'rate limit');
    assert.equal(status?.fetchedAt, 3000);
  });

  it('is only an error when no fetch has ever succeeded', async () => {
    const { db, owner, taskId } = await office();
    await savePullRequestStatus(db, { workspaceId: owner.workspaceId, taskId, error: 'no access', now: 3000 });
    const status = (await pullRequestStatusesForWorkspace(db, owner.workspaceId)).get(taskId);
    assert.equal(status?.known, false);
    assert.equal(status?.error, 'no access');
  });

  it('carries the last action taken on it from the board', async () => {
    const { db, owner, taskId } = await office();
    await savePullRequestStatus(db, { workspaceId: owner.workspaceId, taskId, facts: FACTS, now: 2000 });
    await recordBoardEvent(db, { workspaceId: owner.workspaceId, kind: 'pr.update_branch', actor: { kind: 'user', id: owner.id, name: 'Josh' }, taskId, now: 4000 });
    await recordBoardEvent(db, { workspaceId: owner.workspaceId, kind: 'pr.squash', actor: { kind: 'user', id: owner.id, name: 'Josh' }, taskId, now: 5000 });
    await recordBoardEvent(db, { workspaceId: owner.workspaceId, kind: 'pr.state', actor: { kind: 'office', id: null, name: 'office' }, taskId, payload: { state: 'merged' }, now: 6000 });
    const status = (await pullRequestStatusesForWorkspace(db, owner.workspaceId)).get(taskId);
    assert.deepEqual(status?.lastAction, { action: 'squash', byName: 'Josh', at: 5000 }, 'the newest action, not the poll’s note');
  });

  it('moves the ledger along when GitHub says the state changed', async () => {
    const { db, owner, taskId } = await office();
    assert.deepEqual(await setAgentTaskPullRequestState(db, taskId, 'open'), { changed: false, merged: false });
    assert.deepEqual(await setAgentTaskPullRequestState(db, taskId, 'merged'), { changed: true, merged: true });
    assert.deepEqual(await setAgentTaskPullRequestState(db, taskId, 'merged'), { changed: false, merged: false }, 'said once');
    assert.deepEqual(await setAgentTaskPullRequestState(db, taskId, 'closed'), { changed: true, merged: false });
  });
});

describe('who did what on the board', () => {
  it('is written and read newest first, for one note or task when asked', async () => {
    const { db, owner, taskId } = await office();
    await recordBoardEvent(db, { workspaceId: owner.workspaceId, kind: 'pr.close', actor: { kind: 'user', id: owner.id, name: 'Josh' }, taskId, now: 1000 });
    await recordBoardEvent(db, { workspaceId: owner.workspaceId, kind: 'item.created', actor: { kind: 'agent', id: 'a1', name: 'Marvin' }, itemId: null, now: 2000 });
    const all = await listBoardEvents(db, owner.workspaceId);
    assert.deepEqual(all.map((event) => event.kind), ['item.created', 'pr.close']);
    const forTask = await listBoardEvents(db, owner.workspaceId, { taskId });
    assert.equal(forTask.length, 1);
    assert.equal(forTask[0]?.actor.name, 'Josh');
    assert.equal(forTask[0]?.createdAt, 1000);
  });
});
