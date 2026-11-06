import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BoardAgentRef, BoardItemRef, MapInteractable, PublicActivity, RosterEntry } from '@quintal/shared';

import type { Transcript } from '../useConversations';
import { candidates, checkoutsOf, holderOf, offeredNotes, promptFor, routineOn } from './station';

function entry(over: Partial<RosterEntry>): RosterEntry {
  return {
    sessionId: 's',
    name: 'Bob',
    kind: 'agent',
    status: '',
    isSelf: false,
    ownerName: 'Josh',
    ownerUserId: 'u1',
    scopes: ['dm', 'move'],
    runtimeId: '',
    modelId: '',
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
    seat: '',
    task: null,
    ...over,
  };
}

function note(over: Partial<BoardItemRef>): BoardItemRef {
  return {
    id: 'n1',
    number: 1,
    title: 'Fix the chair',
    body: '',
    status: 'open',
    color: 'yellow',
    labels: [],
    assignee: null,
    createdBy: null,
    createdAt: 0,
    updatedAt: 0,
    task: null,
    ...over,
  };
}

const desk: MapInteractable = {
  id: 'bay-2',
  kind: 'desk',
  label: 'the desk',
  bounds: { x: 9, y: 32, width: 1, height: 1 },
  prop: null,
  halo: null,
};

describe('who the station offers', () => {
  it('lists your agents here, free ones first, the rest with why not', () => {
    const roster = [
      entry({ sessionId: 's1', identityId: 'a1', name: 'Zed', status: 'reading auth.ts' }),
      entry({ sessionId: 's2', identityId: 'a2', name: 'Arthur' }),
      entry({ sessionId: 's3', identityId: 'a3', name: 'Marvin', task: { title: 'Fix the chair', repo: 'api', branch: 'chair' } }),
      entry({ sessionId: 's4', identityId: 'a4', name: 'Deep', ownerUserId: 'u2' }),
      entry({ sessionId: 's5', identityId: 'u1', name: 'Josh', kind: 'human', isSelf: true }),
      entry({ sessionId: 's6', identityId: 'a6', name: 'Quiet', status: 'no model for claude here' }),
      entry({ sessionId: 's7', identityId: 'a7', name: 'Mute', scopes: ['move'] }),
      entry({ sessionId: 's8', identityId: 'a8', name: 'Still', scopes: ['dm'] }),
      entry({ sessionId: 's9', identityId: 'a9', name: 'Idle', status: 'idle' }),
    ];
    assert.deepEqual(
      candidates(roster, 'u1').map((c) => [c.entry.name, c.busy]),
      [
        ['Arthur', ''],
        ['Idle', ''],
        ['Marvin', 'on Fix the chair'],
        ['Mute', 'cannot be messaged'],
        ['Quiet', 'no model for claude here'],
        ['Still', 'cannot walk'],
        ['Zed', 'reading auth.ts'],
      ],
      'a refusal would never answer; one that cannot be woken or moved would never come; a colleague\'s agent is not yours to send',
    );
  });

  it('lists an agent once when its old session is still in reconnection grace', () => {
    const roster = [
      entry({ sessionId: 's1', identityId: 'a1', name: 'Arthur', status: 'away' }),
      entry({ sessionId: 's2', identityId: 'a1', name: 'Arthur' }),
      entry({ sessionId: 's3', identityId: 'a2', name: 'Marvin' }),
      entry({ sessionId: 's4', identityId: 'a2', name: 'Marvin', status: 'away' }),
      entry({ sessionId: 's5', identityId: 'a3', name: 'Zed', status: 'away' }),
    ];
    assert.deepEqual(
      candidates(roster, 'u1').map((c) => [c.entry.name, c.entry.sessionId, c.busy]),
      [
        ['Arthur', 's2', ''],
        ['Marvin', 's3', ''],
        ['Zed', 's5', 'away'],
      ],
      'the live session is the agent, whichever came first; one that is only away says so, and is not free',
    );
  });

  it('offers open notes that are nobody\'s or one of yours, newest first', () => {
    const items = [
      note({ id: 'n1', number: 1 }),
      note({ id: 'n2', number: 2, status: 'in_progress' }),
      note({ id: 'n3', number: 3, assignee: { id: 'a9', name: 'Theirs' } }),
      note({ id: 'n4', number: 4, assignee: { id: 'a1', name: 'Mine' } }),
      note({ id: 'n5', number: 5, status: 'done' }),
    ];
    assert.deepEqual(offeredNotes(items, new Set(['a1'])).map((item) => item.number), [4, 1]);
  });

  it('names the routine an agent is on, from the turn that says so', () => {
    const turn = (over: Partial<PublicActivity>): PublicActivity => ({
      version: 1, turnId: 't1', workerId: '1', sessionId: 's', requestId: 't1', sequence: 1, channelId: 'dm1',
      state: 'running', startedAt: 1_000, updatedAt: 2_000, items: [], agentId: 'a1', agentName: 'Arthur', receivedAt: 2_000, ...over,
    });
    const holding = (...turns: PublicActivity[]): Record<string, Transcript> => ({
      'channel:dm1': {
        messages: turns.map((activity) => ({ from: activity.agentId, fromName: activity.agentName, fromKind: 'agent', text: '', sentAt: activity.startedAt, activity })),
        hasMore: false, loaded: true, loading: false,
      },
    });
    const sweep = turn({ routine: { name: 'Inbox sweep' } });
    assert.equal(routineOn(holding(sweep), 'a1'), 'Inbox sweep');
    assert.equal(routineOn(holding(turn({})), 'a1'), null, 'a turn that names no routine is somebody\'s question');
    assert.equal(routineOn(holding(turn({ routine: { name: 'Inbox sweep' }, state: 'completed' })), 'a1'), null, 'a finished turn is nobody\'s routine any more');
    assert.equal(routineOn(holding(sweep), 'a2'), null, 'another agent\'s turn is not this one\'s');
    assert.equal(routineOn({}, 'a1'), null, 'nothing held, nothing known');
    // A question that joined the routine's busy period is its own turn, and the running one wins.
    const question = turn({ turnId: 't2', requestId: 't2', startedAt: 3_000, updatedAt: 4_000 });
    assert.equal(routineOn(holding({ ...sweep, state: 'completed' }, question), 'a1'), null);

    const roster = [entry({ identityId: 'a1', name: 'Arthur', status: 'working', workingSince: 1_000 })];
    assert.deepEqual(candidates(roster, 'u1', holding(sweep)).map((c) => c.busy), ['on its routine Inbox sweep']);
    assert.deepEqual(candidates(roster, 'u1').map((c) => c.busy), ['working'], 'without the turn, the status line');
  });

  it('offers the checkouts the agent\'s machine listed, or none', () => {
    const agent: BoardAgentRef = {
      id: 'a1', name: 'Arthur', ownerUserId: 'u1', ownerName: 'Josh', description: '', status: '',
      lastSeenAt: null, runtimeId: null, modelId: null, hostLabel: 'laptop', checkouts: ['api', 'group/web'],
    };
    assert.deepEqual(checkoutsOf([agent], 'a1'), ['api', 'group/web']);
    assert.deepEqual(checkoutsOf([agent], 'a2'), []);
  });

  it('says what E does where you stand', () => {
    const board: MapInteractable = { ...desk, id: 'board', kind: 'board', label: 'the board' };
    const roster = [entry({ sessionId: 's1', name: 'Arthur', seat: 'bay-2' })];
    assert.equal(promptFor(null, roster), null);
    assert.equal(promptFor(board, roster), 'open the board');
    assert.equal(promptFor(desk, roster), 'see what Arthur is on');
    assert.equal(promptFor(desk, []), 'begin a task at this desk');
    assert.equal(holderOf(roster, 'bay-2')?.name, 'Arthur');
    assert.equal(holderOf(roster, 'bay-3'), null);
  });
});
