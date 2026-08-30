import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { watchForOrphaning } from '../src/cli.js';

/**
 * A fleet must not outlive the app that started it.
 *
 * Stopping it on the way out covers a tidy quit and nothing else. An app that
 * crashes, is force-quit or is killed runs no handler, and what survives is not
 * an idle process — it is a whole fleet still in the office, agents nothing on
 * the machine can see or stop. Two had accumulated before anybody noticed, and
 * the symptom was every agent appearing twice in a room where settings listed
 * each of them once.
 *
 * On Unix an orphan is reparented to init, so `ppid` of 1 means there is nobody
 * left to serve. Reparenting to anything *else* counts too: what matters is
 * that whoever asked for this fleet is gone.
 */
async function tick(ms = 12): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('a fleet whose app has gone', () => {
  it('does nothing unless asked, so a terminal fleet outlives its shell', async () => {
    let stopped = false;
    const cancel = watchForOrphaning(() => {
      stopped = true;
    }, { asked: false, ppid: () => 1 });

    assert.equal(cancel, null, 'nothing to cancel, because nothing is watching');
    await tick();
    assert.equal(stopped, false, '`quintal-acp up &` must survive the shell exiting');
  });

  it('stops at once when it was already orphaned', async () => {
    let stopped = false;
    watchForOrphaning(() => {
      stopped = true;
    }, { asked: true, ppid: () => 1 });

    assert.equal(stopped, true, 'there was never anybody to serve');
  });

  it('stops when the parent goes away', async () => {
    let parent = 4242;
    let stopped = false;
    const cancel = watchForOrphaning(
      () => {
        stopped = true;
      },
      { asked: true, ppid: () => parent, intervalMs: 5 },
    );

    await tick();
    assert.equal(stopped, false, 'still parented, still working');

    parent = 1;
    await tick(40);
    assert.equal(stopped, true, 'orphaned, so the fleet comes home');
    cancel?.();
  });

  /**
   * Not only `ppid === 1`. A parent that dies while something else adopts the
   * process leaves the same problem — a fleet serving nobody who asked for it.
   */
  it('stops when it is reparented to somebody else', async () => {
    let parent = 4242;
    let stopped = false;
    const cancel = watchForOrphaning(
      () => {
        stopped = true;
      },
      { asked: true, ppid: () => parent, intervalMs: 5 },
    );

    parent = 9999;
    await tick(40);
    assert.equal(stopped, true);
    cancel?.();
  });

  it('shuts down once, however many ticks notice', async () => {
    let parent = 4242;
    let stops = 0;
    const cancel = watchForOrphaning(
      () => {
        stops += 1;
      },
      { asked: true, ppid: () => parent, intervalMs: 5 },
    );

    parent = 1;
    await tick(60);
    assert.equal(stops, 1, 'the interval clears itself on the way out');
    cancel?.();
  });
});
