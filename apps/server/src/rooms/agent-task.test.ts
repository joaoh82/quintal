import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Decoder, Encoder } from '@colyseus/schema';
import { OfficeState, agentTaskOf, createPlayer, type AgentTask } from '@quintal/shared';

import { applyAgentTask } from './agent-task.js';

/**
 * The task on an agent's card is room state, and only room state: it is on the
 * agent that said it, it is off the moment that agent says `null` or leaves,
 * and nobody else's player is touched on the way.
 *
 * The leave itself is `OfficeRoom.onLeave` calling this with `null`; a room
 * needs a database and a map to stand up, so that wiring is checked live.
 */

const TASK: AgentTask = {
  title: 'fix the login redirect',
  repo: 'api',
  branch: 'quintal/marvin/fix-the-login-redirect',
};
const PR = { number: 12, url: 'https://github.com/acme/api/pull/12', state: 'open' as const };

/**
 * A room and a browser decoding it: one encoder for the life of the room, as
 * the server has, and every check reads the patch a client would be sent.
 */
function room() {
  const state = new OfficeState();
  const marvin = createPlayer({ userId: 'agent-1', name: 'Marvin', x: 0, y: 0, kind: 'agent' });
  const bob = createPlayer({ userId: 'agent-2', name: 'Bob', x: 32, y: 32, kind: 'agent' });
  state.players.set('s-marvin', marvin);
  state.players.set('s-bob', bob);
  const encoder = new Encoder(state);
  const browser = new OfficeState();
  const decoder = new Decoder(browser);
  decoder.decode(encoder.encodeAll());
  encoder.discardChanges();

  /** What the browser reads after the latest patch. */
  const seen = (sessionId: string): AgentTask | null => {
    decoder.decode(encoder.encode());
    encoder.discardChanges();
    return agentTaskOf(browser.players.get(sessionId)!);
  };
  return { marvin, seen };
}

describe('an agent task in room state', () => {
  it('lands on the agent that sent it, and reaches the browser', () => {
    const { marvin, seen } = room();
    assert.equal(applyAgentTask(marvin, TASK), true);
    assert.deepEqual(seen('s-marvin'), TASK);
  });

  it('follows the agent and nobody else', () => {
    const { marvin, seen } = room();
    applyAgentTask(marvin, TASK);
    marvin.x = 400;
    marvin.y = 120;
    assert.deepEqual(seen('s-marvin'), TASK, 'walking does not drop it');
    assert.equal(seen('s-bob'), null, 'the agent beside it is on nothing');
  });

  it('takes the pull request when it is seen, and its state when it changes', () => {
    const { marvin, seen } = room();
    applyAgentTask(marvin, TASK);
    applyAgentTask(marvin, { ...TASK, pr: PR });
    assert.deepEqual(seen('s-marvin')?.pr, PR);
    applyAgentTask(marvin, { ...TASK, pr: { ...PR, state: 'merged' } });
    assert.equal(seen('s-marvin')?.pr?.state, 'merged');
  });

  it('says nothing changed when the same task is said again', () => {
    const { marvin } = room();
    applyAgentTask(marvin, { ...TASK, pr: PR });
    assert.equal(applyAgentTask(marvin, { ...TASK, pr: PR }), false, 'a reconnect resends it');
  });

  it('is cleared by an explicit null', () => {
    const { marvin, seen } = room();
    applyAgentTask(marvin, { ...TASK, pr: PR });
    assert.equal(applyAgentTask(marvin, null), true);
    assert.equal(seen('s-marvin'), null);
    assert.equal(marvin.taskPrNumber, 0);
    assert.equal(marvin.taskPrUrl, '');
  });
});
