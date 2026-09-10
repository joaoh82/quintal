import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RosterEntry } from '@quintal/shared';

import { activeWorkFor, workingHere } from './presence.js';

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
    avatar: '',
    isGuest: false,
    description: '',
    pubkey: '',
    zoneId: 'agent-bay',
    emote: '',
    workingIn: '',
    workingSince: 0,
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

  it('shows an agent in every conversation it is answering at once', () => {
    const roster = [agent({ name: 'Marvin', status: 'thinking', workingIn: 'ch-1,ch-2' })];
    assert.equal(workingHere(roster, 'channel:ch-1', 'lobby').length, 1);
    assert.equal(workingHere(roster, 'channel:ch-2', 'lobby').length, 1);
    assert.equal(workingHere(roster, 'channel:ch-3', 'lobby').length, 0);
    assert.equal(workingHere(roster, 'nearby', 'agent-bay').length, 0, 'none of it is spatial');
  });

  it('shows a zone turn beside a channel turn when both are in flight', () => {
    const roster = [agent({ name: 'Marvin', status: 'thinking', workingIn: 'ch-1,zone' })];
    assert.equal(workingHere(roster, 'channel:ch-1', 'lobby').length, 1);
    assert.equal(workingHere(roster, 'nearby', 'agent-bay').length, 1);
  });

  it('counts a balloon alone as worth showing', () => {
    const roster = [agent({ name: 'Marvin', emote: 'laugh', workingIn: 'ch-1' })];
    assert.equal(workingHere(roster, 'channel:ch-1', 'lobby')[0]?.emote, 'laugh');
  });
});

describe('how long they have been at it', () => {
  it('anchors a channel on the agent that started first', () => {
    const roster = [
      agent({ name: 'Arthur', status: 'thinking', workingIn: 'ch-1', workingSince: 5_000 }),
      agent({ name: 'Marvin', status: 'reading', workingIn: 'ch-1', workingSince: 2_000 }),
    ];
    const work = activeWorkFor(roster, 'channel:ch-1', 'lobby');
    assert.equal(work?.anchorAt, 2_000, 'a second agent joining does not reset the clock');
    assert.deepEqual(work?.agents, ['Arthur', 'Marvin']);
  });

  it('ignores agents working elsewhere', () => {
    const roster = [
      agent({ name: 'Arthur', status: 'thinking', workingIn: 'ch-2', workingSince: 5_000 }),
      agent({ name: 'Marvin', status: 'thinking', zoneId: 'agent-bay', workingSince: 6_000 }),
    ];
    assert.equal(activeWorkFor(roster, 'channel:ch-1', 'lobby'), null);
    assert.equal(activeWorkFor(roster, 'zone:agent-bay', 'lobby')?.anchorAt, 6_000);
    assert.equal(activeWorkFor(roster, 'nearby', 'agent-bay')?.anchorAt, 6_000);
  });

  it('shows nothing for an agent with no clock', () => {
    const roster = [agent({ name: 'Marvin', emote: 'laugh', workingIn: 'ch-1', workingSince: 0 })];
    assert.equal(activeWorkFor(roster, 'channel:ch-1', 'lobby'), null, 'a balloon is not work');
  });
});
