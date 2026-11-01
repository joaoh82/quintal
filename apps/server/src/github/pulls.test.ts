import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BoardTaskRef, PullRequestStatusRef } from '@quintal/shared';
import {
  createAgent,
  describeOfficeGithub,
  getOfficeGithub,
  listBoardEvents,
  listAgentTasksForWorkspace,
  noteAgentTask,
  pullRequestStatusesForWorkspace,
  setOfficeGithub,
} from '@quintal/shared/db';
import { createTestDb, createTestUser } from '@quintal/shared/db/testing';

import { PullActionError, PullRequestWatch, REPO_PULLS_REFRESH_MIN_MS, tasksToWatch } from './pulls.js';

const API = 'https://api.github.test';

// The office's token is kept encrypted under the server's secret.
process.env.BETTER_AUTH_SECRET ??= 'pulls-test-secret-at-least-thirty-two-characters';

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

async function office(withToken = true, repos: string[] = ['acme/office']) {
  const db = await createTestDb();
  const owner = await createTestUser(db, 'Josh');
  const marvin = await createAgent(db, { workspaceId: owner.workspaceId, ownerUserId: owner.id, name: 'Marvin', spriteKey: 'slate' });
  if (withToken) await setOfficeGithub(db, { workspaceId: owner.workspaceId, token: 'ghp_token', login: 'josh', setByUserId: owner.id, repos });
  const onPull = async (number: number, now: number, state: 'open' | 'merged' | 'closed' = 'open', repo = 'acme/office') =>
    (
      await noteAgentTask(db, {
        workspaceId: owner.workspaceId,
        agentId: marvin.id,
        task: { title: `pr ${number}`, repo: 'office', branch: `branch-${number}`, pr: { number, url: `https://github.com/${repo}/pull/${number}`, state } },
        now,
      })
    ).record;
  return { db, owner, marvin, onPull };
}

const LISTED = ['acme/office'];

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
      tasksToWatch(tasks, new Map(), LISTED).map((task) => task.id),
      ['open-new', 'merged-active', 'open-old'],
    );
    assert.deepEqual(tasksToWatch(tasks, new Map(), LISTED, 1).map((task) => task.id), ['open-new']);
  });

  it('is only the repositories on the office’s list, whatever an agent’s harness reported', () => {
    const tasks = [
      line('listed', { lastSeenAt: 1 }),
      line('elsewhere', { pr: { number: 88, url: 'https://github.com/acme/payments/pull/88', state: 'open' }, lastSeenAt: 2 }),
      line('cased', { pr: { number: 3, url: 'https://github.com/Acme/Office/pull/3', state: 'open' }, lastSeenAt: 3 }),
    ];
    assert.deepEqual(tasksToWatch(tasks, new Map(), LISTED).map((task) => task.id), ['cased', 'listed']);
    assert.deepEqual(tasksToWatch(tasks, new Map(), []), [], 'an empty list is nothing to look at');
  });

  it('is only the office’s own GitHub host', () => {
    const tasks = [line('other-host', { pr: { number: 1, url: 'https://git.acme.example/acme/office/pull/1', state: 'open' } })];
    assert.equal(tasksToWatch(tasks, new Map(), LISTED).length, 0);
    assert.equal(tasksToWatch(tasks, new Map(), LISTED, 12, 'git.acme.example').length, 1, 'unless that is the office’s host');
  });

  it('watches a pull request reopened since its last check, by the newer listing', () => {
    const ended = line('a', { status: 'ended', pr: { number: 1, url: 'https://github.com/acme/office/pull/1', state: 'closed' } });
    const closedAt1000 = { known: true, state: 'closed', fetchedAt: 1000 } as PullRequestStatusRef;
    const listedOpen = (updatedAt: number) => [
      {
        repo: 'acme/office', number: 1, url: 'https://github.com/acme/office/pull/1', title: '', author: '', state: 'open' as const,
        draft: false, headRef: '', baseRef: '', headSha: '', createdAt: 0, updatedAt,
      },
    ];
    const statuses = new Map([['a', closedAt1000]]);
    assert.equal(tasksToWatch([ended], statuses, LISTED).length, 0, 'closed, as last checked');
    assert.equal(tasksToWatch([ended], statuses, LISTED, 12, undefined, listedOpen(3000)).length, 1, 'reopened since');
    assert.equal(tasksToWatch([ended], statuses, LISTED, 12, undefined, listedOpen(500)).length, 0, 'a listing older than the check');
  });

  it('trusts GitHub over the harness about whether one is still open', () => {
    const closedByGithub = { known: true, state: 'closed' } as PullRequestStatusRef;
    const tasks = [line('a', { status: 'ended' })];
    assert.equal(tasksToWatch(tasks, new Map(), LISTED).length, 1, 'open as the harness said');
    assert.equal(tasksToWatch(tasks, new Map([['a', closedByGithub]]), LISTED).length, 0, 'closed as GitHub said');
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

  it('does not ask about a pull request outside the office’s list, even when asked for by name', async () => {
    const { db, owner, onPull } = await office();
    const elsewhere = await onPull(88, 1000, 'open', 'acme/payments');
    const github = fakeGithub(pullRoutes(88));
    const watch = new PullRequestWatch({ db, workspaceId: owner.workspaceId, apiBase: API, fetch: github.fetch });
    const outcome = await watch.refresh([elsewhere], new Map(), { taskId: elsewhere.id });
    assert.equal(outcome.configured, true);
    assert.equal(outcome.looked, 0);
    assert.equal(github.calls.length, 0, 'GitHub was not called');
    assert.equal((await pullRequestStatusesForWorkspace(db, owner.workspaceId)).size, 0, 'and nothing was written down');
  });

  it('does not call GitHub with a token it cannot decrypt, and says so on the office', async () => {
    const { db, owner, onPull } = await office();
    const first = await onPull(1, 1000);
    const github = fakeGithub(pullRoutes(1));
    const secret = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = 'a-rotated-secret-that-is-thirty-two-characters';
    try {
      const watch = new PullRequestWatch({ db, workspaceId: owner.workspaceId, apiBase: API, fetch: github.fetch, now: () => 7000 });
      const outcome = await watch.refresh([first], new Map());
      assert.equal(outcome.configured, false);
      assert.equal(github.calls.length, 0);
      const stored = await getOfficeGithub(db, owner.workspaceId);
      assert.match(stored?.lastError ?? '', /different BETTER_AUTH_SECRET/);
    } finally {
      process.env.BETTER_AUTH_SECRET = secret;
    }
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
  it('refuses a pull request outside the office’s list before GitHub is called, whoever asks', async () => {
    const { db, owner, onPull } = await office();
    const elsewhere = await onPull(88, 1000, 'open', 'acme/payments');
    const github = fakeGithub({ 'PUT /repos/acme/payments/pulls/88/merge': { body: { sha: 'm', merged: true } } });
    const watch = new PullRequestWatch({ db, workspaceId: owner.workspaceId, apiBase: API, fetch: github.fetch });
    for (const action of ['squash', 'close', 'update_branch'] as const) {
      await assert.rejects(
        watch.act(elsewhere, action, { userId: owner.id, name: 'Josh' }, 'sha88'),
        (error: unknown) => error instanceof PullActionError && error.code === 'unauthorised' && /acme\/payments is not on this office/.test(error.message),
      );
    }
    assert.equal(github.calls.length, 0, 'GitHub was never called');
    assert.equal((await listBoardEvents(db, owner.workspaceId)).length, 0, 'and nothing was written down as done');
  });

  it('merges nothing it cannot pin to a head: none given and none on the board', async () => {
    const { db, owner, onPull } = await office();
    const task = await onPull(1, 1000);
    const github = fakeGithub({
      'PUT /repos/acme/office/pulls/1/merge': { body: { sha: 'm', merged: true } },
      'PUT /repos/acme/office/pulls/1/update-branch': { status: 202 },
      'PATCH /repos/acme/office/pulls/1': { body: { state: 'closed' } },
    });
    const watch = new PullRequestWatch({ db, workspaceId: owner.workspaceId, apiBase: API, fetch: github.fetch });
    for (const action of ['squash', 'merge', 'rebase', 'update_branch'] as const) {
      await assert.rejects(
        watch.act(task, action, { userId: owner.id, name: 'Josh' }),
        (error: unknown) => error instanceof PullActionError && error.code === 'invalid_payload' && /Check #1 with GitHub first/.test(error.message),
      );
    }
    assert.equal(github.calls.length, 0, 'GitHub was not called');
    await watch.act(task, 'close', { userId: owner.id, name: 'Josh' });
    assert.equal(github.calls.length, 1, 'closing needs no head');
  });

  it('pins a merge to the head on the board when the client names none', async () => {
    const { db, owner, onPull } = await office();
    const task = await onPull(1, 1000);
    const github = fakeGithub({ 'PUT /repos/acme/office/pulls/1/merge': { body: { sha: 'm', merged: true } } });
    const watch = new PullRequestWatch({ db, workspaceId: owner.workspaceId, apiBase: API, fetch: github.fetch });
    const onBoard = { known: true, headSha: 'board-head' } as PullRequestStatusRef;
    await watch.act({ ...task, github: onBoard }, 'merge', { userId: owner.id, name: 'Josh' });
    assert.deepEqual(github.calls[0]?.body, { merge_method: 'merge', sha: 'board-head' });
  });

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
    assert.match((await watch.act(task, 'update_branch', { userId: owner.id, name: 'Josh' }, 'sha1')).said, /up to date/);
    assert.deepEqual(github.calls[0]?.body, { expected_head_sha: 'sha1' });
    assert.match((await watch.act(task, 'close', { userId: owner.id, name: 'Josh' })).said, /Closed #1/);
    assert.deepEqual((await listBoardEvents(db, owner.workspaceId, { taskId: task.id })).map((event) => event.kind), ['pr.close', 'pr.update_branch']);
  });

  it('says why not: no token, no pull request, or GitHub’s own reason', async () => {
    const { db, owner, onPull } = await office(false);
    const task = await onPull(1, 1000);
    const github = fakeGithub({ 'PUT /repos/acme/office/pulls/1/merge': { status: 405, body: { message: 'Pull Request is not mergeable' } } });
    const watch = new PullRequestWatch({ db, workspaceId: owner.workspaceId, apiBase: API, fetch: github.fetch });
    await assert.rejects(watch.act(task, 'merge', { userId: owner.id, name: 'Josh' }, 'sha1'), (error: unknown) => error instanceof PullActionError && error.code === 'not_configured');
    await assert.rejects(watch.act({ ...task, pr: null }, 'merge', { userId: owner.id, name: 'Josh' }, 'sha1'), (error: unknown) => error instanceof PullActionError && error.code === 'invalid_payload');

    await setOfficeGithub(db, { workspaceId: owner.workspaceId, token: 'ghp_token', login: 'josh', setByUserId: owner.id, repos: LISTED });
    await assert.rejects(
      watch.act(task, 'merge', { userId: owner.id, name: 'Josh' }, 'sha1'),
      (error: unknown) => error instanceof PullActionError && error.code === 'github' && /not mergeable/.test(error.message),
    );
    assert.equal((await listBoardEvents(db, owner.workspaceId, { taskId: task.id })).length, 0, 'a refused action is not written down as done');
  });
});

describe("listing every pull request of the office's repositories", () => {
  const listed = (number: number, extra: Record<string, unknown> = {}) => ({
    number,
    state: 'open',
    draft: false,
    title: `PR ${number}`,
    html_url: `https://github.com/acme/office/pull/${number}`,
    user: { login: 'trillian' },
    merged_at: null,
    head: { sha: `sha${number}`, ref: `branch-${number}` },
    base: { ref: 'main' },
    created_at: '2026-10-01T00:00:00Z',
    updated_at: `2026-10-0${number}T00:00:00Z`,
    ...extra,
  });

  it('lists open and recently closed ones of each listed repository, newest first, and keeps the last good list of one that fails', async () => {
    const { db, owner } = await office(true, ['acme/office', 'acme/api']);
    const github = fakeGithub({
      'GET /repos/acme/office/pulls?state=open&sort=updated&direction=desc&per_page=100': { body: [listed(3), listed(1, { draft: true })] },
      'GET /repos/acme/office/pulls?state=closed&sort=updated&direction=desc&per_page=20': {
        body: [listed(2, { state: 'closed', merged_at: '2026-10-02T00:00:00Z' })],
      },
    });
    let now = 1000;
    const watch = new PullRequestWatch({ db, workspaceId: owner.workspaceId, apiBase: API, fetch: github.fetch, now: () => now });
    const previous = {
      pulls: [{ ...(await watch.listRepos({ pulls: [], fetchedAt: null, errors: [] })).pulls.pulls[0]!, repo: 'acme/api', number: 9, updatedAt: Date.parse('2026-10-02T12:00:00Z') }],
      fetchedAt: 1,
      errors: [],
    };
    assert.equal(watch.listDue(), false, 'just listed');
    now += 5 * 60_000;
    assert.equal(watch.listDue(), true);

    const outcome = await watch.listRepos(previous);
    assert.equal(outcome.configured, true);
    assert.deepEqual(
      outcome.pulls.pulls.map((pull) => [pull.repo, pull.number, pull.state, pull.draft, pull.author]),
      [
        ['acme/office', 3, 'open', false, 'trillian'],
        ['acme/api', 9, 'open', false, 'trillian'],
        ['acme/office', 2, 'merged', false, 'trillian'],
        ['acme/office', 1, 'open', true, 'trillian'],
      ],
    );
    assert.deepEqual(outcome.pulls.errors.map((error) => error.repo), ['acme/api'], 'acme/api would not list, and kept what it had');
    assert.equal(outcome.pulls.fetchedAt, now);
  });

  it('keeps a refused token written down when the ledger then has nothing to look at', async () => {
    const { db, owner } = await office();
    const github = fakeGithub({
      'GET /repos/acme/office/pulls?state=open&sort=updated&direction=desc&per_page=100': { status: 401, body: { message: 'Bad credentials' } },
    });
    const watch = new PullRequestWatch({ db, workspaceId: owner.workspaceId, apiBase: API, fetch: github.fetch, now: () => 7000 });
    const listedOutcome = await watch.listRepos({ pulls: [], fetchedAt: null, errors: [] });
    assert.match(listedOutcome.tokenRefused ?? '', /token/);
    const looked = await watch.refresh([], new Map());
    assert.equal(looked.looked, 0);
    assert.match((await describeOfficeGithub(db, owner.workspaceId)).lastError ?? '', /token/, 'the empty look did not clear it');
  });

  it('lists again for a person sooner than the poll, but not on every click', async () => {
    const { db, owner } = await office();
    let now = 1000;
    const watch = new PullRequestWatch({ db, workspaceId: owner.workspaceId, apiBase: API, fetch: fakeGithub({}).fetch, now: () => now });
    await watch.listRepos({ pulls: [], fetchedAt: null, errors: [] });
    now += 60_000;
    assert.equal(watch.listDue(REPO_PULLS_REFRESH_MIN_MS), false, 'a minute later, a click checks the ledger only');
    now += REPO_PULLS_REFRESH_MIN_MS;
    assert.equal(watch.listDue(REPO_PULLS_REFRESH_MIN_MS), true);
    assert.equal(watch.listDue(), false, 'the poll waits its five minutes');
  });

  it('lists nothing without a token', async () => {
    const { db, owner } = await office(false);
    const watch = new PullRequestWatch({ db, workspaceId: owner.workspaceId, apiBase: API, fetch: fakeGithub({}).fetch });
    const outcome = await watch.listRepos({ pulls: [], fetchedAt: null, errors: [] });
    assert.equal(outcome.configured, false);
    assert.deepEqual(outcome.pulls.pulls, []);
  });
});
