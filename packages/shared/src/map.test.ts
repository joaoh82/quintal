import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { tileBeside, type OfficeMap } from './map.js';

/**
 * Where an agent stands when it has been asked to come to somebody.
 *
 * "Come here" used to be impossible: `move_to` took a zone and nothing else, so
 * an agent asked to walk over would explain that it could only reach rooms and
 * that its caller was standing outside one. Answering it means finding a tile
 * next to a person, which is a small amount of geometry with several ways to be
 * quietly wrong.
 */

/** A room with a wall down the middle of the third column. */
function room(width = 7, height = 7, walls: Array<[number, number]> = []): OfficeMap {
  const walkable = new Array<boolean>(width * height).fill(true);
  for (const [x, y] of walls) walkable[y * width + x] = false;
  return {
    name: 'test',
    width,
    height,
    tileSize: 16,
    zones: [],
    spawns: [],
    walkable,
  } as unknown as OfficeMap;
}

const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

describe('finding a tile beside somebody', () => {
  it('never returns the tile they are standing on', () => {
    const beside = tileBeside(room(), 3, 3);
    assert.ok(beside);
    assert.notDeepEqual(beside, { x: 3, y: 3 }, 'two people do not share a tile');
  });

  it('stops immediately next to them', () => {
    const beside = tileBeside(room(), 3, 3);
    assert.ok(beside);
    assert.equal(distance(beside, { x: 3, y: 3 }), 1);
  });

  /**
   * Ring by ring, closest first. Scanning in a fixed direction would answer
   * with whatever was checked first — being asked to come here and arriving
   * four tiles away is the kind of thing nobody reports and everybody notices.
   */
  it('takes the nearest free tile when the close ones are blocked', () => {
    const blocked: Array<[number, number]> = [];
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        if (dx !== 0 || dy !== 0) blocked.push([3 + dx, 3 + dy]);
      }
    }
    const beside = tileBeside(room(7, 7, blocked), 3, 3);
    assert.ok(beside);
    assert.equal(distance(beside, { x: 3, y: 3 }), 2, 'one ring further, not more');
  });

  it('skips a tile somebody else already stands on', () => {
    // Everything in the first ring is taken except one square.
    const taken = new Set<string>();
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        if (dx !== 0 || dy !== 0) taken.add(`${3 + dx},${3 + dy}`);
      }
    }
    taken.delete('4,3');

    assert.deepEqual(tileBeside(room(), 3, 3, taken), { x: 4, y: 3 });
  });

  it('stays inside the map at a corner', () => {
    const beside = tileBeside(room(), 0, 0);
    assert.ok(beside);
    assert.ok(beside.x >= 0 && beside.y >= 0, 'a tile off the map is not walkable');
  });

  it('says so when there is nowhere to stand', () => {
    // A single walkable tile, with the person on it.
    const map = room(3, 3, [
      [0, 0],
      [1, 0],
      [2, 0],
      [0, 1],
      [2, 1],
      [0, 2],
      [1, 2],
      [2, 2],
    ]);
    assert.equal(
      tileBeside(map, 1, 1, new Set(), 1),
      null,
      'null is a refusal the caller can report, not a tile in a wall',
    );
  });
});
