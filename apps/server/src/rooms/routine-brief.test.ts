import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RoutineSummary } from '@quintal/shared/db';

import { decideSlot, routineBrief, routineLine, shouldMakeUp } from './routine-brief.js';

/**
 * A routine firing is a hand-over the clock made. What must hold: the line
 * names the agent so it wakes; the brief carries the command's words first
 * and the routine's after, says who set it up, and is marked a routine so
 * the harness heads it right; a slot fires only for an agent that is here
 * and free, and a missed one is made up only while its hour still stands.
 */

function routine(overrides: Partial<RoutineSummary> = {}): RoutineSummary {
  return {
    id: 'r1',
    workspaceId: 'w',
    agentId: 'a-marvin',
    agentName: 'Marvin',
    agentOwnerUserId: 'u-josh',
    name: 'hourly PR check',
    schedule: { kind: 'cron', cron: '0 * * * *', tz: 'Europe/Lisbon' },
    scheduleLabel: 'every hour',
    instructions: 'Review the open pull requests.',
    command: null,
    args: '',
    paused: false,
    nextDueAt: null,
    lastRunAt: null,
    createdBy: 'u-josh',
    createdByName: 'Josh',
    createdByAgentId: null,
    createdByAgentName: '',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('the line and the brief', () => {
  it('names the agent, and briefs it as a routine of the owner’s', () => {
    assert.equal(routineLine(routine()), '@Marvin routine "hourly PR check" is due.');
    const brief = routineBrief(routine(), null, 1_000);
    assert.equal(brief.name, 'hourly-pr-check');
    assert.equal(brief.instructions, 'Review the open pull requests.');
    assert.equal(brief.definedBy, 'Josh');
    assert.equal(brief.addressed, true);
    assert.deepEqual(brief.routine, { name: 'hourly PR check', schedule: 'every hour', dueAt: 1_000, tz: 'Europe/Lisbon' });
  });

  it('puts the command’s words first and the routine’s after, under the command’s name', () => {
    const brief = routineBrief(
      routine({ command: { id: 'c1', name: 'review' }, args: 'whatever is open', instructions: 'Skip drafts.' }),
      { name: 'review', instructions: 'Read the whole diff.' },
      0,
    );
    assert.equal(brief.name, 'review');
    assert.equal(brief.instructions, 'Read the whole diff.\n\nSkip drafts.');
    assert.equal(brief.args, 'whatever is open');
  });

  it('says the agent that made it for the owner', () => {
    const brief = routineBrief(routine({ createdByAgentId: 'a-marvin', createdByAgentName: 'Marvin' }), null, 0);
    assert.equal(brief.definedBy, 'Josh, via Marvin');
  });
});

describe('a due slot', () => {
  it('fires for an agent that is here and free; is missed away; is skipped while busy here', () => {
    assert.deepEqual(decideSlot({ present: true, busyHere: false }), { fire: true });
    assert.deepEqual(decideSlot({ present: false, busyHere: false }), { fire: false, outcome: 'missed', note: 'away' });
    assert.deepEqual(decideSlot({ present: true, busyHere: true }), { fire: false, outcome: 'skipped', note: 'busy' });
  });

  it('is made up on return only while the next slot has not come', () => {
    const here = { present: true, busyHere: false };
    assert.equal(shouldMakeUp({ now: 100, nextDueAt: 200, agent: here }), true);
    assert.equal(shouldMakeUp({ now: 200, nextDueAt: 200, agent: here }), false, 'the next slot is the one to fire');
    assert.equal(shouldMakeUp({ now: 100, nextDueAt: null, agent: here }), true, 'a once routine has no next');
    assert.equal(shouldMakeUp({ now: 100, nextDueAt: 200, agent: { present: false, busyHere: false } }), false);
    assert.equal(shouldMakeUp({ now: 100, nextDueAt: 200, agent: { present: true, busyHere: true } }), false);
  });
});
