import assert from 'node:assert/strict';
import { test } from 'node:test';
import { minimapBounds, minimapObstacles } from './minimapGeometry';

test('nearby crop follows self and stays within the office at every corner', () => {
  const map = { width: 100, height: 80 };
  const view = { x: 35, y: 30, width: 20, height: 16 };
  assert.deepEqual(minimapBounds(map, view, { x: 50, y: 40 }), { x: 30, y: 24, width: 40, height: 32 });
  for (const self of [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 80 }, { x: 100, y: 80 }]) {
    const crop = minimapBounds(map, view, self);
    assert.ok(crop.x >= 0 && crop.y >= 0);
    assert.ok(crop.x + crop.width <= map.width && crop.y + crop.height <= map.height);
    assert.equal(crop.width / crop.height, map.width / map.height);
  }
});

test('small maps and viewports larger than the map produce a whole-office crop', () => {
  assert.deepEqual(minimapBounds({ width: 12, height: 10 }, { x: -20, y: -10, width: 50, height: 40 }), { x: 0, y: 0, width: 12, height: 10 });
});

test('blocked runs are merged without bridging walkable tiles or row boundaries', () => {
  assert.equal(minimapObstacles({ width: 4, height: 2, walkable: [false, false, true, false, false, true, true, false] }), 'M0 0h2v1h-2zM3 0h1v1h-1zM0 1h1v1h-1zM3 1h1v1h-1z');
  assert.equal(minimapObstacles({ width: 2, height: 1, walkable: [true, true] }), '');
});
