import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FULL_VOLUME_TILES,
  gainFor,
  needsVoice,
  pannerPosition,
  resolveTargets,
  shouldSubscribe,
} from './spatial.js';

const RADIUS = 6;

function human(identityId: string, x: number, y: number, isSelf = false) {
  return { identityId, kind: 'human', x, y, isSelf };
}

describe('the hearing boundary', () => {
  it('starts hearing somebody who comes inside the radius', () => {
    assert.equal(shouldSubscribe(5.9, RADIUS, false), true);
    assert.equal(shouldSubscribe(6.1, RADIUS, false), false);
  });

  it('keeps hearing them past the radius, until they are well clear', () => {
    // The point of hysteresis: 7 tiles is outside the radius but inside the
    // band, so somebody already audible stays audible.
    assert.equal(shouldSubscribe(7, RADIUS, true), true);
    assert.equal(shouldSubscribe(8.5, RADIUS, true), false);
  });

  it('does not flap for somebody loitering exactly on the line', () => {
    let subscribed = false;
    for (const distance of [5.99, 6.01, 5.98, 6.02, 6.0, 5.97]) {
      subscribed = shouldSubscribe(distance, RADIUS, subscribed);
    }
    // Subscribed once on the first step inside, and never dropped.
    assert.equal(subscribed, true);
  });
});

describe('volume with distance', () => {
  it('is full up close', () => {
    assert.equal(gainFor(0, RADIUS), 1);
    assert.equal(gainFor(FULL_VOLUME_TILES, RADIUS), 1);
  });

  it('reaches silence exactly at the edge, not before', () => {
    assert.equal(gainFor(RADIUS, RADIUS), 0);
    assert.ok(gainFor(RADIUS - 0.01, RADIUS) > 0);
  });

  it('falls off monotonically', () => {
    let previous = Infinity;
    for (let d = 0; d <= RADIUS; d += 0.5) {
      const gain = gainFor(d, RADIUS);
      assert.ok(gain <= previous, `gain rose at ${d}`);
      previous = gain;
    }
  });
});

describe('placing a voice in the stereo field', () => {
  it('puts somebody on your right to the right', () => {
    assert.ok(pannerPosition({ x: 0, y: 0 }, { x: 3, y: 0 }, RADIUS).x > 0);
  });

  it('maps screen-down to behind, because the office is top-down', () => {
    assert.ok(pannerPosition({ x: 0, y: 0 }, { x: 0, y: 3 }, RADIUS).z > 0);
  });

  it('never pans harder than one ear, however far away they are', () => {
    const far = pannerPosition({ x: 0, y: 0 }, { x: 500, y: 500 }, RADIUS);
    assert.equal(far.x, 1);
    assert.equal(far.z, 1);
  });
});

describe('resolving the room', () => {
  it('hears a nearby human', () => {
    const { hear } = resolveTargets(
      [human('me', 0, 0, true), human('sam', 2, 0)],
      RADIUS,
      new Set(),
    );
    assert.deepEqual(hear.map((t) => t.identityId), ['sam']);
  });

  it('never hears an agent, whatever the distance', () => {
    const { hear } = resolveTargets(
      [
        human('me', 0, 0, true),
        { identityId: 'bot', kind: 'agent', x: 0, y: 0, isSelf: false },
      ],
      RADIUS,
      new Set(),
    );
    assert.deepEqual(hear, []);
  });

  it('never hears itself', () => {
    const { hear } = resolveTargets([human('me', 0, 0, true)], RADIUS, new Set());
    assert.deepEqual(hear, []);
  });

  it('drops somebody who walked away', () => {
    const { hear, drop } = resolveTargets(
      [human('me', 0, 0, true), human('sam', 20, 0)],
      RADIUS,
      new Set(['sam']),
    );
    assert.deepEqual(hear, []);
    assert.deepEqual(drop, ['sam']);
  });

  it('drops everybody when we cannot find ourselves — better silent than wrong', () => {
    const { hear, drop } = resolveTargets([human('sam', 1, 1)], RADIUS, new Set(['sam']));
    assert.deepEqual(hear, []);
    assert.deepEqual(drop, ['sam']);
  });
});

describe('deciding whether voice is worth a connection', () => {
  it('stays off for one human alone with a fleet — the primary case', () => {
    assert.equal(
      needsVoice([
        { kind: 'human', isSelf: true },
        { kind: 'agent', isSelf: false },
        { kind: 'agent', isSelf: false },
      ]),
      false,
    );
  });

  it('turns on the moment a second human arrives', () => {
    assert.equal(
      needsVoice([
        { kind: 'human', isSelf: true },
        { kind: 'human', isSelf: false },
      ]),
      true,
    );
  });
});
