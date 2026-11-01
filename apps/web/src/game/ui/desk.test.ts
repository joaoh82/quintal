import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FLOOR_ZONE_ID } from '@quintal/shared';
import type { ChannelRef, ChatBroadcastPayload, MapZone, PublicActivity, RosterEntry } from '@quintal/shared';

import type { Transcript } from '../useConversations';
import { currentTurn, destinations, labelFor } from './desk';

const NOW = 1_700_000_000_000;

function activity(over: Partial<PublicActivity>): PublicActivity {
  return {
    version: 1,
    turnId: 'turn-1',
    workerId: '0',
    sessionId: 's',
    requestId: 'req',
    sequence: 1,
    state: 'running',
    startedAt: NOW,
    updatedAt: NOW,
    items: [],
    agentId: 'marvin',
    agentName: 'Marvin',
    receivedAt: NOW,
    ...over,
  };
}

function transcript(...activities: PublicActivity[]): Transcript {
  const messages: ChatBroadcastPayload[] = activities.map((value) => ({
    from: value.agentId,
    fromName: value.agentName,
    fromKind: 'agent',
    text: '',
    sentAt: value.startedAt,
    activity: value,
  }));
  return { messages, hasMore: false, loaded: true, loading: false };
}

function entry(over: Partial<RosterEntry>): RosterEntry {
  return {
    sessionId: 'sess',
    name: 'Marvin',
    kind: 'agent',
    status: '',
    isSelf: false,
    ownerName: 'Josh',
    ownerUserId: 'josh',
    scopes: [],
    runtimeId: '',
    modelId: '',
    identityId: 'marvin',
    lastActionAt: 0,
    zoneId: 'bay',
    emote: '',
    workingIn: '',
    workingSince: 0,
    isGuest: false,
    description: '',
    pubkey: '',
    avatar: '',
    task: null,
    ...over,
  };
}

const channels: ChannelRef[] = [
  { id: 'ch-eng', kind: 'channel', name: 'engineering', slug: 'engineering' },
  { id: 'dm-josh', kind: 'dm', name: 'Josh', slug: '' },
];
const zones: MapZone[] = [{ id: 'bay', kind: 'agent_area', label: 'Agent Bay', bounds: { x: 0, y: 0, width: 1, height: 1 } }];

describe('the turn on the screen', () => {
  it('is the running one, over a newer finished one', () => {
    const transcripts = {
      'channel:ch-eng': transcript(
        activity({ turnId: 'old', state: 'running', updatedAt: NOW - 50 }),
        activity({ turnId: 'done', state: 'completed', updatedAt: NOW }),
      ),
    };
    assert.equal(currentTurn(transcripts, 'marvin')?.activity.turnId, 'old');
  });

  it('is the most recently touched when none is running, and only this agent\'s', () => {
    const transcripts = {
      'channel:ch-eng': transcript(activity({ turnId: 'a', state: 'completed', updatedAt: NOW - 10 })),
      'channel:dm-josh': transcript(
        activity({ turnId: 'b', state: 'failed', updatedAt: NOW }),
        activity({ turnId: 'c', state: 'running', agentId: 'arthur', agentName: 'Arthur' }),
      ),
    };
    const found = currentTurn(transcripts, 'marvin');
    assert.equal(found?.activity.turnId, 'b');
    assert.equal(found?.key, 'channel:dm-josh');
    assert.equal(currentTurn({}, 'marvin'), null);
  });

  it('prefers the zone transcript to nearby for a turn heard in both', () => {
    const turn = activity({ zoneId: 'bay' });
    const transcripts = { nearby: transcript(turn), 'zone:bay': transcript(turn) };
    assert.equal(currentTurn(transcripts, 'marvin')?.key, 'zone:bay');
  });
});

describe('where to go', () => {
  it('offers the turn\'s conversation and the ones the work names, once each, by what this client is in', () => {
    const turn = { key: 'channel:ch-eng', activity: activity({ channelId: 'ch-eng' }) };
    const at = entry({ workingIn: 'ch-eng,dm-josh,ch-secret,zone', workingSince: NOW });
    assert.deepEqual(destinations(at, turn, channels, zones), [
      { key: 'channel:ch-eng', label: '#engineering' },
      { key: 'channel:dm-josh', label: 'Josh' },
      { key: 'zone:bay', label: 'Agent Bay' },
    ]);
  });

  it('offers nothing for an idle agent with no turn held: an empty `workingIn` is not "the zone"', () => {
    assert.deepEqual(destinations(entry({}), null, channels, zones), []);
  });

  it('names the floor and nearby', () => {
    assert.equal(labelFor(`zone:${FLOOR_ZONE_ID}`, channels, zones), 'the open floor');
    assert.equal(labelFor('nearby', channels, zones), 'nearby');
    assert.equal(labelFor('channel:ch-unknown', channels, zones), 'a channel');
  });
});
