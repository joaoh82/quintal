import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { recover, type RecoveryDeps } from './recovery.js';

/**
 * The policy for getting back in, with the clock and the network faked.
 *
 * What matters: the seat is retried while the server is still holding it, a
 * fresh join takes over once it is not, a join that will never work stops
 * rather than spinning, and cancelling stops everything at once.
 */

class World {
  time = 0;
  waits: number[] = [];
  reports: string[] = [];
  resumes = 0;
  joins = 0;
  stop = false;

  constructor(
    private readonly resumeOutcomes: Array<'ok' | 'fail'>,
    private readonly joinOutcomes: Array<'ok' | 'fail' | 'signed-out'>,
  ) {}

  deps(): RecoveryDeps<string> {
    return {
      resume: async () => {
        this.resumes += 1;
        const outcome = this.resumeOutcomes.shift() ?? 'fail';
        if (outcome === 'ok') return `seat-${this.resumes}`;
        throw new Error('window closed');
      },
      join: async () => {
        this.joins += 1;
        const outcome = this.joinOutcomes.shift() ?? 'fail';
        if (outcome === 'ok') return `fresh-${this.joins}`;
        const error = new Error(outcome === 'signed-out' ? 'sign in again' : 'unreachable');
        if (outcome === 'signed-out') error.name = 'NotSignedInError';
        throw error;
      },
      wait: async (ms) => {
        this.waits.push(ms);
        this.time += ms;
      },
      now: () => this.time,
      cancelled: () => this.stop,
      report: (phase, attempt) => {
        this.reports.push(`${phase}#${attempt}`);
      },
    };
  }
}

const WINDOW = { resumeWindowMs: 20_000, resumeEveryMs: 1_500, joinBackoffMs: 1_000, joinBackoffCapMs: 8_000 };

describe('getting back into the office', () => {
  it('takes the seat back while the server still holds it', async () => {
    const w = new World(['fail', 'fail', 'ok'], []);
    const outcome = await recover(w.deps(), WINDOW);
    assert.deepEqual(outcome, { kind: 'resumed', room: 'seat-3' });
    assert.equal(w.joins, 0, 'no fresh session while the old one can be had');
    assert.deepEqual(w.waits, [1_500, 1_500]);
  });

  it('starts over once the window has closed', async () => {
    const w = new World([], ['ok']);
    const outcome = await recover(w.deps(), WINDOW);
    assert.deepEqual(outcome, { kind: 'rejoined', room: 'fresh-1' });
    assert.ok(w.resumes >= 13, `tried the seat for the whole window (${w.resumes})`);
    assert.ok(w.time >= 20_000, 'and only then gave up on it');
    assert.equal(w.reports.at(-1), 'rejoining#1');
  });

  it('keeps trying a fresh join, backing off, until the office answers', async () => {
    const w = new World([], ['fail', 'fail', 'fail', 'fail', 'fail', 'ok']);
    const outcome = await recover(w.deps(), WINDOW);
    assert.deepEqual(outcome, { kind: 'rejoined', room: 'fresh-6' });
    const joinWaits = w.waits.slice(-5);
    assert.deepEqual(joinWaits, [1_000, 2_000, 4_000, 8_000, 8_000], 'doubling to the cap');
  });

  it('stops when a join says the session is gone — waiting will not sign anybody in', async () => {
    const w = new World([], ['fail', 'signed-out', 'ok']);
    const outcome = await recover(w.deps(), WINDOW);
    assert.equal(outcome.kind, 'refused');
    assert.equal(w.joins, 2, 'not a third time');
  });

  it('stops the moment it is cancelled, in either phase', async () => {
    const early = new World(['fail', 'fail'], []);
    const deps = early.deps();
    const original = deps.wait;
    deps.wait = async (ms) => {
      await original(ms);
      early.stop = true;
    };
    assert.deepEqual(await recover(deps, WINDOW), { kind: 'cancelled' });
    assert.equal(early.resumes, 1);

    const late = new World([], ['fail']);
    const lateDeps = late.deps();
    const lateWait = lateDeps.wait;
    lateDeps.wait = async (ms) => {
      await lateWait(ms);
      late.stop = true;
    };
    // No window at all: straight to fresh joins.
    assert.deepEqual(await recover(lateDeps, { ...WINDOW, resumeWindowMs: 0 }), { kind: 'cancelled' });
    assert.equal(late.resumes, 0);
    assert.equal(late.joins, 1);
  });
});
