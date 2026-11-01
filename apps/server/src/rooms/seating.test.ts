import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SeatBook, seated, wantedPose } from './seating.js';

/**
 * Two rules, both pinned: the pose follows the state and nothing else, and
 * no seat ever has two holders.
 */

describe('the pose an agent is drawn in', () => {
  it('works while a turn runs, whatever else is true', () => {
    assert.equal(wantedPose({ busy: true, onTask: true }), 'work');
    assert.equal(wantedPose({ busy: true, onTask: false }), 'work');
  });

  it('sits on a task with nothing running — a long task still reads as idle', () => {
    assert.equal(wantedPose({ busy: false, onTask: true }), 'sit');
  });

  it('stands with neither', () => {
    assert.equal(wantedPose({ busy: false, onTask: false }), 'stand');
  });

  it('knows which poses are at a desk', () => {
    assert.equal(seated('stand'), false);
    assert.equal(seated('sit'), true);
    assert.equal(seated('work'), true);
  });
});

describe('the book of desks', () => {
  const now = 1_000_000;

  it('hands out seats in map order and keeps them sticky', () => {
    const book = new SeatBook(['bay-1', 'bay-2']);
    assert.equal(book.claim('arthur', now), 'bay-1');
    assert.equal(book.claim('marvin', now), 'bay-2');
    assert.equal(book.claim('arthur', now + 1), 'bay-1', 'asking again is the same desk');
    assert.equal(book.seatOf('marvin'), 'bay-2');
    assert.equal(book.holderOf('bay-1'), 'arthur');
  });

  it('refuses only when every seat is held by somebody present', () => {
    const book = new SeatBook(['bay-1']);
    assert.equal(book.claim('arthur', now), 'bay-1');
    assert.equal(book.claim('marvin', now), null);
    assert.equal(book.seatOf('marvin'), undefined, 'a refusal is not a half-assignment');
  });

  it('keeps a desk for an agent that left, until a present one needs it', () => {
    const book = new SeatBook(['bay-1', 'bay-2']);
    book.claim('arthur', now);
    book.claim('marvin', now);
    book.left('arthur', now + 10);
    assert.equal(book.seatOf('arthur'), 'bay-1', 'gone, not forgotten');
    assert.equal(book.claim('arthur', now + 20), 'bay-1', 'back at the same desk');

    book.left('arthur', now + 30);
    book.left('marvin', now + 40);
    assert.equal(book.claim('ford', now + 50), 'bay-1', 'the longest-absent holder gives way first');
    assert.equal(book.seatOf('arthur'), undefined);
    assert.equal(book.seatOf('marvin'), 'bay-2');
    assert.equal(book.claim('zaphod', now + 60), 'bay-2');
    assert.equal(book.claim('trillian', now + 70), null, 'everyone with a desk is here now');
  });

  it('never seats two agents on one chair', () => {
    const book = new SeatBook(['bay-1', 'bay-2', 'bay-3']);
    const agents = ['a', 'b', 'c', 'd', 'e'];
    for (const [i, agent] of agents.entries()) {
      book.claim(agent, now + i);
      book.left(agent, now + i);
    }
    const seats = agents.map((agent) => book.seatOf(agent)).filter((seat) => seat !== undefined);
    assert.equal(new Set(seats).size, seats.length);
  });

  it('a released desk is free again', () => {
    const book = new SeatBook(['bay-1']);
    book.claim('arthur', now);
    book.release('arthur');
    assert.equal(book.seatOf('arthur'), undefined);
    assert.equal(book.claim('marvin', now), 'bay-1');
  });
});
