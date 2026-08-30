import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { DEV_GAME_PORT, DEV_WEB_PORT, devGamePort, devWebPort } from './constants.js';

/**
 * Two instances on one machine.
 *
 * Not an exotic case: it is how you check that two offices are genuinely
 * separate, and how anything about multiplayer gets tested against more than
 * one server. With the ports baked in, the second instance collides on both —
 * and the obvious workaround, a second office at `127.0.0.1` instead of
 * `localhost`, is refused by the sign-in origin check. Correctly, which is why
 * the ports had to move instead.
 */
describe('the dev ports', () => {
  const before = { ...process.env };
  afterEach(() => {
    process.env = { ...before };
  });

  it('are the familiar ones when nothing says otherwise', () => {
    delete process.env.QUINTAL_WEB_PORT;
    delete process.env.QUINTAL_GAME_PORT;
    assert.equal(devWebPort(), DEV_WEB_PORT);
    assert.equal(devGamePort(), DEV_GAME_PORT);
  });

  it('move when asked', () => {
    process.env.QUINTAL_WEB_PORT = '3100';
    process.env.QUINTAL_GAME_PORT = '2667';
    assert.equal(devWebPort(), 3100);
    assert.equal(devGamePort(), 2667);
  });

  it('treat an empty value as unset, not as zero', () => {
    process.env.QUINTAL_WEB_PORT = '';
    assert.equal(devWebPort(), DEV_WEB_PORT);
    process.env.QUINTAL_WEB_PORT = '   ';
    assert.equal(devWebPort(), DEV_WEB_PORT);
  });

  /**
   * `Number('nope')` is NaN and `Number('')` is 0 — both would bind something
   * arbitrary and leave somebody wondering why nothing is where they put it.
   */
  it('refuse anything that is not a port, loudly', () => {
    for (const bad of ['nope', '0', '-1', '70000', '3000.5', '3000abc']) {
      process.env.QUINTAL_WEB_PORT = bad;
      assert.throws(() => devWebPort(), /QUINTAL_WEB_PORT/, `${bad} must be refused`);
    }
  });

  it('read the environment each time, so a test can move them', () => {
    process.env.QUINTAL_GAME_PORT = '2667';
    assert.equal(devGamePort(), 2667);
    process.env.QUINTAL_GAME_PORT = '2767';
    assert.equal(devGamePort(), 2767, 'not captured once at import');
  });
});
