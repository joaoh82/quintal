import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LastPlaces } from './last-places.js';

const at = (x: number) => ({ x, y: 0, dir: 'down' as const });

describe('last places', () => {
  it('hands the spot to the next arrival, once', () => {
    const places = new LastPlaces();
    places.left('josh', at(100));
    assert.deepEqual(places.take('josh'), at(100));
    assert.equal(places.take('josh'), null);
  });

  it('knows nothing of somebody who has not left', () => {
    assert.equal(new LastPlaces().take('josh'), null);
  });

  it('keeps the last of two tabs to close', () => {
    const places = new LastPlaces();
    places.left('josh', at(100));
    places.left('josh', at(200));
    assert.deepEqual(places.take('josh'), at(200));
  });

  it('keeps a dropped seat that nobody came back to', () => {
    const places = new LastPlaces();
    places.seatExpired('josh', at(100), false);
    assert.deepEqual(places.take('josh'), at(100));
  });

  it('brings a reload back to the seat it dropped', () => {
    assert.deepEqual(new LastPlaces().take('josh', at(100)), at(100));
  });

  // Reload at 100, walk to 200, go to Settings, come back, all inside the
  // grace of the seat the reload dropped.
  it('prefers a real leave to a seat still held', () => {
    const places = new LastPlaces();
    places.left('josh', at(200));
    assert.deepEqual(places.take('josh', at(100)), at(200));
  });

  // The same, but they do not come back until after the old seat has gone.
  it('does not let a seat timing out overwrite a later leave', () => {
    const places = new LastPlaces();
    places.left('josh', at(200));
    places.seatExpired('josh', at(100), false);
    assert.deepEqual(places.take('josh'), at(200));
  });

  // Reload at 100, walk to 200 and stay. The old seat means nothing now, or
  // the next arrival would be sent back to where the reload happened.
  it('ignores a seat timing out while they are in the room', () => {
    const places = new LastPlaces();
    places.seatExpired('josh', at(100), true);
    assert.equal(places.take('josh'), null);
  });

  it('forgets the oldest past its limit', () => {
    const places = new LastPlaces(2);
    places.left('a', at(1));
    places.left('b', at(2));
    places.left('a', at(3));
    places.left('c', at(4));
    assert.equal(places.take('b'), null);
    assert.deepEqual(places.take('a'), at(3));
    assert.deepEqual(places.take('c'), at(4));
  });
});
