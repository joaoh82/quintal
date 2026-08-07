import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ChatLog, type RoomMessage } from './chat-log.js';

const message = (overrides: Partial<RoomMessage> = {}): RoomMessage => ({
  from: 's1',
  fromUserId: 'u1',
  fromName: 'Ada',
  fromKind: 'human',
  text: 'hello',
  sentAt: 0,
  x: 0,
  y: 0,
  zoneId: null,
  ...overrides,
});

describe('ChatLog', () => {
  it('keeps newest last', () => {
    const log = new ChatLog(10);
    log.push(message({ text: 'first', sentAt: 1 }));
    log.push(message({ text: 'second', sentAt: 2 }));
    assert.deepEqual(
      log.recent(() => true, 10).map((m) => m.text),
      ['first', 'second'],
    );
  });

  it('returns the most recent N, not the oldest', () => {
    const log = new ChatLog(10);
    for (let i = 0; i < 5; i += 1) log.push(message({ text: `m${i}`, sentAt: i }));
    assert.deepEqual(
      log.recent(() => true, 2).map((m) => m.text),
      ['m3', 'm4'],
    );
  });

  it('drops the oldest once it is full', () => {
    const log = new ChatLog(3);
    for (let i = 0; i < 5; i += 1) log.push(message({ text: `m${i}`, sentAt: i }));
    assert.deepEqual(
      log.recent(() => true, 10).map((m) => m.text),
      ['m2', 'm3', 'm4'],
    );
  });

  it('filters, so an agent only gets what it could have heard', () => {
    const log = new ChatLog(10);
    log.push(message({ text: 'near', x: 0 }));
    log.push(message({ text: 'far', x: 10_000 }));
    assert.deepEqual(
      log.recent((m) => m.x < 100, 10).map((m) => m.text),
      ['near'],
    );
  });

  it('forgets a session that left', () => {
    const log = new ChatLog(10);
    log.push(message({ from: 'a', text: 'from a' }));
    log.push(message({ from: 'b', text: 'from b' }));
    log.forget('a');
    assert.deepEqual(
      log.recent(() => true, 10).map((m) => m.text),
      ['from b'],
    );
  });
});
