import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BoardItemRef } from '@quintal/shared';

import { handedFrom, sessionOf, whyNotBegin, whyNotNote, whyNotRepo, type StationAgent } from './station.js';

function agent(over: Partial<StationAgent> = {}): StationAgent {
  return { name: 'Arthur', here: true, status: '', onTask: false, scopes: ['dm', 'move', 'chat'], ...over };
}

describe('which session an agent is on', () => {
  it('a connected one before one in its reconnection grace, whichever came first', () => {
    const sessions = [
      { sessionId: 's1', agentId: 'a1', away: true },
      { sessionId: 's2', agentId: 'a1', away: false },
      { sessionId: 's3', agentId: 'a2', away: false },
      { sessionId: 's4', agentId: 'a2', away: true },
      { sessionId: 's5', agentId: 'a3', away: true },
    ];
    assert.equal(sessionOf(sessions, 'a1'), 's2', 'the harness that restarted is on the new socket');
    assert.equal(sessionOf(sessions, 'a2'), 's3');
    assert.equal(sessionOf(sessions, 'a3'), 's5', 'in its grace it is still here, and the room says how');
    assert.equal(sessionOf(sessions, 'a4'), null);
  });
});

describe('who a task may be begun for', () => {
  it('a free agent of the office that can be woken and can walk', () => {
    assert.equal(whyNotBegin(agent()), null);
    assert.equal(whyNotBegin(agent({ status: 'idle' })), null, '"idle" is idle');
  });

  it('refuses one that is away, busy, on a task, or standing on a refusal', () => {
    assert.equal(whyNotBegin(agent({ here: false })), 'Arthur is not in the office.');
    assert.equal(whyNotBegin(agent({ status: 'reading auth.ts' })), 'Arthur is on something already.');
    assert.equal(whyNotBegin(agent({ onTask: true })), 'Arthur is on something already.');
    assert.equal(
      whyNotBegin(agent({ status: 'no model for claude here' })),
      'Arthur is on something already.',
      'idle life may wander it, but it would never answer',
    );
  });

  it('names only a checkout its machine listed', () => {
    assert.equal(whyNotRepo(null, [], 'Arthur'), null, 'the agent\'s choice');
    assert.equal(whyNotRepo('api', ['api', 'group/web'], 'Arthur'), null);
    assert.equal(whyNotRepo('web', ['api', 'group/web'], 'Arthur'), "Arthur's machine has no checkout named web.");
    assert.equal(whyNotRepo('api', [], 'Arthur'), "Arthur's machine has no checkout named api.");
  });

  it('refuses one the hand-over could not reach, or the desk could not take', () => {
    assert.equal(whyNotBegin(agent({ scopes: ['move'] })), 'Arthur cannot be messaged, so nothing would wake it.');
    assert.equal(whyNotBegin(agent({ scopes: ['dm'] })), 'Arthur may not move, so it could not walk to the desk.');
  });
});

describe('which note, and from whom', () => {
  const note = (over: Partial<BoardItemRef>): BoardItemRef => ({
    id: 'n1', number: 7, title: 't', body: '', status: 'open', color: 'yellow', labels: [],
    assignee: null, createdBy: null, createdAt: 0, updatedAt: 0, task: null, ...over,
  });

  it('only an open note is there to begin', () => {
    assert.equal(whyNotNote(note({})), null);
    assert.equal(whyNotNote(note({ status: 'in_progress' })), 'Note #7 is not open.');
    assert.equal(whyNotNote(note({ status: 'done' })), 'Note #7 is not open.');
  });

  it('a note handed again to the agent that has it is not handed away from it', () => {
    const mine = note({ assignee: { id: 'a1', name: 'Arthur' } });
    assert.equal(handedFrom(mine, 'a1').assignee, null);
    assert.equal(handedFrom(mine, 'a2'), mine, 'from another agent it is a hand-over, and that agent is told');
    assert.equal(handedFrom(note({}), 'a1').assignee, null);
  });
});
