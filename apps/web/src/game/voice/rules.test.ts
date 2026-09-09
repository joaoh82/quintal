import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DTX_THRESHOLD_DBOV,
  JitterScheduler,
  SpeakingMeter,
  gainFor,
  isSilence,
  levelDbov,
  shouldBeOpen,
} from './rules.js';

/**
 * The arithmetic under the voice client. Each rule is one the ear will judge
 * later; these pin what was decided so a retune is a deliberate change.
 */

describe('how loud a frame is', () => {
  it('is full scale at 1.0, silence at nothing, and clamped in between', () => {
    assert.equal(levelDbov(new Float32Array(960).fill(1)), 0);
    assert.equal(levelDbov(new Float32Array(960)), -127);
    assert.equal(levelDbov(new Float32Array(0)), -127);
    const quiet = levelDbov(new Float32Array(960).fill(0.001));
    assert.ok(quiet < -50 && quiet > -70, `${quiet}`);
    assert.equal(levelDbov(new Float32Array(960).fill(3)), 0, 'over full scale still clamps to 0');
  });

  it('calls the very quiet silence, and nothing louder', () => {
    assert.equal(isSilence(DTX_THRESHOLD_DBOV), true);
    assert.equal(isSilence(-127), true);
    assert.equal(isSilence(-59), false);
  });
});

describe('how loud somebody is by distance', () => {
  it('is full up close, nothing at the edge, and never louder than full', () => {
    assert.equal(gainFor(0, 12), 1);
    assert.equal(gainFor(2, 12), 1);
    assert.equal(gainFor(12, 12), 0);
    assert.equal(gainFor(30, 12), 0);
    const mid = gainFor(7, 12);
    assert.ok(mid > 0 && mid < 1, `${mid}`);
    assert.ok(gainFor(5, 12) > gainFor(9, 12), 'monotonic');
    assert.equal(gainFor(Number.NaN, 12), 1, 'an unknown distance plays rather than mutes');
  });
});

describe('when to have a socket', () => {
  it('opens a little before earshot and closes a little after it', () => {
    assert.equal(shouldBeOpen(false, 14, 12), true, 'two tiles out: open');
    assert.equal(shouldBeOpen(false, 15, 12), false, 'three tiles out: not yet');
    assert.equal(shouldBeOpen(true, 15, 12), true, 'open and three out: stay');
    assert.equal(shouldBeOpen(true, 16, 12), true);
    assert.equal(shouldBeOpen(true, 17, 12), false, 'five out: close');
  });

  it('never opens when alone with agents', () => {
    assert.equal(shouldBeOpen(false, null, 12), false);
    assert.equal(shouldBeOpen(true, null, 12), false, 'and closes when the last person leaves');
  });
});

describe('who is speaking', () => {
  it('needs enough non-silence frames in the last half second', () => {
    const meter = new SpeakingMeter();
    for (let i = 0; i < 4; i += 1) meter.note('ann', 1000 + i * 20, false);
    assert.deepEqual(meter.speaking(1100), []);
    meter.note('ann', 1080, false);
    assert.deepEqual(meter.speaking(1100), ['ann']);
    assert.deepEqual(meter.speaking(1700), [], 'and stops when the frames age out');
  });

  it('ignores silence frames, however many', () => {
    const meter = new SpeakingMeter();
    for (let i = 0; i < 20; i += 1) meter.note('bob', 1000 + i * 20, true);
    assert.deepEqual(meter.speaking(1400), []);
  });
});

describe('when a frame plays', () => {
  it('holds a steady cadence a target ahead of the clock', () => {
    const jitter = new JitterScheduler();
    const first = jitter.next(10);
    assert.ok(first > 10, 'ahead of now');
    assert.ok(Math.abs(jitter.next(10.02) - (first + 0.02)) < 1e-9, 'one frame later');
    assert.ok(Math.abs(jitter.next(10.03) - (first + 0.04)) < 1e-9, 'early arrival keeps the cadence');
    assert.equal(jitter.underruns, 0);
  });

  it('grows the target after repeated underruns, and shrinks it again when calm', () => {
    const jitter = new JitterScheduler({ minMs: 40, maxMs: 200, underrunsToGrow: 3, calmMs: 5_000 });
    const start = jitter.target;
    let now = 10;
    jitter.next(now);
    // Three frames that each arrive after their slot — late, not paused.
    for (let i = 0; i < 3; i += 1) {
      now += 0.1;
      jitter.next(now);
    }
    assert.equal(jitter.underruns, 3);
    assert.ok(jitter.target > start, 'the buffer grew');
    assert.ok(jitter.target <= 0.2, 'and never past the cap');

    // A long calm stretch of on-time frames brings it back down.
    let t = now + 0.02;
    for (let i = 0; i < 400; i += 1) {
      jitter.next(t);
      t += 0.02;
    }
    assert.ok(jitter.target < start * 1.5 + 1e-9, `shrank back: ${jitter.target}`);
  });

  it('does not count a pause as an underrun', () => {
    const jitter = new JitterScheduler();
    jitter.next(10);
    jitter.next(10.02);
    // The sender fell silent for two seconds, then spoke again.
    jitter.next(12.5);
    assert.equal(jitter.underruns, 0);
  });

  it('pulls in a cursor that ran far ahead', () => {
    const jitter = new JitterScheduler();
    const first = jitter.next(10);
    // A burst of thirty frames at once would schedule 600 ms ahead.
    let last = first;
    for (let i = 0; i < 30; i += 1) last = jitter.next(10);
    assert.ok(last - 10 < 0.5, `pulled in: ${last - 10}`);
  });
});
