import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BoardItemRef } from '@quintal/shared';

import type { BoardAgentRef, BoardTaskRef, ChannelRef, MapZone, PullRequestStatusRef, RosterEntry } from '@quintal/shared';

import {
  ageLabel,
  agentMatches,
  agentRowsOf,
  branchesWithoutPr,
  checksLabel,
  columnsOf,
  mergeableLabel,
  matchesFilter,
  nextStatus,
  pullActionConfirm,
  pullActionsOf,
  pullRequestMatches,
  pullRequestRowsOf,
  pullStateOf,
  repoOfPrUrl,
  taskBadgeOf,
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

  it('lists the lines with a pull request, newest heard first', () => {
    assert.deepEqual(pullRequestRowsOf(tasks).map((t) => t.id), ['new', 'old']);
  });

  it('counts the branches still active with no pull request yet', () => {
    assert.deepEqual(branchesWithoutPr(tasks).map((t) => t.id), ['branch-only']);
  });

  it('answers the filter by PR number, note number, title, repo, branch, agent or state', () => {
    const row = pullRequestRowsOf(tasks)[0]!;
    assert.equal(pullRequestMatches(row, '#2'), true);
    assert.equal(pullRequestMatches(row, '7'), true, 'the note it is for');
    assert.equal(pullRequestMatches(row, 'chair'), true);
    assert.equal(pullRequestMatches(row, 'api'), true);
    assert.equal(pullRequestMatches(row, 'marvin'), true);
    assert.equal(pullRequestMatches(row, 'open'), true);
    assert.equal(pullRequestMatches(row, '#1'), false);
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

  it('offers nothing until GitHub has answered, and nothing on a closed one', () => {
    assert.deepEqual(pullActionsOf(line), []);
    assert.deepEqual(pullActionsOf({ ...line, github: { ...facts, state: 'merged' } }), []);
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
