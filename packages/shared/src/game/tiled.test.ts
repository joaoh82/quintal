import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { interactableAt, seatAt, withSeatOpen } from '../map.js';
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

describe('seats', () => {
  const floorOnly = [
    {
      type: 'tilelayer' as const,
      name: 'floor',
      width: 2,
      height: 2,
      data: [1, 1, 1, 1],
      visible: true,
    },
  ];
  const seatLayer = (properties: Array<{ name: string; type: string; value: string | number }>) => ({
    type: 'objectgroup' as const,
    name: 'seats',
    objects: [object({ name: 'bay-1', x: 48, y: 48, width: 0, height: 0, point: true, properties })],
  });

  it('reads a seat: its tile from the point, the way it faces, and its screen', () => {
    const parsed = parseTiledMap(
      base([
        ...floorOnly,
        seatLayer([
          { name: 'seatId', type: 'string', value: 'bay-1' },
          { name: 'facing', type: 'string', value: 'up' },
          { name: 'screenX', type: 'int', value: 40 },
          { name: 'screenY', type: 'int', value: 10 },
          { name: 'screenWidth', type: 'int', value: 19 },
          { name: 'screenHeight', type: 'int', value: 16 },
        ]),
      ]),
    );
    assert.deepEqual(parsed.seats, [
      { id: 'bay-1', tile: { x: 1, y: 1 }, facing: 'up', screen: { x: 40, y: 10, width: 19, height: 16 } },
    ]);
  });

  it('blocks a seat for everyone, and opens it for one', () => {
    const parsed = parseTiledMap(
      base([...floorOnly, seatLayer([{ name: 'facing', type: 'string', value: 'up' }])]),
    );
    assert.equal(parsed.seats[0]?.id, 'seat-1', 'named after its object when the map gives no id');
    assert.equal(parsed.seats[0]?.screen, null);
    assert.deepEqual(parsed.walkable, [true, true, true, false], 'the chair is nobody\'s to stand on');
    const seat = parsed.seats[0]!;
    assert.deepEqual(withSeatOpen(parsed, seat).walkable, [true, true, true, true]);
    assert.deepEqual(parsed.walkable, [true, true, true, false], 'and the shared map is untouched');
    assert.equal(seatAt(parsed, 1, 1)?.id, 'seat-1');
    assert.equal(seatAt(parsed, 0, 0), null);
  });

  it('rejects a seat facing nowhere the office knows', () => {
    assert.throws(
      () => parseTiledMap(base([...floorOnly, seatLayer([{ name: 'facing', type: 'string', value: 'nort' }])])),
      /nort/,
    );
    assert.throws(() => parseTiledMap(base([...floorOnly, seatLayer([])])), /<missing>/);
  });

  it('parses a map with no seats at all', () => {
    assert.deepEqual(parseTiledMap(base([...floorOnly])).seats, []);
  });
});
