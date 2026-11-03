import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LastPlaces } from './last-places.js';

const at = (x: number) => ({ x, y: 0, dir: 'down' as const });

describe('last places', () => {
  it('hands the spot to the next arrival, once', () => {
    const places = new LastPlaces();
    places.left('josh', at(100), false);
    assert.deepEqual(places.take('josh'), at(100));
    assert.equal(places.take('josh'), null);
  });

  it('knows nothing of somebody who has not left', () => {
    assert.equal(new LastPlaces().take('josh'), null);
  });

  it('keeps the last of two tabs to close', () => {
    const places = new LastPlaces();
    places.left('josh', at(100), false);
    places.left('josh', at(200), false);
    assert.deepEqual(places.take('josh'), at(200));
  });

  it('keeps a dropped seat that nobody came back to', () => {
    const places = new LastPlaces();
    places.left('josh', at(100), true);
    assert.deepEqual(places.take('josh'), at(100));
  });

  // Reload, walk off, go to Settings, all inside the old seat's grace.
  it('does not let a seat timing out overwrite a later leave', () => {
    const places = new LastPlaces();
    places.left('josh', at(200), false);
    places.left('josh', at(100), true);
    assert.deepEqual(places.take('josh'), at(200));
  });

  it('forgets the oldest past its limit', () => {
    const places = new LastPlaces(2);
    places.left('a', at(1), false);
    places.left('b', at(2), false);
    places.left('a', at(3), false);
    places.left('c', at(4), false);
    assert.equal(places.take('b'), null);
    assert.deepEqual(places.take('a'), at(3));
    assert.deepEqual(places.take('c'), at(4));
  });
});
