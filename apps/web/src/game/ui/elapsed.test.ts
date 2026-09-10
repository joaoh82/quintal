import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatElapsed } from './elapsed.js';

describe('an elapsed time', () => {
  it('reads like a clock', () => {
    const table: Array<[number, string]> = [
      [0, '0s'],
      [999, '0s'],
      [27_000, '27s'],
      [60_000, '1m 0s'],
      [192_000, '3m 12s'],
      [3_842_000, '1h 4m 2s'],
      [-5_000, '0s'],
    ];
    for (const [ms, expected] of table) assert.equal(formatElapsed(ms), expected, `${ms}ms`);
  });
});
