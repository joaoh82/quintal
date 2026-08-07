import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildWalkableGrid, parseTiledMap, type TiledMap } from './tiled.js';

/**
 * The parser's job is to fail loudly. A map is authored by hand in Tiled, so a
 * typo in a property is the most likely defect there is — and the worst outcome
 * is a map that loads "fine" with a zone or a spawn quietly missing.
 */

const base = (layers: TiledMap['layers']): TiledMap => ({
  width: 2,
  height: 2,
  tilewidth: 32,
  tileheight: 32,
  layers,
  properties: [{ name: 'name', type: 'string', value: 'Test' }],
});

const tileLayer = (name: string, data: number[]) => ({
  type: 'tilelayer' as const,
  name,
  width: 2,
  height: 2,
  data,
  visible: true,
});

const object = (
  overrides: Partial<Parameters<typeof identity>[0]> = {},
): Parameters<typeof identity>[0] => ({
  id: 1,
  name: 'thing',
  type: '',
  x: 0,
  y: 0,
  width: 32,
  height: 32,
  ...overrides,
});
const identity = <T extends { id: number; name: string; type: string; x: number; y: number; width: number; height: number; point?: boolean; properties?: Array<{ name: string; type: string; value: string }> }>(o: T) => o;

describe('buildWalkableGrid', () => {
  it('blocks on walls and furniture but not floor or decor', () => {
    const map = base([
      tileLayer('floor', [1, 1, 1, 1]),
      tileLayer('walls', [1, 0, 0, 0]),
      tileLayer('furniture', [0, 1, 0, 0]),
      tileLayer('decor', [0, 0, 1, 0]),
    ]);
    assert.deepEqual(buildWalkableGrid(map), [false, false, true, true]);
  });
});

describe('parseTiledMap', () => {
  const floorOnly = [tileLayer('floor', [1, 1, 1, 1])];

  it('rejects a zone with an unknown kind', () => {
    const map = base([
      ...floorOnly,
      {
        type: 'objectgroup',
        name: 'zones',
        objects: [
          object({
            name: 'Typo Room',
            properties: [{ name: 'kind', type: 'string', value: 'privte' }],
          }),
        ],
      },
    ]);
    assert.throws(() => parseTiledMap(map), /privte/);
  });

  it('rejects a spawn with an unknown kind', () => {
    const map = base([
      ...floorOnly,
      {
        type: 'objectgroup',
        name: 'spawns',
        objects: [
          object({
            name: 'agent-1',
            point: true,
            properties: [{ name: 'kind', type: 'string', value: 'agnt' }],
          }),
        ],
      },
    ]);
    // Defaulting this to "human" would leave agents silently spawn-less.
    assert.throws(() => parseTiledMap(map), /agnt/);
  });

  it('rejects a spawn with no kind at all', () => {
    const map = base([
      ...floorOnly,
      {
        type: 'objectgroup',
        name: 'spawns',
        objects: [object({ name: 'nameless', point: true })],
      },
    ]);
    assert.throws(() => parseTiledMap(map), /missing/);
  });

  it('rejects non-square tiles', () => {
    const map = { ...base(floorOnly), tileheight: 16 };
    assert.throws(() => parseTiledMap(map), /Non-square/);
  });

  it('reads zone bounds in tiles, not pixels', () => {
    const map = base([
      ...floorOnly,
      {
        type: 'objectgroup',
        name: 'zones',
        objects: [
          object({
            name: 'Bay',
            x: 64,
            y: 32,
            width: 96,
            height: 64,
            properties: [
              { name: 'kind', type: 'string', value: 'agent_area' },
              { name: 'zoneId', type: 'string', value: 'bay' },
              { name: 'label', type: 'string', value: 'Agent Bay' },
            ],
          }),
        ],
      },
    ]);
    const [zone] = parseTiledMap(map).zones;
    assert.deepEqual(zone?.bounds, { x: 2, y: 1, width: 3, height: 2 });
    assert.equal(zone?.id, 'bay');
    assert.equal(zone?.label, 'Agent Bay');
  });
});
