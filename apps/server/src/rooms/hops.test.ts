import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AGENT_MENTION_MAX_HOPS } from '@quintal/shared';

import { SPATIAL, WakeHops, hopOf, mayWake } from './hops.js';

/**
 * Three agents naming each other back must stop on their own. The chain the
 * ticket names: a person wakes A, A names B, B names C, C names D, D names
 * E — and E's reply, at hop five, wakes nobody.
 */
describe('mention hops', () => {
  it('counts from the person outwards and stops past the limit', () => {
    assert.equal(AGENT_MENTION_MAX_HOPS, 4);
    const hops = new WakeHops();
    const channel = 'ch-1';

    // Josh writes @A.
    const human = hopOf('human', undefined);
    assert.equal(human, 0);
    hops.woken('A', channel, human);

    let previous = 'A';
    const woke: string[] = [];
    for (const next of ['B', 'C', 'D', 'E', 'F']) {
      const hop = hopOf('agent', hops.lastWake(previous, channel));
      if (mayWake(hop)) {
        hops.woken(next, channel, hop);
        woke.push(`${next}@${hop}`);
      }
      previous = next;
    }
    assert.deepEqual(woke, ['B@1', 'C@2', 'D@3', 'E@4'], "E is the last to wake; F is not woken by E's hop-5 line");
  });

  it('takes the limit from the office, with the constant only as the default', () => {
    assert.equal(mayWake(5, 6), true);
    assert.equal(mayWake(5, 4), false);
    assert.equal(mayWake(1, 1), true, 'one: an agent may answer a person');
    assert.equal(mayWake(2, 1), false, 'and name nobody into a turn');
    assert.equal(mayWake(4), true);
    assert.equal(mayWake(5), false);
  });

  it("a person's line resets the count wherever the agent stands", () => {
    const hops = new WakeHops();
    hops.woken('A', 'ch-1', 4);
    hops.woken('A', 'ch-1', hopOf('human', undefined));
    assert.equal(hopOf('agent', hops.lastWake('A', 'ch-1')), 1);
  });

  it('keeps conversations apart and forgets an agent that left', () => {
    const hops = new WakeHops();
    hops.woken('A', 'ch-1', 3);
    assert.equal(hops.lastWake('A', SPATIAL), undefined, 'a channel wake is not a spatial one');
    assert.equal(hopOf('agent', hops.lastWake('A', SPATIAL)), 1, 'an agent never woken speaks at hop 1');
    hops.forget('A');
    assert.equal(hops.lastWake('A', 'ch-1'), undefined);
  });
});
