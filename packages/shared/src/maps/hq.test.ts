import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { findPath, nearestWalkable } from '../game/pathfinding.js';
import { isWalkable, spawnFor, type OfficeMap } from '../map.js';
import { loadOfficeMap } from './index.js';

/**
 * The shipped map, checked against the things the office assumes about it.
 *
 * `tools/build-hq-map.mjs` runs some of these before it writes the file, but
 * the file is what is committed and what both the browser and the server load,
 * and nothing forces the two to have been produced by each other. A desk nudged
 * two tiles left that seals the cafeteria should fail here, not at the moment
 * somebody walks into it.
 */

const map: OfficeMap = loadOfficeMap('hq');

/** Every tile you can stand on, walking out from one you already stand on. */
function reachableFrom(start: { x: number; y: number }): Set<string> {
  const seen = new Set([`${start.x},${start.y}`]);
  const queue = [start];
  while (queue.length > 0) {
    const tile = queue.pop();
    if (!tile) break;
    for (const [dx, dy] of [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ] as const) {
      const next = { x: tile.x + dx, y: tile.y + dy };
      const key = `${next.x},${next.y}`;
      if (seen.has(key) || !isWalkable(map, next.x, next.y)) continue;
      seen.add(key);
      queue.push(next);
    }
  }
  return seen;
}

describe('the shipped HQ map', () => {
  it('parses into the shape the renderer and the server agree on', () => {
    assert.equal(map.name, 'Quintal HQ');
    assert.equal(map.tileSize, 32);
    assert.equal(map.walkable.length, map.width * map.height);
    assert.ok(map.width >= 40 && map.height >= 30, `${map.width}x${map.height} is smaller than the old HQ`);
  });

  it('has the zones the product depends on', () => {
    const ids = new Set(map.zones.map((zone) => zone.id));
    for (const id of ['lobby', 'agent-bay', 'focus', 'huddle', 'deep-work']) {
      assert.ok(ids.has(id), `zone "${id}" is missing`);
    }

    const agentAreas = map.zones.filter((zone) => zone.kind === 'agent_area');
    assert.equal(agentAreas.length, 1, 'exactly one Agent Bay');
    assert.equal(map.zones.filter((zone) => zone.kind === 'private').length, 3);
    assert.ok(map.zones.some((zone) => zone.kind === 'spawn'));

    // The bay is the product's headline feature; an edit that shrinks it to a
    // corner should fail here, not in a screenshot.
    const bay = agentAreas[0];
    assert.ok(bay);
    assert.ok(
      bay.bounds.width * bay.bounds.height >= 250,
      `Agent Bay is only ${bay.bounds.width}x${bay.bounds.height} tiles`,
    );
  });

  it('can walk from the human spawn to every spawn point', () => {
    const human = map.spawns.find((spawn) => spawn.kind === 'human');
    assert.ok(human, 'no human spawn');
    assert.ok(map.spawns.some((spawn) => spawn.kind === 'agent'), 'no agent spawn');

    for (const spawn of map.spawns) {
      assert.ok(
        isWalkable(map, spawn.x, spawn.y),
        `spawn "${spawn.name}" is inside something solid`,
      );
      if (spawn === human) continue;
      assert.ok(findPath(map, human, spawn).length > 0, `no route from the lobby to "${spawn.name}"`);
    }
  });

  it('leaves every meeting room reachable through its door', () => {
    const human = spawnFor(map, 'human');

    for (const zone of map.zones.filter((z) => z.kind === 'private')) {
      const inside = { x: zone.bounds.x, y: zone.bounds.y + 1 };
      const goal = nearestWalkable(map, inside);
      assert.ok(goal, `${zone.label} has no free tile near its corner`);
      assert.ok(findPath(map, human, goal).length > 0, `${zone.label} is sealed off`);
    }
  });

  /**
   * Not just "can I get in", but "is every tile in it usable once I am".
   *
   * A pocket of floor sealed in by furniture is not cosmetic: click it and
   * `nearestWalkable` routes you to a tile A* cannot reach, so the click does
   * nothing and the office looks broken. Two of those survived the first build
   * of this map — one behind a vending machine, one between two garden tables.
   */
  it('leaves every tile of every zone reachable from the lobby', () => {
    const seen = reachableFrom(spawnFor(map, 'human'));

    for (const zone of map.zones) {
      let open = 0;
      let reached = 0;
      for (let y = zone.bounds.y; y < zone.bounds.y + zone.bounds.height; y += 1) {
        for (let x = zone.bounds.x; x < zone.bounds.x + zone.bounds.width; x += 1) {
          if (!isWalkable(map, x, y)) continue;
          open += 1;
          if (seen.has(`${x},${y}`)) reached += 1;
        }
      }
      assert.ok(open > 0, `zone "${zone.id}" has nowhere to stand`);
      assert.equal(
        reached,
        open,
        `zone "${zone.id}": ${open - reached} of ${open} open tiles cannot be reached`,
      );
    }
  });

  it('leaves room to move: most of the floor is not furniture', () => {
    const walkable = map.walkable.filter(Boolean).length;
    assert.ok(
      walkable > map.walkable.length * 0.5,
      `only ${walkable} of ${map.walkable.length} tiles are walkable`,
    );
  });
});
