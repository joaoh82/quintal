import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cueFor, glassState } from './glass';

describe('what the monitor shows', () => {
  it('is dark with nobody at it, and dim under somebody sitting on a task', () => {
    assert.equal(glassState(null), 'off');
    assert.equal(glassState({ status: 'editing auth.ts', pose: 'stand' }), 'off', 'on its feet, whatever it says');
    assert.equal(glassState({ status: '', pose: 'sit' }), 'idle');
    assert.equal(glassState({ status: 'idle', pose: 'work' }), 'idle');
  });

  it('takes its colour from the status line, by the balloon table', () => {
    assert.equal(glassState({ status: 'thinking', pose: 'work' }), 'thinking');
    assert.equal(glassState({ status: 'editing auth.ts', pose: 'work' }), 'working');
    assert.equal(glassState({ status: 'waiting for Josh', pose: 'work' }), 'waiting');
    assert.equal(glassState({ status: "I've stopped: out of tokens", pose: 'work' }), 'error');
    assert.equal(glassState({ status: 'no model for claude here', pose: 'work' }), 'error');
  });
});

describe('how a holder is drawn at its desk', () => {
  it('reads slowly, edits quickly, fetches with a globe, and sits back for tests', () => {
    assert.deepEqual(cueFor('reading auth.ts'), { pace: 'slow', frames: 'work', globe: false });
    assert.deepEqual(cueFor('searching "seat"'), { pace: 'slow', frames: 'work', globe: false });
    assert.deepEqual(cueFor('editing auth.ts'), { pace: 'fast', frames: 'work', globe: false });
    assert.deepEqual(cueFor('fetching https://example.com'), { pace: 'normal', frames: 'work', globe: true });
    assert.deepEqual(cueFor('running pnpm test'), { pace: 'normal', frames: 'sit', globe: false });
    assert.deepEqual(cueFor('running vitest run'), { pace: 'normal', frames: 'sit', globe: false });
    assert.deepEqual(cueFor('running git status'), { pace: 'normal', frames: 'work', globe: false });
  });

  it('draws anything else as the office does already', () => {
    const plain = { pace: 'normal', frames: 'work', globe: false };
    assert.deepEqual(cueFor(''), plain);
    assert.deepEqual(cueFor('thinking'), plain);
    assert.deepEqual(cueFor('waiting for Josh'), plain);
    assert.deepEqual(cueFor('using my_tool'), plain);
  });
});
