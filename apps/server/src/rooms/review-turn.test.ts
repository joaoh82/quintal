import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BoardPullReviewRef } from '@quintal/shared';

import { reviewOutcomeOf, reviewsFinishedBy } from './review-turn.js';

const ask = (over: Partial<BoardPullReviewRef> = {}): BoardPullReviewRef => ({
  url: 'https://github.com/acme/api/pull/7',
  repo: 'acme/api',
  number: 7,
  agentId: 'marvin',
  agentName: 'Marvin',
  byName: 'Arthur',
  at: 1_000,
  requestId: '11111111-1111-4111-8111-111111111111',
  finishedAt: null,
  outcome: null,
  ...over,
});

describe('when a review asked for from the board is done', () => {
  it('reads a completed turn as reviewed and one that will not finish as stopped', () => {
    assert.equal(reviewOutcomeOf('completed'), 'reviewed');
    assert.equal(reviewOutcomeOf('failed'), 'stopped');
    assert.equal(reviewOutcomeOf('cancelled'), 'stopped');
    assert.equal(reviewOutcomeOf('interrupted'), 'stopped');
  });

  it('waits on a turn still going, and on a disconnected one that may resume', () => {
    for (const state of ['queued', 'preparing', 'running', 'waiting', 'writing', 'disconnected'] as const) {
      assert.equal(reviewOutcomeOf(state), null, state);
    }
  });

  it('finishes the ask whose request id the turn carries, alone or batched', () => {
    const review = ask();
    assert.deepEqual(reviewsFinishedBy([review], 'marvin', { state: 'completed', requestId: review.requestId! }), [
      { review, outcome: 'reviewed' },
    ]);
    assert.deepEqual(
      reviewsFinishedBy([review], 'marvin', {
        state: 'failed',
        requestId: '22222222-2222-4222-8222-222222222222',
        requestIds: ['22222222-2222-4222-8222-222222222222', review.requestId!],
      }),
      [{ review, outcome: 'stopped' }],
    );
  });

  it('leaves alone another agent’s ask, a finished one, one with no id, and a turn on something else', () => {
    const review = ask();
    const done = { state: 'completed' as const, requestId: review.requestId! };
    assert.deepEqual(reviewsFinishedBy([review], 'zaphod', done), []);
    assert.deepEqual(reviewsFinishedBy([ask({ finishedAt: 2_000, outcome: 'reviewed' })], 'marvin', done), []);
    assert.deepEqual(reviewsFinishedBy([ask({ requestId: null })], 'marvin', done), []);
    assert.deepEqual(reviewsFinishedBy([review], 'marvin', { state: 'completed', requestId: 'turn-1' }), []);
    assert.deepEqual(reviewsFinishedBy([review], 'marvin', { state: 'running', requestId: review.requestId! }), []);
  });
});
