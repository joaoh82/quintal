import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ChannelRef } from '@quintal/shared';

import {
  EMPTY_READ_STATE,
  caughtUp,
  heard,
  loadLastRead,
  read,
  saveLastRead,
  type Listener,
  type ReadState,
} from './unread.js';

/**
 * A badge that is wrong is worse than none: a count that includes your own
 * words nags you about nothing, and one that misses a line said to you is
 * a question left unanswered.
 */

const me: Listener = { selfSessionId: 'me', myName: 'Josh', visible: ['nearby'], isDm: false };
const line = (over: Partial<{ from: string; text: string; sentAt: number }> = {}) => ({
  from: 'them',
  text: 'hello',
  sentAt: 1_000,
  ...over,
});

describe('what is waiting in a conversation', () => {
  it('counts a line said where you are not looking', () => {
    let state = heard(EMPTY_READ_STATE, 'channel:ch-1', line(), me, 2_000);
    state = heard(state, 'channel:ch-1', line({ sentAt: 1_500 }), me, 2_500);
    assert.deepEqual(state.unread['channel:ch-1'], { count: 2, mentioned: false });
  });

  it('never counts your own words', () => {
    const state = heard(EMPTY_READ_STATE, 'channel:ch-1', line({ from: 'me' }), me, 2_000);
    assert.equal(state.unread['channel:ch-1'], undefined);
  });

  it('does not count a line in the conversation you are reading, and notes you read it', () => {
    const state = heard(EMPTY_READ_STATE, 'nearby', line({ sentAt: 5_000 }), me, 2_000);
    assert.equal(state.unread['nearby'], undefined);
    assert.equal(state.lastReadAt['nearby'], 5_000, 'as of the line, if the line is later');
  });

  it('marks a line that names you, and every line of a DM', () => {
    const named = heard(EMPTY_READ_STATE, 'channel:ch-1', line({ text: 'hey @Josh' }), me, 2_000);
    assert.equal(named.unread['channel:ch-1']?.mentioned, true);
    const other = heard(EMPTY_READ_STATE, 'channel:ch-1', line({ text: 'hey @Ana' }), me, 2_000);
    assert.equal(other.unread['channel:ch-1']?.mentioned, false);
    const dm = heard(EMPTY_READ_STATE, 'channel:dm-1', line(), { ...me, isDm: true }, 2_000);
    assert.equal(dm.unread['channel:dm-1']?.mentioned, true);
  });

  it('keeps the mention once one line has made it', () => {
    let state = heard(EMPTY_READ_STATE, 'channel:ch-1', line({ text: '@Josh?' }), me, 2_000);
    state = heard(state, 'channel:ch-1', line({ text: 'and more' }), me, 3_000);
    assert.deepEqual(state.unread['channel:ch-1'], { count: 2, mentioned: true });
  });

  it('clears when you look, and remembers when', () => {
    let state = heard(EMPTY_READ_STATE, 'channel:ch-1', line(), me, 2_000);
    state = read(state, 'channel:ch-1', 9_000);
    assert.equal(state.unread['channel:ch-1'], undefined);
    assert.equal(state.lastReadAt['channel:ch-1'], 9_000);
    assert.equal(read(state, 'channel:ch-1', 8_000), state, 'looking again, earlier, changes nothing');
  });
});

describe('what was said while you were away', () => {
  const channel = (id: string, lastMessageAt?: number, kind: 'channel' | 'dm' = 'channel'): ChannelRef => ({
    id,
    kind,
    name: id,
    slug: kind === 'dm' ? '' : id,
    ...(lastMessageAt === undefined ? {} : { lastMessageAt }),
  });

  it('dots a channel that spoke after you last looked, or that you never did', () => {
    const state: ReadState = { lastReadAt: { 'channel:old': 5_000 }, unread: {} };
    const next = caughtUp(
      state,
      [channel('old', 4_000), channel('new', 6_000), channel('never', 1_000), channel('silent')],
      ['nearby'],
    );
    assert.equal(next.unread['channel:old'], undefined, 'read since it last spoke');
    assert.deepEqual(next.unread['channel:new'], { count: 0, mentioned: false });
    assert.deepEqual(next.unread['channel:never'], { count: 0, mentioned: false });
    assert.equal(next.unread['channel:silent'], undefined, 'nothing was ever said');
  });

  it('leaves the conversation in view, and a count already being kept, alone', () => {
    const state: ReadState = { lastReadAt: {}, unread: { 'channel:busy': { count: 3, mentioned: true } } };
    const next = caughtUp(state, [channel('busy', 9_000), channel('open', 9_000)], ['channel:open']);
    assert.deepEqual(next.unread['channel:busy'], { count: 3, mentioned: true });
    assert.equal(next.unread['channel:open'], undefined);
  });

  it('treats a DM you have not read as for you', () => {
    const next = caughtUp(EMPTY_READ_STATE, [channel('dm-1', 9_000, 'dm')], []);
    assert.deepEqual(next.unread['channel:dm-1'], { count: 0, mentioned: true });
  });
});

describe('remembering when you last looked', () => {
  function memory(): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => void data.set(key, value),
    };
  }

  it('round-trips, and keeps only the most recent conversations', () => {
    const storage = memory();
    const many: Record<string, number> = {};
    for (let i = 1; i <= 250; i += 1) many[`channel:c${i}`] = i;
    saveLastRead(storage, many);
    const back = loadLastRead(storage);
    assert.equal(Object.keys(back).length, 200);
    assert.equal(back['channel:c250'], 250);
    assert.equal(back['channel:c1'], undefined, 'the oldest are let go');
  });

  it('shrugs at nothing, garbage, and no storage at all', () => {
    assert.deepEqual(loadLastRead(undefined), {});
    const storage = memory();
    storage.data.set('quintal:lastRead', '{not json');
    assert.deepEqual(loadLastRead(storage), {});
    storage.data.set('quintal:lastRead', JSON.stringify({ ok: 5, bad: 'x', neg: -1 }));
    assert.deepEqual(loadLastRead(storage), { ok: 5 });
    assert.doesNotThrow(() => saveLastRead(undefined, { a: 1 }));
  });
});
