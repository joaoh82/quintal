import type { AgentTaskPrState } from './agent-task.js';
import type { MembershipRole } from './workspace.js';

/**
 * GitHub, as the office reads and acts on it: the facts behind a ledger
 * line's pull request — checks, mergeability, the review — and the few
 * actions a member may take from the board. A fine-grained token an admin
 * puts in the office's settings; plain `fetch` against the REST API, on
 * the server only. The token never leaves it.
 *
 * Everything here that is not the client is pure, so what the panel shows
 * for a given answer from GitHub is pinned by tests and not by a browser.
 */

export const GITHUB_API_DEFAULT = 'https://api.github.com';
/** Where pull requests live, for the URLs a harness reports. An enterprise server says otherwise. */
export const GITHUB_WEB_HOST_DEFAULT = 'github.com';
export const GITHUB_API_VERSION = '2022-11-28';
export const GITHUB_TOKEN_MAX_LENGTH = 255;
/** How many repositories an office's list may name. */
export const GITHUB_REPOS_MAX = 50;

/**
 * A token as GitHub mints them: letters, digits and underscores, at least
 * twenty of them. Trimmed. Null for anything else, a pasted URL say.
 */
export function normaliseGithubToken(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const token = input.trim();
  if (token.length < 20 || token.length > GITHUB_TOKEN_MAX_LENGTH) return null;
  return /^[A-Za-z0-9_]+$/.test(token) ? token : null;
}

/** A pull request, by where it lives. */
export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
}

/**
 * `https://github.com/acme/office/pull/12` → acme, office, 12. Null for
 * anything that is not one: a malformed path, or any other host. A line
 * that points somewhere else is not a pull request on the office's GitHub,
 * whatever its path looks like.
 */
export function parsePullRequestUrl(url: string, host = GITHUB_WEB_HOST_DEFAULT): PullRequestRef | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const hostname = parsed.hostname.toLowerCase();
  const wanted = host.toLowerCase();
  if (hostname !== wanted && hostname !== `www.${wanted}`) return null;
  const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/.exec(parsed.pathname);
  if (!match) return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { owner: match[1]!, repo: match[2]!, number };
}

/** `acme/office`, as the office's list names a repository. */
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * The office's list of repositories, as typed: one per line, or separated
 * by spaces or commas, `owner/name` each, or a GitHub URL of the repository.
 * Lower-cased and deduplicated, because GitHub does not care about case.
 * Null when anything in it is not a repository name, or there are too many.
 */
export function normaliseGithubRepos(input: unknown): string[] | null {
  if (typeof input !== 'string') return null;
  const repos: string[] = [];
  for (const raw of input.split(/[\s,]+/)) {
    if (raw.length === 0) continue;
    let name = raw.replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\.git$/, '').replace(/\/+$/, '');
    name = name.toLowerCase();
    if (!REPO_NAME.test(name)) return null;
    if (!repos.includes(name)) repos.push(name);
  }
  return repos.length > GITHUB_REPOS_MAX ? null : repos;
}

/** Is this pull request in a repository the office's list names? The list is lower-case; the ref may not be. */
export function repoOnList(repos: readonly string[], ref: Pick<PullRequestRef, 'owner' | 'repo'>): boolean {
  return repos.includes(`${ref.owner}/${ref.repo}`.toLowerCase());
}

// --- every pull request of the office's repositories ---------------------------

/** How many open pull requests the office lists per repository: one page. */
export const REPO_PULLS_OPEN_MAX = 100;
/** How many closed or merged pull requests per repository, the most recently updated. */
export const REPO_PULLS_CLOSED_MAX = 20;

/**
 * A pull request of a repository on the office's list, as GitHub lists them:
 * whoever opened it, wherever it came from, an agent's or not. Lighter than
 * a ledger line's facts — no checks or reviews, which cost calls per pull
 * request — and joined to the ledger by repository and number.
 */
export interface RepoPullRequestRef {
  /** `owner/name`, lower-case, as the office's list names it. */
  repo: string;
  number: number;
  url: string;
  title: string;
  /** The GitHub login that opened it. */
  author: string;
  state: AgentTaskPrState;
  draft: boolean;
  headRef: string;
  baseRef: string;
  /** The head commit, for acting on what was looked at. */
  headSha: string;
  createdAt: number;
  updatedAt: number;
}

/** Every listed repository's pull requests, as last asked, and what went wrong asking. */
export interface RepoPullsRef {
  pulls: RepoPullRequestRef[];
  /** When the office last listed them; null for never. */
  fetchedAt: number | null;
  /** Repositories GitHub would not list, and why, fit to show a person. */
  errors: { repo: string; message: string }[];
}

export const NO_REPO_PULLS: RepoPullsRef = { pulls: [], fetchedAt: null, errors: [] };

/** A pull request as GitHub's list gives it. */
export interface RawListedPullRequest {
  number: number;
  state: string;
  draft?: boolean;
  title: string;
  html_url: string;
  user: { login: string } | null;
  merged_at: string | null;
  head: { sha: string; ref: string };
  base: { ref: string };
  created_at: string;
  updated_at: string;
}

/** One listed pull request, as the board carries it. */
export function repoPullOf(raw: RawListedPullRequest, repo: string): RepoPullRequestRef {
  return {
    repo: repo.toLowerCase(),
    number: raw.number,
    url: raw.html_url,
    title: raw.title,
    author: raw.user?.login ?? '',
    state: raw.merged_at ? 'merged' : raw.state === 'closed' ? 'closed' : 'open',
    draft: raw.draft === true,
    headRef: raw.head.ref,
    baseRef: raw.base.ref,
    headSha: raw.head.sha,
    createdAt: Date.parse(raw.created_at) || 0,
    updatedAt: Date.parse(raw.updated_at) || 0,
  };
}

// --- what GitHub says, summarised ------------------------------------------

export const PULL_REQUEST_CHECK_SUMMARIES = ['none', 'pending', 'passing', 'failing'] as const;
export type PullRequestCheckSummary = (typeof PULL_REQUEST_CHECK_SUMMARIES)[number];

/** One check run on the head commit, as the card lists them. */
export interface PullRequestCheck {
  name: string;
  /** `queued`, `in_progress`, `completed`. */
  status: string;
  /** `success`, `failure`, `neutral`, `cancelled`, `skipped`, `timed_out`, `action_required`; null until completed. */
  conclusion: string | null;
  url: string | null;
}

export interface PullRequestChecks {
  summary: PullRequestCheckSummary;
  total: number;
  passed: number;
  failed: number;
  pending: number;
  runs: PullRequestCheck[];
}

export const PULL_REQUEST_REVIEW_DECISIONS = ['approved', 'changes_requested', 'none'] as const;
export type PullRequestReviewDecision = (typeof PULL_REQUEST_REVIEW_DECISIONS)[number];

export const PULL_REQUEST_ACTIONS = ['merge', 'squash', 'rebase', 'update_branch', 'close'] as const;
export type PullRequestAction = (typeof PULL_REQUEST_ACTIONS)[number];

export function isPullRequestAction(value: unknown): value is PullRequestAction {
  return typeof value === 'string' && (PULL_REQUEST_ACTIONS as readonly string[]).includes(value);
}

/** The facts one look at GitHub gives. */
export interface PullRequestFacts {
  state: AgentTaskPrState;
  draft: boolean;
  title: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  /** Null while GitHub is still working it out. */
  mergeable: boolean | null;
  /** GitHub's word: `clean`, `dirty`, `blocked`, `behind`, `unstable`, `draft`, `has_hooks`, `unknown`. */
  mergeableState: string;
  checks: PullRequestChecks;
  reviewDecision: PullRequestReviewDecision;
}

/** The last thing somebody did to the pull request from the board. */
export interface PullRequestActionRef {
  action: PullRequestAction;
  byName: string;
  at: number;
}

/**
 * What the board carries for a ledger line's pull request: the facts as last
 * fetched, when, and whether the last fetch failed. Facts are kept from the
 * last good fetch when a later one fails, with `error` saying so.
 */
export interface PullRequestStatusRef extends PullRequestFacts {
  fetchedAt: number;
  error: string | null;
  lastAction: PullRequestActionRef | null;
  /** False when no fetch has ever succeeded: the facts above are blanks and only `error` means anything. */
  known: boolean;
}

const PASSED = new Set(['success', 'neutral', 'skipped']);

/** The check runs of a commit, as the card sums them up. */
export function summariseChecks(runs: readonly PullRequestCheck[]): PullRequestChecks {
  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const run of runs) {
    if (run.status !== 'completed') pending += 1;
    else if (run.conclusion !== null && PASSED.has(run.conclusion)) passed += 1;
    else failed += 1;
  }
  const summary: PullRequestCheckSummary =
    runs.length === 0 ? 'none' : failed > 0 ? 'failing' : pending > 0 ? 'pending' : 'passing';
  return { summary, total: runs.length, passed, failed, pending, runs: [...runs] };
}

/** A review as GitHub lists them. */
export interface PullRequestReview {
  reviewer: string;
  /** `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED`, `PENDING`. */
  state: string;
  submittedAt: number;
}

/**
 * Each reviewer's last word counts, comments aside. Anybody still asking for
 * changes outweighs anybody approving.
 */
export function reviewDecisionOf(reviews: readonly PullRequestReview[]): PullRequestReviewDecision {
  const latest = new Map<string, PullRequestReview>();
  for (const review of reviews) {
    const state = review.state.toUpperCase();
    if (state !== 'APPROVED' && state !== 'CHANGES_REQUESTED') continue;
    const seen = latest.get(review.reviewer);
    if (!seen || seen.submittedAt <= review.submittedAt) latest.set(review.reviewer, review);
  }
  const words = [...latest.values()].map((review) => review.state.toUpperCase());
  if (words.includes('CHANGES_REQUESTED')) return 'changes_requested';
  if (words.includes('APPROVED')) return 'approved';
  return 'none';
}

/**
 * Who puts the office's token in, or takes it out: an owner or admin. The
 * token acts for the office on GitHub, so it is the office's to hold, not
 * any member's. Every member may then act with it from the board; GitHub's
 * own permissions on the token decide what each action may do.
 */
export function mayManageGithubToken(role: MembershipRole | 'guest' | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

/** Whether the board offers a merge button for these facts. GitHub still has the last word. */
export function mayMergeFromFacts(facts: Pick<PullRequestFacts, 'state' | 'draft' | 'mergeable'>): boolean {
  return facts.state === 'open' && !facts.draft && facts.mergeable !== false;
}

// --- the client --------------------------------------------------------------

export const GITHUB_ERROR_CODES = [
  'unauthorised',
  'forbidden',
  'not_found',
  'conflict',
  'unprocessable',
  'rate_limited',
  'unavailable',
] as const;
export type GithubErrorCode = (typeof GITHUB_ERROR_CODES)[number];

/** GitHub said no, or could not be reached. `message` is fit to show a person. */
export class GithubError extends Error {
  readonly code: GithubErrorCode;
  readonly status: number;
  constructor(code: GithubErrorCode, status: number, message: string) {
    super(message);
    this.name = 'GithubError';
    this.code = code;
    this.status = status;
  }
}

export type GithubFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface GithubClientOptions {
  /** Where the API is. The default is github.com's; a test, or an enterprise server, says otherwise. */
  apiBase?: string;
  fetch?: GithubFetch;
  userAgent?: string;
}

interface RawPullRequest {
  number: number;
  state: string;
  merged: boolean;
  draft?: boolean;
  title: string;
  mergeable: boolean | null;
  mergeable_state?: string;
  head: { sha: string; ref: string };
  base: { ref: string };
}

interface RawCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string | null;
}

interface RawReview {
  user: { login: string } | null;
  state: string;
  submitted_at?: string | null;
}

function codeFor(status: number, body: { message?: string } | null): GithubErrorCode {
  if (status === 401) return 'unauthorised';
  if (status === 403 || status === 429) {
    return /rate limit/i.test(body?.message ?? '') || status === 429 ? 'rate_limited' : 'forbidden';
  }
  if (status === 404) return 'not_found';
  if (status === 405 || status === 409) return 'conflict';
  if (status === 422) return 'unprocessable';
  return 'unavailable';
}

function describe(code: GithubErrorCode, status: number, body: { message?: string } | null): string {
  const said = body?.message?.trim();
  switch (code) {
    case 'unauthorised':
      return 'GitHub does not accept this office’s token. Set a new one in Settings → Office.';
    case 'forbidden':
      return said ? `GitHub refused: ${said}` : 'GitHub refused: the office’s token may not do that here.';
    case 'not_found':
      return 'GitHub has no such pull request for this token: wrong repository, or no access to it.';
    case 'rate_limited':
      return 'GitHub’s rate limit is spent for now. Try again in a few minutes.';
    case 'conflict':
    case 'unprocessable':
      return said ? `GitHub refused: ${said}` : 'GitHub refused the change.';
    default:
      return said ? `GitHub answered ${status}: ${said}` : `GitHub answered ${status}.`;
  }
}

/** Fine-grained or classic, the same calls. One instance per token. */
export class GithubClient {
  readonly #token: string;
  readonly #apiBase: string;
  readonly #fetch: GithubFetch;
  readonly #userAgent: string;

  constructor(token: string, options: GithubClientOptions = {}) {
    this.#token = token;
    this.#apiBase = (options.apiBase ?? GITHUB_API_DEFAULT).replace(/\/$/, '');
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#userAgent = options.userAgent ?? 'quintal-office';
  }

  async #call<T>(method: string, path: string, body?: unknown, accept?: string): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#apiBase}${path}`, {
        method,
        headers: {
          Accept: accept ?? 'application/vnd.github+json',
          Authorization: `Bearer ${this.#token}`,
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
          'User-Agent': this.#userAgent,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error: unknown) {
      throw new GithubError('unavailable', 0, `GitHub could not be reached: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status === 204 || response.status === 202) return undefined as T;
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const said = parsed && typeof parsed === 'object' ? (parsed as { message?: string }) : null;
      const code = codeFor(response.status, said);
      throw new GithubError(code, response.status, describe(code, response.status, said));
    }
    return parsed as T;
  }

  /** Whose token this is. The check a token gets when it is saved. */
  async viewer(): Promise<{ login: string }> {
    const user = await this.#call<{ login: string }>('GET', '/user');
    return { login: user.login };
  }

  async pullRequest(ref: PullRequestRef): Promise<RawPullRequest> {
    return this.#call<RawPullRequest>('GET', `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`);
  }

  async checkRuns(ref: PullRequestRef, sha: string): Promise<PullRequestCheck[]> {
    const page = await this.#call<{ check_runs: RawCheckRun[] }>(
      'GET',
      `/repos/${ref.owner}/${ref.repo}/commits/${sha}/check-runs?per_page=100`,
    );
    return (page.check_runs ?? []).map((run) => ({
      name: run.name,
      status: run.status,
      conclusion: run.conclusion ?? null,
      url: run.html_url ?? null,
    }));
  }

  async reviews(ref: PullRequestRef): Promise<PullRequestReview[]> {
    const rows = await this.#call<RawReview[]>('GET', `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews?per_page=100`);
    return (rows ?? [])
      .filter((row) => row.user?.login)
      .map((row) => ({
        reviewer: row.user!.login,
        state: row.state,
        submittedAt: row.submitted_at ? Date.parse(row.submitted_at) : 0,
      }));
  }

  /** Everything the card shows, in three calls. */
  async facts(ref: PullRequestRef): Promise<PullRequestFacts> {
    const pr = await this.pullRequest(ref);
    const [checks, reviews] = await Promise.all([this.checkRuns(ref, pr.head.sha), this.reviews(ref)]);
    return {
      state: pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
      draft: pr.draft === true,
      title: pr.title,
      headSha: pr.head.sha,
      headRef: pr.head.ref,
      baseRef: pr.base.ref,
      mergeable: pr.mergeable ?? null,
      mergeableState: pr.mergeable_state ?? 'unknown',
      checks: summariseChecks(checks),
      reviewDecision: reviewDecisionOf(reviews),
    };
  }

  /**
   * A repository's pull requests, most recently updated first: the open
   * ones, or the closed and merged. One page, `perPage` long.
   */
  async listPullRequests(
    repo: Pick<PullRequestRef, 'owner' | 'repo'>,
    state: 'open' | 'closed',
    perPage: number,
  ): Promise<RepoPullRequestRef[]> {
    const rows = await this.#call<RawListedPullRequest[]>(
      'GET',
      `/repos/${repo.owner}/${repo.repo}/pulls?state=${state}&sort=updated&direction=desc&per_page=${perPage}`,
    );
    return (rows ?? []).map((row) => repoPullOf(row, `${repo.owner}/${repo.repo}`));
  }

  /** Merge, by method. `sha` makes GitHub refuse if the head moved since the person looked. */
  async merge(ref: PullRequestRef, method: 'merge' | 'squash' | 'rebase', sha?: string): Promise<{ sha: string }> {
    const result = await this.#call<{ sha: string; merged: boolean; message?: string }>(
      'PUT',
      `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/merge`,
      { merge_method: method, ...(sha ? { sha } : {}) },
    );
    if (!result?.merged) {
      throw new GithubError('conflict', 405, result?.message ? `GitHub refused: ${result.message}` : 'GitHub did not merge it.');
    }
    return { sha: result.sha };
  }

  async close(ref: PullRequestRef): Promise<void> {
    await this.#call('PATCH', `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`, { state: 'closed' });
  }

  /** Bring the branch up to date with its base. GitHub does it in the background and answers 202. */
  async updateBranch(ref: PullRequestRef, expectedHeadSha?: string): Promise<void> {
    await this.#call(
      'PUT',
      `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/update-branch`,
      expectedHeadSha ? { expected_head_sha: expectedHeadSha } : {},
    );
  }
}
