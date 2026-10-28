import type { AgentCommandCall, AgentTask, BoardItemRef, BoardStatus } from '@quintal/shared';

/**
 * What the office says when a note on the board is handed to an agent, and
 * how the board follows the task that comes of it. Pure, so it is pinned
 * without a room.
 *
 * Handing a note over is a line from the person who did it, in their DM with
 * the agent, naming it — the same way a person asks for anything here, so
 * the same rules wake the agent and keep the exchange. The brief rides along
 * the way an office command's `[Command]` does: the agent reads it as being
 * asked, and the person reads a one-line hand-over, not a form.
 */

/** `#12 Fix the chair` */
export function noteLabel(item: Pick<BoardItemRef, 'number' | 'title'>): string {
  return `#${item.number} ${item.title}`;
}

/** The line the assigner is seen to say in the DM. It names the agent, which is what reaches it. */
export function assignmentLine(item: Pick<BoardItemRef, 'number' | 'title'>, agentName: string): string {
  return `@${agentName} board note ${noteLabel(item)} is yours.`;
}

/**
 * The line to whoever had it before, if that was an agent: the note has
 * moved on, so they should not start, or carry on with, work for it.
 */
export function handoverLine(
  item: Pick<BoardItemRef, 'number' | 'title'>,
  previousAgentName: string,
  nextAgentName: string | null,
): string {
  const went = nextAgentName ? `has gone to ${nextAgentName}` : 'is no longer yours';
  return `@${previousAgentName} board note ${noteLabel(item)} ${went}.`;
}

/**
 * What the agent is asked, attached to the line. Says how the board follows
 * the work, so the agent passes the note's number to `task_begin` and the
 * office can move the note as the branch and pull request move.
 */
export function assignmentBrief(item: Pick<BoardItemRef, 'number' | 'title' | 'body' | 'labels'>): AgentCommandCall {
  const labels = item.labels.length > 0 ? `\nLabels: ${item.labels.join(', ')}` : '';
  const body = item.body.trim().length > 0 ? `\n\n${item.body.trim()}` : '';
  return {
    name: 'board',
    instructions:
      `You have been handed note #${item.number} from the office board: ${item.title}${labels}${body}\n\n` +
      `If this changes a repository, begin with task_begin and pass item ${item.number}, so the board ` +
      'follows your branch and pull request: the note moves to "in progress" when you begin and to "done" ' +
      'when the pull request merges. If it needs no repository, do it and say so here. Report here, in ' +
      'this conversation: when you pick it up, when it is up for review, and when it is blocked. If you ' +
      'cannot take it, say why.',
    args: `#${item.number}`,
    definedBy: 'the office board',
    addressed: true,
  };
}

/**
 * Where a note goes when its agent's task is heard. A note moves forward
 * only: to "in progress" when a task first takes it, to "done" when the
 * task's pull request has merged. Never back, and never when a person has
 * already moved it further — the board is theirs to move by hand any time.
 * Null when nothing changes.
 */
export function boardStatusAfterTask(
  item: Pick<BoardItemRef, 'status'>,
  heard: { linked: boolean; merged: boolean },
): BoardStatus | null {
  if (heard.merged && item.status !== 'done') return 'done';
  if (heard.linked && item.status === 'open') return 'in_progress';
  return null;
}

/** The note a task is for, as the harness said it: its number, or none. */
export function itemNumberOf(task: AgentTask): number | null {
  return task.item ?? null;
}
