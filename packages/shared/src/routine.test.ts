import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ROUTINE_MIN_INTERVAL_MS,
  describeRoutineSchedule,
  isTimeZone,
  mayManageRoutine,
  nextRoutineDue,
  parseClock,
  parseRoutineWhen,
  routineWhenPhrase,
  routineSlug,
  validateRoutineSchedule,
  wallClockToEpoch,
} from './routine.js';

/**
 * A routine's schedule is read from what people and models write, kept as
 * cron with a zone or one moment, and said back in words. What must hold:
 * the common phrases mean what they say in the zone they were said in, the
 * floor keeps a model from asking for every minute, and the label a card
 * shows is the phrase that was typed, more or less.
 */

const LISBON = 'Europe/Lisbon';
/** Sunday 1 Nov 2026, 12:00 in Lisbon (WET, UTC+0). */
const NOW = Date.UTC(2026, 10, 1, 12, 0);

function when(text: string, tz = LISBON) {
  const result = parseRoutineWhen(text, { now: NOW, tz });
  assert.ok(result.ok, `"${text}": ${result.ok ? '' : result.error}`);
  return result.schedule;
}

function cronOf(text: string): string {
  const schedule = when(text);
  assert.equal(schedule.kind, 'cron', `"${text}" should repeat`);
  return schedule.kind === 'cron' ? schedule.cron : '';
}

function onceAt(text: string): number {
  const schedule = when(text);
  assert.equal(schedule.kind, 'once', `"${text}" should be once`);
  return schedule.kind === 'once' ? schedule.at : 0;
}

describe('a clock as people write it', () => {
  it('reads 9, 9am, 09:30, 5pm, 5:30 pm, noon and midnight', () => {
    assert.deepEqual(parseClock('9'), { hour: 9, minute: 0 });
    assert.deepEqual(parseClock('9am'), { hour: 9, minute: 0 });
    assert.deepEqual(parseClock('09:30'), { hour: 9, minute: 30 });
    assert.deepEqual(parseClock('5pm'), { hour: 17, minute: 0 });
    assert.deepEqual(parseClock('5:30 pm'), { hour: 17, minute: 30 });
    assert.deepEqual(parseClock('12am'), { hour: 0, minute: 0 });
    assert.deepEqual(parseClock('12pm'), { hour: 12, minute: 0 });
    assert.deepEqual(parseClock('noon'), { hour: 12, minute: 0 });
    assert.deepEqual(parseClock('midnight'), { hour: 0, minute: 0 });
    assert.equal(parseClock('25'), null);
    assert.equal(parseClock('13pm'), null);
    assert.equal(parseClock('9:60'), null);
    assert.equal(parseClock('soon'), null);
  });
});

describe('a wall clock in a zone', () => {
  it('is the moment that clock shows there, across the DST change', () => {
    // 09:00 Lisbon on a WET day is 09:00Z; on a WEST day it is 08:00Z.
    assert.equal(wallClockToEpoch({ year: 2026, month: 11, day: 2, hour: 9, minute: 0 }, LISBON), Date.UTC(2026, 10, 2, 9, 0));
    assert.equal(wallClockToEpoch({ year: 2026, month: 7, day: 2, hour: 9, minute: 0 }, LISBON), Date.UTC(2026, 6, 2, 8, 0));
    assert.equal(wallClockToEpoch({ year: 2026, month: 11, day: 2, hour: 9, minute: 0 }, 'America/New_York'), Date.UTC(2026, 10, 2, 14, 0));
  });
  it('knows a zone when Intl does', () => {
    assert.equal(isTimeZone('Europe/Lisbon'), true);
    assert.equal(isTimeZone('UTC'), true);
    assert.equal(isTimeZone('Mars/Olympus'), false);
    assert.equal(isTimeZone(''), false);
    assert.equal(isTimeZone(42), false);
  });
});

describe('reading "when"', () => {
  it('reads the repeating phrases into cron', () => {
    assert.equal(cronOf('every 15 minutes'), '*/15 * * * *');
    assert.equal(cronOf('every hour'), '0 * * * *');
    assert.equal(cronOf('hourly'), '0 * * * *');
    assert.equal(cronOf('every hour at :30'), '30 * * * *');
    assert.equal(cronOf('every 2 hours'), '0 */2 * * *');
    assert.equal(cronOf('daily at 9'), '0 9 * * *');
    assert.equal(cronOf('every day at 09:30'), '30 9 * * *');
    assert.equal(cronOf('daily'), '0 9 * * *');
    assert.equal(cronOf('weekdays at 17:30'), '30 17 * * 1-5');
    assert.equal(cronOf('every weekday at 5pm'), '0 17 * * 1-5');
    assert.equal(cronOf('every weekend at noon'), '0 12 * * 0,6');
    assert.equal(cronOf('every monday at 9'), '0 9 * * 1');
    assert.equal(cronOf('every Monday and Thursday at 9'), '0 9 * * 1,4');
    assert.equal(cronOf('weekly on friday at 4pm'), '0 16 * * 5');
    assert.equal(cronOf('every tuesday'), '0 9 * * 2');
  });

  it('takes a cron line of five fields as it is', () => {
    assert.equal(cronOf('0 9 * * 1-5'), '0 9 * * 1-5');
    assert.equal(cronOf('*/20  *  * * *'), '*/20 * * * *');
  });

  it('reads the once phrases into a moment in the zone', () => {
    assert.equal(onceAt('in 45 minutes'), NOW + 45 * 60_000);
    assert.equal(onceAt('in an hour'), NOW + 3_600_000);
    assert.equal(onceAt('in 2 days'), NOW + 2 * 86_400_000);
    // 12:00 now in Lisbon: 15:00 is today, 9 is tomorrow.
    assert.equal(onceAt('at 15:00'), Date.UTC(2026, 10, 1, 15, 0));
    assert.equal(onceAt('at 9'), Date.UTC(2026, 10, 2, 9, 0));
    assert.equal(onceAt('tomorrow at 9'), Date.UTC(2026, 10, 2, 9, 0));
    assert.equal(onceAt('today at 5pm'), Date.UTC(2026, 10, 1, 17, 0));
    assert.equal(onceAt('tonight'), Date.UTC(2026, 10, 1, 20, 0));
    // Sunday now: next Monday.
    assert.equal(onceAt('on monday at 9'), Date.UTC(2026, 10, 2, 9, 0));
    assert.equal(onceAt('2026-11-05 09:00'), Date.UTC(2026, 10, 5, 9, 0));
    assert.equal(onceAt('on 2026-11-05 at 9'), Date.UTC(2026, 10, 5, 9, 0));
    assert.equal(onceAt('2026-11-05T09:00:00Z'), Date.UTC(2026, 10, 5, 9, 0));
  });

  it('keeps the clock across a DST night: tomorrow at 9 is 09:00 tomorrow, not now plus a day', () => {
    // Saturday 28 Mar 2026, 12:00 WET; clocks go forward that night, so Sunday 09:00 is 08:00Z.
    const springEve = Date.UTC(2026, 2, 28, 12, 0);
    const spring = (text: string) => {
      const result = parseRoutineWhen(text, { now: springEve, tz: LISBON });
      assert.ok(result.ok && result.schedule.kind === 'once', text);
      return result.schedule.kind === 'once' ? result.schedule.at : 0;
    };
    assert.equal(spring('tomorrow at 9'), Date.UTC(2026, 2, 29, 8, 0));
    assert.equal(spring('at 9'), Date.UTC(2026, 2, 29, 8, 0), 'rolls forward to tomorrow at the same clock');
    assert.equal(spring('on sunday at 9'), Date.UTC(2026, 2, 29, 8, 0));
    assert.equal(spring('on saturday at 9'), Date.UTC(2026, 3, 4, 8, 0), 'next week, by the calendar');
    assert.equal(spring('in 2 days'), springEve + 2 * 86_400_000, 'a duration stays on the clock');
    // Saturday 24 Oct 2026, 12:00 WEST; clocks go back that night, so Sunday 09:00 is 09:00Z.
    const autumnEve = Date.UTC(2026, 9, 24, 11, 0);
    const autumn = parseRoutineWhen('tomorrow at 9', { now: autumnEve, tz: LISBON });
    assert.ok(autumn.ok && autumn.schedule.kind === 'once');
    assert.equal(autumn.schedule.at, Date.UTC(2026, 9, 25, 9, 0));
  });

  it('reads the same clock in another zone as another moment', () => {
    const ny = parseRoutineWhen('tomorrow at 9', { now: NOW, tz: 'America/New_York' });
    assert.ok(ny.ok && ny.schedule.kind === 'once');
    assert.equal(ny.schedule.at, Date.UTC(2026, 10, 2, 14, 0));
    assert.equal(ny.schedule.tz, 'America/New_York');
  });

  it('refuses what it cannot read, saying what it can', () => {
    const bad = parseRoutineWhen('whenever', { now: NOW, tz: LISBON });
    assert.ok(!bad.ok);
    assert.match(bad.error, /every 15 minutes/);
    assert.match(bad.error, /cron line/);
    const empty = parseRoutineWhen('', { now: NOW, tz: LISBON });
    assert.ok(!empty.ok && /Say when/.test(empty.error));
    const past = parseRoutineWhen('today at 9', { now: NOW, tz: LISBON });
    assert.ok(!past.ok && /passed/.test(past.error));
    const zone = parseRoutineWhen('every hour', { now: NOW, tz: 'Mars/Olympus' });
    assert.ok(!zone.ok && /time zone/.test(zone.error));
    const odd = parseRoutineWhen('every 7 minutes', { now: NOW, tz: LISBON });
    assert.ok(!odd.ok && /divide the hour/.test(odd.error));
  });

  it('keeps the floor: nothing tighter than ten minutes', () => {
    const minute = parseRoutineWhen('every 5 minutes', { now: NOW, tz: LISBON });
    assert.ok(!minute.ok && /tighter/.test(minute.error));
    const cron = parseRoutineWhen('*/5 * * * *', { now: NOW, tz: LISBON });
    assert.ok(!cron.ok && /tighter/.test(cron.error));
    const close = validateRoutineSchedule({ kind: 'cron', cron: '0,5 9 * * *', tz: LISBON });
    assert.ok(!close.ok, 'two firings five minutes apart are under the floor');
    assert.equal(ROUTINE_MIN_INTERVAL_MS, 600_000);
    assert.ok(validateRoutineSchedule({ kind: 'cron', cron: '*/10 * * * *', tz: LISBON }).ok);
  });
});

describe('when a schedule is next due', () => {
  it('follows the cron in its zone', () => {
    const schedule = { kind: 'cron' as const, cron: '0 9 * * 1-5', tz: LISBON };
    assert.equal(nextRoutineDue(schedule, NOW), Date.UTC(2026, 10, 2, 9, 0), 'Sunday noon: Monday 09:00');
    assert.equal(nextRoutineDue(schedule, Date.UTC(2026, 10, 6, 10, 0)), Date.UTC(2026, 10, 9, 9, 0), 'Friday 10:00: Monday');
    const summer = { kind: 'cron' as const, cron: '0 9 * * *', tz: LISBON };
    assert.equal(nextRoutineDue(summer, Date.UTC(2026, 6, 1, 12, 0)), Date.UTC(2026, 6, 2, 8, 0), 'WEST: 09:00 is 08:00Z');
  });
  it('is exclusive of the moment asked about', () => {
    const schedule = { kind: 'cron' as const, cron: '0 * * * *', tz: 'UTC' };
    assert.equal(nextRoutineDue(schedule, Date.UTC(2026, 10, 1, 12, 0)), Date.UTC(2026, 10, 1, 13, 0));
  });
  it('a once routine is due at its moment and never again', () => {
    const schedule = { kind: 'once' as const, at: NOW + 1000, tz: LISBON };
    assert.equal(nextRoutineDue(schedule, NOW), NOW + 1000);
    assert.equal(nextRoutineDue(schedule, NOW + 1000), null);
  });
});

describe('a schedule in words', () => {
  it('says the common ones back as they were asked', () => {
    assert.equal(describeRoutineSchedule(when('every 15 minutes')), 'every 15 minutes');
    assert.equal(describeRoutineSchedule(when('every hour')), 'every hour');
    assert.equal(describeRoutineSchedule(when('every hour at :30')), 'every hour at :30');
    assert.equal(describeRoutineSchedule(when('every 2 hours')), 'every 2 hours');
    assert.equal(describeRoutineSchedule(when('daily at 9')), 'daily at 09:00 (Europe/Lisbon)');
    assert.equal(describeRoutineSchedule(when('weekdays at 17:30')), 'weekdays at 17:30 (Europe/Lisbon)');
    assert.equal(describeRoutineSchedule(when('every weekend at noon')), 'weekends at 12:00 (Europe/Lisbon)');
    assert.equal(describeRoutineSchedule(when('every monday at 9')), 'every Monday at 09:00 (Europe/Lisbon)');
    assert.equal(describeRoutineSchedule(when('every monday and thursday at 9')), 'every Monday and Thursday at 09:00 (Europe/Lisbon)');
    assert.equal(describeRoutineSchedule(when('daily at 9'), { zone: false }), 'daily at 09:00');
    assert.equal(describeRoutineSchedule(when('daily at 9', 'UTC')), 'daily at 09:00');
    assert.equal(describeRoutineSchedule(when('tomorrow at 9')), 'once, on 2 Nov 2026 at 09:00 (Europe/Lisbon)');
  });
  it('shows a cron the words do not cover as itself', () => {
    assert.equal(describeRoutineSchedule(when('0 9 1 * *')), '0 9 1 * * (Europe/Lisbon)');
  });
  it('reads 7 as Sunday, as croner does, so a week written 1-7 is daily and 0-7 names Sunday once', () => {
    assert.equal(describeRoutineSchedule(when('0 9 * * 1-7', 'UTC')), 'daily at 09:00');
    assert.equal(describeRoutineSchedule(when('0 9 * * 0-7', 'UTC')), 'daily at 09:00');
    assert.equal(describeRoutineSchedule(when('0 9 * * 5-7', 'UTC')), 'every Sunday, Friday and Saturday at 09:00');
    assert.equal(describeRoutineSchedule(when('0 9 * * 7', 'UTC')), 'every Sunday at 09:00');
  });
});

describe('a schedule as a phrase to edit', () => {
  it('reads back to the same schedule, zone left to the form', () => {
    for (const text of [
      'every 15 minutes',
      'every hour',
      'every hour at :30',
      'every 2 hours',
      'daily at 9',
      'weekdays at 17:30',
      'every weekend at noon',
      'every monday at 9',
      'every monday and thursday at 9',
      'every sunday, monday and tuesday at 9',
    ]) {
      const schedule = when(text);
      const phrase = routineWhenPhrase(schedule);
      assert.ok(!phrase.includes('('), `${text}: "${phrase}" names no zone`);
      const back = parseRoutineWhen(phrase, { now: NOW, tz: LISBON });
      assert.ok(back.ok, `${text}: "${phrase}" reads back`);
      assert.deepEqual(back.schedule, schedule, `${text}: "${phrase}" is the same schedule`);
    }
  });
  it('gives a once moment as its date, and a cron its words would not read back as itself', () => {
    assert.equal(routineWhenPhrase(when('tomorrow at 9')), 'on 2026-11-02 at 09:00');
    assert.equal(onceAt(routineWhenPhrase(when('tomorrow at 9'))), onceAt('tomorrow at 9'));
    assert.equal(routineWhenPhrase(when('0 9 * * 1-7')), '0 9 * * 1-7', 'its words say daily, which is another cron');
    assert.equal(routineWhenPhrase(when('0 9 1 * *')), '0 9 1 * *');
  });
});

describe('who manages a routine, and what it is called', () => {
  it('is the agent’s owner, as a member, and nobody else', () => {
    const agent = { ownerUserId: 'u-josh' };
    assert.equal(mayManageRoutine({ userId: 'u-josh', role: 'member' }, agent), true);
    assert.equal(mayManageRoutine({ userId: 'u-ana', role: 'admin' }, agent), false);
    assert.equal(mayManageRoutine({ userId: 'u-josh', role: null }, agent), false);
  });
  it('slugs the name for the brief’s heading', () => {
    assert.equal(routineSlug('Hourly PR check'), 'hourly-pr-check');
    assert.equal(routineSlug('  ---  '), 'routine');
    assert.equal(routineSlug('Revisão diária'), 'revisão-diária');
  });
});
