import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { identiconDataUri, identiconSvg } from './identicon.js';

/**
 * A face derived from a key has to be the same face every time, a different
 * face for a different key, and mirrored so it reads as a shape. Nothing
 * else about it matters enough to pin.
 */
describe('a face derived from a key', () => {
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);

  it('is the same for the same key, and differs between keys', () => {
    assert.equal(identiconSvg(a), identiconSvg(a));
    assert.notEqual(identiconSvg(a), identiconSvg(b));
  });

  it('is mirrored left to right', () => {
    const rects = [...identiconSvg(a).matchAll(/<rect x="(\d)" y="(\d)" width="1"/g)].map(
      (m) => [Number(m[1]), Number(m[2])] as const,
    );
    assert.ok(rects.length > 0, 'something is drawn');
    for (const [x, y] of rects) {
      const mirrored = 6 - x; // columns 1..5 in a 7-unit box: 1 <-> 5, 2 <-> 4, 3 <-> 3
      assert.ok(
        rects.some(([mx, my]) => mx === mirrored && my === y),
        `cell (${x},${y}) has no mirror`,
      );
    }
  });

  it('is an SVG an <img> can show without a request', () => {
    const uri = identiconDataUri(a, 32);
    assert.match(uri, /^data:image\/svg\+xml;utf8,/);
    assert.match(decodeURIComponent(uri), /width="32" height="32"/);
  });
});
