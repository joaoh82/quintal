import {
  GITHUB_WEB_HOST_DEFAULT,
  parsePullRequestUrl,
  repoOnList,
  type AgentCommandCall,
  type AgentTask,
  type BoardGithubRef,
  type BoardItemRef,
  type BoardStatus,
  type BoardTaskRef,
  type RepoPullRequestRef,
} from '@quintal/shared';

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

/** A pull request someone asks an agent to review, as much as the office knows of it. */
export interface ReviewTarget {
  /** `owner/name`. */
  repo: string;
  number: number;
  url: string;
  /** Empty when the office has not heard one. */
  title: string;
  /** Empty when unknown. */
  headRef: string;
  baseRef: string;
  author: string;
}

/**
 * The pull request a URL names, as the office knows it — or null when the
 * office has no business sending an agent to it: not a pull request on the
 * office's GitHub host, or neither on the ledger nor in a repository on the
 * office's list. The same rule as acting on one: a URL to anywhere else is
 * not the office's to hand out.
 */
export function reviewTargetOf(
  url: string,
  known: {
    pulls: readonly RepoPullRequestRef[];
    tasks: readonly BoardTaskRef[];
    github: BoardGithubRef;
    host?: string;
  },
): ReviewTarget | null {
  const host = known.host ?? GITHUB_WEB_HOST_DEFAULT;
  const ref = parsePullRequestUrl(url, host);
  if (!ref) return null;
  const repo = `${ref.owner}/${ref.repo}`.toLowerCase();
  const listed = known.pulls.find((pull) => pull.repo === repo && pull.number === ref.number);
  const line = known.tasks.find((task) => {
    const other = task.pr ? parsePullRequestUrl(task.pr.url, host) : null;
    return other !== null && `${other.owner}/${other.repo}`.toLowerCase() === repo && other.number === ref.number;
  });
  if (!listed && !line && !(known.github.connected && repoOnList(known.github.repos, ref))) return null;
  const facts = line?.github?.known ? line.github : null;
  return {
    repo,
    number: ref.number,
    // Rebuilt, not echoed: what reaches the agent's brief is a pull request's address and nothing after it.
    url: listed?.url ?? line?.pr?.url ?? `https://${host}/${ref.owner}/${ref.repo}/pull/${ref.number}`,
    title: listed?.title ?? (facts?.title || line?.title || ''),
    headRef: listed?.headRef ?? (facts?.headRef || line?.branch || ''),
    baseRef: listed?.baseRef ?? facts?.baseRef ?? '',
    author: listed?.author ?? '',
  };
}

/** `acme/api#12 Fix the chair` */
export function reviewLabel(pr: Pick<ReviewTarget, 'repo' | 'number' | 'title'>): string {
  return `${pr.repo}#${pr.number}${pr.title ? ` ${pr.title}` : ''}`;
}

/** The line the person asking is seen to say in the DM. It names the agent, which is what reaches it. */
export function reviewLine(pr: Pick<ReviewTarget, 'repo' | 'number' | 'title'>, agentName: string): string {
  return `@${agentName} please review pull request ${reviewLabel(pr)}.`;
}

/**
 * What the agent is asked, attached to the line. A review is read and
 * written on GitHub, where the pull request's author will look for it; the
 * agent reads the change, does not change it, and leaves the decision to
 * merge with the people.
 */
export function reviewBrief(pr: ReviewTarget): AgentCommandCall {
  const facts = [
    `Pull request: ${pr.url}`,
    pr.title ? `Title: ${pr.title}` : null,
    pr.author ? `Opened by: ${pr.author}` : null,
    pr.headRef ? `Branch: ${pr.headRef}${pr.baseRef ? ` into ${pr.baseRef}` : ''}` : null,
  ].filter((line): line is string => line !== null);
  return {
    name: 'review',
    instructions:
      `You have been asked to review pull request #${pr.number} in ${pr.repo}.\n${facts.join('\n')}\n\n` +
      'Read the description and the whole diff (gh pr view and gh pr diff work for this), and check the ' +
      'change against the code around it: correctness first, then tests, then anything that will hurt to ' +
      'maintain. Leave your review on the pull request with gh pr review — comment, or request changes ' +
      'when something must change — with inline comments where they help. Do not approve, merge, or push ' +
      'to its branch unless you are asked to. Then say here, in this conversation, what you found, in a ' +
      'few lines. If you cannot reach the pull request, say why.',
    args: `${pr.repo}#${pr.number}`,
    definedBy: 'the office board',
    addressed: true,
  };
}
