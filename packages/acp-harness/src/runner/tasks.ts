import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

/**
 * A git worktree per task.
 *
 * Every agent on a machine works in the nest, with the owner's checkouts under
 * `REPOS/`. Two agents asked to change the same repository therefore share one
 * working tree: one's half-finished edits are the other's `git status`, a
 * branch switch by either moves both, and whoever commits first can sweep up
 * the other's files. Nothing enforced "one agent, one repo at a time" — it was
 * only avoided by habit.
 *
 * A task is the boundary. It begins when the owner says `!task api: fix the
 * login redirect` or the agent calls `task_begin`, because most of what is
 * said to an agent ("what's the weather", "check that log") needs no branch
 * and the harness cannot tell a question from a job. Beginning a task fetches
 * the default branch, cuts `quintal/<agent>/<slug>` from it, and adds a
 * worktree under the nest's `WORKTREES/`. The agent's sessions are rooted
 * there until the task ends. The worktree is born current and dies at merge:
 * short-lived branches, which is the point of the flow. **Never per agent** —
 * a standing worktree per agent is a long-lived branch that drifts from main
 * the moment another agent merges.
 *
 * Ending never loses work. A worktree with uncommitted changes, or with
 * commits no remote has, is kept and the owner is told; a clean one goes with
 * its branch. The decision is `cleanupDecision`, pure, so the one rule that
 * can delete somebody's afternoon is pinned without a repository.
 *
 * Git is shelled out to rather than reimplemented: worktrees, fetches and
 * upstream arithmetic are exactly the things a reimplementation gets subtly
 * wrong, and `git` is already on every machine that has a checkout.
 */

const run = promisify(execFile);

/** Where worktrees live, inside the nest, beside GUIDES/ and PLANS/. */
export const WORKTREES_DIR = 'WORKTREES';
/** The book of tasks, one per agent, beside that agent's worktrees. */
const TASKS_FILE = 'tasks.json';
/** A fetch that takes longer than this is a network that is not there. */
const FETCH_TIMEOUT_MS = 60_000;
/** Enough for a title, short enough for a branch name people can type. */
const SLUG_MAX = 40;

export interface Task {
  slug: string;
  title: string;
  /** The checkout, as named under REPOS/: `api`, or `group/api`. */
  repo: string;
  /** The checkout's absolute path. */
  repoPath: string;
  branch: string;
  /** What the branch was cut from: `origin/main`, or a local ref with no origin. */
  base: string;
  /** The worktree's absolute path — the agent's working directory while active. */
  worktree: string;
  startedAt: number;
  endedAt?: number;
  /** How it ended, for the record: see `cleanupDecision`. */
  outcome?: Cleanup;
  /** The pull request for the branch, once one is seen. */
  pr?: { number: number; url: string; state: string };
}

export interface TaskBook {
  active: string | null;
  tasks: Record<string, Task>;
}

const EMPTY_BOOK: TaskBook = { active: null, tasks: {} };

export class TaskError extends Error {
  constructor(
    readonly code:
      | 'already_active'
      | 'no_task'
      | 'bad_repo'
      | 'not_a_checkout'
      | 'no_title'
      | 'fetch_failed'
      | 'git_failed',
    message: string,
  ) {
    super(message);
  }
}

// --- naming ---------------------------------------------------------------

/**
 * A title as a branch and directory name: lowercase, words joined by dashes,
 * nothing git or a shell would trip on. "Fix the login redirect!" →
 * `fix-the-login-redirect`. Empty when nothing usable is left.
 */
export function slugify(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
}

/** The agent's name as it appears in a branch: same rules, so `Marvin` → `marvin`. */
export function agentSlug(agent: string): string {
  return slugify(agent) || 'agent';
}

export function branchName(agent: string, slug: string): string {
  return `quintal/${agentSlug(agent)}/${slug}`;
}

export function worktreePath(nest: string, agent: string, slug: string): string {
  return join(nest, WORKTREES_DIR, agentSlug(agent), slug);
}

/**
 * `!task api: fix the login redirect` → the repo and the title. The colon
 * is the separator because a title can have spaces and a repo name cannot.
 * Without one, the first word is the repo and the rest is the title.
 */
export function parseTaskCommand(body: string): { repo: string; title: string } | null {
  const text = body.trim();
  if (text.length === 0) return null;
  const colon = /^([^\s:]+)\s*:\s*(.+)$/s.exec(text);
  if (colon) return { repo: colon[1]!, title: colon[2]!.trim() };
  const space = /^(\S+)\s+(.+)$/s.exec(text);
  if (space) return { repo: space[1]!, title: space[2]!.trim() };
  return null;
}

/**
 * A repo name the owner or the agent gave, checked against the repositories
 * directory. Only a checkout directly under it, or one level inside a folder
 * that groups checkouts — the same shapes `workspace_info` lists. Never a
 * path that climbs out, and never an absolute one: the agent is choosing
 * among the owner's checkouts, not naming a directory on the machine.
 */
export function resolveRepo(reposDir: string, repo: string): { name: string; path: string } {
  const wanted = repo.trim().replace(/\\/g, '/').replace(/^\.?\/+|\/+$/g, '');
  if (wanted.length === 0 || isAbsolute(repo) || wanted.split('/').includes('..')) {
    throw new TaskError('bad_repo', `"${repo}" is not the name of a checkout under REPOS/`);
  }
  if (wanted.split('/').length > 2) {
    throw new TaskError('bad_repo', `"${repo}" is too deep: name a checkout as \`api\` or \`group/api\``);
  }
  const path = resolve(reposDir, ...wanted.split('/'));
  const root = resolve(reposDir);
  if (path !== root && !path.startsWith(root + sep)) {
    throw new TaskError('bad_repo', `"${repo}" is not under REPOS/`);
  }
  if (!existsSync(join(path, '.git'))) {
    throw new TaskError(
      'not_a_checkout',
      existsSync(path)
        ? `REPOS/${wanted} is a directory but not a git checkout`
        : `there is no REPOS/${wanted} on this machine — workspace_info lists the checkouts that are`,
    );
  }
  return { name: wanted, path };
}

// --- the book --------------------------------------------------------------

export function bookPath(nest: string, agent: string): string {
  return join(nest, WORKTREES_DIR, agentSlug(agent), TASKS_FILE);
}

export function readBook(nest: string, agent: string): TaskBook {
  try {
    const parsed = JSON.parse(readFileSync(bookPath(nest, agent), 'utf8')) as Partial<TaskBook>;
    return {
      active: typeof parsed.active === 'string' ? parsed.active : null,
      tasks: parsed.tasks && typeof parsed.tasks === 'object' ? parsed.tasks : {},
    };
  } catch {
    return { ...EMPTY_BOOK, tasks: {} };
  }
}

/** Whole-file, via a rename, so a crash mid-write leaves the old book, not half a new one. */
export function writeBook(nest: string, agent: string, book: TaskBook): void {
  const path = bookPath(nest, agent);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(book, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

/** The task the agent is on, or null. A record whose worktree is gone is not active. */
export function activeTask(nest: string, agent: string): Task | null {
  const book = readBook(nest, agent);
  if (book.active === null) return null;
  const task = book.tasks[book.active];
  if (!task) return null;
  if (!existsSync(task.worktree)) {
    // Somebody removed the directory by hand. The book should not keep
    // rooting sessions in a place that is not there.
    writeBook(nest, agent, { ...book, active: null });
    return null;
  }
  return task;
}

// --- cleanup -----------------------------------------------------------------

export type Cleanup = 'removed' | 'kept-dirty' | 'kept-unpushed';

/**
 * The one rule that can delete work, on its own so it can be pinned.
 *
 * `dirty` is uncommitted changes (tracked or new files); `unpushed` is commits
 * on the branch that no remote has. Either keeps the worktree. Only a tree
 * that is clean *and* delivered is removed with its branch.
 */
export function cleanupDecision(state: { dirty: boolean; unpushed: number }): Cleanup {
  if (state.dirty) return 'kept-dirty';
  if (state.unpushed > 0) return 'kept-unpushed';
  return 'removed';
}

export function describeCleanup(task: Task, outcome: Cleanup, unpushed = 0): string {
  switch (outcome) {
    case 'removed':
      return `Finished ${task.branch}: the worktree was clean and everything on it is on the remote, so it is gone, branch and all (ignored files such as a local .env went with it).`;
    case 'kept-dirty':
      return `Finished ${task.branch}, but its worktree has uncommitted changes, so I kept it at ${task.worktree}. Commit or discard them there and the worktree can go.`;
    case 'kept-unpushed':
      return `Finished ${task.branch}, but it has ${unpushed === 1 ? 'a commit' : `${unpushed} commits`} no remote has, so I kept the worktree at ${task.worktree}. Push it, or open its pull request, and the worktree can go.`;
  }
}

// --- git -------------------------------------------------------------------

export interface Git {
  (args: string[], cwd: string, timeoutMs?: number): Promise<string>;
}

/** The real thing. Tests pass their own to script failures. */
export const git: Git = async (args, cwd, timeoutMs = 30_000) => {
  try {
    const { stdout } = await run('git', args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      // Never a prompt: a fetch that wants a password hangs the harness.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true' },
    });
    return stdout.trim();
  } catch (error: unknown) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    const message = stderr && stderr.length > 0 ? stderr : describe(error);
    throw new TaskError('git_failed', `git ${args[0]}: ${message}`);
  }
};

/**
 * The branch a task starts from.
 *
 * With an `origin`: its default branch, fetched first so the task begins
 * from what is actually merged, not from whatever was pulled last week. A
 * fetch that fails is refused rather than worked around — a branch cut from a
 * stale base is the drift this whole thing exists to prevent, and the owner
 * would rather hear "no network" now than at the pull request.
 *
 * Without one: the checkout's own HEAD. There is nothing fresher to have.
 */
export async function baseRef(repoPath: string, exec: Git = git): Promise<string> {
  const remotes = (await exec(['remote'], repoPath)).split('\n').filter(Boolean);
  if (!remotes.includes('origin')) {
    const head = await exec(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
    return head === 'HEAD' ? 'HEAD' : head;
  }

  try {
    await exec(['fetch', '--quiet', '--prune', 'origin'], repoPath, FETCH_TIMEOUT_MS);
  } catch (error: unknown) {
    throw new TaskError('fetch_failed', `could not fetch origin for a fresh base: ${describe(error)}`);
  }

  // `origin/HEAD` is where git records the remote's default branch. A
  // checkout cloned long ago, or made with `git init` + `remote add`, may not
  // have it; then the usual names, whichever the remote has.
  try {
    const head = await exec(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], repoPath);
    if (head.length > 0) return head;
  } catch {
    // Fall through to the guesses.
  }
  for (const candidate of ['origin/main', 'origin/master']) {
    try {
      await exec(['rev-parse', '--verify', '--quiet', `refs/remotes/${candidate}`], repoPath);
      return candidate;
    } catch {
      // Not this one.
    }
  }
  throw new TaskError(
    'git_failed',
    'origin has neither main nor master and no default branch is recorded; run `git remote set-head origin -a` in the checkout',
  );
}

// --- begin and end ---------------------------------------------------------

export interface BeginInput {
  nest: string;
  agent: string;
  reposDir: string;
  repo: string;
  title: string;
  exec?: Git;
  now?: () => number;
}

/**
 * Start a task: a fresh branch in its own worktree, rooted for the agent.
 *
 * One at a time. A session has one working directory, and an agent on two
 * branches at once is an agent that edits the wrong one.
 */
export async function beginTask(input: BeginInput): Promise<Task> {
  const exec = input.exec ?? git;
  const now = input.now ?? (() => Date.now());

  const title = input.title.trim();
  if (title.length === 0) throw new TaskError('no_title', 'a task needs a title: `!task api: fix the login redirect`');

  const current = activeTask(input.nest, input.agent);
  if (current) {
    throw new TaskError(
      'already_active',
      `already on a task: "${current.title}" (${current.branch}). Finish it with !done or task_end first.`,
    );
  }

  const repo = resolveRepo(input.reposDir, input.repo);
  const base = await baseRef(repo.path, exec);

  const book = readBook(input.nest, input.agent);
  const slug = freeSlug(slugify(title) || 'task', (candidate) =>
    candidate in book.tasks || existsSync(worktreePath(input.nest, input.agent, candidate)),
  );
  const branch = branchName(input.agent, slug);
  const worktree = worktreePath(input.nest, input.agent, slug);
  mkdirSync(dirname(worktree), { recursive: true });

  // `--no-track`: cut from a remote-tracking ref, git would otherwise make
  // `origin/main` the new branch's upstream — so `@{u}` would mean main, a
  // bare `git push` under `push.default=upstream` would push *to* main, and
  // "unpushed" would be counted against the wrong branch. The branch gets an
  // upstream when the agent pushes it with `-u`, and not before.
  await exec(['worktree', 'add', '--quiet', '--no-track', '-b', branch, worktree, base], repo.path);

  const task: Task = {
    slug,
    title,
    repo: repo.name,
    repoPath: repo.path,
    branch,
    base,
    worktree,
    startedAt: now(),
  };
  writeBook(input.nest, input.agent, {
    active: slug,
    tasks: { ...book.tasks, [slug]: task },
  });
  return task;
}

/** `fix-login`, else `fix-login-2`, `fix-login-3`… — the first the book does not know. */
function freeSlug(wanted: string, taken: (slug: string) => boolean): string {
  if (!taken(wanted)) return wanted;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${wanted}-${n}`;
    if (!taken(candidate)) return candidate;
  }
  throw new TaskError('git_failed', `could not find a free name for "${wanted}"`);
}

export interface EndInput {
  nest: string;
  agent: string;
  exec?: Git;
  now?: () => number;
  /**
   * The commit a merged pull request delivered, when ending because of one.
   * Commits up to it count as delivered even though a squash merge leaves
   * them absent from `origin/<base>` and the remote branch deleted.
   */
  deliveredHead?: string;
}

export interface Ended {
  task: Task;
  outcome: Cleanup;
  unpushed: number;
}

/**
 * End the active task, keeping the worktree if it holds anything the remote
 * does not. The book keeps the record either way.
 */
export async function endTask(input: EndInput): Promise<Ended> {
  const exec = input.exec ?? git;
  const now = input.now ?? (() => Date.now());

  const task = activeTask(input.nest, input.agent);
  if (!task) throw new TaskError('no_task', 'not on a task');

  const state = await worktreeState(task, exec, input.deliveredHead);
  const outcome = cleanupDecision(state);

  if (outcome === 'removed') {
    await exec(['worktree', 'remove', '--force', task.worktree], task.repoPath);
    // `-D`: the branch is delivered by the check above, and `-d` would refuse
    // one whose remote counterpart a squash merge left unreachable.
    try {
      await exec(['branch', '-D', task.branch], task.repoPath);
    } catch (error: unknown) {
      // The worktree is gone, which is what matters; a branch that would not
      // delete is a line in the log, not a failed task.
      console.error(`[quintal-acp] could not delete ${task.branch}: ${describe(error)}`);
    }
  }

  const ended: Task = { ...task, endedAt: now(), outcome };
  const book = readBook(input.nest, input.agent);
  writeBook(input.nest, input.agent, {
    active: null,
    tasks: { ...book.tasks, [task.slug]: ended },
  });
  return { task: ended, outcome, unpushed: state.unpushed };
}

/**
 * What the worktree holds that nowhere else does.
 *
 * Unpushed is counted against this branch on `origin` when the remote has
 * it (fetched first, so a push from elsewhere counts), else against the
 * branch's upstream if one was set, else against the base it was cut from —
 * a branch never pushed has every commit unpushed. With a delivered head,
 * commits reachable from it are delivered too: a squash merge rewrites them,
 * so neither remote branch nor base contains them, yet the work is on main.
 */
export async function worktreeState(
  task: Task,
  exec: Git = git,
  deliveredHead?: string,
): Promise<{ dirty: boolean; unpushed: number }> {
  const status = await exec(['status', '--porcelain', '--untracked-files=all'], task.worktree);
  const dirty = status.length > 0;

  // Best effort: offline, the last fetch's view of the remote is what there is.
  try {
    await exec(['fetch', '--quiet', '--prune', 'origin'], task.worktree, FETCH_TIMEOUT_MS);
  } catch {
    // Counted against what is known.
  }
  let against: string;
  try {
    await exec(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${task.branch}`], task.worktree);
    against = `refs/remotes/origin/${task.branch}`;
  } catch {
    try {
      against = await exec(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], task.worktree);
    } catch {
      against = task.base;
    }
  }
  const exclude = [`^${against}`];
  if (deliveredHead) exclude.push(`^${deliveredHead}`);
  let unpushed = 0;
  try {
    const list = await exec(['rev-list', 'HEAD', ...exclude], task.worktree);
    unpushed = list.length === 0 ? 0 : list.split('\n').length;
  } catch {
    // A base that no longer resolves (origin removed since): count everything
    // on the branch as unpushed, which keeps the worktree. Keeping is the
    // safe failure.
    const list = await exec(['rev-list', 'HEAD'], task.worktree);
    unpushed = list.length === 0 ? 0 : list.split('\n').length;
  }
  return { dirty, unpushed };
}

// --- the pull request ------------------------------------------------------

export interface PrView {
  number: number;
  url: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED' | string;
  headRefOid: string;
}

/**
 * The pull request for the task's branch, through `gh`, or null when there
 * is none or `gh` is not here. Run in the worktree, so `gh` works out the
 * repository and the branch itself. Best effort throughout: the poll that
 * calls this must never take the agent down.
 */
export async function pullRequestFor(task: Task): Promise<PrView | null> {
  try {
    const { stdout } = await run(
      'gh',
      ['pr', 'view', task.branch, '--json', 'number,url,state,headRefOid'],
      { cwd: task.worktree, timeout: 20_000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } },
    );
    const parsed = JSON.parse(stdout) as Partial<PrView>;
    if (typeof parsed.number !== 'number' || typeof parsed.url !== 'string') return null;
    return {
      number: parsed.number,
      url: parsed.url,
      state: String(parsed.state ?? ''),
      headRefOid: String(parsed.headRefOid ?? ''),
    };
  } catch {
    return null;
  }
}

/** Record what `gh` said about the branch's pull request. */
export function notePullRequest(nest: string, agent: string, slug: string, pr: PrView): Task | null {
  const book = readBook(nest, agent);
  const task = book.tasks[slug];
  if (!task) return null;
  const updated: Task = { ...task, pr: { number: pr.number, url: pr.url, state: pr.state } };
  writeBook(nest, agent, { ...book, tasks: { ...book.tasks, [slug]: updated } });
  return updated;
}

/** One line for a status or a card: `quintal/marvin/fix-login · PR #12`. */
export function describeTask(task: Task): string {
  return task.pr ? `${task.branch} · PR #${task.pr.number}` : task.branch;
}

/**
 * Worktrees of ended tasks that were kept because they held work nowhere
 * else, and are still there. Listed so they do not pile up unseen: the
 * owner can push or discard and remove them, and an agent asked about its
 * workspace can say they exist.
 */
export function keptWorktrees(nest: string, agent: string): { branch: string; worktree: string; outcome: Cleanup }[] {
  const book = readBook(nest, agent);
  return Object.values(book.tasks)
    .filter((task) => task.slug !== book.active && task.outcome !== undefined && task.outcome !== 'removed')
    .filter((task) => existsSync(task.worktree))
    .map((task) => ({ branch: task.branch, worktree: task.worktree, outcome: task.outcome! }));
}

/** The task's parts for `workspace_info` and `task_status`. */
export function taskReport(
  task: Task | null,
  kept: ReturnType<typeof keptWorktrees> = [],
): Record<string, unknown> {
  const leftovers =
    kept.length > 0
      ? {
          kept_worktrees: kept,
          kept_note:
            'Worktrees of finished tasks, kept because they had uncommitted changes or unpushed commits. ' +
            'Push or discard what is in them, then remove each with `git worktree remove <path>` in its repository.',
        }
      : {};
  if (!task) {
    return {
      active: false,
      note:
        'No task is active: you are in the shared workspace. Before editing files in a ' +
        'repository, begin a task with task_begin so your work has its own branch and worktree.',
      ...leftovers,
    };
  }
  return {
    ...leftovers,
    active: true,
    title: task.title,
    repo: task.repo,
    branch: task.branch,
    base: task.base,
    worktree: task.worktree,
    ...(task.pr ? { pull_request: task.pr } : {}),
    note:
      `Work in ${task.worktree} — it is a worktree of REPOS/${task.repo} on ${task.branch}, cut from ${task.base}. ` +
      'Commit there, push with `git push -u origin HEAD`, open the pull request with `gh pr create`, and call task_end when it is merged or abandoned.',
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
