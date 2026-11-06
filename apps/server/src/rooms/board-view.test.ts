import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NO_REPO_PULLS, type BoardAgentRef, type BoardRoutineRef, type BoardTaskRef, type PullRequestStatusRef, type RepoPullsRef } from '@quintal/shared';
import type { RoutineRunRef, RoutineSummary } from '@quintal/shared/db';

import { boardAgentsOf, boardForRole, boardRoutineRunsOf, boardRoutinesOf, boardSignatureOf } from './board-view.js';

/** A whole minute, so what rounding does is plain. */
const MINUTE = 1_700_000_040_000;

const marvin: BoardAgentRef = {
  id: 'a1',
  name: 'Marvin',
  ownerUserId: 'u1',
  ownerName: 'Josh',
  description: 'Reviews pull requests.',
  status: 'reading auth.ts',
  lastSeenAt: MINUTE + 12_345,
  runtimeId: 'claude-code',
  modelId: 'claude-opus-5-5',
  hostLabel: "Josh's laptop",
};

const task: BoardTaskRef = {
  id: 't1',
  agentId: 'a1',
  agentName: 'Marvin',
  item: null,
  title: 'fix the chair',
  repo: 'acme/office',
  branch: 'quintal/marvin/fix-the-chair',
  pr: { number: 12, url: 'https://github.com/acme/office/pull/12', state: 'open' },
  status: 'active',
  startedAt: 1000,
  endedAt: null,
  lastSeenAt: 2000,
  github: null,
};

const GITHUB = { connected: true, login: 'josh', repos: ['acme/office'] };

const PULLS: RepoPullsRef = {
  pulls: [
    {
      repo: 'acme/office',
      number: 13,
      url: 'https://github.com/acme/office/pull/13',
      title: 'Paint the lobby',
      author: 'trillian',
      state: 'open',
      draft: false,
      headRef: 'paint',
      baseRef: 'main',
      headSha: 'abc',
      createdAt: 1000,
      updatedAt: 2000,
    },
  ],
  // On a five-minute mark, so a minute later is the same grain.
  fetchedAt: 1_700_000_100_000,
  errors: [],
};

const checked: PullRequestStatusRef = {
  state: 'open',
  draft: false,
  title: 'fix the chair',
  headSha: 'abc',
  headRef: 'quintal/marvin/fix-the-chair',
  baseRef: 'main',
  mergeable: true,
  mergeableState: 'clean',
  checks: { summary: 'passing', total: 1, passed: 1, failed: 0, pending: 0, runs: [] },
  reviewDecision: 'none',
  fetchedAt: 1_700_000_100_000 + 1000, // a thousand past a five-minute mark
  error: null,
  lastAction: null,
  known: true,
};

const ROUTINE: RoutineSummary = {
  id: 'r1',
  workspaceId: 'w1',
  agentId: 'a1',
  agentName: 'Marvin',
  agentOwnerUserId: 'u1',
  name: 'hourly PR check',
  schedule: { kind: 'cron', cron: '0 * * * *', tz: 'Europe/Lisbon' },
  scheduleLabel: 'every hour',
  instructions: 'Review the open pull requests and say what you found.',
  command: null,
  args: '',
  paused: false,
  nextDueAt: MINUTE + 3_600_000,
  lastRunAt: MINUTE,
  createdBy: 'u1',
  createdByName: 'Josh',
  createdByAgentId: null,
  createdByAgentName: '',
  createdAt: 0,
  updatedAt: 0,
};

const RUN: RoutineRunRef = {
  id: 'run1',
  routineId: 'r1',
  dueAt: MINUTE,
  outcome: 'fired',
  note: '',
  firedAt: MINUTE + 2_000,
  conversationId: 'dm-1',
  createdAt: MINUTE,
};

const REVIEW = {
  url: 'https://github.com/acme/api/pull/7',
  repo: 'acme/api',
  number: 7,
  agentId: 'a1',
  agentName: 'Marvin',
  byName: 'Arthur',
  at: MINUTE,
  requestId: null,
  finishedAt: null,
  outcome: null,
};

describe('what the board is sent, and when', () => {
  it('does not count an agent being heard from as the board changing', () => {
    const before = { items: [], agents: boardAgentsOf([marvin]), tasks: [task], github: GITHUB, pulls: NO_REPO_PULLS, reviews: [], routines: [], routineRuns: [] };
    const heard = { ...marvin, lastSeenAt: marvin.lastSeenAt! + 40_000 };
    const after = { items: [], agents: boardAgentsOf([heard]), tasks: [task], github: GITHUB, pulls: NO_REPO_PULLS, reviews: [], routines: [], routineRuns: [] };
    assert.equal(boardSignatureOf(after), boardSignatureOf(before), 'the same minute is the same board');

    const later = { ...marvin, lastSeenAt: marvin.lastSeenAt! + 60_000 };
    assert.notEqual(boardSignatureOf({ ...after, agents: boardAgentsOf([later]) }), boardSignatureOf(before));
  });

  it('keeps the time to the minute, and never for an agent never heard from', () => {
    const [rounded, never] = boardAgentsOf([marvin, { ...marvin, id: 'a2', lastSeenAt: null }]);
    assert.equal(rounded?.lastSeenAt, MINUTE, 'down to the minute');
    assert.equal(never?.lastSeenAt, null);
  });

  it('does not count GitHub being asked again as the board changing, unless the answer differs', () => {
    const view = (github: PullRequestStatusRef) => ({ items: [], agents: [], tasks: [{ ...task, github }], github: GITHUB, pulls: NO_REPO_PULLS, reviews: [], routines: [], routineRuns: [] });
    const first = boardSignatureOf(view(checked));
    assert.equal(boardSignatureOf(view({ ...checked, fetchedAt: checked.fetchedAt + 60_000 })), first, 'a minute later, the same facts');
    assert.notEqual(boardSignatureOf(view({ ...checked, fetchedAt: checked.fetchedAt + 5 * 60_000 })), first, 'five minutes later it is sent once, so "checked … ago" catches up');
    assert.notEqual(boardSignatureOf(view({ ...checked, checks: { ...checked.checks, summary: 'failing' } })), first, 'a check failing is a change');
    assert.notEqual(boardSignatureOf(view({ ...checked, error: 'rate limit' })), first, 'so is GitHub refusing');
  });

  it("does not count listing the repositories again as the board changing, unless the list differs", () => {
    const view = (pulls: RepoPullsRef) => ({ items: [], agents: [], tasks: [], github: GITHUB, pulls, reviews: [], routines: [], routineRuns: [] });
    const first = boardSignatureOf(view(PULLS));
    assert.equal(boardSignatureOf(view({ ...PULLS, fetchedAt: PULLS.fetchedAt! + 60_000 })), first);
    assert.notEqual(boardSignatureOf(view({ ...PULLS, pulls: [{ ...PULLS.pulls[0]!, state: 'merged' }] })), first);
  });

  it('counts somebody being asked to review as the board changing', () => {
    const view = { items: [], agents: [], tasks: [], github: GITHUB, pulls: PULLS, reviews: [], routines: [], routineRuns: [] };
    assert.notEqual(boardSignatureOf({ ...view, reviews: [REVIEW], routines: [], routineRuns: [] }), boardSignatureOf(view));
  });

  it('carries a routine without its words, and a run without its conversation', () => {
    const [routine] = boardRoutinesOf([ROUTINE], [RUN]);
    assert.equal(routine?.name, 'hourly PR check');
    assert.equal(routine?.ownerUserId, 'u1');
    assert.equal(routine?.nextDueAt, ROUTINE.nextDueAt);
    assert.equal(routine?.awaitingMakeUp, false, 'its newest slot was spoken');
    assert.ok(!('instructions' in (routine as object)), 'the brief stays in Settings and the DM');
    assert.ok(!JSON.stringify(routine).includes('Review the open'), 'nothing sent quotes it');
    const [run] = boardRoutineRunsOf([RUN]);
    assert.deepEqual(run, { id: 'run1', routineId: 'r1', dueAt: MINUTE, outcome: 'fired', note: '', firedAt: MINUTE + 2_000 });
  });

  it('says a routine whose newest slot is missed waits for its agent, so a once routine is not shown done', () => {
    const once: RoutineSummary = { ...ROUTINE, id: 'r2', schedule: { kind: 'once', at: MINUTE, tz: 'UTC' }, nextDueAt: null, lastRunAt: null };
    const missed: RoutineRunRef = { ...RUN, id: 'run2', routineId: 'r2', outcome: 'missed', note: 'away', firedAt: null };
    const [hourly, waiting] = boardRoutinesOf([ROUTINE, once], [missed, RUN]);
    assert.equal(waiting?.awaitingMakeUp, true);
    assert.equal(waiting?.paused, false, 'and it is not paused: nobody paused it');
    assert.equal(hourly?.awaitingMakeUp, false);
    const madeUp: RoutineRunRef = { ...missed, id: 'run3', dueAt: missed.dueAt, outcome: 'made_up', firedAt: MINUTE + 60_000 };
    assert.equal(boardRoutinesOf([once], [madeUp])[0]?.awaitingMakeUp, false, 'spoken on return, it is done');
    const later: RoutineRunRef = { ...RUN, id: 'run4', dueAt: MINUTE + 3_600_000, outcome: 'skipped', note: 'busy' };
    assert.equal(boardRoutinesOf([ROUTINE], [missed, { ...later, routineId: 'r1' }, { ...missed, routineId: 'r1', id: 'run5' }])[0]?.awaitingMakeUp, false, 'only the newest slot counts, whatever order the runs come in');
  });

  it('counts a slot landing, and a routine paused, as the board changing', () => {
    const view = { items: [], agents: [], tasks: [], github: GITHUB, pulls: PULLS, reviews: [], routines: boardRoutinesOf([ROUTINE]), routineRuns: [] };
    const first = boardSignatureOf(view);
    assert.notEqual(boardSignatureOf({ ...view, routineRuns: boardRoutineRunsOf([RUN]) }), first, 'a run is history the tab shows');
    assert.notEqual(boardSignatureOf({ ...view, routines: boardRoutinesOf([{ ...ROUTINE, paused: true, nextDueAt: null }]) }), first);
  });

  it('sends a member everything the board has', () => {
    const routines: BoardRoutineRef[] = boardRoutinesOf([ROUTINE]);
    const routineRuns = boardRoutineRunsOf([RUN]);
    const sent = boardForRole({ items: [], agents: [marvin], tasks: [task], github: GITHUB, pulls: PULLS, reviews: [REVIEW], routines, routineRuns }, 'member');
    assert.deepEqual(sent.reviews, [REVIEW]);
    assert.deepEqual(sent.routines, routines);
    assert.deepEqual(sent.routineRuns, routineRuns);
    assert.deepEqual(sent.agents, [marvin]);
    assert.deepEqual(sent.tasks, [task]);
    assert.deepEqual(sent.github, GITHUB);
    assert.deepEqual(sent.pulls, PULLS);
  });

  it("sends a guest the notes and who the agents are, not the ledger or the office's machines", () => {
    const sent = boardForRole(
      { items: [], agents: [marvin], tasks: [task], github: GITHUB, pulls: PULLS, reviews: [REVIEW], routines: boardRoutinesOf([ROUTINE]), routineRuns: boardRoutineRunsOf([RUN]) },
      null,
    );
    assert.deepEqual(sent.tasks, []);
    assert.deepEqual(sent.reviews, [], 'nor who was asked to review what');
    assert.deepEqual(sent.routines, [], 'nor the routines between members and their agents');
    assert.deepEqual(sent.routineRuns, []);
    assert.deepEqual(sent.pulls.pulls, [], "nor the office's repositories' pull requests");
    assert.deepEqual(sent.github, { connected: false, login: null, repos: [] }, 'nor whether the office has a token');
    assert.equal(sent.agents.length, 1);
    const [agent] = sent.agents;
    assert.equal(agent?.name, 'Marvin');
    assert.equal(agent?.description, marvin.description);
    assert.equal(agent?.hostLabel, null);
    assert.equal(agent?.runtimeId, null);
    assert.equal(agent?.modelId, null);
    assert.ok(!JSON.stringify(sent).includes('laptop'), 'nothing sent names the machine');
  });
});
