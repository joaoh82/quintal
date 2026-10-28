import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LatestRead } from './latest-read.js';

describe('ordering overlapping reads', () => {
  it('lets a lone read land', () => {
    const reads = new LatestRead();
    const ticket = reads.start();
    assert.equal(reads.isLatest(ticket), true);
  });

  it('drops the older read when a newer one finished first', () => {
    const reads = new LatestRead();
    // The timer's read starts, then a write commits and its own read starts.
    const timer = reads.start();
    const afterWrite = reads.start();
    // The write's read lands first, as it should.
    assert.equal(reads.isLatest(afterWrite), true);
    // The timer's read, finishing late with the board as it was, is dropped.
    assert.equal(reads.isLatest(timer), false);
  });

  it('drops the older read even when it finishes first', () => {
    const reads = new LatestRead();
    const older = reads.start();
    const newer = reads.start();
    // Order of finishing does not matter: a superseded read never lands,
    // because the newer one carries everything it would have, and more.
    assert.equal(reads.isLatest(older), false);
    assert.equal(reads.isLatest(newer), true);
  });
});
