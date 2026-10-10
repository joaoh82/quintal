import { activityText } from './activity.js';

/**
 * What an agent is on: the task its harness began, the branch it cut, and the
 * pull request once one exists. Sent as `agent:task`; `null` says "nothing".
 *
 * Not the status line. That line is the activity signal — a non-empty one keeps
 * a balloon up and stops the office's idle life — and an agent can be on one
 * task for days while idle in between, so the task has a message of its own
 * and lives on the agent's card. See `docs/GATEWAY.md`.
 */
export interface AgentTask {
  /** What the task is, as whoever began it wrote it. */
  title: string;
  /** The checkout under the machine's `REPOS/`: `api`, or `group/api`. */
  repo: string;
  /** The task's branch: `quintal/marvin/fix-the-login-redirect`. */
  branch: string;
  /** The branch's pull request, once the harness has seen one. */
  pr?: AgentTaskPullRequest;
}

export interface AgentTaskPullRequest {
  number: number;
  url: string;
  state: AgentTaskPrState;
}

export const AGENT_TASK_PR_STATES = ['open', 'merged', 'closed'] as const;
export type AgentTaskPrState = (typeof AGENT_TASK_PR_STATES)[number];

/** Long titles are clipped, not refused: a title is prose, and most of one is better than none. */
export const AGENT_TASK_TITLE_MAX = 200;
/** Repos and branches are refused past this: a clipped name is the name of something else. */
export const AGENT_TASK_NAME_MAX = 200;
export const AGENT_TASK_URL_MAX = 500;

const name = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= AGENT_TASK_NAME_MAX && /^[\w.@+/-]+$/.test(v);

/**
 * A pull request state in any case — `gh` says `OPEN` — as the wire says it,
 * or null for anything else.
 */
export function agentTaskPrState(value: unknown): AgentTaskPrState | null {
  if (typeof value !== 'string') return null;
  const lower = value.toLowerCase();
  return (AGENT_TASK_PR_STATES as readonly string[]).includes(lower)
    ? (lower as AgentTaskPrState)
    : null;
}

/**
 * A link the office will draw for everybody, so only `http:` and `https:`.
 * A harness is only as trusted as the key it holds, and a `javascript:` URL
 * on a card is a script in every viewer's tab.
 */
export function agentTaskUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > AGENT_TASK_URL_MAX) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function pullRequest(value: unknown): AgentTaskPullRequest | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const url = agentTaskUrl(v.url);
  const state = agentTaskPrState(v.state);
  if (typeof v.number !== 'number' || !Number.isSafeInteger(v.number) || v.number <= 0) return null;
  if (!url || !state) return null;
  return { number: v.number, url, state };
}

/**
 * Rebuild an `agent:task` payload at the trust boundary.
 *
 * Returns the task, `null` for an explicit "no task", or `undefined` for
 * anything that is neither — which the office refuses rather than reading as
 * a clear, so a malformed message can never wipe a card by accident. Never
 * spreads what came in.
 */
export function parseAgentTask(value: unknown): AgentTask | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const title = activityText(v.title, AGENT_TASK_TITLE_MAX).replace(/\s+/g, ' ').trim();
  if (title.length === 0 || !name(v.repo) || !name(v.branch)) return undefined;
  let pr: AgentTaskPullRequest | null = null;
  if (v.pr !== undefined && v.pr !== null) {
    pr = pullRequest(v.pr);
    if (!pr) return undefined;
  }
  return { title, repo: v.repo, branch: v.branch, ...(pr ? { pr } : {}) };
}

/**
 * The task fields as `OfficePlayer` carries them: flat, because the schema
 * carries no nulls. An empty `taskBranch` is no task; a `taskPrNumber` of 0 is
 * no pull request.
 */
export interface AgentTaskFields {
  taskTitle: string;
  taskRepo: string;
  taskBranch: string;
  taskPrNumber: number;
  taskPrUrl: string;
  taskPrState: string;
}

/** Read an agent's task back out of room state, or null when it is on none. */
export function agentTaskOf(fields: AgentTaskFields): AgentTask | null {
  if (fields.taskBranch.length === 0) return null;
  const state = agentTaskPrState(fields.taskPrState);
  const url = agentTaskUrl(fields.taskPrUrl);
  return {
    title: fields.taskTitle,
    repo: fields.taskRepo,
    branch: fields.taskBranch,
    ...(fields.taskPrNumber > 0 && state && url
      ? { pr: { number: fields.taskPrNumber, url, state } }
      : {}),
  };
}

/** The same task as room state writes it; `null` is every field blank. */
export function agentTaskFields(task: AgentTask | null): AgentTaskFields {
  return {
    taskTitle: task?.title ?? '',
    taskRepo: task?.repo ?? '',
    taskBranch: task?.branch ?? '',
    taskPrNumber: task?.pr?.number ?? 0,
    taskPrUrl: task?.pr?.url ?? '',
    taskPrState: task?.pr?.state ?? '',
  };
}
