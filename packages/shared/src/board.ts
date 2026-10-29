import type { AgentTaskPullRequest } from './agent-task.js';
import { normalisePromptProse } from './agent.js';
import type { ChannelActor } from './conversation.js';
import type { PlayerKind } from './player.js';
import { tidyDisplayText, type MembershipRole } from './workspace.js';

/**
 * The office board: the noticeboard in the hallway, as data.
 *
 * An item is a post-it — a number, a title, a colour, a few labels, and the
 * agent it is for — kept by the office the way a team or a command is. The
 * board is shared: anyone who belongs here may put something on it or move
 * what is there, because a board one person curates is a to-do list with a
 * frame around it. Taking a note down is for whoever wrote it or an admin.
 *
 * What a client needs to know about an item is here; the rows and the rules
 * that need a database are in `db/board.ts`.
 */

/** Three columns. "In review" is a badge on an open pull request, not a place. */
export const BOARD_STATUSES = ['open', 'in_progress', 'done'] as const;
export type BoardStatus = (typeof BOARD_STATUSES)[number];

/** The post-it palette. Names, not hex: the panel paints them for its theme. */
export const BOARD_COLORS = ['yellow', 'blue', 'green', 'pink', 'orange', 'purple'] as const;
export type BoardColor = (typeof BOARD_COLORS)[number];

export const BOARD_DEFAULT_STATUS: BoardStatus = 'open';
export const BOARD_DEFAULT_COLOR: BoardColor = 'yellow';

/** A title is a line on a note; a body is the rest of the ticket. */
export const BOARD_TITLE_MAX_LENGTH = 200;
export const BOARD_BODY_MAX_LENGTH = 8_000;
/** A label is a word on a chip. */
export const BOARD_LABEL_MAX_LENGTH = 24;
export const BOARD_LABELS_MAX = 10;
/**
 * Most notes an office keeps up at once — open or in progress; done notes
 * do not count. A board is read whole by everybody in the room, so it has
 * to stay a board, and a cap is what stops an agent in a loop turning it
 * into a log. Past it, a new note is refused until some are done or taken
 * down.
 */
export const BOARD_OPEN_ITEMS_MAX = 500;

export function isBoardStatus(value: unknown): value is BoardStatus {
  return typeof value === 'string' && (BOARD_STATUSES as readonly string[]).includes(value);
}

export function isBoardColor(value: unknown): value is BoardColor {
  return typeof value === 'string' && (BOARD_COLORS as readonly string[]).includes(value);
}

/** Who an item is for, as a client shows it. */
export interface BoardAssigneeRef {
  /** `agents.id`. */
  id: string;
  name: string;
}

/** Who wrote an item: a person, or an agent asked to. */
export interface BoardAuthorRef {
  kind: PlayerKind;
  /** `users.id` or `agents.id`. */
  id: string;
  name: string;
}

/** An item as a client sees it. */
/**
 * The task an agent is on, or was on, for a note: the ledger's latest row
 * that names it. What the card's "in review" badge and the drawer's branch
 * line are drawn from.
 */
export interface BoardItemTask {
  agent: { id: string; name: string };
  repo: string;
  branch: string;
  pr: AgentTaskPullRequest | null;
  /** True while the harness still says it is on it. */
  active: boolean;
}

export interface BoardItemRef {
  id: string;
  /** `#12`: the office's own count, never reused. */
  number: number;
  title: string;
  body: string;
  status: BoardStatus;
  color: BoardColor;
  labels: string[];
  assignee: BoardAssigneeRef | null;
  /** Null when whoever wrote it has left. */
  createdBy: BoardAuthorRef | null;
  createdAt: number;
  updatedAt: number;
  /** The branch and pull request an agent took it to, if any. */
  task: BoardItemTask | null;
}

/** An agent an item could be for, online or not. */
export interface BoardAgentRef {
  /** `agents.id`. */
  id: string;
  name: string;
  ownerUserId: string;
  ownerName: string;
}

/**
 * The board, as the office sends it: every item, every agent it could be for,
 * and where the viewer stands — so the panel can hide what the office would
 * refuse rather than offer it and apologise.
 */
export interface BoardPayload {
  items: BoardItemRef[];
  agents: BoardAgentRef[];
  you: { userId: string; role: MembershipRole | null };
}

/** Empty, trimmed, one line. Null when nothing is left: a note needs a title. */
export function normaliseBoardTitle(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const title = tidyDisplayText(input, BOARD_TITLE_MAX_LENGTH);
  return title.length > 0 ? title : null;
}

/** Prose, newlines kept, capped. Same rules as an agent's instructions: it lands in a prompt. */
export function normaliseBoardBody(input: unknown): string {
  return normalisePromptProse(input, BOARD_BODY_MAX_LENGTH);
}

/**
 * Labels as chips: short, one line each, no duplicates in any case, at most
 * ten. Accepts an array or a comma-separated line, since both are typed.
 */
export function normaliseBoardLabels(input: unknown): string[] {
  const raw: unknown[] = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(',')
      : [];
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const label = tidyDisplayText(value, BOARD_LABEL_MAX_LENGTH);
    if (label.length === 0) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
    if (labels.length >= BOARD_LABELS_MAX) break;
  }
  return labels;
}

/** What `board_create` carries. */
export interface BoardCreateInput {
  title: string;
  body: string;
  status: BoardStatus;
  color: BoardColor;
  labels: string[];
  /** `agents.id`, or null for nobody yet. */
  assigneeAgentId: string | null;
}

/** What `board_update` carries: only the fields named change. */
export interface BoardUpdateInput {
  itemId: string;
  title?: string;
  body?: string;
  status?: BoardStatus;
  color?: BoardColor;
  labels?: string[];
  /** Null takes the note off whoever had it. */
  assigneeAgentId?: string | null;
}

function id(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : null;
}

/**
 * Rebuild a `board_create` payload at the trust boundary. Null for anything
 * that is not a note — no title, a status or colour the board has no column
 * or paint for. Never spreads what came in.
 */
export function parseBoardCreate(value: unknown): BoardCreateInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const title = normaliseBoardTitle(v.title);
  if (!title) return null;
  if (v.status !== undefined && !isBoardStatus(v.status)) return null;
  if (v.color !== undefined && !isBoardColor(v.color)) return null;
  let assigneeAgentId: string | null = null;
  if (v.assigneeAgentId !== undefined && v.assigneeAgentId !== null) {
    assigneeAgentId = id(v.assigneeAgentId);
    if (!assigneeAgentId) return null;
  }
  return {
    title,
    body: normaliseBoardBody(v.body),
    status: isBoardStatus(v.status) ? v.status : BOARD_DEFAULT_STATUS,
    color: isBoardColor(v.color) ? v.color : BOARD_DEFAULT_COLOR,
    labels: normaliseBoardLabels(v.labels),
    assigneeAgentId,
  };
}

/**
 * Rebuild a `board_update` payload. Null when it names no item, changes
 * nothing, or would change something into nonsense — a blank title, say.
 */
export function parseBoardUpdate(value: unknown): BoardUpdateInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const itemId = id(v.itemId);
  if (!itemId) return null;
  const patch: BoardUpdateInput = { itemId };
  if (v.title !== undefined) {
    const title = normaliseBoardTitle(v.title);
    if (!title) return null;
    patch.title = title;
  }
  if (v.body !== undefined) {
    if (typeof v.body !== 'string') return null;
    patch.body = normaliseBoardBody(v.body);
  }
  if (v.status !== undefined) {
    if (!isBoardStatus(v.status)) return null;
    patch.status = v.status;
  }
  if (v.color !== undefined) {
    if (!isBoardColor(v.color)) return null;
    patch.color = v.color;
  }
  if (v.labels !== undefined) {
    if (!Array.isArray(v.labels) && typeof v.labels !== 'string') return null;
    patch.labels = normaliseBoardLabels(v.labels);
  }
  if (v.assigneeAgentId !== undefined) {
    if (v.assigneeAgentId === null) patch.assigneeAgentId = null;
    else {
      const assignee = id(v.assigneeAgentId);
      if (!assignee) return null;
      patch.assigneeAgentId = assignee;
    }
  }
  if (Object.keys(patch).length === 1) return null;
  return patch;
}

/** Any member may write on the board. A guest reads it on the way through. */
export function mayWriteBoard(actor: Pick<ChannelActor, 'role'>): boolean {
  return actor.role !== null;
}

/**
 * May this person hand a note to this agent?
 *
 * **Its owner, and nobody else** — the rule for messaging it (`mayOpenDm`)
 * and for pulling it into a channel, for the same reason: a note handed over
 * is a request the agent reads as being asked, and it acts as its owner, on
 * its owner's machine. A colleague who could hand my agent work could put
 * instructions in front of it that I never see. Taking a note off an agent,
 * or moving it between columns, is a board edit any member may make; only
 * putting one in an agent's hands is the owner's.
 *
 * Admins are not excepted: the office's rule for agents is accountability,
 * not rank. Anybody else asks the owner.
 */
export function mayAssignBoardItem(actor: ChannelActor, agent: Pick<BoardAgentRef, 'ownerUserId'>): boolean {
  return actor.role !== null && agent.ownerUserId === actor.userId;
}

/**
 * The note a task is for, if the task may have it. A task naming a note
 * takes it when nobody has it, and keeps it when it is this agent's. A note
 * handed to another agent is left alone — its card, its column and its
 * branch stay that agent's, whatever a stale task book or a typo in another
 * agent's `task_begin` says. Null when the task gets no note.
 */
export function noteForTask<T extends { assignee: { id: string } | null }>(item: T | null, agentId: string): T | null {
  if (!item) return null;
  if (item.assignee && item.assignee.id !== agentId) return null;
  return item;
}

/**
 * Whoever wrote a note may take it down, and office admins may take down
 * any — a board fills with notes whose authors have moved on, and somebody
 * has to be able to clear it.
 */
export function mayDeleteBoardItem(
  actor: ChannelActor,
  item: { createdBy: { kind: PlayerKind; id: string } | null },
): boolean {
  if (actor.role === 'owner' || actor.role === 'admin') return true;
  return actor.role !== null && item.createdBy?.kind === 'human' && item.createdBy.id === actor.userId;
}

/** The column's name as a person reads it. */
export function boardStatusLabel(status: BoardStatus): string {
  switch (status) {
    case 'open':
      return 'Open';
    case 'in_progress':
      return 'In progress';
    case 'done':
      return 'Done';
  }
}
