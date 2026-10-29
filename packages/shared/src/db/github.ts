import { randomBytes } from 'node:crypto';

import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';

import type { AgentTaskPrState } from '../agent-task.js';
import type { BoardEventRef, BoardGithubRef, OfficeGithubRef } from '../board.js';
import type { PullRequestAction, PullRequestFacts, PullRequestStatusRef } from '../github.js';
import type { Database } from './client.js';
import { agentTasks, boardEvents, officeGithub, pullRequestStatus, users } from './schema.js';

/**
 * The office's GitHub: its token, what GitHub last said about the ledger's
 * pull requests, and what was done to them from the board. The token is
 * read by one function, for the game server; everything a page or a client
 * sees goes through `describeOfficeGithub`, which leaves it out.
 */

function newId(): string {
  return randomBytes(16).toString('hex');
}

// --- the token ---------------------------------------------------------------

export interface OfficeGithubRow {
  workspaceId: string;
  token: string;
  login: string;
  setByUserId: string | null;
  lastCheckedAt: number | null;
  lastError: string | null;
  updatedAt: number;
}

/** The token and all. Server-side only: never hand this to a client. */
export async function getOfficeGithub(db: Database, workspaceId: string): Promise<OfficeGithubRow | null> {
  const rows = await db.select().from(officeGithub).where(eq(officeGithub.workspaceId, workspaceId)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    workspaceId: row.workspaceId,
    token: row.token,
    login: row.login,
    setByUserId: row.setByUserId,
    lastCheckedAt: row.lastCheckedAt?.getTime() ?? null,
    lastError: row.lastError,
    updatedAt: row.updatedAt.getTime(),
  };
}

/** What a page or the board may know: that there is a token, whose, who set it, and whether it still works. */
export async function describeOfficeGithub(db: Database, workspaceId: string): Promise<OfficeGithubRef> {
  const rows = await db
    .select({ row: officeGithub, setByName: users.name })
    .from(officeGithub)
    .leftJoin(users, eq(users.id, officeGithub.setByUserId))
    .where(eq(officeGithub.workspaceId, workspaceId))
    .limit(1);
  const found = rows[0];
  if (!found) return { connected: false, login: null, setByName: null, updatedAt: null, lastCheckedAt: null, lastError: null };
  return {
    connected: true,
    login: found.row.login,
    setByName: found.setByName ?? null,
    updatedAt: found.row.updatedAt.getTime(),
    lastCheckedAt: found.row.lastCheckedAt?.getTime() ?? null,
    lastError: found.row.lastError,
  };
}

/** For the board payload: the two facts the panel acts on. */
export function boardGithubOf(office: OfficeGithubRef): BoardGithubRef {
  return { connected: office.connected, login: office.login };
}

export interface SetOfficeGithubInput {
  workspaceId: string;
  token: string;
  /** Whose token GitHub said it is, checked by the caller before saving. */
  login: string;
  setByUserId: string;
}

/** Put the token in, or replace it. A new token starts with a clean record. */
export async function setOfficeGithub(db: Database, input: SetOfficeGithubInput): Promise<void> {
  const at = new Date();
  await db
    .insert(officeGithub)
    .values({
      workspaceId: input.workspaceId,
      token: input.token,
      login: input.login,
      setByUserId: input.setByUserId,
      lastCheckedAt: at,
      lastError: null,
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoUpdate({
      target: officeGithub.workspaceId,
      set: { token: input.token, login: input.login, setByUserId: input.setByUserId, lastCheckedAt: at, lastError: null, updatedAt: at },
    });
}

/** Take the token out. The status cache stays: it is what was last known, and says when. */
export async function clearOfficeGithub(db: Database, workspaceId: string): Promise<boolean> {
  const gone = await db.delete(officeGithub).where(eq(officeGithub.workspaceId, workspaceId)).returning({ id: officeGithub.workspaceId });
  return gone.length > 0;
}

/** The server tried the token: when, and what GitHub said if it was no. */
export async function noteOfficeGithubCheck(db: Database, workspaceId: string, error: string | null, now = Date.now()): Promise<void> {
  await db
    .update(officeGithub)
    .set({ lastCheckedAt: new Date(now), lastError: error })
    .where(eq(officeGithub.workspaceId, workspaceId));
}

// --- what GitHub said ----------------------------------------------------------

export interface SavePullRequestStatusInput {
  workspaceId: string;
  taskId: string;
  /** The facts, from a good fetch. Omit when the fetch failed: the last good facts are kept. */
  facts?: PullRequestFacts;
  error?: string | null;
  now?: number;
}

/** Keep what GitHub said about a task's pull request. A failed fetch keeps the facts and notes the failure. */
export async function savePullRequestStatus(db: Database, input: SavePullRequestStatusInput): Promise<void> {
  const fetchedAt = new Date(input.now ?? Date.now());
  const error = input.error ?? null;
  if (input.facts) {
    const f = input.facts;
    const columns = {
      state: f.state,
      draft: f.draft,
      title: f.title,
      headSha: f.headSha,
      headRef: f.headRef,
      baseRef: f.baseRef,
      mergeable: f.mergeable,
      mergeableState: f.mergeableState,
      checks: f.checks,
      reviewDecision: f.reviewDecision,
      fetchedAt,
      error,
    };
    await db
      .insert(pullRequestStatus)
      .values({ taskId: input.taskId, workspaceId: input.workspaceId, ...columns })
      .onConflictDoUpdate({ target: pullRequestStatus.taskId, set: columns });
    return;
  }
  await db
    .insert(pullRequestStatus)
    .values({ taskId: input.taskId, workspaceId: input.workspaceId, fetchedAt, error })
    .onConflictDoUpdate({ target: pullRequestStatus.taskId, set: { fetchedAt, error } });
}

function statusOf(row: typeof pullRequestStatus.$inferSelect, lastAction: PullRequestStatusRef['lastAction']): PullRequestStatusRef | null {
  // A row with no state is a failed first fetch: nothing to show but the error.
  if (row.state === null) {
    return row.error
      ? {
          state: 'open',
          draft: false,
          title: '',
          headSha: '',
          headRef: '',
          baseRef: '',
          mergeable: null,
          mergeableState: 'unknown',
          checks: { summary: 'none', total: 0, passed: 0, failed: 0, pending: 0, runs: [] },
          reviewDecision: 'none',
          fetchedAt: row.fetchedAt.getTime(),
          error: row.error,
          lastAction,
          known: false,
        }
      : null;
  }
  return {
    state: row.state as AgentTaskPrState,
    draft: row.draft,
    title: row.title,
    headSha: row.headSha,
    headRef: row.headRef,
    baseRef: row.baseRef,
    mergeable: row.mergeable,
    mergeableState: row.mergeableState,
    checks: row.checks ?? { summary: 'none', total: 0, passed: 0, failed: 0, pending: 0, runs: [] },
    reviewDecision: row.reviewDecision,
    fetchedAt: row.fetchedAt.getTime(),
    error: row.error,
    lastAction,
    known: true,
  };
}

/** Every cached status of an office, by task id, with the last action taken on each from the board. */
export async function pullRequestStatusesForWorkspace(db: Database, workspaceId: string): Promise<Map<string, PullRequestStatusRef>> {
  const [rows, actions] = await Promise.all([
    db.select().from(pullRequestStatus).where(eq(pullRequestStatus.workspaceId, workspaceId)),
    db
      .select({ taskId: boardEvents.taskId, kind: boardEvents.kind, actorName: boardEvents.actorName, createdAt: boardEvents.createdAt })
      .from(boardEvents)
      .where(and(eq(boardEvents.workspaceId, workspaceId), isNotNull(boardEvents.taskId), inArray(boardEvents.kind, PR_ACTION_KINDS)))
      .orderBy(desc(boardEvents.createdAt)),
  ]);
  const lastActions = new Map<string, PullRequestStatusRef['lastAction']>();
  for (const event of actions) {
    if (!event.taskId || lastActions.has(event.taskId)) continue;
    lastActions.set(event.taskId, {
      action: event.kind.slice('pr.'.length) as PullRequestAction,
      byName: event.actorName,
      at: event.createdAt.getTime(),
    });
  }
  const statuses = new Map<string, PullRequestStatusRef>();
  for (const row of rows) {
    const status = statusOf(row, lastActions.get(row.taskId) ?? null);
    if (status) statuses.set(row.taskId, status);
  }
  return statuses;
}

/**
 * The office's own poll found the pull request in another state than the
 * harness last said: the ledger follows GitHub. True when this changed it
 * to merged, which is the change the board acts on.
 */
export async function setAgentTaskPullRequestState(
  db: Database,
  taskId: string,
  state: AgentTaskPrState,
): Promise<{ changed: boolean; merged: boolean }> {
  const rows = await db.select({ prState: agentTasks.prState, prNumber: agentTasks.prNumber }).from(agentTasks).where(eq(agentTasks.id, taskId)).limit(1);
  const row = rows[0];
  if (!row || row.prNumber === null || row.prState === state) return { changed: false, merged: false };
  await db.update(agentTasks).set({ prState: state }).where(eq(agentTasks.id, taskId));
  return { changed: true, merged: state === 'merged' };
}

// --- who did what --------------------------------------------------------------

export const BOARD_EVENT_KINDS = [
  'item.created',
  'item.updated',
  'item.deleted',
  'pr.merge',
  'pr.squash',
  'pr.rebase',
  'pr.update_branch',
  'pr.close',
  /** The office's own poll found the pull request's state changed on GitHub. */
  'pr.state',
] as const;
export type BoardEventKind = (typeof BOARD_EVENT_KINDS)[number];

const PR_ACTION_KINDS = ['pr.merge', 'pr.squash', 'pr.rebase', 'pr.update_branch', 'pr.close'];

export interface RecordBoardEventInput {
  workspaceId: string;
  kind: BoardEventKind;
  actor: { kind: 'user' | 'agent' | 'office'; id: string | null; name: string };
  itemId?: string | null;
  taskId?: string | null;
  payload?: unknown;
  now?: number;
}

export async function recordBoardEvent(db: Database, input: RecordBoardEventInput): Promise<BoardEventRef> {
  const id = newId();
  const createdAt = new Date(input.now ?? Date.now());
  await db.insert(boardEvents).values({
    id,
    workspaceId: input.workspaceId,
    itemId: input.itemId ?? null,
    taskId: input.taskId ?? null,
    actorKind: input.actor.kind,
    actorId: input.actor.id,
    actorName: input.actor.name,
    kind: input.kind,
    payload: input.payload ?? null,
    createdAt,
  });
  return {
    id,
    kind: input.kind,
    actor: input.actor,
    itemId: input.itemId ?? null,
    taskId: input.taskId ?? null,
    payload: input.payload ?? null,
    createdAt: createdAt.getTime(),
  };
}

export interface ListBoardEventsOptions {
  itemId?: string;
  taskId?: string;
  limit?: number;
}

/** An office's board events, newest first, for one note or task when asked. */
export async function listBoardEvents(db: Database, workspaceId: string, options: ListBoardEventsOptions = {}): Promise<BoardEventRef[]> {
  const where = [eq(boardEvents.workspaceId, workspaceId)];
  if (options.itemId) where.push(eq(boardEvents.itemId, options.itemId));
  if (options.taskId) where.push(eq(boardEvents.taskId, options.taskId));
  const rows = await db
    .select()
    .from(boardEvents)
    .where(and(...where))
    .orderBy(desc(boardEvents.createdAt))
    .limit(Math.max(1, options.limit ?? 100));
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as BoardEventKind,
    actor: { kind: row.actorKind as 'user' | 'agent' | 'office', id: row.actorId, name: row.actorName },
    itemId: row.itemId,
    taskId: row.taskId,
    payload: row.payload ?? null,
    createdAt: row.createdAt.getTime(),
  }));
}
