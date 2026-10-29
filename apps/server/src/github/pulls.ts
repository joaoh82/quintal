import {
  GithubClient,
  GithubError,
  parsePullRequestUrl,
  type BoardTaskRef,
  type GithubFetch,
  type PullRequestAction,
  type PullRequestFacts,
  type PullRequestRef,
  type PullRequestStatusRef,
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
 */

/** How often the office asks, while somebody is here to see the answer. */
export const PULL_POLL_MS = 60_000;
/** How many pull requests one tick looks at: the newest that are still open or being worked on. */
export const PULL_WATCH_MAX = 12;
/** How soon after one look a person may ask for another. */
export const PULL_REFRESH_MIN_MS = 10_000;
/** How many looks at once. */
const CONCURRENCY = 3;

/**
 * Which ledger lines are worth asking about: those with a pull request, still
 * open as far as anybody knows, or still worked on. Newest first, capped. A
 * merged or closed one is asked about once more only if its line is active:
 * the harness has not caught up, and the office's word moves the note.
 */
export function tasksToWatch(
  tasks: readonly BoardTaskRef[],
  statuses: ReadonlyMap<string, PullRequestStatusRef>,
  max = PULL_WATCH_MAX,
): BoardTaskRef[] {
  return tasks
    .filter((task) => {
      if (!task.pr || !parsePullRequestUrl(task.pr.url)) return false;
      const known = statuses.get(task.id);
      const open = known?.known ? known.state === 'open' : task.pr.state === 'open';
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

export class PullActionError extends Error {
  readonly code: 'not_configured' | 'invalid_payload' | 'github';
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
  fetch?: GithubFetch;
  now?: () => number;
}

export class PullRequestWatch {
  readonly #db: Database;
  readonly #workspaceId: string;
  readonly #apiBase: string;
  readonly #fetch: GithubFetch | undefined;
  readonly #now: () => number;
  #lastLookAt = 0;
  #looking: Promise<PullRefreshOutcome> | null = null;

  constructor(options: PullRequestWatchOptions) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
    this.#apiBase = options.apiBase;
    this.#fetch = options.fetch;
    this.#now = options.now ?? (() => Date.now());
  }

  async #client(): Promise<GithubClient | null> {
    const row = await getOfficeGithub(this.#db, this.#workspaceId);
    if (!row) return null;
    return new GithubClient(row.token, { apiBase: this.#apiBase, ...(this.#fetch ? { fetch: this.#fetch } : {}) });
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
    options: { taskId?: string } = {},
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
    options: { taskId?: string },
  ): Promise<PullRefreshOutcome> {
    const client = await this.#client();
    if (!client) return { configured: false, looked: 0, changes: [], tokenRefused: null };
    this.#lastLookAt = this.#now();
    const targets = options.taskId
      ? tasks.filter((task) => task.id === options.taskId && task.pr && parsePullRequestUrl(task.pr.url))
      : tasksToWatch(tasks, statuses);
    const changes: PullStateChange[] = [];
    let tokenRefused: string | null = null;
    let looked = 0;

    const queue = [...targets];
    const worker = async (): Promise<void> => {
      for (let task = queue.shift(); task && tokenRefused === null; task = queue.shift()) {
        const ref = parsePullRequestUrl(task.pr!.url)!;
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
    await noteOfficeGithubCheck(this.#db, this.#workspaceId, tokenRefused, this.#now());
    return { configured: true, looked, changes, tokenRefused };
  }

  /**
   * Do what a member asked to a pull request, with the office's token, and
   * write down who asked. GitHub's refusals come back as `PullActionError`
   * with GitHub's reason; the caller looks at the pull request again after.
   */
  async act(
    task: BoardTaskRef,
    action: PullRequestAction,
    by: { userId: string; name: string },
    expectedHeadSha?: string,
  ): Promise<{ said: string; ref: PullRequestRef }> {
    const ref = task.pr ? parsePullRequestUrl(task.pr.url) : null;
    if (!ref) throw new PullActionError('invalid_payload', 'That line has no pull request on GitHub.');
    const client = await this.#client();
    if (!client) {
      throw new PullActionError('not_configured', 'This office has no GitHub token. An owner or admin puts one in Settings → Office → GitHub.');
    }
    let said: string;
    try {
      switch (action) {
        case 'merge':
        case 'squash':
        case 'rebase': {
          await client.merge(ref, action, expectedHeadSha);
          said = `Merged #${ref.number}${action === 'merge' ? '' : ` (${action})`}.`;
          break;
        }
        case 'update_branch':
          await client.updateBranch(ref, expectedHeadSha);
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
      payload: { number: ref.number, url: task.pr!.url, ...(expectedHeadSha ? { expectedHeadSha } : {}) },
      now: this.#now(),
    });
    return { said, ref };
  }
}
