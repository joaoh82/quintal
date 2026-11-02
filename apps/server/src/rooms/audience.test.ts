import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canSeeTurn } from './audience.js';

const RADIUS = 100;
const AT = { x: 0, y: 0 };
const viewer = (over: Partial<Parameters<typeof canSeeTurn>[2]>) => ({
  x: 1000,
  y: 1000,
  inChannel: false,
  followedZone: null,
  ...over,
});

describe('who may read a turn', () => {
  it('a channel turn is for members, wherever they stand', () => {
    const turn = { channelId: 'ch-1' };
    assert.equal(canSeeTurn(turn, AT, viewer({ inChannel: true }), RADIUS), true);
    assert.equal(
      canSeeTurn(turn, AT, viewer({ inChannel: false, x: 0, y: 0 }), RADIUS),
      false,
      'standing beside the agent is not membership',
    );
    assert.equal(
      canSeeTurn(turn, AT, viewer({ inChannel: false, followedZone: 'bay' }), RADIUS),
      false,
      'following the zone it sits in is not membership either',
    );
  });

  it('a zone turn is for earshot of where it began, and for readers of that zone', () => {
    const turn = { zoneId: 'bay' };
    assert.equal(canSeeTurn(turn, AT, viewer({ x: 60, y: 80 }), RADIUS), true, 'within earshot');
    assert.equal(canSeeTurn(turn, AT, viewer({ x: 60, y: 81 }), RADIUS), false, 'a step outside');
    assert.equal(canSeeTurn(turn, AT, viewer({ followedZone: 'bay' }), RADIUS), true, 'reading the zone');
    assert.equal(canSeeTurn(turn, AT, viewer({ followedZone: 'garden' }), RADIUS), false);
  });
});
