import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RosterEntry } from '@quintal/shared';

import { workingHere } from './presence.js';

/**
 * A transcript shows the agents working in it, and only those. The wrong
 * answer in either direction is misleading: an agent shown thinking in a
 * channel it is not answering, or one answering in a DM shown as idle.
 */

function agent(over: Partial<RosterEntry>): RosterEntry {
  return {
    sessionId: 's',
    name: 'Bob',
    kind: 'agent',
    status: '',
    isSelf: false,
    ownerName: 'Josh',
    ownerUserId: 'u1',
    scopes: [],
    identityId: 'a1',
    lastActionAt: 0,
    isGuest: false,
    description: '',
    pubkey: '',
    zoneId: 'agent-bay',
    emote: '',
    workingIn: '',
    ...over,
  };
}

describe('who is working here', () => {
  it('shows an agent answering in this channel, and not in another', () => {
    const roster = [
      agent({ name: 'Arthur', status: 'thinking', emote: 'dots', workingIn: 'ch-1' }),
      agent({ name: 'Marvin', status: 'reading x.ts', workingIn: 'ch-2' }),
    ];
    assert.deepEqual(
      workingHere(roster, 'channel:ch-1', 'lobby').map((w) => w.name),
      ['Arthur'],
    );
  });

  it('shows a zone turn in the zone the agent stands in, not in a channel', () => {
    const roster = [agent({ name: 'Marvin', status: 'thinking', zoneId: 'agent-bay' })];
    assert.deepEqual(workingHere(roster, 'zone:agent-bay', 'lobby').map((w) => w.name), ['Marvin']);
    assert.deepEqual(workingHere(roster, 'zone:lobby', 'lobby'), []);
    assert.deepEqual(workingHere(roster, 'channel:ch-1', 'lobby'), [], 'not a channel turn');
  });

  it('reads "nearby" as the zone you stand in', () => {
    const roster = [agent({ name: 'Marvin', status: 'thinking', zoneId: 'agent-bay' })];
    assert.equal(workingHere(roster, 'nearby', 'agent-bay').length, 1);
    assert.equal(workingHere(roster, 'nearby', 'lobby').length, 0);
  });

  it('leaves out idle agents and people', () => {
    const roster = [
      agent({ name: 'Marvin' }),
      agent({ name: 'Josh', kind: 'human', status: 'on a call' }),
    ];
    assert.deepEqual(workingHere(roster, 'nearby', 'agent-bay'), []);
  });

  it('counts a balloon alone as worth showing', () => {
    const roster = [agent({ name: 'Marvin', emote: 'laugh', workingIn: 'ch-1' })];
    assert.equal(workingHere(roster, 'channel:ch-1', 'lobby')[0]?.emote, 'laugh');
  });
});
