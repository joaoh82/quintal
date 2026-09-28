import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BODIES, bodyForSeed, isBodyId } from './bodies.js';

describe('choosing a body', () => {
  it('always answers with one of the twelve', () => {
    for (const seed of ['', 'a', 'user_01HZ', '◆', 'Someone', '  ']) {
      assert.ok(isBodyId(bodyForSeed(seed)), `"${seed}" produced something that is not a body`);
    }
  });

  it('gives the same person the same body every time', () => {
    const seed = 'user_01HZXK9Q2MJ';
    assert.equal(bodyForSeed(seed), bodyForSeed(seed));
  });

  /**
   * The seeds this is fed are short and structured — session ids that differ in
   * one character, names like "agent-1" and "agent-2". A weak hash puts those
   * on the same body, which is the one outcome that makes a room of twelve
   * people look like a room of one again.
   */
  it('separates seeds that differ by a single character', () => {
    const bodies = new Set(
      Array.from({ length: BODIES.length }, (_, i) => bodyForSeed(`agent-${i}`)),
    );
    assert.ok(bodies.size >= BODIES.length / 2, `only ${bodies.size} distinct bodies`);
  });

  it('spreads a realistic population over the whole cast', () => {
    const bodies = new Set(
      Array.from({ length: 400 }, (_, i) => bodyForSeed(`user_${i.toString(36)}`)),
    );
    assert.equal(bodies.size, BODIES.length);
  });
});
