import { randomBytes } from 'node:crypto';

import { and, asc, count, desc, eq, isNull, ne, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';

import {
  BOARD_OPEN_ITEMS_MAX,
  type BoardAgentRef,
  type BoardColor,
  type BoardCreateInput,
  type BoardItemRef,
  type BoardItemTask,
  type BoardStatus,
  type BoardUpdateInput,
  normaliseBoardLabels,
} from '../board.js';
import { displayName } from '../identity.js';
import { taskLinksForBoard } from './agent-tasks.js';
import type { Database } from './client.js';
import { agentTasks, agents, boardItems, users, workspaces } from './schema.js';

/**
 * The office board's rows.
 *
 * One `board_items` row per note. The room reads the whole board on its
 * refresh cadence and after every change it makes, so nothing here pages:
 * an office board that needs paging is a tracker, and that is not this.
 * The rules about who may write are pure functions in `board.ts`.
 */

function newId(): string {
  return randomBytes(16).toString('hex');
}

export class BoardItemError extends Error {
  constructor(
    readonly reason: 'invalid' | 'assignee' | 'not_found' | 'full',
    message: string,
  ) {
    super(message);
    this.name = 'BoardItemError';
  }
}

/** Who wrote it. Exactly one, or neither when a request carries no author. */
export type BoardAuthor = { userId: string } | { agentId: string };

export interface CreateBoardItemInput extends BoardCreateInput {
  workspaceId: string;
  createdBy: BoardAuthor;
  /** Most notes up at once before a new one is refused. `BOARD_OPEN_ITEMS_MAX` unless a test says less. */
  openLimit?: number;
}

/** Notes up on the board — not done — right now. */
async function countOpenItems(db: Database, workspaceId: string): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(boardItems)
    .where(and(eq(boardItems.workspaceId, workspaceId), ne(boardItems.status, 'done')));
  return rows[0]?.n ?? 0;
}

/** An agent of this office, live, or refuse. */
async function assertAssignee(db: Database, workspaceId: string, agentId: string): Promise<void> {
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId), isNull(agents.revokedAt)))
    .limit(1);
  if (!rows[0]) throw new BoardItemError('assignee', 'No such agent here, or it has been revoked.');
}

/**
 * The next `#n` here, taken: the office's counter moves in the same
 * statement that reads it, so no two notes are ever given one number and a
 * note taken down never hands its number on.
 */
async function takeNumber(db: Database, workspaceId: string): Promise<number> {
  const rows = await db
    .update(workspaces)
    .set({ boardCounter: sql`${workspaces.boardCounter} + 1` })
    .where(eq(workspaces.id, workspaceId))
    .returning({ number: workspaces.boardCounter });
  const number = rows[0]?.number;
  if (number === undefined) throw new BoardItemError('not_found', 'No such office.');
  return number;
}

export async function createBoardItem(
  db: Database,
  input: CreateBoardItemInput,
): Promise<BoardItemRef> {
  if (input.assigneeAgentId) await assertAssignee(db, input.workspaceId, input.assigneeAgentId);
  const openLimit = input.openLimit ?? BOARD_OPEN_ITEMS_MAX;
  if (input.status !== 'done' && (await countOpenItems(db, input.workspaceId)) >= openLimit) {
    throw new BoardItemError(
      'full',
      `The board has ${openLimit} notes up already. Finish some, or take some down, before pinning another.`,
    );
  }
  const id = newId();
  const author =
    'userId' in input.createdBy
      ? { createdByUserId: input.createdBy.userId, createdByAgentId: null }
      : { createdByUserId: null, createdByAgentId: input.createdBy.agentId };

  const number = await takeNumber(db, input.workspaceId);
  await db.insert(boardItems).values({
    id,
    workspaceId: input.workspaceId,
    number,
    title: input.title,
    body: input.body,
    status: input.status,
    color: input.color,
    labels: JSON.stringify(input.labels),
    assigneeAgentId: input.assigneeAgentId,
    ...author,
  });
  const made = await getBoardItem(db, input.workspaceId, id);
  if (!made) throw new Error('The board item was not written.');
  return made;
}

export interface UpdateBoardItemInput extends BoardUpdateInput {
  workspaceId: string;
}

/** Change a note. Absent fields stay. */
export async function updateBoardItem(db: Database, input: UpdateBoardItemInput): Promise<BoardItemRef> {
  const patch: Partial<typeof boardItems.$inferInsert> = { updatedAt: new Date() };
  if (input.title !== undefined) patch.title = input.title;
  if (input.body !== undefined) patch.body = input.body;
  if (input.status !== undefined) patch.status = input.status;
  if (input.color !== undefined) patch.color = input.color;
  if (input.labels !== undefined) patch.labels = JSON.stringify(input.labels);
  if (input.assigneeAgentId !== undefined) {
    if (input.assigneeAgentId) await assertAssignee(db, input.workspaceId, input.assigneeAgentId);
    patch.assigneeAgentId = input.assigneeAgentId;
  }
  const result = await db
    .update(boardItems)
    .set(patch)
    .where(and(eq(boardItems.id, input.itemId), eq(boardItems.workspaceId, input.workspaceId)));
  if (result.rowsAffected === 0) throw new BoardItemError('not_found', 'No such item on this board.');
  const updated = await getBoardItem(db, input.workspaceId, input.itemId);
  if (!updated) throw new BoardItemError('not_found', 'No such item on this board.');
  return updated;
}

/** Take a note down. True when there was one. */
export async function deleteBoardItem(
  db: Database,
  workspaceId: string,
  itemId: string,
): Promise<boolean> {
  const result = await db
    .delete(boardItems)
    .where(and(eq(boardItems.id, itemId), eq(boardItems.workspaceId, workspaceId)));
  return result.rowsAffected > 0;
}

const assignee = alias(agents, 'assignee');
const creatorAgent = alias(agents, 'creator_agent');

function selectItems(db: Database) {
  return (
    db
      .select({
        row: boardItems,
        assigneeName: assignee.name,
        creatorUserName: users.name,
        creatorUserPubkey: users.pubkey,
        creatorAgentName: creatorAgent.name,
      })
      .from(boardItems)
      // A revoked agent keeps its row; a note it held goes back to nobody.
      .leftJoin(assignee, and(eq(assignee.id, boardItems.assigneeAgentId), isNull(assignee.revokedAt)))
      .leftJoin(users, eq(users.id, boardItems.createdByUserId))
      .leftJoin(creatorAgent, eq(creatorAgent.id, boardItems.createdByAgentId))
  );
}

type ItemRow = Awaited<ReturnType<ReturnType<typeof selectItems>['where']>>[number];

/** Labels as stored, or none: a column somebody edited by hand is not a reason to drop the note. */
function labelsOf(stored: string): string[] {
  try {
    return normaliseBoardLabels(JSON.parse(stored));
  } catch {
    return [];
  }
}

function toRef(
  { row, assigneeName, creatorUserName, creatorUserPubkey, creatorAgentName }: ItemRow,
  task: BoardItemTask | null,
): BoardItemRef {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    body: row.body,
    status: row.status as BoardStatus,
    color: row.color as BoardColor,
    labels: labelsOf(row.labels),
    assignee: row.assigneeAgentId && assigneeName ? { id: row.assigneeAgentId, name: assigneeName } : null,
    // A person who never chose a name is still somebody: the same derived
    // name the rest of the office calls them by.
    createdBy:
      row.createdByUserId && creatorUserPubkey !== null
        ? {
            kind: 'human',
            id: row.createdByUserId,
            name: displayName({ name: creatorUserName, pubkey: creatorUserPubkey }),
          }
        : row.createdByAgentId && creatorAgentName
          ? { kind: 'agent', id: row.createdByAgentId, name: creatorAgentName }
          : null,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    task,
  };
}

/** Every note on an office's board, newest first, each with the task it went to. */
export async function listBoardItemsForWorkspace(
  db: Database,
  workspaceId: string,
): Promise<BoardItemRef[]> {
  const [rows, links] = await Promise.all([
    selectItems(db).where(eq(boardItems.workspaceId, workspaceId)).orderBy(desc(boardItems.number)),
    taskLinksForBoard(db, workspaceId),
  ]);
  return rows.map((row) => toRef(row, links.get(row.row.id) ?? null));
}

async function oneItem(db: Database, workspaceId: string, rows: ItemRow[]): Promise<BoardItemRef | null> {
  const row = rows[0];
  if (!row) return null;
  const links = await taskLinksForBoard(db, workspaceId);
  return toRef(row, links.get(row.row.id) ?? null);
}

export async function getBoardItem(
  db: Database,
  workspaceId: string,
  itemId: string,
): Promise<BoardItemRef | null> {
  const rows = await selectItems(db)
    .where(and(eq(boardItems.id, itemId), eq(boardItems.workspaceId, workspaceId)))
    .limit(1);
  return oneItem(db, workspaceId, rows);
}

/** A note by its number, as people say it. */
export async function findBoardItemByNumber(
  db: Database,
  workspaceId: string,
  number: number,
): Promise<BoardItemRef | null> {
  const rows = await selectItems(db)
    .where(and(eq(boardItems.workspaceId, workspaceId), eq(boardItems.number, number)))
    .limit(1);
  return oneItem(db, workspaceId, rows);
}

/**
 * The note a task is most likely for when the harness named none: the
 * newest note handed to this agent that is not done and that no task has
 * been linked to yet. An owner's `!task` says no number, and this is how the
 * board still follows it.
 */
export async function findUnlinkedItemForAgent(
  db: Database,
  workspaceId: string,
  agentId: string,
): Promise<BoardItemRef | null> {
  const rows = await selectItems(db)
    .where(
      and(
        eq(boardItems.workspaceId, workspaceId),
        eq(boardItems.assigneeAgentId, agentId),
        ne(boardItems.status, 'done'),
        notExists(db.select({ id: agentTasks.id }).from(agentTasks).where(eq(agentTasks.boardItemId, boardItems.id))),
      ),
    )
    .orderBy(desc(boardItems.number))
    .limit(1);
  return oneItem(db, workspaceId, rows);
}

/** The agents a note could be for: every live one in the office, by name. */
export async function listBoardAgentsForWorkspace(
  db: Database,
  workspaceId: string,
): Promise<BoardAgentRef[]> {
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      ownerUserId: agents.ownerUserId,
      ownerName: users.name,
    })
    .from(agents)
    .leftJoin(users, eq(users.id, agents.ownerUserId))
    .where(and(eq(agents.workspaceId, workspaceId), isNull(agents.revokedAt)))
    .orderBy(asc(agents.name));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    ownerUserId: row.ownerUserId,
    ownerName: row.ownerName ?? '',
  }));
}
