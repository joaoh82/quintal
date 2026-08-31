import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { watchForOrphaning } from '../src/cli.js';

/**
 * A fleet must not outlive the app that started it.
 *
 * Stopping it on the way out covers a tidy quit and nothing else. An app that
 * crashes, is force-quit or is killed runs no handler, and what survives is not
 * an idle process — it is a whole fleet still in the office, agents nothing on
 * the machine can see or stop. Three had accumulated before anybody noticed,
 * and the symptom was every agent appearing twice in a room where settings
 * listed each of them once.
 *
 * The signal is EOF on stdin. The host holds the write end open for its whole
 * life and never writes to it, so the pipe closing means that process ended —
 * by any route, including the ones that run no cleanup.
 *
 * `ppid` is kept as a secondary check and must never be the only one. It is
 * live under Node and frozen under Bun, which is what the compiled sidecar
 * runs: it caches the parent pid at startup and reports the dead parent
 * forever. That is why the first version of this passed in development and did
 * nothing whatsoever in the shipped app.
 */
async function tick(ms = 12): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** A stdin we can close on purpose, standing in for the pipe from the host. */
function fakeStdin() {
  const handlers = new Map<string, Array<() => void>>();
  let flowing = false;
  return {
    flowing: () => flowing,
    emit(event: string) {
      for (const handler of handlers.get(event) ?? []) handler();
    },
    stream: {
      on(event: string, handler: () => void) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        return this;
      },
      resume() {
        flowing = true;
        return this;
      },
      pause() {
        flowing = false;
        return this;
      },
    } as unknown as Pick<NodeJS.ReadStream, 'on' | 'resume' | 'pause'>,
  };
}

describe('a fleet whose app has gone', () => {
  it('does nothing unless asked, so a terminal fleet outlives its shell', async () => {
    const stdin = fakeStdin();
    let stopped = false;
    const cancel = watchForOrphaning(
      () => {
        stopped = true;
      },
      { asked: false, ppid: () => 1, stdin: stdin.stream },
    );

    assert.equal(cancel, null, 'nothing to cancel, because nothing is watching');
    assert.equal(stdin.flowing(), false, 'an unasked fleet must not eat its own stdin');
    stdin.emit('end');
    await tick();
    assert.equal(stopped, false, '`quintal-acp up &` must survive the shell exiting');
  });

  it('stops when its stdin closes, whatever the parent pid still claims', async () => {
    const stdin = fakeStdin();
    let stopped = false;
    // The pid never moves — exactly what the bundled sidecar reports after its
    // parent has died. The pipe is the only thing that knows the truth.
    watchForOrphaning(
      () => {
        stopped = true;
      },
      { asked: true, ppid: () => 4242, stdin: stdin.stream, intervalMs: 5 },
    );

    await tick();
    assert.equal(stopped, false, 'still held open, still working');

    stdin.emit('end');
    assert.equal(stopped, true, 'the pipe closed, so the host is gone');
  });

  it('treats the stream closing and breaking the same as EOF', async () => {
    for (const event of ['close', 'error']) {
      const stdin = fakeStdin();
      let stopped = false;
      watchForOrphaning(
        () => {
          stopped = true;
        },
        { asked: true, ppid: () => 4242, stdin: stdin.stream, intervalMs: 5 },
      );
      stdin.emit(event);
      assert.equal(stopped, true, `${event} means there is nobody left to serve`);
    }
  });

  it('starts the stream flowing, or EOF would never arrive', () => {
    const stdin = fakeStdin();
    watchForOrphaning(() => {}, {
      asked: true,
      ppid: () => 4242,
      stdin: stdin.stream,
      intervalMs: 5,
    });

    assert.equal(stdin.flowing(), true, 'a paused stream emits no end event');
  });

  it('stops at once when it was already orphaned', () => {
    const stdin = fakeStdin();
    let stopped = false;
    watchForOrphaning(
      () => {
        stopped = true;
      },
      { asked: true, ppid: () => 1, stdin: stdin.stream },
    );

    assert.equal(stopped, true, 'there was never anybody to serve');
  });

  it('still notices a reparenting, where the pid is live', async () => {
    const stdin = fakeStdin();
    let parent = 4242;
    let stopped = false;
    const cancel = watchForOrphaning(
      () => {
        stopped = true;
      },
      { asked: true, ppid: () => parent, stdin: stdin.stream, intervalMs: 5 },
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
    const stdin = fakeStdin();
    let parent = 4242;
    let stopped = false;
    const cancel = watchForOrphaning(
      () => {
        stopped = true;
      },
      { asked: true, ppid: () => parent, stdin: stdin.stream, intervalMs: 5 },
    );

    parent = 9999;
    await tick(40);
    assert.equal(stopped, true);
    cancel?.();
  });

  it('shuts down once, however many signals notice', async () => {
    const stdin = fakeStdin();
    let parent = 4242;
    let stops = 0;
    const cancel = watchForOrphaning(
      () => {
        stops += 1;
      },
      { asked: true, ppid: () => parent, stdin: stdin.stream, intervalMs: 5 },
    );

    // Both signals fire, repeatedly. Bringing a fleet home twice would race the
    // supervisor against itself.
    parent = 1;
    stdin.emit('end');
    stdin.emit('close');
    await tick(60);
    assert.equal(stops, 1);
    cancel?.();
  });
});
