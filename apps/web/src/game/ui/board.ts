import {
  type BoardColor,
  type BoardItemRef,
  type BoardStatus,
} from '@quintal/shared';

/**
 * What the board panel works out before it draws: which notes go in which
 * column, which match the filter, and what colour a post-it is. Pure, so it
 * can be pinned down without a browser.
 */

export type BoardView = 'kanban' | 'postits';

/** Notes per column, each column newest first, every column present. */
export function columnsOf(items: readonly BoardItemRef[]): Record<BoardStatus, BoardItemRef[]> {
  const columns: Record<BoardStatus, BoardItemRef[]> = { open: [], in_progress: [], done: [] };
  for (const item of items) columns[item.status].push(item);
  return columns;
}

/**
 * Does a note match what was typed in the filter box? The number, with or
 * without its `#`; any word of the title; a label; who it is for.
 */
export function matchesFilter(item: BoardItemRef, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  if (q === `#${item.number}` || q === String(item.number)) return true;
  if (item.title.toLowerCase().includes(q)) return true;
  if (item.labels.some((label) => label.toLowerCase().includes(q))) return true;
  if (item.assignee && item.assignee.name.toLowerCase().includes(q)) return true;
  return false;
}

/**
 * The post-it wall: open and in-progress notes, in progress first, newest
 * first within each — what is pinned up, not what has come down. Done notes
 * are read in the kanban's third column.
 */
export function wallOf(items: readonly BoardItemRef[]): BoardItemRef[] {
  const columns = columnsOf(items);
  return [...columns.in_progress, ...columns.open];
}

/** Where a note goes next with one press: open → in progress → done. Done stays. */
export function nextStatus(status: BoardStatus): BoardStatus | null {
  switch (status) {
    case 'open':
      return 'in_progress';
    case 'in_progress':
      return 'done';
    case 'done':
      return null;
  }
}

/** The post-it palette, as paper: a light face with a darker pin. */
export const POSTIT_STYLES: Record<BoardColor, { face: string; pin: string; ink: string }> = {
  yellow: { face: '#f7e98a', pin: '#d9b400', ink: '#3a3300' },
  blue: { face: '#b9ddff', pin: '#2d7fd3', ink: '#0d2a47' },
  green: { face: '#c6f0b8', pin: '#3f9d3a', ink: '#163812' },
  pink: { face: '#ffc9df', pin: '#d9418a', ink: '#4a1430' },
  orange: { face: '#ffd6a8', pin: '#e07b1c', ink: '#4a2a08' },
  purple: { face: '#dccbff', pin: '#7b4fd6', ink: '#2a1750' },
};

/**
 * What the note's task says, in a word: in review while its pull request is
 * open, merged once it is, closed if it was closed without merging, and on a
 * branch when there is a branch and no pull request yet. Nothing when no
 * task has taken the note, or the one that did is over without a pull request.
 */
export function taskBadgeOf(item: Pick<BoardItemRef, 'task'>): string | null {
  const task = item.task;
  if (!task) return null;
  if (task.pr?.state === 'open') return 'in review';
  if (task.pr?.state === 'merged') return 'merged';
  if (task.pr?.state === 'closed') return 'closed';
  return task.active ? 'on a branch' : null;
}

/** `2h ago`, for a note's corner. Coarser than a clock: a note is not a timer. */
export function ageLabel(at: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}
