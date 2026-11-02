import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BoardItemRef } from '@quintal/shared';

import type {
  BoardAgentRef,
  BoardRoutineRef,
  BoardRoutineRunRef,
  BoardTaskRef,
  ChannelRef,
  MapZone,
  PullRequestStatusRef,
  RepoPullRequestRef,
  RosterEntry,
} from '@quintal/shared';

import {
  ageLabel,
  agentMatches,
  agentRowsOf,
  branchesWithoutPr,
  checksLabel,
  columnsOf,
  dueLabel,
  mergeableLabel,
  matchesFilter,
  nextStatus,
  pullActionConfirm,
  pullActionsOf,
  pullOnOfficeList,
  pullAuthorsOf,
  pullListMatches,
  pullListOf,
  pullRowActionsOf,
  pullProjectsOf,
  DEFAULT_PULL_FILTERS,
  pullStateOf,
  repoOfPrUrl,
  routineMatches,
  routineRowsOf,
  routinesLine,
  sortRoutines,
  taskBadgeOf,
  untilLabel,
  wallOf,
  whereLabel,
} from './board.js';

function note(number: number, extra: Partial<BoardItemRef> = {}): BoardItemRef {
  return {
    id: `i${number}`,
    number,
    title: `Note ${number}`,
    body: '',
    status: 'open',
    color: 'yellow',
    labels: [],
    assignee: null,
    createdBy: null,
    createdAt: 0,
    updatedAt: 0,
    task: null,
    ...extra,
  };
}

describe('the board, sorted for the panel', () => {
  const items = [
    note(3, { status: 'done' }),
    note(2, { status: 'in_progress' }),
    note(1),
  ];

  it('puts every note in its column, and has every column', () => {
    const columns = columnsOf(items);
    assert.deepEqual(Object.keys(columns), ['open', 'in_progress', 'done']);
    assert.deepEqual(columns.open.map((i) => i.number), [1]);
    assert.deepEqual(columns.in_progress.map((i) => i.number), [2]);
    assert.deepEqual(columns.done.map((i) => i.number), [3]);
    assert.deepEqual(columnsOf([]).done, []);
  });

  it('pins up what is not done, in progress first', () => {
    assert.deepEqual(wallOf(items).map((i) => i.number), [2, 1]);
  });

  it('moves a note one column along, and leaves done alone', () => {
    assert.equal(nextStatus('open'), 'in_progress');
    assert.equal(nextStatus('in_progress'), 'done');
    assert.equal(nextStatus('done'), null);
  });
});

describe('filtering notes', () => {
  const chair = note(12, {
    title: 'Fix the office chair',
    labels: ['bug', 'Furniture'],
    assignee: { id: 'a1', name: 'Marvin' },
  });

  it('matches nothing typed', () => {
    assert.equal(matchesFilter(chair, ''), true);
    assert.equal(matchesFilter(chair, '   '), true);
  });

  it('matches the number, a word of the title, a label, or who it is for', () => {
    assert.equal(matchesFilter(chair, '#12'), true);
    assert.equal(matchesFilter(chair, '12'), true);
    assert.equal(matchesFilter(chair, '1'), false, 'a number is whole');
    assert.equal(matchesFilter(chair, 'CHAIR'), true);
    assert.equal(matchesFilter(chair, 'furn'), true);
    assert.equal(matchesFilter(chair, 'marv'), true);
    assert.equal(matchesFilter(chair, 'tunnel'), false);
  });
});

describe('what a note\'s task says', () => {
  const task = { agent: { id: 'a1', name: 'Marvin' }, repo: 'office', branch: 'quintal/marvin/chair', pr: null, active: true };
  const pr = (state: 'open' | 'merged' | 'closed') => ({ number: 12, url: 'https://x/pull/12', state });

  it('is nothing until a task takes the note', () => {
    assert.equal(taskBadgeOf({ task: null }), null);
  });

  it('follows the pull request, and before one the branch', () => {
    assert.equal(taskBadgeOf({ task }), 'on a branch');
    assert.equal(taskBadgeOf({ task: { ...task, pr: pr('open') } }), 'in review');
    assert.equal(taskBadgeOf({ task: { ...task, pr: pr('merged'), active: false } }), 'merged');
    assert.equal(taskBadgeOf({ task: { ...task, pr: pr('closed'), active: false } }), 'closed');
  });

  it('says nothing of a task that ended without a pull request', () => {
    assert.equal(taskBadgeOf({ task: { ...task, active: false } }), null);
  });
});

describe('how old a note is', () => {
  it('reads coarsely', () => {
    const now = 1_000_000_000;
    assert.equal(ageLabel(now - 5_000, now), 'just now');
    assert.equal(ageLabel(now - 5 * 60_000, now), '5m ago');
    assert.equal(ageLabel(now - 3 * 3_600_000, now), '3h ago');
    assert.equal(ageLabel(now - 2 * 86_400_000, now), '2d ago');
    assert.equal(ageLabel(now + 60_000, now), 'just now', 'never in the future');
  });
  it('reads how long until a routine is due the same way', () => {
    const now = 1_000_000_000;
    assert.equal(untilLabel(now + 10_000, now), 'now');
    assert.equal(untilLabel(now - 60_000, now), 'now', 'a moment that has come and not yet been ticked');
    assert.equal(untilLabel(now + 23 * 60_000, now), 'in 23m');
    assert.equal(untilLabel(now + 90_000, now), 'in 2m', 'to the nearest minute, never "in 0m"');
    assert.equal(untilLabel(now + 3 * 3_600_000, now), 'in 3h');
    assert.equal(untilLabel(now + 2 * 86_400_000, now), 'in 2d');
  });
});

describe('the Routines tab', () => {
  const now = 1_000_000_000;
  const hourly = routine('hourly', { name: 'hourly PR check', nextDueAt: now + 23 * 60_000, lastRunAt: now - 37 * 60_000 });
  const daily = routine('daily', { name: 'daily board look', agentId: 'zaphod', agentName: 'zaphod', ownerUserId: 'u2', scheduleLabel: 'daily at 09:00', nextDueAt: now + 5 * 3_600_000 });
  const paused = routine('paused', { name: 'weekly digest', paused: true, nextDueAt: null, command: { id: 'c1', name: 'digest' } });
  const once = routine('once', { name: 'check the deploy', nextDueAt: null, scheduleLabel: 'once, on 2 Nov 2026 at 09:00' });
  /** A once routine whose agent was away: its slot is claimed, missed, and waits for the agent. */
  const waiting = routine('waiting', { name: 'check the deploy', nextDueAt: null, awaitingMakeUp: true, scheduleLabel: 'once, on 2 Nov 2026 at 09:00' });
  const runs = [
    run('r1', { routineId: 'hourly', dueAt: now - 97 * 60_000, outcome: 'missed', note: 'away' }),
    run('r2', { routineId: 'hourly', dueAt: now - 37 * 60_000, firedAt: now - 37 * 60_000 + 3_000 }),
    run('r3', { routineId: 'daily', dueAt: now - 19 * 3_600_000, outcome: 'skipped', note: 'busy' }),
  ];

  it('puts what fires next at the top, then what waits for its agent, then the spent, then the paused', () => {
    assert.deepEqual(sortRoutines([paused, once, daily, waiting, hourly]).map((r) => r.id), ['hourly', 'daily', 'waiting', 'once', 'paused']);
  });

  it('joins each routine to its runs, newest first, and says whose it is to pause', () => {
    const rows = routineRowsOf([paused, daily, hourly], runs, [here('marvin')], 'u1');
    assert.deepEqual(rows.map((row) => row.routine.id), ['hourly', 'daily', 'paused']);
    const [first, second, third] = rows;
    assert.deepEqual(first!.runs.map((r) => r.id), ['r2', 'r1']);
    assert.equal(first!.lastRun?.id, 'r2');
    assert.equal(first!.here, true, 'marvin is in the room');
    assert.equal(first!.yours, true);
    assert.equal(second!.here, false);
    assert.equal(second!.yours, false, "another member's agent");
    assert.equal(second!.lastRun?.note, 'busy');
    assert.equal(third!.lastRun, null, 'no slot has come');
  });

  it('finds a routine by its name, its agent, its cadence, its command, or who set it up', () => {
    const [row] = routineRowsOf([paused], [], [], 'u1');
    assert.equal(routineMatches(row!, 'digest'), true, 'the name');
    assert.equal(routineMatches(row!, '!digest'), true, 'the command');
    assert.equal(routineMatches(row!, 'marvin'), true, 'the agent');
    assert.equal(routineMatches(row!, 'every hour'), true, 'the cadence');
    assert.equal(routineMatches(row!, 'josh'), true, 'who set it up');
    assert.equal(routineMatches(row!, 'paused'), true);
    assert.equal(routineMatches(row!, 'zaphod'), false);
    const [running] = routineRowsOf([hourly], [], [], 'u1');
    assert.equal(routineMatches(running!, 'paused'), false, '"paused" finds only paused ones');
  });

  it('says when a routine is next due in a few words, and keeps "paused" for the owner’s doing', () => {
    assert.equal(dueLabel(hourly, now), 'in 23m');
    assert.equal(dueLabel(paused, now), 'paused');
    assert.equal(dueLabel(once, now), 'done', 'a once routine that was spoken');
    assert.equal(dueLabel(waiting, now), 'when the agent is back', 'a once routine the agent was away for still fires');
    assert.equal(dueLabel({ ...hourly, awaitingMakeUp: true }, now), 'in 23m', 'a missed slot on a repeating routine does not hide its next');
  });

  it("gives the agent's card one line: how many, and the next to fire", () => {
    assert.equal(routinesLine([], now), null, 'no row for an agent with none');
    assert.equal(routinesLine([paused, hourly], now), '2 · next hourly PR check in 23m');
    assert.equal(routinesLine([paused, waiting], now), '2 · check the deploy when it is back', 'a slot waiting for the agent is the next to fire');
    assert.equal(routinesLine([paused], now), '1, paused');
    assert.equal(routinesLine([once], now), '1, done');
    assert.equal(routinesLine([paused, paused], now), '2, all paused');
    assert.equal(routinesLine([paused, once], now), '2, nothing scheduled', 'a spent once routine is not paused');
  });

  it('hangs each agent’s routines on its row, soonest first, and the filter finds an agent by one', () => {
    const [row] = agentRowsOf([agent('marvin')], [], [], [], zones, channels, now, [paused, daily, hourly]);
    assert.deepEqual(row!.routines.map((r) => r.id), ['hourly', 'paused'], "marvin's only, running first");
    assert.equal(agentMatches(row!, 'weekly digest'), true);
  });
});

function agent(id: string, extra: Partial<BoardAgentRef> = {}): BoardAgentRef {
  return {
    id,
    name: id,
    ownerUserId: 'u1',
    ownerName: 'Josh',
    description: '',
    status: '',
    lastSeenAt: null,
    runtimeId: null,
    modelId: null,
    hostLabel: null,
    ...extra,
  };
}

function here(identityId: string, extra: Partial<RosterEntry> = {}): RosterEntry {
  return {
    sessionId: `s-${identityId}`,
    name: identityId,
    kind: 'agent',
    status: '',
    isSelf: false,
    ownerName: 'Josh',
    ownerUserId: 'u1',
    scopes: [],
    runtimeId: '',
    modelId: '',
    identityId,
    lastActionAt: 0,
    zoneId: 'lobby',
    emote: '',
    workingIn: '',
    workingSince: 0,
    isGuest: false,
    description: '',
    pubkey: '',
    avatar: '',
    task: null,
    ...extra,
  };
}

function routine(id: string, extra: Partial<BoardRoutineRef> = {}): BoardRoutineRef {
  return {
    id,
    agentId: 'marvin',
    agentName: 'marvin',
    ownerUserId: 'u1',
    name: id,
    schedule: { kind: 'cron', cron: '0 * * * *', tz: 'UTC' },
    scheduleLabel: 'every hour',
    command: null,
    paused: false,
    nextDueAt: 0,
    awaitingMakeUp: false,
    lastRunAt: null,
    createdByName: 'Josh',
    createdByAgentName: '',
    updatedAt: 0,
    ...extra,
  };
}

function run(id: string, extra: Partial<BoardRoutineRunRef> = {}): BoardRoutineRunRef {
  return { id, routineId: 'hourly', dueAt: 0, outcome: 'fired', note: '', firedAt: null, ...extra };
}

function ledger(id: string, extra: Partial<BoardTaskRef> = {}): BoardTaskRef {
  return {
    id,
    agentId: 'marvin',
    agentName: 'marvin',
    item: null,
    title: `task ${id}`,
    repo: 'api',
    branch: `quintal/marvin/${id}`,
    pr: null,
    status: 'active',
    startedAt: 0,
    endedAt: null,
    lastSeenAt: 0,
    github: null,
    ...extra,
  };
}

const zones: MapZone[] = [{ id: 'focus', kind: 'common', label: 'Focus room', bounds: { x: 0, y: 0, width: 1, height: 1 } }];
const channels: ChannelRef[] = [
  { id: 'ch-1', kind: 'channel', name: 'Engineering', slug: 'engineering' },
  { id: 'dm-1', kind: 'dm', name: 'Josh', slug: '' },
];

describe('where an agent is', () => {
  it('names the zone it stands in when idle, and the floor outside every zone', () => {
    assert.equal(whereLabel(here('a', { zoneId: 'focus' }), zones, channels), 'Focus room');
    assert.equal(whereLabel(here('a', { zoneId: 'nowhere' }), zones, channels), 'the floor');
  });

  it('names the channels and DMs it is answering, and the zone for spatial work', () => {
    const busy = here('a', { zoneId: 'focus', workingSince: 5, workingIn: 'ch-1,dm-1,zone' });
    assert.equal(whereLabel(busy, zones, channels), '#engineering, DM with Josh, Focus room');
  });

  it('falls back to the zone when the work is somewhere it cannot name', () => {
    assert.equal(whereLabel(here('a', { zoneId: 'focus', workingSince: 5, workingIn: 'gone' }), zones, channels), 'Focus room');
  });
});

describe('the Agents tab', () => {
  const task = { title: 'fix the chair', repo: 'api', branch: 'quintal/marvin/chair' };
  const agents = [agent('zaphod', { status: 'last seen fixing', lastSeenAt: 100 }), agent('marvin')];
  const roster = [here('marvin', { status: 'reading', zoneId: 'focus', workingSince: 7, task })];
  const items = [
    note(1, { assignee: { id: 'marvin', name: 'marvin' } }),
    note(2, { assignee: { id: 'marvin', name: 'marvin' }, status: 'done' }),
    note(3, { assignee: { id: 'zaphod', name: 'zaphod' } }),
  ];

  it('puts who is here first, live, and the rest by what the office last knew', () => {
    const rows = agentRowsOf(agents, roster, items, [ledger('t1', { agentId: 'zaphod', pr: null })], zones, channels, 1000);
    assert.deepEqual(rows.map((row) => row.agent.id), ['marvin', 'zaphod']);
    const [marvin, zaphod] = rows;
    assert.equal(marvin!.here?.identityId, 'marvin');
    assert.equal(marvin!.status, 'reading', 'the live status line');
    assert.equal(marvin!.where, 'Focus room');
    assert.deepEqual(marvin!.task, task, 'the roster says what it is on');
    assert.equal(marvin!.workingSince, 7);
    assert.equal(marvin!.lastSeenAt, 1000, 'here means heard from now');
    assert.deepEqual(marvin!.notes.map((n) => n.number), [1], 'done notes are not open work');
    assert.equal(zaphod!.here, null);
    assert.equal(zaphod!.status, 'last seen fixing', 'the line it left');
    assert.equal(zaphod!.where, '');
    assert.equal(zaphod!.task?.branch, 'quintal/marvin/t1', "the ledger's active task");
    assert.equal(zaphod!.lastSeenAt, 100);
  });

  it('shows an away agent no task once the ledger says it ended', () => {
    const [row] = agentRowsOf([agent('zaphod')], [], [], [ledger('t1', { agentId: 'zaphod', status: 'ended' })], zones, channels, 0);
    assert.equal(row!.task, null);
  });

  it("gives each agent its other ledger lines as history, not the task it is on", () => {
    const tasks = [
      ledger('now', { agentId: 'zaphod', lastSeenAt: 30 }),
      ledger('before', { agentId: 'zaphod', status: 'ended', lastSeenAt: 20 }),
      ledger('someone-else', { agentId: 'marvin', status: 'ended', lastSeenAt: 15 }),
      ledger('long-ago', { agentId: 'zaphod', status: 'ended', lastSeenAt: 10 }),
    ];
    const [row] = agentRowsOf([agent('zaphod')], [], [], tasks, zones, channels, 0);
    assert.equal(row!.task?.branch, 'quintal/marvin/now');
    assert.deepEqual(row!.history.map((line) => line.id), ['before', 'long-ago']);
    assert.equal(agentMatches(row!, 'long-ago'), true, 'the filter finds an agent by what it was on');
  });

  it('answers the filter by name, owner, status, branch or note', () => {
    const [marvin] = agentRowsOf([agent('marvin')], roster, items, [], zones, channels, 0);
    assert.equal(agentMatches(marvin!, 'marv'), true);
    assert.equal(agentMatches(marvin!, 'josh'), true);
    assert.equal(agentMatches(marvin!, 'reading'), true);
    assert.equal(agentMatches(marvin!, 'chair'), true);
    assert.equal(agentMatches(marvin!, '#1'), true);
    assert.equal(agentMatches(marvin!, 'zaphod'), false);
  });
});

describe('the Pull requests tab', () => {
  const pr = (number: number, state: 'open' | 'merged' | 'closed') => ({ number, url: `https://github.com/acme/api/pull/${number}`, state });
  const tasks = [
    ledger('old', { pr: pr(1, 'merged'), lastSeenAt: 10, status: 'ended' }),
    ledger('branch-only'),
    ledger('new', { pr: pr(2, 'open'), lastSeenAt: 20, item: { id: 'i7', number: 7, title: 'Fix the chair' } }),
    ledger('done-branch', { status: 'ended' }),
  ];

  const listed = (number: number, extra: Partial<RepoPullRequestRef> = {}): RepoPullRequestRef => ({
    repo: 'acme/api',
    number,
    url: `https://github.com/acme/api/pull/${number}`,
    title: `Listed ${number}`,
    author: 'trillian',
    state: 'open',
    draft: false,
    headRef: `head-${number}`,
    baseRef: 'main',
    headSha: 'abc',
    createdAt: 0,
    updatedAt: 15,
    ...extra,
  });

  it("joins GitHub's list with the ledger, and keeps the ledger's pull requests GitHub did not list", () => {
    const rows = pullListOf([listed(2, { updatedAt: 5 }), listed(3, { repo: 'acme/web', url: 'https://github.com/acme/web/pull/3' })], tasks);
    assert.deepEqual(
      rows.map((row) => [row.key, row.task?.id ?? null, row.author, row.agentName]),
      [
        ['acme/api#2', 'new', 'trillian', 'marvin'],
        ['acme/web#3', null, 'trillian', null],
        ['acme/api#1', 'old', '', 'marvin'],
      ],
      'most recently moved first: #2 heard at 20, #3 listed at 15, #1 heard at 10',
    );
    assert.equal(rows[0]!.title, 'Listed 2', "GitHub's title over the task's");
  });

  it('says which agents were asked to review each pull request, each once, newest first', () => {
    const ask = (agentId: string, at: number, number = 3) => ({
      url: `https://github.com/acme/web/pull/${number}`,
      repo: 'acme/web',
      number,
      agentId,
      agentName: agentId === 'a1' ? 'Marvin' : 'Eddie',
      byName: 'Arthur',
      at,
    });
    const rows = pullListOf(
      [listed(2), listed(3, { repo: 'acme/web', url: 'https://github.com/acme/web/pull/3' })],
      tasks,
      undefined,
      [ask('a1', 10), ask('a2', 30), ask('a1', 20), ask('a1', 5, 9)],
    );
    const web = rows.find((row) => row.key === 'acme/web#3')!;
    assert.deepEqual(
      web.reviews.map((review) => [review.agentName, review.at]),
      [
        ['Eddie', 30],
        ['Marvin', 20],
      ],
    );
    assert.deepEqual(rows.find((row) => row.key === 'acme/api#2')!.reviews, [], 'another pull request was asked of nobody');
  });

  it('counts the branches still active with no pull request yet', () => {
    assert.deepEqual(branchesWithoutPr(tasks).map((t) => t.id), ['branch-only']);
  });

  it('filters by status, author and project', () => {
    const rows = pullListOf([listed(4, { draft: true }), listed(5, { state: 'closed', author: 'ford', repo: 'acme/web' })], tasks);
    const keys = (filters: Partial<typeof DEFAULT_PULL_FILTERS>) =>
      rows.filter((row) => pullListMatches(row, { ...DEFAULT_PULL_FILTERS, ...filters }, '')).map((row) => row.number);
    assert.deepEqual(keys({}), [2, 4], 'open, drafts included, by default');
    assert.deepEqual(keys({ status: 'draft' }), [4]);
    assert.deepEqual(keys({ status: 'merged' }), [1]);
    assert.deepEqual(keys({ status: 'closed' }), [5]);
    assert.deepEqual(keys({ status: 'all', author: 'ford' }), [5]);
    assert.deepEqual(keys({ status: 'all', author: 'marvin' }), [2, 1], "an agent's, by its name");
    assert.deepEqual(keys({ status: 'all', project: 'acme/web' }), [5]);
    assert.deepEqual(
      pullAuthorsOf(rows).map((author) => author.label),
      ['@ford', '@trillian', '◆ marvin'],
    );
    assert.deepEqual(pullProjectsOf(rows, { connected: true, login: null, repos: ['acme/zz'] }), ['acme/api', 'acme/web', 'acme/zz']);
  });

  it('answers the filter box by PR number, note number, title, repo, branch, author or agent', () => {
    const row = pullListOf([], tasks)[0]!;
    const all = { ...DEFAULT_PULL_FILTERS, status: 'all' as const };
    assert.equal(pullListMatches(row, all, '#2'), true);
    assert.equal(pullListMatches(row, all, '7'), true, 'the note it is for');
    assert.equal(pullListMatches(row, all, 'chair'), true);
    assert.equal(pullListMatches(row, all, 'api'), true);
    assert.equal(pullListMatches(row, all, 'marvin'), true);
    assert.equal(pullListMatches(row, all, '#1'), false);
  });

  it('names the repository from the pull request URL', () => {
    assert.equal(repoOfPrUrl('https://github.com/acme/api/pull/12'), 'github.com/acme/api');
    assert.equal(repoOfPrUrl('https://example.com/'), 'example.com');
    assert.equal(repoOfPrUrl('not a url'), 'not a url');
  });
});


describe('what GitHub said, as the tab shows it', () => {
  const line: BoardTaskRef = {
    id: 't',
    agentId: 'a',
    agentName: 'Marvin',
    item: null,
    title: 'fix the chair',
    repo: 'office',
    branch: 'b',
    pr: { number: 12, url: 'https://github.com/acme/office/pull/12', state: 'open' },
    status: 'active',
    startedAt: 0,
    endedAt: null,
    lastSeenAt: 0,
    github: null,
  };
  const facts: PullRequestStatusRef = {
    state: 'open',
    draft: false,
    title: 'Fix the chair',
    headSha: 'abc',
    headRef: 'b',
    baseRef: 'main',
    mergeable: true,
    mergeableState: 'clean',
    checks: { summary: 'passing', total: 2, passed: 2, failed: 0, pending: 0, runs: [] },
    reviewDecision: 'approved',
    fetchedAt: 0,
    error: null,
    lastAction: null,
    known: true,
  };

  it('shows GitHub’s state once it has answered, else the harness’s', () => {
    assert.equal(pullStateOf(line), 'open');
    assert.equal(pullStateOf({ ...line, github: { ...facts, state: 'merged' } }), 'merged');
    assert.equal(pullStateOf({ ...line, github: { ...facts, known: false, state: 'merged' } }), 'open', 'a failed first look is not an answer');
  });

  it('lets the newer of the listing and the check say what state a pull request is in', () => {
    const office = { connected: true, login: 'josh', repos: ['acme/office'] };
    const listedAs = (state: 'open' | 'merged' | 'closed', updatedAt: number): RepoPullRequestRef => ({
      repo: 'acme/office',
      number: 12,
      url: 'https://github.com/acme/office/pull/12',
      title: 'fix the chair',
      author: 'josh',
      state,
      draft: false,
      headRef: 'b',
      baseRef: 'main',
      headSha: 'abc',
      createdAt: 0,
      updatedAt,
    });
    const closedLine = { ...line, status: 'ended' as const, github: { ...facts, state: 'closed' as const, fetchedAt: 1000 } };
    const [reopened] = pullListOf([listedAs('open', 3000)], [closedLine]);
    assert.equal(reopened!.state, 'open', 'reopened on GitHub after the last check: the listing is newer');
    assert.deepEqual(pullRowActionsOf(reopened!, office), [], 'but the actions wait for a check that says open');

    const openLine = { ...line, github: { ...facts, fetchedAt: 1000 } };
    const [merged] = pullListOf([listedAs('merged', 3000)], [openLine]);
    assert.equal(merged!.state, 'merged', 'merged since the last check');
    assert.deepEqual(pullRowActionsOf(merged!, office), [], 'so nothing is offered to merge or close it again');

    const [fresh] = pullListOf([listedAs('open', 500)], [{ ...line, github: { ...facts, state: 'merged', fetchedAt: 1000 } }]);
    assert.equal(fresh!.state, 'merged', 'a check after the listing is the newer word');
  });

  it("reads the ledger's URLs on the office's own GitHub host, so an enterprise pull request is one row", () => {
    const host = 'git.acme.test';
    const enterprise = { ...line, pr: { ...line.pr!, url: 'https://git.acme.test/acme/office/pull/12' } };
    const listedThere: RepoPullRequestRef = {
      repo: 'acme/office',
      number: 12,
      url: 'https://git.acme.test/acme/office/pull/12',
      title: 'fix the chair',
      author: 'josh',
      state: 'open',
      draft: false,
      headRef: 'b',
      baseRef: 'main',
      headSha: 'abc',
      createdAt: 0,
      updatedAt: 0,
    };
    const rows = pullListOf([listedThere], [enterprise], host);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.task?.id, 't');
    const office = { connected: true, login: 'josh', repos: ['acme/office'] };
    assert.equal(pullOnOfficeList(enterprise, office, host), true);
    assert.equal(pullOnOfficeList(enterprise, office), false, 'not on github.com');
  });

  it('offers nothing until GitHub has answered, and nothing on a closed one', () => {
    assert.deepEqual(pullActionsOf(line), []);
    assert.deepEqual(pullActionsOf({ ...line, github: { ...facts, state: 'merged' } }), []);
  });

  it('offers nothing in a repository off the office’s list, and says which lines are on it', () => {
    const office = { connected: true, login: 'josh', repos: ['acme/office'] };
    assert.equal(pullOnOfficeList(line, office), true);
    assert.deepEqual(pullActionsOf({ ...line, github: facts }, office), ['squash', 'merge', 'rebase', 'close']);
    const elsewhere = { ...line, pr: { number: 88, url: 'https://github.com/acme/payments/pull/88', state: 'open' as const } };
    assert.equal(pullOnOfficeList(elsewhere, office), false);
    assert.deepEqual(pullActionsOf({ ...elsewhere, github: facts }, office), []);
    assert.equal(pullOnOfficeList(line, { ...office, repos: [] }), false, 'an empty list is nothing');
  });

  it('offers the three merges and close on a clean open one, update branch only when behind, no merge on a draft or conflicts', () => {
    assert.deepEqual(pullActionsOf({ ...line, github: facts }), ['squash', 'merge', 'rebase', 'close']);
    assert.deepEqual(pullActionsOf({ ...line, github: { ...facts, mergeableState: 'behind' } }), ['squash', 'merge', 'rebase', 'update_branch', 'close']);
    assert.deepEqual(pullActionsOf({ ...line, github: { ...facts, draft: true } }), ['close']);
    assert.deepEqual(pullActionsOf({ ...line, github: { ...facts, mergeable: false, mergeableState: 'dirty' } }), ['close']);
  });

  it('says exactly what is about to happen', () => {
    assert.equal(pullActionConfirm({ ...line, github: facts }, 'squash'), 'Squash #12 into main as one commit?');
    assert.equal(pullActionConfirm({ ...line, github: facts }, 'close'), 'Close #12 without merging?');
    assert.equal(pullActionConfirm({ ...line, github: { ...facts, mergeableState: 'behind' } }, 'update_branch'), 'Bring #12 up to date with main?');
  });

  it('puts the checks and the mergeability in a word', () => {
    assert.deepEqual(checksLabel(facts.checks), { text: 'checks 2/2', tone: 'good' });
    assert.deepEqual(checksLabel({ ...facts.checks, summary: 'failing', failed: 1 }), { text: '1 failing', tone: 'bad' });
    assert.equal(mergeableLabel(facts), 'ready to merge');
    assert.equal(mergeableLabel({ ...facts, mergeableState: 'behind' }), 'behind its base');
    assert.equal(mergeableLabel({ ...facts, mergeable: false, mergeableState: 'dirty' }), 'conflicts');
    assert.equal(mergeableLabel({ ...facts, draft: true }), 'draft');
    assert.equal(mergeableLabel({ ...facts, state: 'merged' }), 'merged');
  });
});
