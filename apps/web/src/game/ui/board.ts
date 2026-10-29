import {
  WORKING_IN_ZONE,
  workingInTokens,
  type AgentTask,
  type BoardAgentRef,
  type BoardItemRef,
  type BoardColor,
  type BoardStatus,
  type BoardTaskRef,
  type ChannelRef,
  type MapZone,
  type RosterEntry,
  mayMergeFromFacts,
  parsePullRequestUrl,
  repoOnList,
  type BoardGithubRef,
  type PullRequestAction,
  type PullRequestStatusRef,
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

// --- the Agents tab ----------------------------------------------------------

export type BoardTab = 'issues' | 'agents' | 'pulls';

/**
 * An agent as the Agents tab draws it: the board's row joined to the
 * roster's, so an agent that is here says what it is doing now, and one
 * that is not says when it was last heard from and what it was last on.
 */
export interface AgentRow {
  agent: BoardAgentRef;
  /** Its roster entry while it is in the office; null when it is not. */
  here: RosterEntry | null;
  /** The status line: live from the roster, else the one it last left. */
  status: string;
  /** Where the work is, or where it stands, in the office's words. Empty when away. */
  where: string;
  /** What it is on: live from the roster, else the ledger's newest task still active. */
  task: AgentTask | null;
  /** When that work began on the office's clock; 0 when idle or away. */
  workingSince: number;
  /** The notes handed to it that are not done, newest first. */
  notes: BoardItemRef[];
  /** Its other ledger lines — what it was on before, and any still open beside `task` — most recently heard first. */
  history: BoardTaskRef[];
  /** When the office last heard from it: now while it is here. Null for never. */
  lastSeenAt: number | null;
}

/**
 * Where an agent's work is, as a person would say it: the zone it stands
 * in, or the channels and DMs it is answering. The roster says ids; the
 * map and the channel list say names. An id nobody can name is left out
 * rather than printed.
 */
export function whereLabel(entry: RosterEntry, zones: readonly MapZone[], channels: readonly ChannelRef[]): string {
  const zone = zones.find((z) => z.id === entry.zoneId)?.label ?? 'the floor';
  if (entry.workingSince === 0) return zone;
  const places = workingInTokens(entry.workingIn).map((token) => {
    if (token === WORKING_IN_ZONE) return zone;
    const channel = channels.find((c) => c.id === token);
    if (!channel) return null;
    return channel.kind === 'channel' ? `#${channel.slug || channel.name}` : `DM with ${channel.name}`;
  });
  const named = places.filter((place): place is string => place !== null);
  return named.length > 0 ? named.join(', ') : zone;
}

/** The ledger's newest task of this agent still active, as a task. Null when it has none. */
function ledgerTaskOf(agentId: string, tasks: readonly BoardTaskRef[]): AgentTask | null {
  const row = tasks.find((task) => task.agentId === agentId && task.status === 'active');
  if (!row) return null;
  return {
    title: row.title,
    repo: row.repo,
    branch: row.branch,
    ...(row.pr ? { pr: row.pr } : {}),
    ...(row.item ? { item: row.item.number } : {}),
  };
}

export function agentRowsOf(
  agents: readonly BoardAgentRef[],
  roster: readonly RosterEntry[],
  items: readonly BoardItemRef[],
  tasks: readonly BoardTaskRef[],
  zones: readonly MapZone[],
  channels: readonly ChannelRef[],
  now: number,
): AgentRow[] {
  const rows = agents.map((agent): AgentRow => {
    const here = roster.find((entry) => entry.kind === 'agent' && entry.identityId === agent.id) ?? null;
    const task = here ? here.task : ledgerTaskOf(agent.id, tasks);
    return {
      agent,
      here,
      status: here ? here.status : agent.status,
      where: here ? whereLabel(here, zones, channels) : '',
      task,
      workingSince: here?.workingSince ?? 0,
      notes: items.filter((item) => item.assignee?.id === agent.id && item.status !== 'done'),
      // The ledger is upserted by (agent, branch), so the branch is what makes a line the current task.
      history: tasks.filter((line) => line.agentId === agent.id && line.branch !== task?.branch),
      lastSeenAt: here ? now : agent.lastSeenAt,
    };
  });
  // Here before away; within each, by name, so the list reads the same every time.
  return rows.sort((a, b) => Number(b.here !== null) - Number(a.here !== null) || a.agent.name.localeCompare(b.agent.name));
}

/** Does an agent row answer the filter box? By name, owner, status, branch or note number. */
export function agentMatches(row: AgentRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  if (row.agent.name.toLowerCase().includes(q)) return true;
  if (row.agent.ownerName.toLowerCase().includes(q)) return true;
  if (row.status.toLowerCase().includes(q)) return true;
  if (row.task && (row.task.branch.toLowerCase().includes(q) || row.task.title.toLowerCase().includes(q))) return true;
  if (row.history.some((line) => line.branch.toLowerCase().includes(q) || line.title.toLowerCase().includes(q))) return true;
  return row.notes.some((note) => matchesFilter(note, q));
}

// --- the Pull requests tab -----------------------------------------------------

/** Ledger lines with a pull request, as last heard, most recent first. */
export function pullRequestRowsOf(tasks: readonly BoardTaskRef[]): BoardTaskRef[] {
  return tasks.filter((task) => task.pr !== null).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

/** Ledger lines on a branch with no pull request yet, still active. */
export function branchesWithoutPr(tasks: readonly BoardTaskRef[]): BoardTaskRef[] {
  return tasks.filter((task) => task.pr === null && task.status === 'active');
}

/** Does a pull request row answer the filter box? By number, title, repo, branch, agent or note. */
export function pullRequestMatches(task: BoardTaskRef, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  const number = q.replace(/^#/, '');
  if (task.pr && String(task.pr.number) === number) return true;
  if (task.item && String(task.item.number) === number) return true;
  return [task.title, task.repo, task.branch, task.agentName, task.item?.title ?? '', task.pr?.state ?? '']
    .some((text) => text.toLowerCase().includes(q));
}

/** `github.com/acme/api` from a pull request URL, for the row; the URL itself when it is not one. */
export function repoOfPrUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const [owner, repo] = parsed.pathname.split('/').filter((part) => part.length > 0);
    return owner && repo ? `${parsed.host}/${owner}/${repo}` : parsed.host;
  } catch {
    return url;
  }
}

// --- what GitHub said, as the tab shows it -----------------------------------------

/** The state the tab shows: GitHub's when it has answered, else what the harness last said. */
export function pullStateOf(task: BoardTaskRef): 'open' | 'merged' | 'closed' {
  return task.github?.known ? task.github.state : (task.pr?.state ?? 'open');
}

/**
 * Is this line's pull request one the office may look at and act in: on
 * the office's GitHub, in a repository on its list? The office refuses
 * anything else before GitHub is called; the panel says so instead of
 * offering it.
 */
export function pullOnOfficeList(task: BoardTaskRef, github: BoardGithubRef): boolean {
  const ref = task.pr ? parsePullRequestUrl(task.pr.url) : null;
  return ref !== null && repoOnList(github.repos, ref);
}

/**
 * What a member may do to this line's pull request from the board. Nothing
 * for a repository off the office's list; nothing until GitHub has been
 * asked and says it is open; a draft is merged from GitHub, where it is
 * marked ready first; "update branch" only when GitHub says the branch is
 * behind, because that is the one thing it fixes.
 */
export function pullActionsOf(task: BoardTaskRef, office?: BoardGithubRef): PullRequestAction[] {
  if (office && !pullOnOfficeList(task, office)) return [];
  const github = task.github;
  if (!github?.known || github.state !== 'open') return [];
  const actions: PullRequestAction[] = [];
  if (mayMergeFromFacts(github)) actions.push('squash', 'merge', 'rebase');
  if (github.mergeableState === 'behind') actions.push('update_branch');
  actions.push('close');
  return actions;
}

export function pullActionLabel(action: PullRequestAction): string {
  switch (action) {
    case 'squash':
      return 'Squash and merge';
    case 'merge':
      return 'Merge';
    case 'rebase':
      return 'Rebase and merge';
    case 'update_branch':
      return 'Update branch';
    case 'close':
      return 'Close';
  }
}

/** The confirm line under a button: what exactly is about to happen, and to what. */
export function pullActionConfirm(task: BoardTaskRef, action: PullRequestAction): string {
  const number = task.pr ? `#${task.pr.number}` : 'this pull request';
  const base = task.github?.baseRef ? ` into ${task.github.baseRef}` : '';
  switch (action) {
    case 'squash':
      return `Squash ${number}${base} as one commit?`;
    case 'merge':
      return `Merge ${number}${base} with a merge commit?`;
    case 'rebase':
      return `Rebase ${number} onto ${task.github?.baseRef || 'its base'} and merge?`;
    case 'update_branch':
      return `Bring ${number} up to date with ${task.github?.baseRef || 'its base'}?`;
    case 'close':
      return `Close ${number} without merging?`;
  }
}

/** One short word on the checks, and a tone for it. */
export function checksLabel(checks: PullRequestStatusRef['checks']): { text: string; tone: 'good' | 'bad' | 'wait' | 'none' } {
  switch (checks.summary) {
    case 'passing':
      return { text: `checks ${checks.passed}/${checks.total}`, tone: 'good' };
    case 'failing':
      return { text: `${checks.failed} failing`, tone: 'bad' };
    case 'pending':
      return { text: `${checks.pending} running`, tone: 'wait' };
    default:
      return { text: 'no checks', tone: 'none' };
  }
}

/** GitHub's `mergeable_state`, in words a person uses. */
export function mergeableLabel(status: Pick<PullRequestStatusRef, 'state' | 'draft' | 'mergeable' | 'mergeableState'>): string {
  if (status.state !== 'open') return status.state;
  if (status.draft) return 'draft';
  if (status.mergeable === false || status.mergeableState === 'dirty') return 'conflicts';
  switch (status.mergeableState) {
    case 'clean':
      return 'ready to merge';
    case 'behind':
      return 'behind its base';
    case 'blocked':
      return 'blocked by a rule';
    case 'unstable':
      return 'checks not green';
    case 'has_hooks':
      return 'waiting on hooks';
    default:
      return status.mergeable === true ? 'can merge' : 'GitHub still working it out';
  }
}

export function reviewLabel(decision: PullRequestStatusRef['reviewDecision']): string | null {
  switch (decision) {
    case 'approved':
      return 'approved';
    case 'changes_requested':
      return 'changes requested';
    default:
      return null;
  }
}
