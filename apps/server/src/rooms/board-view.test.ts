import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NO_REPO_PULLS, type BoardAgentRef, type BoardTaskRef, type PullRequestStatusRef, type RepoPullsRef } from '@quintal/shared';

import { boardAgentsOf, boardForRole, boardSignatureOf } from './board-view.js';

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

describe('what the board is sent, and when', () => {
  it('does not count an agent being heard from as the board changing', () => {
    const before = { items: [], agents: boardAgentsOf([marvin]), tasks: [task], github: GITHUB, pulls: NO_REPO_PULLS };
    const heard = { ...marvin, lastSeenAt: marvin.lastSeenAt! + 40_000 };
    const after = { items: [], agents: boardAgentsOf([heard]), tasks: [task], github: GITHUB, pulls: NO_REPO_PULLS };
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
    const view = (github: PullRequestStatusRef) => ({ items: [], agents: [], tasks: [{ ...task, github }], github: GITHUB, pulls: NO_REPO_PULLS });
    const first = boardSignatureOf(view(checked));
    assert.equal(boardSignatureOf(view({ ...checked, fetchedAt: checked.fetchedAt + 60_000 })), first, 'a minute later, the same facts');
    assert.notEqual(boardSignatureOf(view({ ...checked, fetchedAt: checked.fetchedAt + 5 * 60_000 })), first, 'five minutes later it is sent once, so "checked … ago" catches up');
    assert.notEqual(boardSignatureOf(view({ ...checked, checks: { ...checked.checks, summary: 'failing' } })), first, 'a check failing is a change');
    assert.notEqual(boardSignatureOf(view({ ...checked, error: 'rate limit' })), first, 'so is GitHub refusing');
  });

  it("does not count listing the repositories again as the board changing, unless the list differs", () => {
    const view = (pulls: RepoPullsRef) => ({ items: [], agents: [], tasks: [], github: GITHUB, pulls });
    const first = boardSignatureOf(view(PULLS));
    assert.equal(boardSignatureOf(view({ ...PULLS, fetchedAt: PULLS.fetchedAt! + 60_000 })), first);
    assert.notEqual(boardSignatureOf(view({ ...PULLS, pulls: [{ ...PULLS.pulls[0]!, state: 'merged' }] })), first);
  });

  it('sends a member everything the board has', () => {
    const sent = boardForRole({ items: [], agents: [marvin], tasks: [task], github: GITHUB, pulls: PULLS }, 'member');
    assert.deepEqual(sent.agents, [marvin]);
    assert.deepEqual(sent.tasks, [task]);
    assert.deepEqual(sent.github, GITHUB);
    assert.deepEqual(sent.pulls, PULLS);
  });

  it("sends a guest the notes and who the agents are, not the ledger or the office's machines", () => {
    const sent = boardForRole({ items: [], agents: [marvin], tasks: [task], github: GITHUB, pulls: PULLS }, null);
    assert.deepEqual(sent.tasks, []);
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
