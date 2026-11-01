import { Cron } from 'croner';

import { normalisePromptProse } from './agent.js';
import type { ChannelActor } from './conversation.js';
import { tidyDisplayText } from './workspace.js';

/**
 * Routines: a standing request on one agent, with a schedule.
 *
 * "Every hour, review the open pull requests." "Weekdays at nine, see what
 * is on the board." "In an hour, check the deploy." Anything an agent can
 * be asked once, it can be asked on a schedule — and the office keeps the
 * schedule, not the runtime, so a routine behaves the same on every runtime
 * and is read in the same places as everything else an agent does.
 *
 * A routine fires as a line in its owner's DM with the agent, with a brief
 * attached, the way a board hand-over does (`docs/ROUTINES.md`). What a
 * client and the room both need — the schedule's shape, how a phrase
 * becomes one, when it is next due, the caps — is here; the rows are in
 * `db/routines.ts`, the firing in the room.
 *
 * Nothing here may import `node:*`: the settings form reads schedules too.
 */

export const ROUTINE_NAME_MAX_LENGTH = 60;
/** Same cap as a command's: a routine's brief is sent once per firing, and a checklist runs to pages. */
export const ROUTINE_INSTRUCTIONS_MAX_LENGTH = 16_000;
/** What a routine gives the command it runs, like the text after `!review`. */
export const ROUTINE_ARGS_MAX_LENGTH = 2_000;
export const ROUTINES_PER_AGENT_MAX = 20;
/** No cron tighter than this: a firing is a model turn, and a turn costs. */
export const ROUTINE_MIN_INTERVAL_MS = 10 * 60_000;

/**
 * When a routine fires. Cron with a time zone for the repeating kind; one
 * moment for the once kind. The zone rides along on both so the label can
 * say "09:00 (Europe/Lisbon)" and a once routine can be shown in the time
 * it was asked in.
 */
export type RoutineSchedule =
  | { kind: 'cron'; cron: string; tz: string }
  | { kind: 'once'; at: number; tz: string };

/** Pure validation of a schedule as stored, from anywhere: a form, a tool, the database. */
export type RoutineScheduleResult = { ok: true; schedule: RoutineSchedule } | { ok: false; error: string };

/** A zone the host's Intl knows. Croner does not check, and a wrong zone would fire at the wrong hour forever. */
export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Five fields, as people write them; croner also takes six and seven, which nobody types. */
const CRON_FIVE = /^\S+(?:\s+\S+){4}$/;

/** The cron, parsed, or null when croner refuses it. */
function cronOf(cron: string, tz: string): Cron | null {
  if (!CRON_FIVE.test(cron)) return null;
  try {
    return new Cron(cron, { timezone: tz, paused: true });
  } catch {
    return null;
  }
}

/**
 * Whether a cron keeps to the floor. Checked on the first few firings after
 * a fixed moment rather than proved in general: every five minutes fails on
 * its first gap, nine every morning passes every one, and nothing anybody
 * would type slips through the sample.
 */
function cronAboveFloor(cron: Cron): boolean {
  const base = new Date('2026-01-05T00:00:00Z');
  const runs = cron.nextRuns(6, base);
  for (let i = 1; i < runs.length; i += 1) {
    const gap = runs[i]!.getTime() - runs[i - 1]!.getTime();
    if (gap < ROUTINE_MIN_INTERVAL_MS) return false;
  }
  return true;
}

/** Check a schedule as stored. Returns a normalised copy with nothing on it that was not checked. */
export function validateRoutineSchedule(input: unknown): RoutineScheduleResult {
  if (!input || typeof input !== 'object') return { ok: false, error: 'A schedule is cron with a time zone, or one moment.' };
  const raw = input as Record<string, unknown>;
  if (!isTimeZone(raw.tz)) return { ok: false, error: `"${String(raw.tz ?? '')}" is not a time zone this office knows; "Europe/Lisbon", say.` };
  const tz = raw.tz;
  if (raw.kind === 'once') {
    const at = Number(raw.at);
    if (!Number.isSafeInteger(at) || at <= 0) return { ok: false, error: 'A once schedule needs a moment.' };
    return { ok: true, schedule: { kind: 'once', at, tz } };
  }
  if (raw.kind === 'cron') {
    const cron = String(raw.cron ?? '').trim().replace(/\s+/g, ' ');
    const parsed = cronOf(cron, tz);
    if (!parsed) return { ok: false, error: `"${cron}" is not a cron line of five fields.` };
    if (!cronAboveFloor(parsed)) {
      return { ok: false, error: `Nothing tighter than every ${ROUTINE_MIN_INTERVAL_MS / 60_000} minutes: a firing is a whole turn.` };
    }
    return { ok: true, schedule: { kind: 'cron', cron, tz } };
  }
  return { ok: false, error: 'A schedule is cron or once.' };
}

/**
 * When the schedule next fires after `after` (exclusive), or null when it
 * never will again: a once routine that has had its moment.
 */
export function nextRoutineDue(schedule: RoutineSchedule, after: number): number | null {
  if (schedule.kind === 'once') return schedule.at > after ? schedule.at : null;
  const cron = cronOf(schedule.cron, schedule.tz);
  if (!cron) return null;
  const next = cron.nextRun(new Date(after));
  return next ? next.getTime() : null;
}

// --- phrases ---------------------------------------------------------------

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const DAY_SHORT = DAYS.map((day) => day.slice(0, 3));

function dayIndex(word: string): number | null {
  const lower = word.toLowerCase();
  const full = DAYS.indexOf(lower as (typeof DAYS)[number]);
  if (full >= 0) return full;
  const short = DAY_SHORT.indexOf(lower.slice(0, 3));
  return short >= 0 && lower.startsWith(DAY_SHORT[short]!) ? short : null;
}

/** `9`, `9am`, `09:30`, `5:30 pm`, `noon`, `midnight` → hours and minutes, or null. */
export function parseClock(text: string): { hour: number; minute: number } | null {
  const lower = text.trim().toLowerCase().replace(/\s+/g, '');
  if (lower === 'noon' || lower === 'midday') return { hour: 12, minute: 0 };
  if (lower === 'midnight') return { hour: 0, minute: 0 };
  const match = /^(\d{1,2})(?::(\d{2}))?(am|pm|h)?$/.exec(lower);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  const suffix = match[3];
  if (minute > 59) return null;
  if (suffix === 'am' || suffix === 'pm') {
    if (hour < 1 || hour > 12) return null;
    if (suffix === 'am' && hour === 12) hour = 0;
    if (suffix === 'pm' && hour !== 12) hour += 12;
  } else if (hour > 23) {
    return null;
  }
  return { hour, minute };
}

/** The wall clock in `tz` at `at`. */
function wallClock(at: number, tz: string): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
  }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    weekday: DAY_SHORT.indexOf(get('weekday').toLowerCase()),
  };
}

/**
 * The moment a wall-clock time in `tz` is, in ms. Two passes over the zone's
 * offset settle it, DST changes included; an hour that does not exist that
 * night lands on the hour after, which is what a clock in the room does.
 */
export function wallClockToEpoch(
  clock: { year: number; month: number; day: number; hour: number; minute: number },
  tz: string,
): number {
  const asUtc = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute);
  let guess = asUtc;
  for (let pass = 0; pass < 2; pass += 1) {
    const seen = wallClock(guess, tz);
    const seenAsUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute);
    guess += asUtc - seenAsUtc;
  }
  return guess;
}

export type RoutineWhenResult = RoutineScheduleResult;

const UNIT_MS: Record<string, number> = {
  minute: 60_000,
  minutes: 60_000,
  min: 60_000,
  mins: 60_000,
  hour: 3_600_000,
  hours: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  day: 86_400_000,
  days: 86_400_000,
  week: 7 * 86_400_000,
  weeks: 7 * 86_400_000,
};

/**
 * What a person or a model writes for "when", read into a schedule.
 *
 * Repeating: `every 15 minutes`, `every 2 hours`, `hourly`, `every hour`,
 * `daily at 9`, `every day at 09:30`, `weekdays at 17:30`, `every monday at 9`,
 * `weekly on friday at 4pm`, `every weekend at noon`, or a five-field cron
 * line. Once: `in 45 minutes`, `in 2 hours`, `at 15:00` (today, else
 * tomorrow), `today at 5pm`, `tomorrow at 9`, `on monday at 9`,
 * `2026-11-02 09:00`, or an ISO moment. Hours default to :00; a repeating
 * day without a time is 09:00. Anything else is an error that says what is
 * taken, so a tool can hand it straight back to the model.
 */
export function parseRoutineWhen(text: unknown, context: { now: number; tz: string }): RoutineWhenResult {
  const tz = context.tz;
  if (!isTimeZone(tz)) return { ok: false, error: `"${String(tz)}" is not a time zone this office knows.` };
  const raw = String(text ?? '').trim().replace(/\s+/g, ' ');
  const lower = raw.toLowerCase().replace(/^(please\s+)?/, '');
  if (lower.length === 0) return { ok: false, error: 'Say when: "every hour", "weekdays at 9", "in 45 minutes", or a cron line.' };

  if (CRON_FIVE.test(raw) && /^[\d*\/,\-\s?LW#A-Za-z]+$/.test(raw) && !/^[a-z]/i.test(raw)) {
    return validateRoutineSchedule({ kind: 'cron', cron: raw, tz });
  }

  const cron = (expr: string) => validateRoutineSchedule({ kind: 'cron', cron: expr, tz });
  const once = (at: number) => validateRoutineSchedule({ kind: 'once', at, tz });
  const clockOrDefault = (words: string | undefined, fallback = { hour: 9, minute: 0 }) => {
    if (words === undefined || words.trim().length === 0) return fallback;
    return parseClock(words);
  };

  let match: RegExpExecArray | null;

  // every N minutes|hours|days
  if ((match = /^every (\d+) (minutes?|mins?|hours?|hrs?|days?)$/.exec(lower))) {
    const n = Number(match[1]);
    const unit = match[2]!;
    if (n < 1) return { ok: false, error: 'Every how many?' };
    if (unit.startsWith('min')) {
      if (60 % n !== 0) return { ok: false, error: `Every ${n} minutes does not divide the hour; try 10, 15, 20 or 30.` };
      return cron(`*/${n} * * * *`);
    }
    if (unit.startsWith('h')) {
      if (24 % n !== 0) return { ok: false, error: `Every ${n} hours does not divide the day; try 1, 2, 3, 4, 6, 8 or 12.` };
      return cron(`0 */${n} * * *`);
    }
    if (n !== 1) return { ok: false, error: `Every ${n} days: say which days instead ("every monday and thursday at 9").` };
    return cron('0 9 * * *');
  }
  if (lower === 'hourly' || lower === 'every hour') return cron('0 * * * *');
  if ((match = /^(?:hourly|every hour) at :?(\d{1,2})$/.exec(lower))) {
    const minute = Number(match[1]);
    return minute > 59 ? { ok: false, error: 'Minutes run 0 to 59.' } : cron(`${minute} * * * *`);
  }

  // daily / every day / weekdays / weekends [at time]
  if ((match = /^(daily|every day|everyday|weekdays|every weekday|on weekdays|weekends|every weekend|on weekends)(?: at (.+))?$/.exec(lower))) {
    const clock = clockOrDefault(match[2]);
    if (!clock) return { ok: false, error: `"${match[2]}" is not a time; "9", "09:30" or "5pm".` };
    const which = match[1]!;
    const days = which.includes('weekday') ? '1-5' : which.includes('weekend') ? '0,6' : '*';
    return cron(`${clock.minute} ${clock.hour} * * ${days}`);
  }

  // every monday [and thursday] [at time] / weekly on friday at 4pm
  if ((match = /^(?:every|weekly on|on) ((?:[a-z]+(?:,? (?:and )?)?)+?)s?(?: at (.+))?$/.exec(lower))) {
    const names = match[1]!.split(/,\s*|\s+and\s+|\s+/).filter((word) => word.length > 0 && word !== 'and');
    const indexes = names.map(dayIndex);
    if (indexes.length > 0 && indexes.every((index) => index !== null)) {
      const clock = clockOrDefault(match[2]);
      if (!clock) return { ok: false, error: `"${match[2]}" is not a time; "9", "09:30" or "5pm".` };
      if (lower.startsWith('on ') && !lower.startsWith('on weekday')) {
        // "on monday at 9" is once: the next such day.
        const target = indexes[0]!;
        const today = wallClock(context.now, tz);
        let ahead = (target - today.weekday + 7) % 7;
        let at = wallClockToEpoch({ ...today, ...clock }, tz) + ahead * 86_400_000;
        if (at <= context.now) {
          ahead = ahead === 0 ? 7 : ahead;
          at = wallClockToEpoch({ ...today, ...clock }, tz) + ahead * 86_400_000;
        }
        return once(at);
      }
      const unique = [...new Set(indexes as number[])].sort((a, b) => a - b);
      return cron(`${clock.minute} ${clock.hour} * * ${unique.join(',')}`);
    }
  }

  // in N minutes|hours|days|weeks
  if ((match = /^in (?:(\d+)|an?) (minutes?|mins?|hours?|hrs?|days?|weeks?)$/.exec(lower))) {
    const n = match[1] === undefined ? 1 : Number(match[1]);
    const ms = UNIT_MS[match[2]!]!;
    if (n < 1) return { ok: false, error: 'In how long?' };
    return once(context.now + n * ms);
  }

  // at 15:00 / today at 5pm / tomorrow at 9 / tonight
  if ((match = /^(?:(today|tomorrow|tonight) ?)?(?:at )?(.+)$/.exec(lower))) {
    const when = match[1];
    const clock = match[2] === 'tonight' || when === 'tonight' ? { hour: 20, minute: 0 } : parseClock(match[2]!);
    if (clock && (when !== undefined || match[2] === 'tonight' || /^(at )/.test(lower) || parseClock(lower))) {
      const today = wallClock(context.now, tz);
      let at = wallClockToEpoch({ ...today, ...clock }, tz);
      if (when === 'tomorrow') at += 86_400_000;
      else if (at <= context.now && when !== 'today') at += 86_400_000;
      if (at <= context.now) return { ok: false, error: 'That time has passed today; say "tomorrow at …".' };
      return once(at);
    }
  }

  // 2026-11-02 09:00 / 2026-11-02T09:00 / on 2026-11-02 at 9
  if ((match = /^(?:on )?(\d{4})-(\d{2})-(\d{2})(?:\sat\s|[t ])?(.*)$/.exec(lower))) {
    const clock =
      match[4] && match[4].trim().length > 0
        ? parseClock(match[4].replace(/z$/, '').replace(/^(\d{1,2}:\d{2}):\d{2}(?:\.\d+)?$/, '$1'))
        : { hour: 9, minute: 0 };
    if (clock) {
      const at = /z$/.test(match[4] ?? '')
        ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), clock.hour, clock.minute)
        : wallClockToEpoch({ year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), ...clock }, tz);
      if (Number.isNaN(at)) return { ok: false, error: 'That is not a date.' };
      if (at <= context.now) return { ok: false, error: 'That moment has passed.' };
      return once(at);
    }
  }

  return {
    ok: false,
    error:
      `Could not read "${raw}" as a schedule. Say "every 15 minutes", "every hour", "daily at 9", ` +
      '"weekdays at 17:30", "every monday at 9", "in 45 minutes", "tomorrow at 9", or a cron line of five fields.',
  };
}

// --- labels ----------------------------------------------------------------

function two(n: number): string {
  return String(n).padStart(2, '0');
}

/** `09:00`, `17:30` from a cron's minute and hour fields when both are plain numbers; null otherwise. */
function clockOfCron(minute: string, hour: string): string | null {
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return null;
  return `${two(Number(hour))}:${two(Number(minute))}`;
}

function dayNames(field: string): string | null {
  const names: string[] = [];
  for (const part of field.split(',')) {
    const range = /^(\d)-(\d)$/.exec(part);
    if (range) {
      for (let day = Number(range[1]); day <= Number(range[2]); day += 1) names.push(DAYS[day]!);
    } else if (/^\d$/.test(part)) {
      names.push(DAYS[Number(part) % 7]!);
    } else {
      return null;
    }
  }
  const cap = (name: string) => name[0]!.toUpperCase() + name.slice(1);
  return names.map(cap).join(', ').replace(/, ([^,]+)$/, ' and $1');
}

/**
 * The schedule in words, the way the card and the brief say it: "every
 * hour", "every 15 minutes", "daily at 09:00", "weekdays at 17:30", "every
 * Monday at 09:00", "once, on 2 Nov 2026 at 09:00". A cron the words do
 * not cover is shown as itself. The zone is named when it is not UTC.
 */
export function describeRoutineSchedule(schedule: RoutineSchedule, options: { zone?: boolean } = {}): string {
  const zone = options.zone === false || schedule.tz === 'UTC' ? '' : ` (${schedule.tz})`;
  if (schedule.kind === 'once') {
    const clock = wallClock(schedule.at, schedule.tz);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `once, on ${clock.day} ${months[clock.month - 1]} ${clock.year} at ${two(clock.hour)}:${two(clock.minute)}${zone}`;
  }
  const [minute = '', hour = '', dom = '', month = '', dow = ''] = schedule.cron.split(' ');
  if (dom === '*' && month === '*') {
    const everyMinutes = /^\*\/(\d+)$/.exec(minute);
    if (everyMinutes && hour === '*' && dow === '*') return `every ${everyMinutes[1]} minutes`;
    if (minute === '0' && hour === '*' && dow === '*') return 'every hour';
    if (/^\d{1,2}$/.test(minute) && hour === '*' && dow === '*') return `every hour at :${two(Number(minute))}`;
    const everyHours = /^\*\/(\d+)$/.exec(hour);
    if (everyHours && minute === '0' && dow === '*') return `every ${everyHours[1]} hours`;
    const clock = clockOfCron(minute, hour);
    if (clock) {
      if (dow === '*') return `daily at ${clock}${zone}`;
      if (dow === '1-5') return `weekdays at ${clock}${zone}`;
      if (dow === '0,6' || dow === '6,0') return `weekends at ${clock}${zone}`;
      const days = dayNames(dow);
      if (days) return `every ${days} at ${clock}${zone}`;
    }
  }
  return `${schedule.cron}${zone}`;
}

// --- fields and rules ------------------------------------------------------

/** One line, trimmed, capped. Null when nothing is left: a routine needs a name. */
export function normaliseRoutineName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const name = tidyDisplayText(input, ROUTINE_NAME_MAX_LENGTH);
  return name.length > 0 ? name : null;
}

/** Same rules as a command's instructions: they land in the same prompt. */
export function normaliseRoutineInstructions(input: unknown): string {
  return normalisePromptProse(input, ROUTINE_INSTRUCTIONS_MAX_LENGTH);
}

/** What the routine gives its command, on one line, as somebody would type after `!review`. */
export function normaliseRoutineArgs(input: unknown): string {
  return typeof input === 'string' ? tidyDisplayText(input, ROUTINE_ARGS_MAX_LENGTH) : '';
}

/**
 * Only the agent's owner puts a routine on it, changes it or takes it off —
 * the same rule as handing it a board note, because the firing speaks in
 * the owner's DM as the owner. Admins read every routine and may change
 * none of anybody else's; a routine is a standing request from one person
 * to their agent, not shared vocabulary like a command.
 */
export function mayManageRoutine(actor: ChannelActor, agent: { ownerUserId: string }): boolean {
  return actor.role !== null && actor.userId === agent.ownerUserId;
}

/** `hourly-pr-check`: the name as the brief's heading writes it, like a command's. */
export function routineSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'routine'
  );
}
