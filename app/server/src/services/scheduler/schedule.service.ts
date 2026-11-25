// Schedules (spec 40.7): the standard five-field expression, read in the organisation's time
// zone, never the server's. Pure: no clock, no I/O.
//
// Fields: minute (0-59), hour (0-23), day of month (1-31), month (1-12), day of week (0-7,
// both 0 and 7 Sunday). Each is *, a value, a range a-b, a list, or a step (*/n, a-b/n).
// Names (JAN, MON) and the non-standard L, W, # and ? are refused rather than guessed. As
// in every cron since Vixie's, when both day of month and day of week are restricted, a day
// matching either fires.
//
// Across a clock change, a local time that does not exist (the hour skipped in spring) does
// not fire; a local time that happens twice (the hour repeated in autumn) fires once, at the
// first. A schedule never fires twice for one local minute.

import { AppError } from '../../utils/errors.util.ts';

export interface Schedule {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  daysOfWeek: ReadonlySet<number>;
  /** Whether the field was * (unrestricted), for the day-of-month or day-of-week rule. */
  anyDayOfMonth: boolean;
  anyDayOfWeek: boolean;
}

const refuse = (message: string): AppError => new AppError('validation', message, { code: 'scheduler.schedule_invalid' });

function field(text: string, min: number, max: number, label: string): { values: Set<number>; any: boolean } {
  const values = new Set<number>();
  let any = false;
  for (const part of text.split(',')) {
    const match = /^(\*|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/.exec(part);
    if (!match) throw refuse(`the ${label} field is not a number, a range, a list or a step`);
    const step = match[4] === undefined ? 1 : Number(match[4]);
    let from = min;
    let to = max;
    if (match[1] === '*') {
      if (match[4] === undefined) any = true;
    } else {
      from = Number(match[2]);
      to = match[3] === undefined ? (match[4] === undefined ? from : max) : Number(match[3]);
    }
    if (step < 1 || from < min || to > max || from > to) throw refuse(`the ${label} field is out of range (${min}-${max})`);
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return { values, any };
}

export function parseSchedule(expression: string): Schedule {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw refuse('a schedule is five fields: minute hour day-of-month month day-of-week');
  const minutes = field(parts[0]!, 0, 59, 'minute');
  const hours = field(parts[1]!, 0, 23, 'hour');
  const daysOfMonth = field(parts[2]!, 1, 31, 'day-of-month');
  const months = field(parts[3]!, 1, 12, 'month');
  const daysOfWeek = field(parts[4]!, 0, 7, 'day-of-week');
  const dow = new Set([...daysOfWeek.values].map((d) => d % 7));
  return {
    minutes: minutes.values, hours: hours.values, daysOfMonth: daysOfMonth.values, months: months.values, daysOfWeek: dow,
    anyDayOfMonth: daysOfMonth.any, anyDayOfWeek: daysOfWeek.any,
  };
}

// ----------------------------------------------------------------------------- time zones

interface Local { year: number; month: number; day: number; hour: number; minute: number }

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone);
  if (found === undefined) {
    found = new Intl.DateTimeFormat('en-GB', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
    });
    formatters.set(timeZone, found);
  }
  return found;
}

/** Whether the zone is one this runtime knows (an IANA name). */
export function validTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

function localOf(instant: number, timeZone: string): Local {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(instant)).map((p) => [p.type, p.value]));
  return { year: Number(parts['year']), month: Number(parts['month']), day: Number(parts['day']), hour: Number(parts['hour']), minute: Number(parts['minute']) };
}

const sameLocal = (a: Local, b: Local): boolean =>
  a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute;

/** The instants at which the zone's clock reads this local minute: none (skipped), one, or two (repeated). */
function instantsOf(local: Local, timeZone: string): number[] {
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const found = new Set<number>();
  // Offsets are within a day either side; try the offsets in force a day before and after.
  for (const probe of [asUtc - 86_400_000, asUtc, asUtc + 86_400_000]) {
    const seen = localOf(probe, timeZone);
    const offset = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute) - Math.floor(probe / 60_000) * 60_000;
    const candidate = asUtc - offset;
    if (sameLocal(localOf(candidate, timeZone), local)) found.add(candidate);
  }
  return [...found].sort((a, b) => a - b);
}

const daysIn = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

function dayMatches(schedule: Schedule, year: number, month: number, day: number): boolean {
  if (!schedule.months.has(month)) return false;
  const dom = schedule.daysOfMonth.has(day);
  const dow = schedule.daysOfWeek.has(new Date(Date.UTC(year, month - 1, day)).getUTCDay());
  if (schedule.anyDayOfMonth && schedule.anyDayOfWeek) return true;
  if (schedule.anyDayOfMonth) return dow;
  if (schedule.anyDayOfWeek) return dom;
  return dom || dow;
}

/** The first instant strictly after `after` at which the schedule fires in the zone; undefined if none within five years. */
export function nextOccurrence(schedule: Schedule, after: number, timeZone: string): number | undefined {
  const start = localOf(after, timeZone);
  const hours = [...schedule.hours].sort((a, b) => a - b);
  const minutes = [...schedule.minutes].sort((a, b) => a - b);
  let { year, month, day } = start;
  for (let days = 0; days < 366 * 5 + 2; days += 1) {
    if (dayMatches(schedule, year, month, day)) {
      for (const hour of hours) {
        for (const minute of minutes) {
          const local = { year, month, day, hour, minute };
          // The first instant the clock reads this minute: a repeated minute fires once.
          const instant = instantsOf(local, timeZone)[0];
          if (instant !== undefined && instant > after) return instant;
        }
      }
    }
    day += 1;
    if (day > daysIn(year, month)) {
      day = 1;
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
  }
  return undefined;
}

/** The next n occurrences after `after`. */
export function occurrences(schedule: Schedule, after: number, timeZone: string, n: number): number[] {
  const out: number[] = [];
  let cursor = after;
  while (out.length < n) {
    const next = nextOccurrence(schedule, cursor, timeZone);
    if (next === undefined) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

/**
 * Refuses a schedule that never fires, or whose runs come closer than the minimum interval
 * (spec 40.7: "a question running every minute is a cost the customer did not intend").
 */
export function checkSchedule(expression: string, timeZone: string, minIntervalMinutes: number, now: number): Schedule {
  const schedule = parseSchedule(expression);
  const next = occurrences(schedule, now, timeZone, 48);
  if (next.length === 0) throw refuse('the schedule never fires');
  for (let i = 1; i < next.length; i += 1) {
    if (next[i]! - next[i - 1]! < minIntervalMinutes * 60_000) {
      throw new AppError('bounds', `refused: runs would come closer than the minimum interval of ${minIntervalMinutes} minutes`, {
        code: 'scheduler.interval_too_short', details: { minIntervalMinutes },
      });
    }
  }
  return schedule;
}

/** How many occurrences fell in (from, to]: runs missed while nothing ran (spec 40.7: reported, never backfilled). */
export function missedBetween(schedule: Schedule, from: number, to: number, timeZone: string, cap = 1000): number {
  let count = 0;
  let cursor = from;
  while (count < cap) {
    const next = nextOccurrence(schedule, cursor, timeZone);
    if (next === undefined || next > to) break;
    count += 1;
    cursor = next;
  }
  return count;
}
