import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BoardAgentRef, BoardItemRef, BoardRoutineRef, BoardRoutineRunRef, MapInteractable, RosterEntry } from '@quintal/shared';

import { ROUTINE_WAKE_WINDOW_MS, candidates, checkoutsOf, holderOf, offeredNotes, promptFor, routineOn } from './station';

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

  it('names the routine an agent is on, from the run spoken just before its turn began', () => {
    const routine = (id: string, agentId: string, name: string): BoardRoutineRef => ({
      id, agentId, agentName: 'Arthur', ownerUserId: 'u1', name, schedule: { kind: 'cron', cron: '0 9 * * *', tz: 'UTC' },
      scheduleLabel: 'daily at 09:00', command: null, paused: false, nextDueAt: null, awaitingMakeUp: false,
      lastRunAt: null, createdByName: 'Josh', createdByAgentName: '', updatedAt: 0,
    });
    const run = (routineId: string, firedAt: number | null): BoardRoutineRunRef => ({
      id: `${routineId}:${firedAt}`, routineId, dueAt: firedAt ?? 0, outcome: firedAt === null ? 'missed' : 'fired', note: '', firedAt,
    });
    const scheduled = {
      routines: [routine('r1', 'a1', 'Morning standup'), routine('r2', 'a1', 'Inbox sweep'), routine('r9', 'a9', 'Theirs')],
      runs: [run('r1', 1_000_000), run('r2', 1_000_000 + 60_000), run('r9', 1_000_000 + 60_000), run('r1', null)],
    };
    const at = (workingSince: number) => ({ identityId: 'a1', workingSince });
    assert.equal(routineOn(at(1_000_000 + 65_000), scheduled)?.name, 'Inbox sweep', 'the newest line spoken before the turn');
    assert.equal(routineOn(at(1_000_000 + 30_000), scheduled)?.name, 'Morning standup', 'not one spoken after it');
    assert.equal(routineOn(at(1_000_000 + 60_000 + ROUTINE_WAKE_WINDOW_MS + 1), scheduled), null, 'a turn minutes later is somebody\'s question');
    assert.equal(routineOn(at(0), scheduled), null, 'no turn, no routine');
    assert.equal(routineOn({ identityId: 'a2', workingSince: 1_000_000 + 65_000 }, scheduled), null, 'another agent\'s routines are not this one\'s');

    const roster = [entry({ identityId: 'a1', name: 'Arthur', status: 'reading inbox.md', workingSince: 1_000_000 + 65_000 })];
    assert.deepEqual(candidates(roster, 'u1', scheduled).map((c) => c.busy), ['on its routine Inbox sweep']);
    assert.deepEqual(candidates(roster, 'u1').map((c) => c.busy), ['reading inbox.md'], 'without the board, the tool it is on');
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
