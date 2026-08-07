import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ChatLog, mentions, type RoomMessage } from './chat-log.js';

const message = (overrides: Partial<RoomMessage> = {}): RoomMessage => ({
  from: 's1',
  fromName: 'Ada',
  fromKind: 'human',
  text: 'hello',
  sentAt: 0,
  x: 0,
  y: 0,
  zoneId: null,
  ...overrides,
});

describe('mentions', () => {
  it('matches the name on its own', () => {
    assert.equal(mentions('reviewer can you look at this', 'reviewer'), true);
  });

  it('matches with an @ and regardless of case', () => {
    assert.equal(mentions('hey @Reviewer', 'reviewer'), true);
    assert.equal(mentions('REVIEWER!', 'reviewer'), true);
  });

  it('does not match inside a longer word', () => {
    // The reason this is a word-boundary test and not `includes`: an agent
    // called Ana must not wake up for "banana".
    assert.equal(mentions('I ate a banana', 'ana'), false);
    assert.equal(mentions('reviewership', 'reviewer'), false);
  });

  it('matches at either end of the sentence', () => {
    assert.equal(mentions('reviewer', 'reviewer'), true);
    assert.equal(mentions('ask reviewer', 'reviewer'), true);
  });

  it('treats punctuation as a boundary', () => {
    assert.equal(mentions('reviewer, please', 'reviewer'), true);
    assert.equal(mentions('(reviewer)', 'reviewer'), true);
  });

  it('is not fooled by regex characters in a name', () => {
    assert.equal(mentions('ask c++ about it', 'c++'), true);
    assert.equal(mentions('anything at all', '.*'), false);
  });

  it('ignores an empty name', () => {
    assert.equal(mentions('anything', ''), false);
    assert.equal(mentions('anything', '   '), false);
  });
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
