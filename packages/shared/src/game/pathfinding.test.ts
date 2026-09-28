import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { OfficeMap } from '../map.js';
import { findPath, nearestWalkable } from './pathfinding.js';

/**
 * The walkability grid is about to become shared truth: the browser walks on it
 * and the game server will simulate against it. These lock the contract before
 * a second consumer can quietly disagree with the first.
 *
 * The shipped map is checked in `src/maps/hq.test.ts`, next to the loader that
 * reads it.
 */

/** Build a map from ASCII art. `#` blocks, anything else is walkable. */
function gridMap(rows: string[]): OfficeMap {
  const width = rows[0]?.length ?? 0;
  const walkable: boolean[] = [];
  for (const row of rows) {
    assert.equal(row.length, width, 'ragged test grid');
    for (const cell of row) walkable.push(cell !== '#');
  }
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

describe('findPath', () => {
  it('walks a straight line across open floor', () => {
    const map = gridMap(['.....', '.....', '.....']);
    const path = findPath(map, { x: 0, y: 1 }, { x: 4, y: 1 });
    assert.equal(path.length, 4);
    assert.deepEqual(path.at(-1), { x: 4, y: 1 });
    // The start tile is excluded — you're already standing on it.
    assert.notDeepEqual(path[0], { x: 0, y: 1 });
  });

  it('returns an empty path when already at the goal', () => {
    const map = gridMap(['...', '...']);
    assert.deepEqual(findPath(map, { x: 1, y: 1 }, { x: 1, y: 1 }), []);
  });

  it('routes around a wall rather than through it', () => {
    const map = gridMap([
      '.....',
      '.###.',
      '.....',
    ]);
    const path = findPath(map, { x: 2, y: 0 }, { x: 2, y: 2 });
    assert.ok(path.length > 0, 'expected a route around the wall');
    for (const step of path) {
      assert.ok(map.walkable[step.y * map.width + step.x], `stepped into a wall at ${step.x},${step.y}`);
    }
    // Around one end of a 3-wide wall, not straight through it.
    assert.ok(path.length >= 6, `expected a detour, got ${path.length} steps`);
  });

  it('finds the single gap in a wall', () => {
    const map = gridMap([
      '.....',
      '##.##',
      '.....',
    ]);
    const path = findPath(map, { x: 0, y: 0 }, { x: 4, y: 2 });
    assert.ok(path.some((step) => step.x === 2 && step.y === 1), 'route must use the doorway');
  });

  it('gives up when the goal is walled off', () => {
    const map = gridMap([
      '...#.',
      '...#.',
      '...#.',
    ]);
    assert.deepEqual(findPath(map, { x: 0, y: 0 }, { x: 4, y: 0 }), []);
  });

  it('refuses to plan from or to a blocked tile', () => {
    const map = gridMap(['.#.', '...']);
    assert.deepEqual(findPath(map, { x: 1, y: 0 }, { x: 2, y: 1 }), [], 'blocked start');
    assert.deepEqual(findPath(map, { x: 0, y: 0 }, { x: 1, y: 0 }), [], 'blocked goal');
  });

  it('never steps diagonally', () => {
    const map = gridMap(['...', '...', '...']);
    const path = findPath(map, { x: 0, y: 0 }, { x: 2, y: 2 });
    let previous = { x: 0, y: 0 };
    for (const step of path) {
      const distance = Math.abs(step.x - previous.x) + Math.abs(step.y - previous.y);
      assert.equal(distance, 1, `non-adjacent step to ${step.x},${step.y}`);
      previous = step;
    }
  });
});

describe('nearestWalkable', () => {
  it('returns the target when it is already free', () => {
    const map = gridMap(['...', '...']);
    assert.deepEqual(nearestWalkable(map, { x: 1, y: 1 }), { x: 1, y: 1 });
  });

  it('picks the closest free tile in the ring, not the first scanned', () => {
    // Scan order would hit (0,0) first; (2,1) is the closer one.
    const map = gridMap([
      '.#.',
      '##.',
      '...',
    ]);
    assert.deepEqual(nearestWalkable(map, { x: 1, y: 1 }), { x: 2, y: 1 });
  });

  it('gives up rather than searching the whole map', () => {
    const map = gridMap([
      '###',
      '###',
      '###',
    ]);
    assert.equal(nearestWalkable(map, { x: 1, y: 1 }, 2), null);
  });
});
