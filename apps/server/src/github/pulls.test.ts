import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BoardTaskRef, PullRequestStatusRef } from '@quintal/shared';
import {
  createAgent,
  describeOfficeGithub,
  listBoardEvents,
  listAgentTasksForWorkspace,
  noteAgentTask,
  pullRequestStatusesForWorkspace,
  setOfficeGithub,
} from '@quintal/shared/db';
import { createTestDb, createTestUser } from '@quintal/shared/db/testing';

import { PullActionError, PullRequestWatch, tasksToWatch } from './pulls.js';

const API = 'https://api.github.test';

/** A GitHub that answers from a table and keeps what it was asked. */
function fakeGithub(routes: Record<string, { status?: number; body?: unknown }>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const path = url.replace(API, '');
    const method = init.method ?? 'GET';
    calls.push({ method, path, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
    const route = routes[`${method} ${path}`];
    if (!route) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    const status = route.status ?? 200;
    return new Response(status === 202 || status === 204 ? null : JSON.stringify(route.body ?? {}), { status });
  };
  return { fetch, calls };
}

function pullRoutes(number: number, overrides: Partial<{ state: string; merged: boolean; mergeable: boolean | null; sha: string }> = {}) {
  const sha = overrides.sha ?? `sha${number}`;
  return {
    [`GET /repos/acme/office/pulls/${number}`]: {
      body: {
        number,
        state: overrides.state ?? 'open',
        merged: overrides.merged ?? false,
        draft: false,
        title: `PR ${number}`,
        mergeable: overrides.mergeable ?? true,
        mergeable_state: 'clean',
        head: { sha, ref: `branch-${number}` },
        base: { ref: 'main' },
      },
    },
    [`GET /repos/acme/office/commits/${sha}/check-runs?per_page=100`]: {
      body: { check_runs: [{ name: 'build', status: 'completed', conclusion: 'success', html_url: null }] },
    },
    [`GET /repos/acme/office/pulls/${number}/reviews?per_page=100`]: { body: [] },
  };
}

async function office(withToken = true) {
  const db = await createTestDb();
  const owner = await createTestUser(db, 'Josh');
  const marvin = await createAgent(db, { workspaceId: owner.workspaceId, ownerUserId: owner.id, name: 'Marvin', spriteKey: 'slate' });
  if (withToken) await setOfficeGithub(db, { workspaceId: owner.workspaceId, token: 'ghp_token', login: 'josh', setByUserId: owner.id });
  const onPull = async (number: number, now: number, state: 'open' | 'merged' | 'closed' = 'open') =>
    (
      await noteAgentTask(db, {
        workspaceId: owner.workspaceId,
        agentId: marvin.id,
        task: { title: `pr ${number}`, repo: 'office', branch: `branch-${number}`, pr: { number, url: `https://github.com/acme/office/pull/${number}`, state } },
        now,
      })
    ).record;
  return { db, owner, marvin, onPull };
}

const line = (id: string, over: Partial<BoardTaskRef>): BoardTaskRef => ({
  id,
  agentId: 'a',
  agentName: 'Marvin',
  item: null,
  title: 't',
  repo: 'office',
  branch: id,
  pr: { number: 1, url: 'https://github.com/acme/office/pull/1', state: 'open' },
  status: 'active',
  startedAt: 0,
  endedAt: null,
  lastSeenAt: 0,
  github: null,
  ...over,
});

describe('which pull requests the office asks about', () => {
  it('is the open or still-active ones with a GitHub URL, newest first, capped', () => {
    const tasks = [
      line('open-old', { lastSeenAt: 1 }),
      line('open-new', { lastSeenAt: 3 }),
      line('merged-ended', { status: 'ended', pr: { number: 2, url: 'https://github.com/acme/office/pull/2', state: 'merged' }, lastSeenAt: 2 }),
      line('merged-active', { pr: { number: 3, url: 'https://github.com/acme/office/pull/3', state: 'merged' }, lastSeenAt: 2 }),
      line('no-pr', { pr: null, lastSeenAt: 9 }),
      line('elsewhere', { pr: { number: 4, url: 'https://gitlab.com/acme/office/-/merge_requests/4', state: 'open' }, lastSeenAt: 9 }),
    ];
    assert.deepEqual(
      tasksToWatch(tasks, new Map()).map((task) => task.id),
      ['open-new', 'merged-active', 'open-old'],
    );
    assert.deepEqual(tasksToWatch(tasks, new Map(), 1).map((task) => task.id), ['open-new']);
  });

  it('trusts GitHub over the harness about whether one is still open', () => {
    const closedByGithub = { known: true, state: 'closed' } as PullRequestStatusRef;
    const tasks = [line('a', { status: 'ended' })];
    assert.equal(tasksToWatch(tasks, new Map()).length, 1, 'open as the harness said');
    assert.equal(tasksToWatch(tasks, new Map([['a', closedByGithub]])).length, 0, 'closed as GitHub said');
  });
});

describe('a look at GitHub', () => {
  it('asks nothing without a token', async () => {
    const { db, owner, onPull } = await office(false);
    const task = await onPull(1, 1000);
    const github = fakeGithub(pullRoutes(1));
    const watch = new PullRequestWatch({ db, workspaceId: owner.workspaceId, apiBase: API, fetch: github.fetch });
    const outcome = await watch.refresh([task], new Map());
    assert.equal(outcome.configured, false);
    assert.equal(github.calls.length, 0);
  });

  it('writes down what GitHub said, and moves the ledger when the state differs', async () => {
    const { db, owner, onPull } = await office();
    const open = await onPull(1, 1000);
    const merged = await onPull(2, 2000);
    const github = fakeGithub({ ...pullRoutes(1), ...pullRoutes(2, { state: 'closed', merged: true }) });
    const watch = new PullRequestWatch({ db, workspaceId: owner.workspaceId, apiBase: API, fetch: github.fetch, now: () => 5000 });
    const outcome = await watch.refresh([open, merged], new Map());
    assert.equal(outcome.configured, true);
    assert.equal(outcome.looked, 2);
    assert.equal(outcome.tokenRefused, null);
    assert.deepEqual(outcome.changes.map((change) => [change.task.id, change.state, change.merged]), [[merged.id, 'merged', true]]);

    const statuses = await pullRequestStatusesForWorkspace(db, owner.workspaceId);
    assert.equal(statuses.get(open.id)?.checks.summary, 'passing');
    assert.equal(statuses.get(open.id)?.fetchedAt, 5000);
    assert.equal(statuses.get(merged.id)?.state, 'merged');

    const ledger = await listAgentTasksForWorkspace(db, owner.workspaceId);
    assert.equal(ledger.find((row) => row.id === merged.id)?.pr?.state, 'merged', 'the ledger follows GitHub');
    const events = await listBoardEvents(db, owner.workspaceId, { taskId: merged.id });
    assert.equal(events[0]?.kind, 'pr.state');
    assert.equal(events[0]?.actor.kind, 'office');
    assert.equal((await describeOfficeGithub(db, owner.workspaceId)).lastError, null);
  });

  it('keeps a failed look as an error on that line, and a refused token on the office', async () => {
    const { db, owner, onPull } = await office();
    const first = await onPull(1, 1000);
    const github = fakeGithub({ 'GET /repos/acme/office/pulls/1': { status: 401, body: { message: 'Bad credentials' } } });
    const watch = new PullRequestWatch({ db, workspaceId: owner.workspaceId, apiBase: API, fetch: github.fetch, now: () => 7000 });
    const outcome = await watch.refresh([first], new Map());
    assert.match(outcome.tokenRefused ?? '', /token/);
    const status = (await pullRequestStatusesForWorkspace(db, owner.workspaceId)).get(first.id);
    assert.equal(status?.known, false);
    assert.match(status?.error ?? '', /token/);
    const described = await describeOfficeGithub(db, owner.workspaceId);
    assert.match(described.lastError ?? '', /token/);
    assert.equal(described.lastCheckedAt, 7000);
  });

  it('paces people asking for another look', async () => {
    const { db, owner, onPull } = await office();
    const task = await onPull(1, 1000);
    let now = 10_000;
    const github = fakeGithub(pullRoutes(1));
    const watch = new PullRequestWatch({ db, workspaceId: owner.workspaceId, apiBase: API, fetch: github.fetch, now: () => now });
    assert.equal(watch.refreshWaitMs(), 0);
    await watch.refresh([task], new Map());
    assert.equal(watch.refreshWaitMs(), 10_000);
    now += 4000;
    assert.equal(watch.refreshWaitMs(), 6000);
    now += 6000;
    assert.equal(watch.refreshWaitMs(), 0);
  });
});

describe('acting on a pull request from the board', () => {
  it('merges by method, pinned to the head seen, and writes down who did it', async () => {
    const { db, owner, onPull } = await office();
    const task = await onPull(1, 1000);
    const github = fakeGithub({ 'PUT /repos/acme/office/pulls/1/merge': { body: { sha: 'm', merged: true } } });
    const watch = new PullRequestWatch({ db, workspaceId: owner.workspaceId, apiBase: API, fetch: github.fetch, now: () => 9000 });
    const done = await watch.act(task, 'squash', { userId: owner.id, name: 'Josh' }, 'sha1');
    assert.match(done.said, /Merged #1 \(squash\)/);
    assert.deepEqual(github.calls[0]?.body, { merge_method: 'squash', sha: 'sha1' });
    const events = await listBoardEvents(db, owner.workspaceId, { taskId: task.id });
    assert.equal(events[0]?.kind, 'pr.squash');
    assert.equal(events[0]?.actor.name, 'Josh');
    assert.equal(events[0]?.createdAt, 9000);
  });

  it('closes, and updates the branch', async () => {
    const { db, owner, onPull } = await office();
    const task = await onPull(1, 1000);
    const github = fakeGithub({
      'PATCH /repos/acme/office/pulls/1': { body: { state: 'closed' } },
      'PUT /repos/acme/office/pulls/1/update-branch': { status: 202 },
    });
    const watch = new PullRequestWatch({ db, workspaceId: owner.workspaceId, apiBase: API, fetch: github.fetch });
    assert.match((await watch.act(task, 'update_branch', { userId: owner.id, name: 'Josh' })).said, /up to date/);
    assert.match((await watch.act(task, 'close', { userId: owner.id, name: 'Josh' })).said, /Closed #1/);
    assert.deepEqual((await listBoardEvents(db, owner.workspaceId, { taskId: task.id })).map((event) => event.kind), ['pr.close', 'pr.update_branch']);
  });

  it('says why not: no token, no pull request, or GitHub’s own reason', async () => {
    const { db, owner, onPull } = await office(false);
    const task = await onPull(1, 1000);
    const github = fakeGithub({ 'PUT /repos/acme/office/pulls/1/merge': { status: 405, body: { message: 'Pull Request is not mergeable' } } });
    const watch = new PullRequestWatch({ db, workspaceId: owner.workspaceId, apiBase: API, fetch: github.fetch });
    await assert.rejects(watch.act(task, 'merge', { userId: owner.id, name: 'Josh' }), (error: unknown) => error instanceof PullActionError && error.code === 'not_configured');
    await assert.rejects(watch.act({ ...task, pr: null }, 'merge', { userId: owner.id, name: 'Josh' }), (error: unknown) => error instanceof PullActionError && error.code === 'invalid_payload');

    await setOfficeGithub(db, { workspaceId: owner.workspaceId, token: 'ghp_token', login: 'josh', setByUserId: owner.id });
    await assert.rejects(
      watch.act(task, 'merge', { userId: owner.id, name: 'Josh' }),
      (error: unknown) => error instanceof PullActionError && error.code === 'github' && /not mergeable/.test(error.message),
    );
    assert.equal((await listBoardEvents(db, owner.workspaceId, { taskId: task.id })).length, 0, 'a refused action is not written down as done');
  });
});
