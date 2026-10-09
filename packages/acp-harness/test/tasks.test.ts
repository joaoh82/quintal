import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  TaskError,
  activeTask,
  agentSlug,
  baseRef,
  beginTask,
  branchName,
  cleanupDecision,
  describeTask,
  endTask,
  notePullRequest,
  parseTaskCommand,
  readBook,
  resolveRepo,
  slugify,
  taskReport,
  worktreePath,
  worktreeState,
  type Git,
} from '../src/runner/tasks.js';

/**
 * A git worktree per task.
 *
 * What these defend: a task begins from the remote's *current* default
 * branch, not from whatever was pulled last; two tasks never share a name or
 * a directory; and ending a task never deletes work that is nowhere else —
 * uncommitted changes and unpushed commits both keep the worktree, and a
 * squash-merged branch counts as delivered even though neither upstream nor
 * base contains its commits.
 *
 * Against real repositories in a temporary directory, with a bare "origin"
 * beside each, because worktrees and upstream arithmetic are exactly what a
 * fake would get wrong.
 */

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function sh(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  }).trim();
}

/** A nest, a repos dir with one checkout `api` cloned from a bare origin. */
function world(): { nest: string; repos: string; api: string; origin: string } {
  const root = mkdtempSync(join(tmpdir(), 'quintal-tasks-'));
  roots.push(root);
  const nest = join(root, 'nest');
  const repos = join(root, 'repos');
  const origin = join(root, 'origin.git');
  mkdirSync(nest);
  mkdirSync(repos);

  // The remote first, with one commit on main, so a clone has a default branch.
  const seed = join(root, 'seed');
  sh(['init', '-q', '-b', 'main', seed], root);
  writeFileSync(join(seed, 'README.md'), 'hello\n');
  sh(['add', '.'], seed);
  sh(['commit', '-q', '-m', 'first'], seed);
  sh(['clone', '-q', '--bare', seed, origin], root);
  sh(['symbolic-ref', 'HEAD', 'refs/heads/main'], origin);

  const api = join(repos, 'api');
  sh(['clone', '-q', origin, api], root);
  return { nest, repos, api, origin };
}

/** Push a commit to origin's main from somewhere else, as another agent would. */
function someoneElseMerges(origin: string, root: string, file: string): string {
  const other = join(root, `other-${file}`);
  sh(['clone', '-q', origin, other], root);
  writeFileSync(join(other, file), 'merged elsewhere\n');
  sh(['add', '.'], other);
  sh(['commit', '-q', '-m', `add ${file}`], other);
  sh(['push', '-q', 'origin', 'main'], other);
  return sh(['rev-parse', 'HEAD'], other);
}

describe('naming', () => {
  it('turns a title into something git and a shell accept', () => {
    assert.equal(slugify('Fix the login redirect!'), 'fix-the-login-redirect');
    assert.equal(slugify('  Ünïcode — café  '), 'unicode-cafe');
    assert.equal(slugify('!!!'), '');
    assert.ok(slugify('a'.repeat(100)).length <= 40);
  });

  it('names the branch and the worktree after the agent and the slug', () => {
    assert.equal(agentSlug('Marvin'), 'marvin');
    assert.equal(branchName('Marvin', 'fix-login'), 'quintal/marvin/fix-login');
    assert.equal(worktreePath('/nest', 'Marvin', 'fix-login'), '/nest/WORKTREES/marvin/fix-login');
  });

  it('reads `!task api: fix the login redirect`, with or without the colon', () => {
    assert.deepEqual(parseTaskCommand('api: fix the login redirect'), {
      repo: 'api',
      title: 'fix the login redirect',
    });
    assert.deepEqual(parseTaskCommand('group/api fix it'), { repo: 'group/api', title: 'fix it' });
    assert.equal(parseTaskCommand('api'), null);
    assert.equal(parseTaskCommand(''), null);
  });
});

describe('resolveRepo', () => {
  it('accepts a checkout under REPOS/, directly or one folder in', () => {
    const { repos, api } = world();
    assert.deepEqual(resolveRepo(repos, 'api'), { name: 'api', path: api });
    assert.deepEqual(resolveRepo(repos, 'api/'), { name: 'api', path: api });
    mkdirSync(join(repos, 'group'));
    sh(['clone', '-q', api, join(repos, 'group', 'web')], repos);
    assert.equal(resolveRepo(repos, 'group/web').name, 'group/web');
  });

  it('refuses anything that is not one of the owner\'s checkouts', () => {
    const { repos } = world();
    for (const bad of ['../etc', '/etc', 'a/b/c', '', 'api/../../x']) {
      assert.throws(() => resolveRepo(repos, bad), (error: unknown) => error instanceof TaskError && error.code === 'bad_repo', bad);
    }
    mkdirSync(join(repos, 'notes'));
    assert.throws(() => resolveRepo(repos, 'notes'), (error: unknown) => error instanceof TaskError && error.code === 'not_a_checkout');
    assert.throws(() => resolveRepo(repos, 'nothing'), (error: unknown) => error instanceof TaskError && error.code === 'not_a_checkout');
  });
});

describe('the base', () => {
  it('is the remote\'s default branch, fetched first', async () => {
    const { api, origin } = world();
    const root = join(api, '..', '..');
    const delivered = someoneElseMerges(origin, root, 'elsewhere.txt');
    assert.equal(await baseRef(api), 'origin/main');
    // The fetch happened: the checkout now knows the commit it never pulled.
    assert.equal(sh(['rev-parse', 'origin/main'], api), delivered);
  });

  it('is HEAD when there is no origin at all', async () => {
    const { repos } = world();
    const local = join(repos, 'local');
    sh(['init', '-q', '-b', 'trunk', local], repos);
    writeFileSync(join(local, 'a'), 'a');
    sh(['add', '.'], local);
    sh(['commit', '-q', '-m', 'a'], local);
    assert.equal(await baseRef(local), 'trunk');
  });

  it('refuses rather than starting from a stale base when the fetch fails', async () => {
    const { api } = world();
    const failing: Git = async (args, cwd) => {
      if (args[0] === 'fetch') throw new Error('could not resolve host');
      return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    };
    await assert.rejects(baseRef(api, failing), (error: unknown) => error instanceof TaskError && error.code === 'fetch_failed');
  });
});

describe('beginning a task', () => {
  it('cuts a branch from fresh main into its own worktree and records it', async () => {
    const { nest, repos, api, origin } = world();
    const delivered = someoneElseMerges(origin, join(api, '..', '..'), 'fresh.txt');

    const task = await beginTask({ nest, agent: 'Marvin', reposDir: repos, repo: 'api', title: 'Fix the login redirect', now: () => 42 });

    assert.equal(task.branch, 'quintal/marvin/fix-the-login-redirect');
    assert.equal(task.base, 'origin/main');
    assert.equal(task.worktree, join(nest, 'WORKTREES', 'marvin', 'fix-the-login-redirect'));
    assert.ok(existsSync(join(task.worktree, 'fresh.txt')), 'the worktree starts from what was merged, not from the stale checkout');
    assert.equal(sh(['rev-parse', 'HEAD'], task.worktree), delivered);
    assert.equal(sh(['rev-parse', '--abbrev-ref', 'HEAD'], task.worktree), task.branch);
    // The owner's own checkout was not moved.
    assert.equal(sh(['rev-parse', '--abbrev-ref', 'HEAD'], api), 'main');

    assert.deepEqual(activeTask(nest, 'Marvin'), task);
    assert.equal(readBook(nest, 'Marvin').active, task.slug);
    assert.equal(task.startedAt, 42);
  });

  it('refuses a second task while one is active, naming the first', async () => {
    const { nest, repos } = world();
    await beginTask({ nest, agent: 'Marvin', reposDir: repos, repo: 'api', title: 'first' });
    await assert.rejects(
      beginTask({ nest, agent: 'Marvin', reposDir: repos, repo: 'api', title: 'second' }),
      (error: unknown) => error instanceof TaskError && error.code === 'already_active' && error.message.includes('first'),
    );
  });

  it('gives two tasks with the same title different names', async () => {
    const { nest, repos } = world();
    const first = await beginTask({ nest, agent: 'Marvin', reposDir: repos, repo: 'api', title: 'tidy' });
    await endTask({ nest, agent: 'Marvin' });
    const second = await beginTask({ nest, agent: 'Marvin', reposDir: repos, repo: 'api', title: 'tidy' });
    assert.equal(first.slug, 'tidy');
    assert.equal(second.slug, 'tidy-2');
    assert.notEqual(first.branch, second.branch);
  });

  it('keeps two agents apart in the same repository', async () => {
    const { nest, repos } = world();
    const a = await beginTask({ nest, agent: 'Arthur', reposDir: repos, repo: 'api', title: 'rate limiting' });
    const b = await beginTask({ nest, agent: 'Marvin', reposDir: repos, repo: 'api', title: 'login bug' });
    writeFileSync(join(a.worktree, 'limits.ts'), 'x');
    assert.ok(!existsSync(join(b.worktree, 'limits.ts')), 'one agent\'s edit is not the other\'s working tree');
    assert.equal(sh(['status', '--porcelain'], b.worktree), '');
  });

  it('needs a title and a real checkout', async () => {
    const { nest, repos } = world();
    await assert.rejects(beginTask({ nest, agent: 'M', reposDir: repos, repo: 'api', title: '  ' }), (e: unknown) => e instanceof TaskError && e.code === 'no_title');
    await assert.rejects(beginTask({ nest, agent: 'M', reposDir: repos, repo: 'nope', title: 'x' }), (e: unknown) => e instanceof TaskError && e.code === 'not_a_checkout');
    assert.equal(activeTask(nest, 'M'), null);
  });
});

describe('the cleanup rule', () => {
  it('keeps anything the remote does not have, and only that', () => {
    assert.equal(cleanupDecision({ dirty: false, unpushed: 0 }), 'removed');
    assert.equal(cleanupDecision({ dirty: true, unpushed: 0 }), 'kept-dirty');
    assert.equal(cleanupDecision({ dirty: false, unpushed: 3 }), 'kept-unpushed');
    // Dirty outranks unpushed: uncommitted work is the easier thing to lose.
    assert.equal(cleanupDecision({ dirty: true, unpushed: 3 }), 'kept-dirty');
  });
});

describe('ending a task', () => {
  it('removes a clean, delivered worktree and its branch', async () => {
    const { nest, repos, api } = world();
    const task = await beginTask({ nest, agent: 'Marvin', reposDir: repos, repo: 'api', title: 'noop' });
    const ended = await endTask({ nest, agent: 'Marvin', now: () => 7 });
    assert.equal(ended.outcome, 'removed');
    assert.ok(!existsSync(task.worktree));
    assert.throws(() => sh(['rev-parse', '--verify', '--quiet', task.branch], api), 'the branch is gone too');
    assert.equal(activeTask(nest, 'Marvin'), null);
    assert.equal(readBook(nest, 'Marvin').tasks[task.slug]?.outcome, 'removed');
    assert.equal(readBook(nest, 'Marvin').tasks[task.slug]?.endedAt, 7);
  });

  it('keeps a worktree with uncommitted changes, and says so', async () => {
    const { nest, repos } = world();
    const task = await beginTask({ nest, agent: 'Marvin', reposDir: repos, repo: 'api', title: 'wip' });
    writeFileSync(join(task.worktree, 'new.ts'), 'half done');
    const ended = await endTask({ nest, agent: 'Marvin' });
    assert.equal(ended.outcome, 'kept-dirty');
    assert.ok(existsSync(join(task.worktree, 'new.ts')), 'the half-done file survived');
    assert.equal(activeTask(nest, 'Marvin'), null, 'but the task is over');
  });

  it('keeps a worktree with commits no remote has', async () => {
    const { nest, repos } = world();
    const task = await beginTask({ nest, agent: 'Marvin', reposDir: repos, repo: 'api', title: 'local commits' });
    writeFileSync(join(task.worktree, 'a.ts'), 'a');
    sh(['add', '.'], task.worktree);
    sh(['commit', '-q', '-m', 'a'], task.worktree);
    assert.deepEqual(await worktreeState(task), { dirty: false, unpushed: 1 });
    const ended = await endTask({ nest, agent: 'Marvin' });
    assert.equal(ended.outcome, 'kept-unpushed');
    assert.equal(ended.unpushed, 1);
    assert.ok(existsSync(task.worktree));
  });

  it('removes a worktree once its commits are pushed', async () => {
    const { nest, repos } = world();
    const task = await beginTask({ nest, agent: 'Marvin', reposDir: repos, repo: 'api', title: 'pushed' });
    writeFileSync(join(task.worktree, 'a.ts'), 'a');
    sh(['add', '.'], task.worktree);
    sh(['commit', '-q', '-m', 'a'], task.worktree);
    sh(['push', '-q', '-u', 'origin', 'HEAD'], task.worktree);
    assert.deepEqual(await worktreeState(task), { dirty: false, unpushed: 0 });
    assert.equal((await endTask({ nest, agent: 'Marvin' })).outcome, 'removed');
  });

  it('treats a squash-merged branch as delivered, even with the remote branch gone', async () => {
    const { nest, repos, origin } = world();
    const task = await beginTask({ nest, agent: 'Marvin', reposDir: repos, repo: 'api', title: 'squashed' });
    writeFileSync(join(task.worktree, 'a.ts'), 'a');
    sh(['add', '.'], task.worktree);
    sh(['commit', '-q', '-m', 'a'], task.worktree);
    sh(['push', '-q', '-u', 'origin', 'HEAD'], task.worktree);
    const head = sh(['rev-parse', 'HEAD'], task.worktree);
    // The squash: main gets a different commit with the same content, and
    // the branch is deleted on the remote, as GitHub does.
    const root = join(repos, '..');
    const other = join(root, 'merger');
    sh(['clone', '-q', origin, other], root);
    writeFileSync(join(other, 'a.ts'), 'a');
    sh(['add', '.'], other);
    sh(['commit', '-q', '-m', 'squashed (#1)'], other);
    sh(['push', '-q', 'origin', 'main'], other);
    sh(['push', '-q', 'origin', '--delete', task.branch], other);
    sh(['fetch', '-q', '--prune', 'origin'], task.worktree);

    // Without knowing the merge, the commit looks unpushed and the tree is kept.
    assert.equal((await worktreeState(task)).unpushed, 1);
    // Told what the pull request delivered, it is clean.
    assert.deepEqual(await worktreeState(task, undefined, head), { dirty: false, unpushed: 0 });
    const ended = await endTask({ nest, agent: 'Marvin', deliveredHead: head });
    assert.equal(ended.outcome, 'removed');
  });

  it('is refused when there is no task', async () => {
    const { nest } = world();
    await assert.rejects(endTask({ nest, agent: 'Marvin' }), (e: unknown) => e instanceof TaskError && e.code === 'no_task');
  });

  it('forgets an active task whose worktree somebody removed by hand', async () => {
    const { nest, repos } = world();
    const task = await beginTask({ nest, agent: 'Marvin', reposDir: repos, repo: 'api', title: 'gone' });
    rmSync(task.worktree, { recursive: true, force: true });
    assert.equal(activeTask(nest, 'Marvin'), null);
    assert.equal(readBook(nest, 'Marvin').active, null);
  });
});

describe('the pull request and the report', () => {
  it('records the PR on the task and shows it in one line', async () => {
    const { nest, repos } = world();
    const task = await beginTask({ nest, agent: 'Marvin', reposDir: repos, repo: 'api', title: 'pr' });
    assert.equal(describeTask(task), 'quintal/marvin/pr');
    const noted = notePullRequest(nest, 'Marvin', task.slug, { number: 12, url: 'https://x/pull/12', state: 'OPEN', headRefOid: 'abc' });
    assert.equal(describeTask(noted!), 'quintal/marvin/pr · PR #12');
    assert.deepEqual(activeTask(nest, 'Marvin')?.pr, { number: 12, url: 'https://x/pull/12', state: 'OPEN' });
    assert.equal(notePullRequest(nest, 'Marvin', 'nothing', { number: 1, url: '', state: '', headRefOid: '' }), null);
  });

  it('tells the agent where to work, or that it is not on a task', async () => {
    const { nest, repos } = world();
    assert.equal(taskReport(null).active, false);
    const task = await beginTask({ nest, agent: 'Marvin', reposDir: repos, repo: 'api', title: 'report' });
    const report = taskReport(task);
    assert.equal(report.active, true);
    assert.equal(report.worktree, task.worktree);
    assert.equal(report.branch, task.branch);
  });
});
