import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EarshotTracker,
  VOICE_FRAME_MAX_BYTES,
  VOICE_HEADER_BYTES,
  clampLevel,
  packVoiceHeader,
  parseVoiceHeader,
  type EarshotPlayer,
} from './voice.js';

/**
 * Two rules the whole feature rests on. Who hears whom is decided here, and
 * an agent is never part of the answer. A frame is only ever refused for its
 * size, never for what its header says.
 */

function human(id: string, x: number, y = 0): EarshotPlayer {
  return { id, kind: 'human', x, y };
}

describe('who hears whom', () => {
  it('enters at the radius and leaves two tiles past it, not before', () => {
    const tracker = new EarshotTracker();
    assert.deepEqual(tracker.update([human('a', 0), human('b', 6)], 5), []);
    assert.deepEqual(tracker.update([human('a', 0), human('b', 5)], 5), [
      { a: 'a', b: 'b', kind: 'enter' },
    ]);
    // Drift back over the line: still hearing.
    assert.deepEqual(tracker.update([human('a', 0), human('b', 6.5)], 5), []);
    assert.deepEqual(tracker.hearers('a'), ['b']);
    assert.deepEqual(tracker.update([human('a', 0), human('b', 7.01)], 5), [
      { a: 'a', b: 'b', kind: 'leave' },
    ]);
    assert.deepEqual(tracker.hearers('a'), []);
  });

  it('never puts an agent in a pair, however close it stands', () => {
    const tracker = new EarshotTracker();
    const deltas = tracker.update(
      [human('a', 0), { id: 'bot', kind: 'agent', x: 0.5, y: 0 }, human('b', 1)],
      5,
    );
    assert.deepEqual(deltas, [{ a: 'a', b: 'b', kind: 'enter' }]);
    assert.deepEqual(tracker.hearers('bot'), []);
    assert.deepEqual(tracker.hearers('a'), ['b']);
  });

  it('ends every pair somebody was in when they leave, and when they vanish from the list', () => {
    const tracker = new EarshotTracker();
    tracker.update([human('a', 0), human('b', 1), human('c', 2)], 5);
    assert.deepEqual(
      tracker.remove('a').map((d) => d.kind),
      ['leave', 'leave'],
    );
    assert.deepEqual(tracker.hearers('b'), ['c']);
    // c stops being reported at all — the next update says so.
    assert.deepEqual(tracker.update([human('b', 1)], 5), [{ a: 'b', b: 'c', kind: 'leave' }]);
  });

  it('is symmetric: the pair is one fact, however the list is ordered', () => {
    const tracker = new EarshotTracker();
    tracker.update([human('b', 1), human('a', 0)], 5);
    assert.deepEqual(tracker.hearers('a'), ['b']);
    assert.deepEqual(tracker.hearers('b'), ['a']);
    assert.deepEqual(
      tracker.update([human('a', 0), human('b', 1)], 5),
      [],
      'reordering changes nothing',
    );
  });
});

describe('the frame header', () => {
  it('round-trips, and clamps a level it cannot believe', () => {
    const frame = new Uint8Array(VOICE_HEADER_BYTES + 3);
    packVoiceHeader(frame, { seq: 70_000, timestamp: 2 ** 32 + 5, level: 12, flags: 1 });
    assert.deepEqual(parseVoiceHeader(frame), {
      seq: 70_000 & 0xffff,
      timestamp: 5,
      level: 0,
      flags: 1,
    });
    assert.equal(clampLevel(-200), -127);
    assert.equal(clampLevel(Number.NaN), -127);
    assert.equal(clampLevel(-30.4), -30);
  });

  it('refuses only on size', () => {
    assert.equal(parseVoiceHeader(new Uint8Array(VOICE_HEADER_BYTES - 1)), null);
    assert.equal(parseVoiceHeader(new Uint8Array(VOICE_FRAME_MAX_BYTES + 1)), null);
    assert.ok(
      parseVoiceHeader(new Uint8Array(VOICE_HEADER_BYTES)),
      'a header with no payload is a frame',
    );
    assert.ok(parseVoiceHeader(new Uint8Array(VOICE_FRAME_MAX_BYTES)));
  });
});
