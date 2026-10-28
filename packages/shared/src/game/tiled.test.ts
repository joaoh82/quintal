import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { interactableAt } from '../map.js';
import { buildWalkableGrid, parseTiledMap, type TiledMap, type TiledObject } from './tiled.js';

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
const identity = <T extends TiledObject>(o: T) => o;

describe('buildWalkableGrid', () => {
  it('blocks on walls and authored collision, but not on the floor', () => {
    const map = base([
      tileLayer('floor', [1, 1, 1, 1]),
      tileLayer('walls', [1, 0, 0, 0]),
      tileLayer('collision', [0, 1, 0, 0]),
    ]);
    assert.deepEqual(buildWalkableGrid(map), [false, false, true, true]);
  });

  /**
   * Furniture is drawn from the `props` object layer, not the grid, precisely
   * so that a desk's 128x96 cell does not become a 128x96 obstacle. If an
   * unknown tile layer ever started blocking again, every room with a sprite
   * layer in it would silently shrink.
   */
  it('ignores tile layers that are not collision layers', () => {
    const map = base([
      tileLayer('floor', [1, 1, 1, 1]),
      tileLayer('decor', [1, 1, 1, 1]),
    ]);
    assert.deepEqual(buildWalkableGrid(map), [true, true, true, true]);
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

  it('rejects an interactable with an unknown kind', () => {
    const map = base([
      ...floorOnly,
      {
        type: 'objectgroup',
        name: 'interactables',
        objects: [
          object({
            name: 'the board',
            properties: [{ name: 'kind', type: 'string', value: 'borad' }],
          }),
        ],
      },
    ]);
    assert.throws(() => parseTiledMap(map), /borad/);
  });

  it('reads an interactable: where to stand, in tiles, and the prop it belongs to', () => {
    const map = base([
      ...floorOnly,
      {
        type: 'objectgroup',
        name: 'interactables',
        objects: [
          object({
            name: 'the board',
            x: 32,
            y: 32,
            width: 32,
            height: 32,
            properties: [
              { name: 'kind', type: 'string', value: 'board' },
              { name: 'interactableId', type: 'string', value: 'board' },
              { name: 'label', type: 'string', value: 'the board' },
              { name: 'prop', type: 'string', value: 'hallway/noticeboard' },
              { name: 'haloX', type: 'int', value: 27 },
              { name: 'haloY', type: 'int', value: 10 },
              { name: 'haloWidth', type: 'int', value: 42 },
              { name: 'haloHeight', type: 'int', value: 32 },
            ],
          }),
          object({ id: 2, name: 'bare floor', properties: [{ name: 'kind', type: 'string', value: 'board' }] }),
        ],
      },
    ]);
    const parsed = parseTiledMap(map);
    assert.deepEqual(parsed.interactables[0], {
      id: 'board',
      kind: 'board',
      label: 'the board',
      bounds: { x: 1, y: 1, width: 1, height: 1 },
      prop: 'hallway/noticeboard',
      halo: { x: 27, y: 10, width: 42, height: 32 },
    });
    assert.equal(parsed.interactables[1]?.prop, null, 'a patch of floor belongs to no prop');
    assert.equal(parsed.interactables[1]?.halo, null, 'and has nothing to light up');
    assert.equal(parsed.interactables[1]?.id, 'interactable-2');
    assert.equal(interactableAt(parsed, 1, 1)?.id, 'board');
    assert.equal(interactableAt(parsed, 0, 0)?.id, 'interactable-2');
    assert.equal(interactableAt(parsed, 1, 0), null);
  });

  it('parses a map with no interactables at all', () => {
    assert.deepEqual(parseTiledMap(base([...floorOnly])).interactables, []);
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
