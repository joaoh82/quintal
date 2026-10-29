import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BoardAgentRef, BoardTaskRef } from '@quintal/shared';

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
};

describe('what the board is sent, and when', () => {
  it('does not count an agent being heard from as the board changing', () => {
    const before = { items: [], agents: boardAgentsOf([marvin]), tasks: [task] };
    const heard = { ...marvin, lastSeenAt: marvin.lastSeenAt! + 40_000 };
    const after = { items: [], agents: boardAgentsOf([heard]), tasks: [task] };
    assert.equal(boardSignatureOf(after), boardSignatureOf(before), 'the same minute is the same board');

    const later = { ...marvin, lastSeenAt: marvin.lastSeenAt! + 60_000 };
    assert.notEqual(boardSignatureOf({ ...after, agents: boardAgentsOf([later]) }), boardSignatureOf(before));
  });

  it('keeps the time to the minute, and never for an agent never heard from', () => {
    const [rounded, never] = boardAgentsOf([marvin, { ...marvin, id: 'a2', lastSeenAt: null }]);
    assert.equal(rounded?.lastSeenAt, MINUTE, 'down to the minute');
    assert.equal(never?.lastSeenAt, null);
  });

  it('sends a member everything the board has', () => {
    const sent = boardForRole({ items: [], agents: [marvin], tasks: [task] }, 'member');
    assert.deepEqual(sent.agents, [marvin]);
    assert.deepEqual(sent.tasks, [task]);
  });

  it("sends a guest the notes and who the agents are, not the ledger or the office's machines", () => {
    const sent = boardForRole({ items: [], agents: [marvin], tasks: [task] }, null);
    assert.deepEqual(sent.tasks, []);
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
