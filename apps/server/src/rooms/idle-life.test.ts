import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FLOOR_ZONE_ID, type MapZone, type OfficeMap } from '@quintal/shared';

import {
  IDLE_AFTER_MS,
  SLEEP_AFTER_MS,
  WANDER_MAX_MS,
  WANDER_RADIUS_TILES,
  idleCapable,
  newIdleRecord,
  pickSmallTalk,
  stepIdle,
  touch,
  wake,
  wanderTarget,
  zoneIdAt,
  BANTER_AFTERGLOW_MS,
  BANTER_DAILY_CAP,
  BANTER_PER_AGENT_MS,
  BANTER_STAGE_MS,
  banterOver,
  mayBanter,
  newBanterLedger,
  noteBanter,
  type IdleRecord,
} from './idle-life.js';

/**
 * The small life of an agent with nothing to do.
 *
 * Two things matter more than the rest and are pinned hardest: a busy agent
 * never wanders, and anything that happens to an idle one wakes it at once.
 * Everything else — where it wanders, when it dozes, who it stops beside —
 * is checked against the rules as written, with the random source under the
 * test's control.
 */

/** Build a map from ASCII art. `#` blocks; letters name a zone. */
function gridMap(rows: string[], zones: MapZone[] = []): OfficeMap {
  const width = rows[0]?.length ?? 0;
  const walkable: boolean[] = [];
  for (const row of rows) {
    assert.equal(row.length, width, 'ragged test grid');
    for (const cell of row) walkable.push(cell !== '#');
  }
  return { name: 'test', width, height: rows.length, tileSize: 32, zones, spawns: [], walkable };
}

/** A predictable "random": hands out the given fractions in turn, then 0. */
function rngOf(...values: number[]): () => number {
  let index = 0;
  return () => values[index++] ?? 0;
}

const BAY: MapZone = { id: 'bay', kind: 'agent_area', label: 'Agent Bay', bounds: { x: 0, y: 0, width: 6, height: 6 } };
const FOCUS: MapZone = { id: 'focus', kind: 'private', label: 'Focus', bounds: { x: 6, y: 0, width: 4, height: 6 } };

describe('the clock of an idle life', () => {
  const start = 1_000_000;

  function idleFor(ms: number, record: IdleRecord = newIdleRecord(start)) {
    return { record, now: start + ms };
  }

  it('stays active until the idle threshold, then wanders, then sleeps', () => {
    const record = newIdleRecord(start);
    const at = (ms: number) => stepIdle(record, { now: start + ms, busy: false, zoneId: 'bay' }, rngOf(0));

    assert.deepEqual(at(IDLE_AFTER_MS - 1), { kind: 'none' });
    assert.equal(record.phase, 'active');

    assert.deepEqual(at(IDLE_AFTER_MS), { kind: 'none' }, 'crossing the line only starts the phase');
    assert.equal(record.phase, 'wandering');
    assert.equal(record.homeZone, 'bay', 'home is where it stood when it went idle');

    assert.deepEqual(at(IDLE_AFTER_MS + WANDER_MAX_MS), { kind: 'wander' });

    assert.deepEqual(at(SLEEP_AFTER_MS), { kind: 'sleep' });
    assert.equal(record.phase, 'asleep');
    assert.deepEqual(at(SLEEP_AFTER_MS + 60_000), { kind: 'none' }, 'asleep is asleep');
  });

  it('never moves a busy agent, and wakes one that was idling when work arrived', () => {
    const { record, now } = idleFor(IDLE_AFTER_MS + WANDER_MAX_MS);
    stepIdle(record, { now, busy: false, zoneId: 'bay' }, rngOf(0));
    assert.equal(record.phase, 'wandering');

    const busyNow = now + 1_000;
    assert.deepEqual(stepIdle(record, { now: busyNow, busy: true, zoneId: 'bay' }, rngOf(0)), {
      kind: 'wake',
    });
    // As the room does on that cue.
    wake(record);
    assert.equal(record.phase, 'active');
    assert.equal(record.activeAt, busyNow, 'being busy is activity');

    // Long past every threshold, still busy: nothing, ever.
    for (const later of [IDLE_AFTER_MS, SLEEP_AFTER_MS, SLEEP_AFTER_MS * 3]) {
      assert.deepEqual(stepIdle(record, { now: busyNow + later, busy: true, zoneId: 'bay' }, rngOf(0.9)), {
        kind: 'none',
      });
      assert.equal(record.phase, 'active');
    }
  });

  it('is woken by anything that happens to it, and starts counting again', () => {
    const { record, now } = idleFor(SLEEP_AFTER_MS);
    assert.deepEqual(stepIdle(record, { now, busy: false, zoneId: 'bay' }, rngOf(0)), { kind: 'sleep' });

    assert.equal(wake(record), true, 'it was asleep, so the caller has a balloon to take down');
    touch(record, now);
    assert.equal(record.phase, 'active');
    assert.equal(wake(record), false, 'waking twice is nothing');

    // The clock restarted: not a second of the old idle time carries over.
    assert.deepEqual(stepIdle(record, { now: now + IDLE_AFTER_MS - 1, busy: false, zoneId: 'bay' }, rngOf(0)), {
      kind: 'none',
    });
    assert.equal(record.phase, 'active');
  });

  it('does not wander while stopped for a chat', () => {
    const { record, now } = idleFor(IDLE_AFTER_MS + WANDER_MAX_MS);
    stepIdle(record, { now, busy: false, zoneId: 'bay' }, rngOf(0));
    record.talk = { partner: 'other', initiator: true, startedAt: now, answered: false, banter: null };
    assert.deepEqual(stepIdle(record, { now: now + WANDER_MAX_MS, busy: false, zoneId: 'bay' }, rngOf(0)), {
      kind: 'none',
    });
  });
});

describe('what counts as busy', () => {
  it('reads the nameplate the way the harness writes it', () => {
    assert.equal(idleCapable(''), true, 'a cleared status is idle');
    assert.equal(idleCapable('no model "opus" here'), true, 'a standing refusal is not work');
    assert.equal(idleCapable('thinking'), false);
    assert.equal(idleCapable('editing auth.ts'), false);
    assert.equal(idleCapable('waiting for Josh'), false);
    assert.equal(idleCapable('offline'), false, 'an offline agent is not available either');
  });
});

describe('where an agent wanders', () => {
  const map = gridMap(
    [
      '......####',
      '......#..#',
      '......#..#',
      '..##..####',
      '......####',
      '......####',
      '..........',
      '..........',
    ],
    [BAY, FOCUS],
  );

  it('stays inside its home zone, on walkable tiles, a few steps away', () => {
    let rng = 0.01;
    for (let draw = 0; draw < 40; draw += 1) {
      rng = (rng * 9301 + 49297) % 233280;
      const target = wanderTarget(map, { x: 2, y: 2 }, 'bay', rngOf(rng / 233280));
      if (!target) continue;
      assert.equal(zoneIdAt(map, target), 'bay', `left the bay: ${JSON.stringify(target)}`);
      assert.ok(map.walkable[target.y * map.width + target.x], 'onto a wall');
      assert.ok(
        Math.max(Math.abs(target.x - 2), Math.abs(target.y - 2)) <= WANDER_RADIUS_TILES,
        'too far for a wander',
      );
      assert.notDeepEqual(target, { x: 2, y: 2 }, 'a wander goes somewhere');
    }
  });

  it('treats the open floor as a zone of its own', () => {
    const target = wanderTarget(map, { x: 8, y: 7 }, FLOOR_ZONE_ID, rngOf(0.5));
    assert.ok(target, 'the floor is somewhere to wander');
    assert.equal(zoneIdAt(map, target), FLOOR_ZONE_ID, 'and it does not walk into the bay');
  });

  it('never wanders inside a private zone', () => {
    assert.equal(wanderTarget(map, { x: 7, y: 1 }, 'focus', rngOf(0.5)), null);
  });

  it('has nowhere to go when boxed in', () => {
    const boxed = gridMap(['###', '#.#', '###'], [BAY]);
    assert.equal(wanderTarget(boxed, { x: 1, y: 1 }, 'bay', rngOf(0.5)), null);
  });
});

describe('who stops for a chat', () => {
  it('pairs at most two per zone, once per cooldown', () => {
    const free = new Map<string, string[]>([
      ['bay', ['a', 'b', 'c']],
      ['floor', ['d']],
    ]);
    const nextTalkAt = new Map<string, number>();

    const pairs = pickSmallTalk(free, nextTalkAt, 1_000, rngOf(0, 0, 0.5));
    assert.equal(pairs.length, 1, 'one pair in the bay, none for the lone agent on the floor');
    const [pair] = pairs;
    assert.ok(pair);
    assert.notEqual(pair[0], pair[1], 'nobody chats with themselves');
    assert.ok(pair.every((id) => ['a', 'b', 'c'].includes(id)));

    const again = pickSmallTalk(free, nextTalkAt, 1_000 + 60_000, rngOf(0, 0, 0.5));
    assert.equal(again.length, 0, 'the bay is on cooldown');

    const later = pickSmallTalk(free, nextTalkAt, 1_000 + 6 * 60_000, rngOf(0, 0, 0.5));
    assert.equal(later.length, 1, 'and off it again');
  });
});

describe('whether two idle agents may actually speak', () => {
  const now = Date.UTC(2026, 8, 6, 12, 0, 0);
  const allowed = { setting: 'rare', humansPresent: true, a: 'agent-a', b: 'agent-b', now };

  it('is off unless the office turned it on, and never to an empty room', () => {
    assert.equal(mayBanter({ ...allowed, setting: 'off' }, newBanterLedger()), false);
    assert.equal(mayBanter({ ...allowed, setting: 'often' }, newBanterLedger()), false, 'unknown is off');
    assert.equal(mayBanter({ ...allowed, humansPresent: false }, newBanterLedger()), false);
    assert.equal(mayBanter(allowed, newBanterLedger()), true);
  });

  it('gives each agent one exchange an hour', () => {
    const ledger = newBanterLedger();
    assert.equal(mayBanter(allowed, ledger), true);
    noteBanter(ledger, 'agent-a', 'agent-b', now);

    assert.equal(mayBanter({ ...allowed, now: now + 10 * 60_000 }, ledger), false, 'both are spent');
    assert.equal(
      mayBanter({ ...allowed, b: 'agent-c', now: now + 10 * 60_000 }, ledger),
      false,
      'a is spent even with a fresh partner',
    );
    assert.equal(
      mayBanter({ ...allowed, a: 'agent-c', b: 'agent-d', now: now + 10 * 60_000 }, ledger),
      true,
      'two fresh agents may',
    );
    assert.equal(mayBanter({ ...allowed, now: now + BANTER_PER_AGENT_MS }, ledger), true, 'an hour later');
  });

  it('stops at the daily cap whatever the setting says, and starts over tomorrow', () => {
    const ledger = newBanterLedger();
    for (let i = 0; i < BANTER_DAILY_CAP; i += 1) {
      const at = now + i * 1_000;
      assert.equal(mayBanter({ ...allowed, a: `x${i}`, b: `y${i}`, now: at }, ledger), true, `exchange ${i}`);
      noteBanter(ledger, `x${i}`, `y${i}`, at);
    }
    assert.equal(mayBanter({ ...allowed, a: 'fresh-1', b: 'fresh-2', now: now + 60_000 }, ledger), false);

    const tomorrow = now + 24 * 60 * 60_000;
    assert.equal(mayBanter({ ...allowed, a: 'fresh-1', b: 'fresh-2', now: tomorrow }, ledger), true);
  });

  it('never pairs an agent with itself', () => {
    assert.equal(mayBanter({ ...allowed, b: 'agent-a' }, newBanterLedger()), false);
  });
});

describe('the clock on an exchange', () => {
  const t0 = 1_000_000;

  it('gives each line its own full stage, however long the first took', () => {
    // A is asked at t0 and takes 40s to answer.
    const a = { stage: 'asked_a' as const, since: t0 };
    assert.equal(banterOver(a, t0 + 40_000), false, 'still within the first stage');
    assert.equal(banterOver(a, t0 + BANTER_STAGE_MS), true, 'and it would have expired at the limit');

    // B is asked at t0 + 40s: a fresh stage, not the five seconds left of A's.
    const b = { stage: 'asked_b' as const, since: t0 + 40_000 };
    assert.equal(banterOver(b, t0 + BANTER_STAGE_MS), false, 'B is not cut off by A\'s clock');
    assert.equal(banterOver(b, t0 + 40_000 + BANTER_STAGE_MS - 1), false);
    assert.equal(banterOver(b, t0 + 40_000 + BANTER_STAGE_MS), true);
  });

  it('never ends from the listening side', () => {
    const listening = { stage: 'listening' as const, since: t0 };
    assert.equal(banterOver(listening, t0 + 10 * BANTER_STAGE_MS), false);
  });

  it('lingers a moment after the answer, then parts', () => {
    const done = { stage: 'done' as const, since: t0 };
    assert.equal(banterOver(done, t0 + BANTER_AFTERGLOW_MS - 1), false);
    assert.equal(banterOver(done, t0 + BANTER_AFTERGLOW_MS), true);
  });
});
