import {
  GITHUB_WEB_HOST_DEFAULT,
  REPO_PULLS_CLOSED_MAX,
  REPO_PULLS_OPEN_MAX,
  GithubClient,
  GithubError,
  parsePullRequestUrl,
  repoOnList,
  type BoardTaskRef,
  type GithubFetch,
  type PullRequestAction,
  type PullRequestFacts,
  type PullRequestRef,
  type PullRequestStatusRef,
  type RepoPullRequestRef,
  type RepoPullsRef,
} from '@quintal/shared';
import {
  getOfficeGithub,
  noteOfficeGithubCheck,
  recordBoardEvent,
  savePullRequestStatus,
  setAgentTaskPullRequestState,
  type Database,
} from '@quintal/shared/db';

/**
 * The office's eye on GitHub: what it asks about the ledger's pull requests,
 * how often, and what it does for a member who presses a button on the
 * board. One per room. The token is read from the row each time, so one
 * replaced or taken out in Settings is felt on the next look.
 *
 * Budget: a token has 5000 calls an hour, and a look at one pull request is
 * three. The poll looks at most `PULL_WATCH_MAX` lines every `PULL_POLL_MS`
 * while a person is in the room, which spends under half of that with
 * nothing to spare for anybody else, so a busy office still has headroom.
 * Listing every pull request of the office's repositories is two calls a
 * repository every `REPO_PULLS_POLL_MS`, 1200 an hour at the most
 * repositories a list may name. A person asking again lists at most every
 * `REPO_PULLS_REFRESH_MIN_MS`, so however often anybody clicks, listing
 * spends at most 2000 an hour and the ledger's checks keep theirs.
 */

/** How often the office asks, while somebody is here to see the answer. */
export const PULL_POLL_MS = 60_000;
/** How many pull requests one tick looks at: the newest that are still open or being worked on. */
export const PULL_WATCH_MAX = 12;
/** How soon after one look a person may ask for another. */
export const PULL_REFRESH_MIN_MS = 10_000;
/** How often the office lists its repositories' pull requests, while somebody is here. */
export const REPO_PULLS_POLL_MS = 5 * 60_000;
/** How soon after one listing a person's Check GitHub lists again. Sooner, it checks only the ledger. */
export const REPO_PULLS_REFRESH_MIN_MS = 3 * 60_000;
/** How many looks at once. */
const CONCURRENCY = 3;

/**
 * Which ledger lines are worth asking about: those with a pull request on
 * the office's GitHub, in a repository on the office's list, still open as
 * far as anybody knows, or still worked on. Newest first, capped. A merged
 * or closed one is asked about once more only if its line is active: the
 * harness has not caught up, and the office's word moves the note.
 *
 * The list is the rule that matters. A line's URL is whatever an agent's
 * harness said, and any member owns a harness; the token reaches whatever
 * its owner gave it. Only the repositories an owner or admin named are
 * looked at or touched with it, so a URL to anywhere else is shown as
 * reported and nothing more.
 */
export function tasksToWatch(
  tasks: readonly BoardTaskRef[],
  statuses: ReadonlyMap<string, PullRequestStatusRef>,
  repos: readonly string[],
  max = PULL_WATCH_MAX,
  host = GITHUB_WEB_HOST_DEFAULT,
  /** The repositories' listing: newer than a line's last check, its word on open wins — a reopened one is watched again. */
  listed: readonly RepoPullRequestRef[] = [],
): BoardTaskRef[] {
  return tasks
    .filter((task) => {
      const pr = task.pr;
      const ref = pr ? parsePullRequestUrl(pr.url, host) : null;
      if (!pr || !ref || !repoOnList(repos, ref)) return false;
      const known = statuses.get(task.id);
      const repo = `${ref.owner}/${ref.repo}`.toLowerCase();
      const seen = listed.find((pull) => pull.repo === repo && pull.number === ref.number);
      const open =
        seen && (!known?.known || seen.updatedAt > known.fetchedAt)
          ? seen.state === 'open'
          : known?.known
            ? known.state === 'open'
            : pr.state === 'open';
      return open || task.status === 'active';
    })
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, max);
}

/** What one look found that changes the board. */
export interface PullStateChange {
  task: BoardTaskRef;
  state: PullRequestFacts['state'];
  /** This look is the one that found it merged. */
  merged: boolean;
}

export interface PullRefreshOutcome {
  /** False when the office has no token: nothing was asked. */
  configured: boolean;
  /** How many pull requests were asked about. */
  looked: number;
  /** Lines whose pull request state GitHub says differs from the ledger's. */
  changes: PullStateChange[];
  /** The token was refused: nothing more will work until it is replaced. */
  tokenRefused: string | null;
}

export interface RepoListOutcome {
  /** False when the office has no token: nothing was asked, and there is nothing to list. */
  configured: boolean;
  pulls: RepoPullsRef;
  /** The token was refused: nothing more will work until it is replaced. */
  tokenRefused: string | null;
}

export class PullActionError extends Error {
  readonly code: 'not_configured' | 'invalid_payload' | 'unauthorised' | 'github';
  constructor(code: PullActionError['code'], message: string) {
    super(message);
    this.name = 'PullActionError';
    this.code = code;
  }
}

export interface PullRequestWatchOptions {
  db: Database;
  workspaceId: string;
  apiBase: string;
  /** The host pull request URLs are on: github.com, or the enterprise server `apiBase` belongs to. */
  webHost?: string;
  fetch?: GithubFetch;
  now?: () => number;
}

export class PullRequestWatch {
  readonly #db: Database;
  readonly #workspaceId: string;
  readonly #apiBase: string;
  readonly #webHost: string;
  readonly #fetch: GithubFetch | undefined;
  readonly #now: () => number;
  #lastLookAt = 0;
  #looking: Promise<PullRefreshOutcome> | null = null;
  #lastListAt = 0;
  #listing: Promise<RepoListOutcome> | null = null;

  constructor(options: PullRequestWatchOptions) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
    this.#apiBase = options.apiBase;
    this.#webHost = options.webHost ?? GITHUB_WEB_HOST_DEFAULT;
    this.#fetch = options.fetch;
    this.#now = options.now ?? (() => Date.now());
  }

  async #office(): Promise<{ client: GithubClient; repos: string[] } | null> {
    const row = await getOfficeGithub(this.#db, this.#workspaceId);
    if (!row) return null;
    return {
      client: new GithubClient(row.token, { apiBase: this.#apiBase, ...(this.#fetch ? { fetch: this.#fetch } : {}) }),
      repos: row.repos,
    };
  }

  /** The pull request a line names, if it is on the office's GitHub. Null otherwise. */
  #refOf(task: BoardTaskRef): PullRequestRef | null {
    return task.pr ? parsePullRequestUrl(task.pr.url, this.#webHost) : null;
  }

  /** How long until a person may ask again, in ms. Zero now. */
  refreshWaitMs(): number {
    return Math.max(0, this.#lastLookAt + PULL_REFRESH_MIN_MS - this.#now());
  }

  /**
   * Look at the pull requests that matter among these lines, or at one. Two
   * looks asked for at once are one look. Every answer is written down as
   * it comes, good or bad; a refused token stops the look and is written on
   * the token's row for the settings page to show.
   */
  refresh(
    tasks: readonly BoardTaskRef[],
    statuses: ReadonlyMap<string, PullRequestStatusRef>,
    options: { taskId?: string; listed?: readonly RepoPullRequestRef[] } = {},
  ): Promise<PullRefreshOutcome> {
    if (this.#looking) return this.#looking;
    this.#looking = this.#look(tasks, statuses, options).finally(() => {
      this.#looking = null;
    });
    return this.#looking;
  }

  async #look(
    tasks: readonly BoardTaskRef[],
    statuses: ReadonlyMap<string, PullRequestStatusRef>,
    options: { taskId?: string; listed?: readonly RepoPullRequestRef[] },
  ): Promise<PullRefreshOutcome> {
    const office = await this.#office();
    if (!office) return { configured: false, looked: 0, changes: [], tokenRefused: null };
    const { client, repos } = office;
    this.#lastLookAt = this.#now();
    // One line asked for is still only looked at if its repository is listed.
    const targets = options.taskId
      ? tasks.filter((task) => {
          if (task.id !== options.taskId) return false;
          const ref = this.#refOf(task);
          return ref !== null && repoOnList(repos, ref);
        })
      : tasksToWatch(tasks, statuses, repos, PULL_WATCH_MAX, this.#webHost, options.listed);
    const changes: PullStateChange[] = [];
    let tokenRefused: string | null = null;
    let looked = 0;

    const queue = [...targets];
    const worker = async (): Promise<void> => {
      for (let task = queue.shift(); task && tokenRefused === null; task = queue.shift()) {
        const ref = this.#refOf(task)!;
        looked += 1;
        try {
          const facts = await client.facts(ref);
          await savePullRequestStatus(this.#db, { workspaceId: this.#workspaceId, taskId: task.id, facts, now: this.#now() });
          const moved = await setAgentTaskPullRequestState(this.#db, task.id, facts.state);
          if (moved.changed) {
            await recordBoardEvent(this.#db, {
              workspaceId: this.#workspaceId,
              kind: 'pr.state',
              actor: { kind: 'office', id: null, name: 'office' },
              taskId: task.id,
              itemId: task.item?.id ?? null,
              payload: { number: ref.number, url: task.pr!.url, from: task.pr!.state, to: facts.state },
              now: this.#now(),
            });
            changes.push({ task, state: facts.state, merged: moved.merged });
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          await savePullRequestStatus(this.#db, { workspaceId: this.#workspaceId, taskId: task.id, error: message, now: this.#now() });
          if (error instanceof GithubError && error.code === 'unauthorised') tokenRefused = message;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    // Nothing looked at is nothing learnt about the token: a refusal the listing
    // just wrote down stays written down.
    if (looked > 0) await noteOfficeGithubCheck(this.#db, this.#workspaceId, tokenRefused, this.#now());
    return { configured: true, looked, changes, tokenRefused };
  }

  /** Whether the repositories are due to be listed again: by the poll, or sooner for a person who asked. */
  listDue(minMs = REPO_PULLS_POLL_MS): boolean {
    return this.#now() - this.#lastListAt >= minMs;
  }

  /**
   * List every pull request of the repositories on the office's list: the
   * open ones and the most recently closed or merged. Two lists asked for
   * at once are one. A repository GitHub will not list keeps what it last
   * listed, with the reason beside it; a refused token stops the listing
   * and is written on the token's row.
   */
  listRepos(previous: RepoPullsRef): Promise<RepoListOutcome> {
    if (this.#listing) return this.#listing;
    this.#listing = this.#list(previous).finally(() => {
      this.#listing = null;
    });
    return this.#listing;
  }

  async #list(previous: RepoPullsRef): Promise<RepoListOutcome> {
    const office = await this.#office();
    if (!office) return { configured: false, pulls: { pulls: [], fetchedAt: null, errors: [] }, tokenRefused: null };
    const { client, repos } = office;
    this.#lastListAt = this.#now();
    const byRepo = new Map<string, RepoPullRequestRef[]>();
    const errors: RepoPullsRef['errors'] = [];
    let tokenRefused: string | null = null;

    const queue = [...repos];
    const worker = async (): Promise<void> => {
      for (let repo = queue.shift(); repo && tokenRefused === null; repo = queue.shift()) {
        const [owner, name] = repo.split('/') as [string, string];
        try {
          const [open, closed] = await Promise.all([
            client.listPullRequests({ owner, repo: name }, 'open', REPO_PULLS_OPEN_MAX),
            client.listPullRequests({ owner, repo: name }, 'closed', REPO_PULLS_CLOSED_MAX),
          ]);
          byRepo.set(repo, [...open, ...closed]);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          errors.push({ repo, message });
          byRepo.set(repo, previous.pulls.filter((pull) => pull.repo === repo));
          if (error instanceof GithubError && error.code === 'unauthorised') tokenRefused = message;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    // In the list's order, then newest first, so the same answer is the same board.
    const pulls = repos
      .flatMap((repo) => byRepo.get(repo) ?? previous.pulls.filter((pull) => pull.repo === repo))
      .sort((a, b) => b.updatedAt - a.updatedAt || a.repo.localeCompare(b.repo) || b.number - a.number);
    await noteOfficeGithubCheck(this.#db, this.#workspaceId, tokenRefused, this.#now());
    return { configured: true, pulls: { pulls, fetchedAt: this.#now(), errors }, tokenRefused };
  }

  /**
   * Do what a member asked to a pull request, with the office's token, and
   * write down who asked. Refused before GitHub is called when the office
   * has no token, the repository is not on the office's list, or a merge or
   * update names no head: a merge is of the head the person looked at,
   * which is the one on the board, so GitHub refuses it if the branch moved
   * since. GitHub's own refusals come back as `PullActionError` with its
   * reason; the caller looks at the pull request again after.
   */
  async act(
    task: BoardTaskRef,
    action: PullRequestAction,
    by: { userId: string; name: string },
    expectedHeadSha?: string,
  ): Promise<{ said: string; ref: PullRequestRef }> {
    const ref = this.#refOf(task);
    if (!ref) throw new PullActionError('invalid_payload', 'That line has no pull request on the office’s GitHub.');
    const office = await this.#office();
    if (!office) {
      throw new PullActionError('not_configured', 'This office has no GitHub token. An owner or admin puts one in Settings → Office → GitHub.');
    }
    if (!repoOnList(office.repos, ref)) {
      throw new PullActionError(
        'unauthorised',
        `${ref.owner}/${ref.repo} is not on this office’s GitHub list. An owner or admin adds it in Settings → Office → GitHub.`,
      );
    }
    // The head on the board is the one the person saw. Without one — a line
    // GitHub has not been asked about, a client that sent none — nobody
    // merges or moves anything.
    const pinnedTo = expectedHeadSha ?? (task.github?.known ? task.github.headSha : undefined);
    if (action !== 'close' && !pinnedTo) {
      throw new PullActionError('invalid_payload', `Check #${ref.number} with GitHub first, then act on what it shows.`);
    }
    const { client } = office;
    let said: string;
    try {
      switch (action) {
        case 'merge':
        case 'squash':
        case 'rebase': {
          await client.merge(ref, action, pinnedTo);
          said = `Merged #${ref.number}${action === 'merge' ? '' : ` (${action})`}.`;
          break;
        }
        case 'update_branch':
          await client.updateBranch(ref, pinnedTo);
          said = `Asked GitHub to bring #${ref.number} up to date with ${task.github?.baseRef || 'its base'}. It takes a moment.`;
          break;
        case 'close':
          await client.close(ref);
          said = `Closed #${ref.number} without merging.`;
          break;
      }
    } catch (error: unknown) {
      if (error instanceof GithubError) throw new PullActionError('github', error.message);
      throw error;
    }
    await recordBoardEvent(this.#db, {
      workspaceId: this.#workspaceId,
      kind: `pr.${action}`,
      actor: { kind: 'user', id: by.userId, name: by.name },
      taskId: task.id,
      itemId: task.item?.id ?? null,
      payload: { number: ref.number, url: task.pr!.url, ...(pinnedTo ? { expectedHeadSha: pinnedTo } : {}) },
      now: this.#now(),
    });
    return { said, ref };
  }
}
