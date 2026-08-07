import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { OfficeMap } from '../map.js';
import {
  PLAYER_HALF_SIZE,
  WALK_SPEED,
  directionFromIntent,
  followPath,
  isBlockedAt,
  normalize,
  stepMovement,
} from './movement.js';

/**
 * This module is the reason client prediction and server authority agree. If it
 * drifts, the symptom is rubber-banding in the browser — miles from the cause.
 */

/** Build a map from ASCII art. `#` blocks, anything else is walkable. */
function gridMap(rows: string[]): OfficeMap {
  const width = rows[0]?.length ?? 0;
  const walkable: boolean[] = [];
  for (const row of rows) for (const cell of row) walkable.push(cell !== '#');
  return {
    name: 'test',
    width,
    height: rows.length,
    tileSize: 32,
    zones: [],
    spawns: [],
    walkable,
  };
}

/** Centre of a tile, in pixels. */
const at = (tile: number) => tile * 32 + 16;

describe('normalize', () => {
  it('leaves a unit axis alone', () => {
    assert.deepEqual(normalize({ x: 1, y: 0 }), { x: 1, y: 0 });
  });

  it('stops diagonals being faster than straights', () => {
    const diagonal = normalize({ x: 1, y: 1 });
    assert.ok(Math.abs(Math.hypot(diagonal.x, diagonal.y) - 1) < 1e-9);
  });

  it('leaves a partial stick input alone', () => {
    assert.deepEqual(normalize({ x: 0.5, y: 0 }), { x: 0.5, y: 0 });
  });
});

describe('isBlockedAt', () => {
  const map = gridMap(['...', '.#.', '...']);

  it('is blocked standing on a wall', () => {
    assert.equal(isBlockedAt(map, at(1), at(1)), true);
  });

  it('is clear standing in the open', () => {
    assert.equal(isBlockedAt(map, at(0), at(0)), false);
  });

  it('counts the body box, not just the centre point', () => {
    // Centre is on the open tile, but the box overlaps the wall next door.
    const justLeftOfTheWall = 32 - PLAYER_HALF_SIZE + 1;
    assert.equal(isBlockedAt(map, justLeftOfTheWall, at(1)), true);
  });

  it('treats outside the map as solid', () => {
    assert.equal(isBlockedAt(map, -50, at(1)), true);
  });
});

describe('stepMovement', () => {
  // Wide enough that a full second of walking (128px) stays inside the map —
  // the edge of the world is solid, so a short map would block the step.
  const open = gridMap(['..........', '..........', '..........']);

  it('covers exactly the walking speed in one second', () => {
    const result = stepMovement(open, { x: at(1), y: at(1) }, { x: 1, y: 0 }, 1);
    assert.ok(Math.abs(result.x - (at(1) + WALK_SPEED)) < 1e-9);
    assert.equal(result.y, at(1));
  });

  it('does not move without intent', () => {
    const from = { x: at(1), y: at(1) };
    const result = stepMovement(open, from, { x: 0, y: 0 }, 1);
    assert.deepEqual({ x: result.x, y: result.y }, from);
    assert.equal(result.blocked, false);
  });

  it('stops at a wall instead of passing through it', () => {
    const map = gridMap(['...', '.#.', '...']);
    const start = { x: at(0), y: at(1) };
    const result = stepMovement(map, start, { x: 1, y: 0 }, 1);
    assert.equal(result.blocked, true);
    assert.equal(result.x, start.x, 'should not have advanced into the wall');
  });

  it('slides along a wall instead of stopping dead', () => {
    // Wall across the top; walking up-and-right should still go right.
    const map = gridMap(['###', '...', '...']);
    const start = { x: at(1), y: at(1) };
    const result = stepMovement(map, start, normalize({ x: 1, y: -1 }), 0.1);
    assert.ok(result.x > start.x, 'expected to keep moving along the wall');
    assert.equal(result.y, start.y, 'expected the blocked axis to be held');
    assert.equal(result.blocked, true);
  });

  it('is frame-rate independent over the same elapsed time', () => {
    const start = { x: at(1), y: at(1) };
    const oneBigStep = stepMovement(open, start, { x: 1, y: 0 }, 0.2);

    let position = start;
    for (let i = 0; i < 12; i += 1) {
      position = stepMovement(open, position, { x: 1, y: 0 }, 0.2 / 12);
    }

    // The server ticks at 20Hz and the browser renders at 60; they must land in
    // the same place or reconciliation fights prediction forever.
    assert.ok(Math.abs(position.x - oneBigStep.x) < 1e-6, `${position.x} vs ${oneBigStep.x}`);
  });
});

describe('directionFromIntent', () => {
  it('picks the dominant axis', () => {
    assert.equal(directionFromIntent({ x: 0.9, y: 0.1 }, 'down'), 'right');
    assert.equal(directionFromIntent({ x: 0.1, y: -0.9 }, 'down'), 'up');
  });

  it('keeps facing the same way when standing still', () => {
    assert.equal(directionFromIntent({ x: 0, y: 0 }, 'left'), 'left');
  });
});

describe('followPath', () => {
  const map = gridMap(['.....', '.....', '.....']);

  it('consumes a waypoint it can reach this step', () => {
    const from = { x: at(0), y: at(0) };
    const result = followPath(map, from, [{ x: 1, y: 0 }], 1);
    assert.equal(result.consumed, 1);
    assert.equal(result.position.x, at(1));
  });

  it('stops short when the step is too small, without consuming', () => {
    const from = { x: at(0), y: at(0) };
    const result = followPath(map, from, [{ x: 4, y: 0 }], 0.05);
    assert.equal(result.consumed, 0);
    assert.ok(result.position.x > from.x && result.position.x < at(4));
  });

  it('walks through several waypoints in one generous step', () => {
    const from = { x: at(0), y: at(0) };
    const result = followPath(map, from, [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }], 1);
    assert.equal(result.consumed, 3);
    assert.equal(result.position.x, at(3));
  });

  it('reports the direction it is heading', () => {
    const result = followPath(map, { x: at(0), y: at(0) }, [{ x: 0, y: 2 }], 0.1);
    assert.equal(directionFromIntent(result.intent, 'up'), 'down');
  });
});
