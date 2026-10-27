import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HISTORY_LIMIT, NOT_RECALLING, edited, remember, step } from './history.js';

describe('remembering sent lines', () => {
  it('keeps them in order, without repeating the last one', () => {
    let history = remember([], 'hello');
    history = remember(history, 'hello');
    history = remember(history, '!review');
    assert.deepEqual(history, ['hello', '!review']);
  });

  it('forgets the oldest past the limit', () => {
    let history: string[] = [];
    for (let n = 0; n <= HISTORY_LIMIT; n += 1) history = remember(history, `line ${n}`);
    assert.equal(history.length, HISTORY_LIMIT);
    assert.equal(history[0], 'line 1');
  });
});

describe('Up and Down', () => {
  const history = ['first', 'second', 'third'];

  it('walks back from the newest and stops at the oldest', () => {
    const one = step(history, NOT_RECALLING, 'half-typed', true);
    assert.equal(one?.text, 'third');
    const two = step(history, one!.recall, one!.text, true);
    assert.equal(two?.text, 'second');
    const three = step(history, two!.recall, two!.text, true);
    assert.equal(three?.text, 'first');
    assert.equal(step(history, three!.recall, three!.text, true), null);
  });

  it('walks forward to the line you were writing', () => {
    const back = step(history, NOT_RECALLING, 'half-typed', true)!;
    const older = step(history, back.recall, back.text, true)!;
    const newer = step(history, older.recall, older.text, false)!;
    assert.equal(newer.text, 'third');
    const draft = step(history, newer.recall, newer.text, false)!;
    assert.equal(draft.text, 'half-typed');
    assert.deepEqual(draft.recall, NOT_RECALLING);
  });

  it('gives back the line you were writing after you edit a recalled one', () => {
    const back = step(history, NOT_RECALLING, 'hello wor', true)!;
    const typed = edited(back.recall);
    const down = step(history, typed, 'third!', false)!;
    assert.equal(down.text, 'hello wor');
    assert.deepEqual(down.recall, NOT_RECALLING);

    // Up again from the edit, then all the way down, still ends there.
    const again = step(history, typed, 'third!', true)!;
    assert.equal(again.text, 'third');
    assert.equal(step(history, again.recall, again.text, false)!.text, 'hello wor');
  });

  it('does nothing with no history, or Down while typing', () => {
    assert.equal(step([], NOT_RECALLING, 'x', true), null);
    assert.equal(step(history, NOT_RECALLING, 'x', false), null);
  });
});
