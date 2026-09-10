import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { workingSinceAfter } from './working-since.js';

/**
 * The clock on a channel row is only worth showing if it is honest: it must
 * start when the work does, not restart on every status line, and it must
 * stop the moment the agent is idle.
 */
describe('when the work began', () => {
  it('starts the clock when an idle agent picks something up', () => {
    assert.equal(workingSinceAfter({ workingIn: '', workingSince: 0 }, 'ch-1', 5_000), 5_000);
  });

  it('keeps the clock across status lines in the same conversation', () => {
    const since = workingSinceAfter({ workingIn: 'ch-1', workingSince: 5_000 }, 'ch-1', 9_000);
    assert.equal(since, 5_000);
  });

  it('keeps the clock when a second turn joins the first', () => {
    const since = workingSinceAfter(
      { workingIn: 'ch-1', workingSince: 5_000 },
      'ch-1,ch-2',
      9_000,
    );
    assert.equal(since, 5_000, 'a busy agent got busier; it did not start over');
  });

  it('stops the clock when the agent is idle', () => {
    assert.equal(workingSinceAfter({ workingIn: 'ch-1', workingSince: 5_000 }, '', 9_000), 0);
  });

  it('starts a fresh clock after an idle gap', () => {
    const idle = workingSinceAfter({ workingIn: 'ch-1', workingSince: 5_000 }, '', 9_000);
    assert.equal(workingSinceAfter({ workingIn: '', workingSince: idle }, 'ch-2', 12_000), 12_000);
  });

  it('stamps a clock it somehow lacks rather than showing none', () => {
    // A player whose `workingIn` was set by an older room that had no clock.
    assert.equal(workingSinceAfter({ workingIn: 'ch-1', workingSince: 0 }, 'ch-1', 7_000), 7_000);
  });
});
