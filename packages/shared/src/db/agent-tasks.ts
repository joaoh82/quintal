import { randomBytes } from 'node:crypto';

import { and, desc, eq, isNotNull } from 'drizzle-orm';

import type { AgentTask, AgentTaskPrState, AgentTaskPullRequest, AgentTaskStatus } from '../agent-task.js';
import type { BoardItemTask, BoardTaskRef } from '../board.js';
import type { Database } from './client.js';
import { agentTasks, agents, boardItems } from './schema.js';

/**
 * The ledger of agents' tasks: `agent_tasks`, one row per branch an agent
 * has said it was on. Written from `agent:task` as it arrives, read by the
 * board and, later, the Pull requests tab.
 *
 * A harness says its task again on every connect and whenever its pull
 * request changes, so a note is an upsert by (office, agent, branch): the
 * same branch said twice is one row seen twice, not two tasks.
 */

function newId(): string {
  return randomBytes(16).toString('hex');
}

/** A ledger line as the board sends it, with the office it belongs to. */
export interface AgentTaskRecord extends BoardTaskRef {
  workspaceId: string;
}

export interface NoteAgentTaskInput {
  workspaceId: string;
  agentId: string;
  task: AgentTask;
  /** The board note this task is for, resolved by the caller; null for none. */
  boardItemId?: string | null;
  now?: number;
}

export interface NotedAgentTask {
  record: AgentTaskRecord;
  /** First time this branch was heard of. */
  created: boolean;
  /** This note attached the row to a board note it was not attached to before. */
  linked: boolean;
  /** This note is the one that said the pull request had merged. */
  merged: boolean;
}

function selectRecords(db: Database) {
  return db
    .select({
      row: agentTasks,
      agentName: agents.name,
      itemNumber: boardItems.number,
      itemTitle: boardItems.title,
    })
    .from(agentTasks)
    .innerJoin(agents, eq(agents.id, agentTasks.agentId))
    .leftJoin(boardItems, eq(boardItems.id, agentTasks.boardItemId));
}

type RecordRow = Awaited<ReturnType<ReturnType<typeof selectRecords>['where']>>[number];

function prOf(row: typeof agentTasks.$inferSelect): AgentTaskPullRequest | null {
  return row.prNumber && row.prUrl && row.prState
    ? { number: row.prNumber, url: row.prUrl, state: row.prState as AgentTaskPrState }
    : null;
}

function toRecord({ row, agentName, itemNumber, itemTitle }: RecordRow): AgentTaskRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    agentId: row.agentId,
    agentName,
    item:
      row.boardItemId && itemNumber !== null && itemTitle !== null
        ? { id: row.boardItemId, number: itemNumber, title: itemTitle }
        : null,
    title: row.title,
    repo: row.repo,
    branch: row.branch,
    pr: prOf(row),
    status: row.status as AgentTaskStatus,
    startedAt: row.startedAt.getTime(),
    endedAt: row.endedAt?.getTime() ?? null,
    lastSeenAt: row.lastSeenAt.getTime(),
  };
}

async function getRecord(db: Database, id: string): Promise<AgentTaskRecord> {
  const rows = await selectRecords(db).where(eq(agentTasks.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw new Error('The task was not written.');
  return toRecord(row);
}

/**
 * Note what an agent says it is on. The same branch again updates the row
 * — the pull request as it is now, seen now, active again if it had been
 * ended — and keeps the note it was first linked to: a task is for the note
 * it began for, whatever a later message says.
 */
export async function noteAgentTask(db: Database, input: NoteAgentTaskInput): Promise<NotedAgentTask> {
  const now = new Date(input.now ?? Date.now());
  const { task } = input;
  const prFields = {
    prNumber: task.pr?.number ?? null,
    prUrl: task.pr?.url ?? null,
    prState: task.pr?.state ?? null,
  };
  const merged = task.pr?.state === 'merged';

  const existing = (
    await db
      .select()
      .from(agentTasks)
      .where(
        and(
          eq(agentTasks.workspaceId, input.workspaceId),
          eq(agentTasks.agentId, input.agentId),
          eq(agentTasks.branch, task.branch),
        ),
      )
      .limit(1)
  )[0];

  if (!existing) {
    const id = newId();
    await db.insert(agentTasks).values({
      id,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      boardItemId: input.boardItemId ?? null,
      title: task.title,
      repo: task.repo,
      branch: task.branch,
      ...prFields,
      status: 'active',
      startedAt: now,
      endedAt: null,
      lastSeenAt: now,
    });
    return { record: await getRecord(db, id), created: true, linked: !!input.boardItemId, merged };
  }

  const linked = existing.boardItemId === null && !!input.boardItemId;
  await db
    .update(agentTasks)
    .set({
      title: task.title,
      repo: task.repo,
      ...prFields,
      status: 'active',
      endedAt: null,
      lastSeenAt: now,
      ...(linked ? { boardItemId: input.boardItemId } : {}),
    })
    .where(eq(agentTasks.id, existing.id));
  return {
    record: await getRecord(db, existing.id),
    created: false,
    linked,
    merged: merged && existing.prState !== 'merged',
  };
}

/** The agent said it is on nothing: every task it was on is over. Returns the ones that were active. */
export async function endAgentTasks(
  db: Database,
  workspaceId: string,
  agentId: string,
  now: number = Date.now(),
): Promise<AgentTaskRecord[]> {
  const active = await selectRecords(db).where(
    and(
      eq(agentTasks.workspaceId, workspaceId),
      eq(agentTasks.agentId, agentId),
      eq(agentTasks.status, 'active'),
    ),
  );
  if (active.length === 0) return [];
  const at = new Date(now);
  await db
    .update(agentTasks)
    .set({ status: 'ended', endedAt: at, lastSeenAt: at })
    .where(
      and(
        eq(agentTasks.workspaceId, workspaceId),
        eq(agentTasks.agentId, agentId),
        eq(agentTasks.status, 'active'),
      ),
    );
  return active.map((row) => toRecord({ ...row, row: { ...row.row, status: 'ended', endedAt: at, lastSeenAt: at } }));
}

export interface ListAgentTasksOptions {
  /**
   * Send every active line, and at most this many ended ones, the most
   * recently seen. Unset reads the whole ledger.
   */
  endedMax?: number;
}

/** An office's ledger, most recently seen first: all of it, or every active line and the newest ended ones. */
export async function listAgentTasksForWorkspace(
  db: Database,
  workspaceId: string,
  options: ListAgentTasksOptions = {},
): Promise<AgentTaskRecord[]> {
  const { endedMax } = options;
  if (endedMax === undefined) {
    const rows = await selectRecords(db)
      .where(eq(agentTasks.workspaceId, workspaceId))
      .orderBy(desc(agentTasks.lastSeenAt));
    return rows.map(toRecord);
  }
  const [active, ended] = await Promise.all([
    selectRecords(db)
      .where(and(eq(agentTasks.workspaceId, workspaceId), eq(agentTasks.status, 'active')))
      .orderBy(desc(agentTasks.lastSeenAt)),
    selectRecords(db)
      .where(and(eq(agentTasks.workspaceId, workspaceId), eq(agentTasks.status, 'ended')))
      .orderBy(desc(agentTasks.lastSeenAt))
      .limit(Math.max(0, endedMax)),
  ]);
  return [...active, ...ended].map(toRecord).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

/**
 * For every board note that a task names, the task most recently seen for
 * it: what the note's card shows. Keyed by the note's id.
 */
export async function taskLinksForBoard(db: Database, workspaceId: string): Promise<Map<string, BoardItemTask>> {
  const rows = await db
    .select({ row: agentTasks, agentName: agents.name })
    .from(agentTasks)
    .innerJoin(agents, eq(agents.id, agentTasks.agentId))
    .where(and(eq(agentTasks.workspaceId, workspaceId), isNotNull(agentTasks.boardItemId)))
    .orderBy(desc(agentTasks.lastSeenAt));
  const links = new Map<string, BoardItemTask>();
  for (const { row, agentName } of rows) {
    if (!row.boardItemId || links.has(row.boardItemId)) continue;
    links.set(row.boardItemId, {
      agent: { id: row.agentId, name: agentName },
      repo: row.repo,
      branch: row.branch,
      pr: prOf(row),
      active: row.status === 'active',
    });
  }
  return links;
}
