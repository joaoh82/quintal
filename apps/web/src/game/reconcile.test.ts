import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RECONCILE_SNAP_PX } from './constants';
import { canSettle, settle, type Authority } from './reconcile';

/**
 * Prediction is only corrected against a server position that describes the
 * present. Correcting against a late one is what made walking feel sluggish to
 * start and slippery to stop.
 */

const at = (over: Partial<Authority> = {}): Authority => ({
  x: 100,
  y: 100,
  moving: false,
  seq: 3,
  ...over,
});

describe('canSettle', () => {
  it('waits while we are walking, however current the server is', () => {
    assert.equal(canSettle(at(), true, 3), false);
  });

  it('waits while the server is still walking us', () => {
    assert.equal(canSettle(at({ moving: true }), false, 3), false);
  });

  it('waits until the server has acted on the last command we sent', () => {
    assert.equal(canSettle(at({ seq: 2 }), false, 3), false);
    assert.equal(canSettle(at({ seq: 3 }), false, 3), true);
  });

  it('settles before the first command, once the server agrees on zero', () => {
    assert.equal(canSettle(at({ seq: 0 }), false, 0), true);
  });

  it('has nothing to settle on before the first patch', () => {
    assert.equal(canSettle(null, false, 0), false);
  });
});

describe('settle', () => {
  it('eases a small gap rather than jumping it', () => {
    const next = settle({ x: 96, y: 100 }, { x: 100, y: 100 }, 1 / 60);
    assert.ok(next.x > 96 && next.x < 100, `x was ${next.x}`);
    assert.equal(next.y, 100);
  });

  it('closes the gap in the same time at any frame rate', () => {
    let fast = { x: 90, y: 100 };
    for (let frame = 0; frame < 12; frame += 1) fast = settle(fast, { x: 100, y: 100 }, 1 / 120);
    let slow = { x: 90, y: 100 };
    for (let frame = 0; frame < 6; frame += 1) slow = settle(slow, { x: 100, y: 100 }, 1 / 60);
    assert.ok(Math.abs(fast.x - slow.x) < 1e-9);
  });

  it('lands exactly once the gap is too small to see', () => {
    let position = { x: 96, y: 100 };
    for (let frame = 0; frame < 60; frame += 1) {
      position = settle(position, { x: 100, y: 100 }, 1 / 60);
    }
    assert.deepEqual(position, { x: 100, y: 100 });
  });

  it('jumps a gap too wide to be anything but a wrong prediction', () => {
    const next = settle({ x: 0, y: 0 }, { x: RECONCILE_SNAP_PX + 1, y: 0 }, 1 / 60);
    assert.deepEqual(next, { x: RECONCILE_SNAP_PX + 1, y: 0 });
  });
});
