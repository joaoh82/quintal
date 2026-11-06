import {
  GITHUB_WEB_HOST_DEFAULT,
  WORKING_IN_ZONE,
  workingInTokens,
  type AgentTask,
  type BoardAgentRef,
  type BoardItemRef,
  type BoardPullReviewRef,
  type BoardRoutineRef,
  type BoardRoutineRunRef,
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
  type RepoPullRequestRef,
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

/** `in 23m`, for when a routine is next due; `now` once the moment has come and the room has not yet ticked. */
export function untilLabel(at: number, now: number = Date.now()): string {
  const seconds = Math.round((at - now) / 1000);
  if (seconds < 30) return 'now';
  if (seconds < 3600) return `in ${Math.max(1, Math.round(seconds / 60))}m`;
  if (seconds < 86_400) return `in ${Math.floor(seconds / 3600)}h`;
  return `in ${Math.floor(seconds / 86_400)}d`;
}

// --- the Agents tab ----------------------------------------------------------

export type BoardTab = 'issues' | 'agents' | 'pulls' | 'routines';

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
  /** The reviews it was asked for from the board, every ask, newest first. Not on the ledger: a review cuts no branch. */
  reviews: BoardPullReviewRef[];
  /** The routines on it, running ones first and the soonest due at the top. */
  routines: BoardRoutineRef[];
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
  routines: readonly BoardRoutineRef[] = [],
  reviews: readonly BoardPullReviewRef[] = [],
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
      reviews: reviews.filter((review) => review.agentId === agent.id).sort((a, b) => b.at - a.at),
      routines: sortRoutines(routines.filter((routine) => routine.agentId === agent.id)),
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
  if (row.routines.some((routine) => routine.name.toLowerCase().includes(q))) return true;
  if (row.reviews.some((review) => `${review.repo}#${review.number}`.includes(q))) return true;
  return row.notes.some((note) => matchesFilter(note, q));
}

/** One line of an agent's history: a ledger task, or a review it was asked for. */
export type AgentHistoryLine =
  | { kind: 'task'; at: number; line: BoardTaskRef }
  | { kind: 'review'; at: number; review: BoardPullReviewRef };

/** A React key for one ask: its request id, or for an older ask with none, the agent and when. */
export function reviewKeyOf(review: Pick<BoardPullReviewRef, 'requestId' | 'agentId' | 'at'>): string {
  return review.requestId ?? `${review.agentId}:${review.at}`;
}

/** An agent's history as its row opens onto it: tasks and reviews together, the most recent first. */
export function agentHistoryOf(row: Pick<AgentRow, 'history' | 'reviews'>): AgentHistoryLine[] {
  const lines: AgentHistoryLine[] = [
    ...row.history.map((line) => ({ kind: 'task' as const, at: line.lastSeenAt, line })),
    ...row.reviews.map((review) => ({ kind: 'review' as const, at: review.finishedAt ?? review.at, review })),
  ];
  return lines.sort((a, b) => b.at - a.at);
}

// --- reviews asked for from the board ------------------------------------------

/**
 * How long the board waits on a review before it stops saying "reviewing".
 * The office hears a review is done from the agent's turn on it; a turn it
 * never hears end — an older harness, an office restarted under it — is
 * past saying anything about after this.
 */
export const REVIEW_WAIT_MS = 6 * 60 * 60_000;

/**
 * Where an asked-for review stands: `reviewing` while the agent's turn on
 * it is going, `reviewed` once it completed, `stopped` for one that failed
 * or was cut off, and `asked` when the office cannot say — an ask from
 * before it stamped them, or one it has waited on too long.
 */
export type ReviewStanding = 'reviewing' | 'reviewed' | 'stopped' | 'asked';

export function reviewStandingOf(review: Pick<BoardPullReviewRef, 'requestId' | 'outcome' | 'at'>, now: number): ReviewStanding {
  if (review.outcome) return review.outcome;
  if (review.requestId === null || now - review.at > REVIEW_WAIT_MS) return 'asked';
  return 'reviewing';
}

/** A review's standing in a few words: `reviewed 4m ago`, `reviewing · asked 2m ago`. */
export function reviewStandingLabel(review: BoardPullReviewRef, now: number): string {
  switch (reviewStandingOf(review, now)) {
    case 'reviewed':
      return `reviewed ${ageLabel(review.finishedAt!, now)}`;
    case 'stopped':
      return `review stopped ${ageLabel(review.finishedAt!, now)}`;
    case 'reviewing':
      return `reviewing · asked ${ageLabel(review.at, now)}`;
    case 'asked':
      return `asked ${ageLabel(review.at, now)}`;
  }
}

/**
 * A pull request's reviews from the board, summed up: `reviewed` once any
 * agent's is done, else `reviewing` while one is going, else `asked` when
 * somebody was asked, else `none`.
 */
export function pullReviewStandingOf(reviews: readonly BoardPullReviewRef[], now: number): ReviewStanding | 'none' {
  const standings = reviews.map((review) => reviewStandingOf(review, now));
  for (const standing of ['reviewed', 'reviewing', 'asked', 'stopped'] as const) {
    if (standings.includes(standing)) return standing;
  }
  return 'none';
}

// --- the Routines tab --------------------------------------------------------

/**
 * A routine as the Routines tab draws it: the office's row, whether its
 * agent is in the room to hear it, its newest runs, and whether the viewer
 * may pause it — their own agent's, by the office's rule.
 */
export interface RoutineRow {
  routine: BoardRoutineRef;
  /** Whether the agent it is on is in the office now. */
  here: boolean;
  /** Its newest runs, newest first — as many as the board carries. */
  runs: BoardRoutineRunRef[];
  /** The newest slot that was decided: spoken, skipped, or missed and waiting. Null before the first. */
  lastRun: BoardRoutineRunRef | null;
  /** Whether this is the viewer's to pause: the agent is theirs. */
  yours: boolean;
}

/**
 * Where a routine stands: `due` at its next slot; `waiting` for its agent
 * to come back and make up a missed slot, with no later slot scheduled;
 * `done`, a once routine that has had its moment; or `paused` by its owner.
 * "Paused" is only ever the owner's doing — a routine the office could not
 * speak is paused by the room and says so the same way.
 */
export type RoutineStanding = 'due' | 'waiting' | 'done' | 'paused';

export function routineStanding(routine: Pick<BoardRoutineRef, 'paused' | 'nextDueAt' | 'awaitingMakeUp'>): RoutineStanding {
  if (routine.paused) return 'paused';
  if (routine.nextDueAt !== null) return 'due';
  if (routine.awaitingMakeUp) return 'waiting';
  return 'done';
}

const STANDING_ORDER: Record<RoutineStanding, number> = { due: 0, waiting: 1, done: 2, paused: 3 };

/**
 * What fires next at the top: due routines by their slot, then those
 * waiting for their agent, then the spent, then the paused; by name within
 * each, so the list reads the same every time.
 */
export function sortRoutines<T extends Pick<BoardRoutineRef, 'name' | 'paused' | 'nextDueAt' | 'awaitingMakeUp'>>(routines: readonly T[]): T[] {
  return [...routines].sort(
    (a, b) =>
      STANDING_ORDER[routineStanding(a)] - STANDING_ORDER[routineStanding(b)] ||
      (a.nextDueAt ?? 0) - (b.nextDueAt ?? 0) ||
      a.name.localeCompare(b.name),
  );
}

export function routineRowsOf(
  routines: readonly BoardRoutineRef[],
  runs: readonly BoardRoutineRunRef[],
  roster: readonly RosterEntry[],
  you: string,
): RoutineRow[] {
  const here = new Set(roster.filter((entry) => entry.kind === 'agent').map((entry) => entry.identityId));
  return sortRoutines(routines).map((routine) => {
    const own = runs.filter((run) => run.routineId === routine.id).sort((a, b) => b.dueAt - a.dueAt);
    return {
      routine,
      here: here.has(routine.agentId),
      runs: own,
      lastRun: own[0] ?? null,
      yours: routine.ownerUserId === you,
    };
  });
}

/** Does a routine match the filter box? Its name, its agent, its cadence, the command it runs, who set it up. */
export function routineMatches(row: RoutineRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  const { routine } = row;
  if (routine.name.toLowerCase().includes(q)) return true;
  if (routine.agentName.toLowerCase().includes(q)) return true;
  if (routine.scheduleLabel.toLowerCase().includes(q)) return true;
  if (routine.command && `!${routine.command.name}`.toLowerCase().includes(q)) return true;
  if (q === 'paused') return routine.paused;
  return routine.createdByName.toLowerCase().includes(q) || routine.createdByAgentName.toLowerCase().includes(q);
}

/**
 * When a routine is next due, in a few words: `in 23m`; `when the agent is
 * back` for a missed slot waiting to be made up; `done` for a once routine
 * that has had its moment; `paused`.
 */
export function dueLabel(routine: Pick<BoardRoutineRef, 'paused' | 'nextDueAt' | 'awaitingMakeUp'>, now: number): string {
  switch (routineStanding(routine)) {
    case 'paused':
      return 'paused';
    case 'waiting':
      return 'when the agent is back';
    case 'done':
      return 'done';
    case 'due':
      return untilLabel(routine.nextDueAt!, now);
  }
}

/**
 * The agent card's one line about its routines: how many, and the next to
 * fire — `2 · next hourly PR check in 23m`; or the one waiting for the agent
 * to come back — `1 · check the deploy when it is back`. With nothing to
 * fire, why: `2, all paused`, `1, done`, `3, nothing scheduled` when the
 * reasons are mixed. Null for an agent with none: the row is left off.
 */
export function routinesLine(routines: readonly BoardRoutineRef[], now: number): string | null {
  if (routines.length === 0) return null;
  const sorted = sortRoutines(routines);
  const next = sorted[0]!;
  const standing = routineStanding(next);
  if (standing === 'due') return `${routines.length} · next ${next.name} ${untilLabel(next.nextDueAt!, now)}`;
  if (standing === 'waiting') return `${routines.length} · ${next.name} when it is back`;
  const same = sorted.every((routine) => routineStanding(routine) === standing);
  if (routines.length === 1) return `1, ${standing}`;
  return same ? `${routines.length}, all ${standing}` : `${routines.length}, nothing scheduled`;
}

// --- the Pull requests tab -----------------------------------------------------

/**
 * A pull request as the tab lists it: one of the office's repositories' as
 * GitHub listed it, an agent's from the ledger, or both joined by
 * repository and number. A ledger line's pull request off the office's list
 * is still a row, as the harness reported it.
 */
export interface PullListRow {
  key: string;
  /** `owner/name`, lower-case; the ledger's repo when the URL is not GitHub's. */
  repo: string;
  number: number;
  url: string;
  title: string;
  /** The GitHub login that opened it. Empty when only the ledger knows it. */
  author: string;
  /** The agent whose task it came from, if any. */
  agentName: string | null;
  state: 'open' | 'merged' | 'closed';
  draft: boolean;
  headRef: string;
  updatedAt: number;
  /** The ledger line, when an agent's task opened it: the facts, the actions. */
  task: BoardTaskRef | null;
  /** GitHub's list entry, when its repository is on the office's list. */
  listed: RepoPullRequestRef | null;
  /** The agents asked from the board to review it: the newest ask of each, newest first. */
  reviews: BoardPullReviewRef[];
}

function pullKey(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${number}`;
}

/**
 * Every pull request the office knows: what GitHub listed for its
 * repositories, joined with the ledger's lines, most recently moved first.
 * The ledger's newest line wins when two name the same pull request. URLs
 * are read on the office's GitHub host, so an enterprise server's pull
 * request is one row too.
 *
 * Where both have a word on its state, the newer wins: a ledger line's
 * check from before the pull request last changed on GitHub — merged,
 * closed, reopened, out of draft — gives way to the listing.
 *
 * Each row carries who was asked to review it from the board, an agent once
 * however often it was asked.
 */
export function pullListOf(
  listed: readonly RepoPullRequestRef[],
  tasks: readonly BoardTaskRef[],
  host: string = GITHUB_WEB_HOST_DEFAULT,
  reviews: readonly BoardPullReviewRef[] = [],
): PullListRow[] {
  const asked = new Map<string, BoardPullReviewRef[]>();
  for (const review of [...reviews].sort((a, b) => b.at - a.at)) {
    const key = pullKey(review.repo, review.number);
    const those = asked.get(key) ?? [];
    if (!those.some((other) => other.agentId === review.agentId)) those.push(review);
    asked.set(key, those);
  }
  const reviewsOf = (key: string): BoardPullReviewRef[] => asked.get(key) ?? [];
  const lines = new Map<string, BoardTaskRef>();
  for (const task of [...tasks].sort((a, b) => b.lastSeenAt - a.lastSeenAt)) {
    if (!task.pr) continue;
    const ref = parsePullRequestUrl(task.pr.url, host);
    const key = ref ? pullKey(`${ref.owner}/${ref.repo}`, ref.number) : task.pr.url;
    if (!lines.has(key)) lines.set(key, task);
  }
  const rows: PullListRow[] = [];
  for (const pull of listed) {
    const key = pullKey(pull.repo, pull.number);
    const task = lines.get(key) ?? null;
    lines.delete(key);
    const checked = task?.github?.known ? task.github : null;
    const facts = checked && checked.fetchedAt >= pull.updatedAt ? checked : null;
    rows.push({
      key,
      repo: pull.repo,
      number: pull.number,
      url: pull.url,
      title: pull.title,
      author: pull.author,
      agentName: task?.agentName ?? null,
      state: facts?.state ?? pull.state,
      draft: facts?.draft ?? pull.draft,
      headRef: pull.headRef,
      updatedAt: Math.max(pull.updatedAt, task?.lastSeenAt ?? 0),
      task,
      listed: pull,
      reviews: reviewsOf(key),
    });
  }
  for (const [key, task] of lines) {
    const ref = parsePullRequestUrl(task.pr!.url, host);
    const facts = task.github?.known ? task.github : null;
    rows.push({
      key,
      repo: ref ? `${ref.owner}/${ref.repo}`.toLowerCase() : task.repo,
      number: task.pr!.number,
      url: task.pr!.url,
      title: facts?.title || task.title,
      author: '',
      agentName: task.agentName,
      state: pullStateOf(task),
      draft: facts?.draft ?? false,
      headRef: task.branch,
      updatedAt: task.lastSeenAt,
      task,
      listed: null,
      reviews: ref ? reviewsOf(key) : [],
    });
  }
  return rows.sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key));
}

/**
 * What a member may do to a row's pull request: its ledger line's actions,
 * and only while the row itself — the newer word on it — says it is open.
 */
export function pullRowActionsOf(row: PullListRow, office: BoardGithubRef, host: string = GITHUB_WEB_HOST_DEFAULT): PullRequestAction[] {
  if (!row.task || row.state !== 'open') return [];
  return pullActionsOf(row.task, office, host);
}

export const PULL_STATUS_FILTERS = ['open', 'draft', 'merged', 'closed', 'all'] as const;
export type PullStatusFilter = (typeof PULL_STATUS_FILTERS)[number];

/** The review picker: any, none asked, asked and not done yet, done. */
export const PULL_REVIEW_FILTERS = ['any', 'unasked', 'waiting', 'reviewed'] as const;
export type PullReviewFilter = (typeof PULL_REVIEW_FILTERS)[number];

export const PULL_REVIEW_FILTER_LABELS: Record<PullReviewFilter, string> = {
  any: 'any review',
  unasked: 'no agent asked',
  waiting: 'awaiting review',
  reviewed: 'reviewed',
};

/** The tab's pickers. An empty author or project is anybody's, anywhere. */
export interface PullFilters {
  status: PullStatusFilter;
  review: PullReviewFilter;
  /** A GitHub login, or an agent's name. */
  author: string;
  project: string;
}

export const DEFAULT_PULL_FILTERS: PullFilters = { status: 'open', review: 'any', author: '', project: '' };

/** Who opened what is listed, for the author picker: GitHub logins, then agents, each once. */
export function pullAuthorsOf(rows: readonly PullListRow[]): { value: string; label: string }[] {
  const logins = [...new Set(rows.map((row) => row.author).filter((author) => author.length > 0))].sort((a, b) => a.localeCompare(b));
  const agents = [...new Set(rows.map((row) => row.agentName).filter((name): name is string => name !== null))]
    .filter((name) => !logins.includes(name))
    .sort((a, b) => a.localeCompare(b));
  return [...logins.map((login) => ({ value: login, label: `@${login}` })), ...agents.map((name) => ({ value: name, label: `◆ ${name}` }))];
}

/** Every project there is to pick: the office's list, and wherever the ledger's pull requests are. */
export function pullProjectsOf(rows: readonly PullListRow[], github: BoardGithubRef): string[] {
  return [...new Set([...github.repos, ...rows.map((row) => row.repo)])].sort((a, b) => a.localeCompare(b));
}

/** Does a row answer the pickers and the filter box? The box: number, note, title, repo, branch, author, agent. */
export function pullListMatches(row: PullListRow, filters: PullFilters, query: string, now: number = Date.now()): boolean {
  switch (filters.status) {
    case 'open':
      if (row.state !== 'open') return false;
      break;
    case 'draft':
      if (row.state !== 'open' || !row.draft) return false;
      break;
    case 'merged':
    case 'closed':
      if (row.state !== filters.status) return false;
      break;
    case 'all':
      break;
  }
  if (filters.review !== 'any') {
    const standing = pullReviewStandingOf(row.reviews, now);
    if (filters.review === 'unasked' && standing !== 'none') return false;
    if (filters.review === 'waiting' && standing !== 'reviewing' && standing !== 'asked') return false;
    if (filters.review === 'reviewed' && standing !== 'reviewed') return false;
  }
  if (filters.author && row.author !== filters.author && row.agentName !== filters.author) return false;
  if (filters.project && row.repo !== filters.project) return false;
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  const number = q.replace(/^#/, '');
  if (String(row.number) === number) return true;
  if (row.task?.item && String(row.task.item.number) === number) return true;
  return [row.title, row.repo, row.headRef, row.author, row.agentName ?? '', row.task?.item?.title ?? '', row.state]
    .some((text) => text.toLowerCase().includes(q));
}

/** Ledger lines on a branch with no pull request yet, still active. */
export function branchesWithoutPr(tasks: readonly BoardTaskRef[]): BoardTaskRef[] {
  return tasks.filter((task) => task.pr === null && task.status === 'active');
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
export function pullOnOfficeList(task: BoardTaskRef, github: BoardGithubRef, host: string = GITHUB_WEB_HOST_DEFAULT): boolean {
  const ref = task.pr ? parsePullRequestUrl(task.pr.url, host) : null;
  return ref !== null && repoOnList(github.repos, ref);
}

/**
 * What a member may do to this line's pull request from the board. Nothing
 * for a repository off the office's list; nothing until GitHub has been
 * asked and says it is open; a draft is merged from GitHub, where it is
 * marked ready first; "update branch" only when GitHub says the branch is
 * behind, because that is the one thing it fixes.
 */
export function pullActionsOf(task: BoardTaskRef, office?: BoardGithubRef, host: string = GITHUB_WEB_HOST_DEFAULT): PullRequestAction[] {
  if (office && !pullOnOfficeList(task, office, host)) return [];
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
