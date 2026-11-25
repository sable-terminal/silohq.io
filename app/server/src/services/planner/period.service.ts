// Period resolution (spec 26.8): the asker's words and a typed expression, resolved to an
// absolute half-open range at the moment the plan runs, against the organisation's own
// calendar: its time zone, the day its financial year begins, the day its week begins.
//
// - Last quarter means their last quarter; a financial period needs the financial year's
//   start, and is refused (naming the calendar) where none is set: no default is assumed.
// - A date field is compared as a calendar date in the organisation's zone: the range is
//   two dates, never instants at midnight UTC (the recorded defect east of UTC).
// - A timestamp field gets instants: the zone's midnight at each end, through daylight
//   saving changes.
// - Ranges are [from, to): "the past year" is twelve months ending now, not one day.
// The model never does this arithmetic; this module does, from the clock.

import type { PeriodExpression, PlanParameters, Refusal } from '../../contracts/planner/plan.contract.ts';

export interface Calendar {
  timeZone: string;
  financialYearStartMonth: number | null;
  financialYearStartDay: number;
  /** 1 Monday to 7 Sunday. */
  weekStartDay: number;
}

export interface ResolvedRange {
  from: string;
  to: string;
  basis: 'date' | 'timestamp';
}

interface LocalDate { y: number; m: number; d: number }

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const iso = (d: LocalDate) => `${pad(d.y, 4)}-${pad(d.m)}-${pad(d.d)}`;

/** Calendar arithmetic in the UTC domain, where every day has 24 hours. */
function normalise(y: number, m: number, d: number): LocalDate {
  const t = new Date(Date.UTC(y, m - 1, d));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
const addDays = (date: LocalDate, days: number) => normalise(date.y, date.m, date.d + days);
/** Months forward or back, the day clamped to the month's last. */
function addMonths(date: LocalDate, months: number): LocalDate {
  const index = date.y * 12 + (date.m - 1) + months;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { y, m, d: Math.min(date.d, last) };
}
const compare = (a: LocalDate, b: LocalDate) => (a.y - b.y) || (a.m - b.m) || (a.d - b.d);
const weekday = (d: LocalDate) => { const w = new Date(Date.UTC(d.y, d.m - 1, d.d)).getUTCDay(); return w === 0 ? 7 : w; };

/** The zone's offset from UTC at an instant, in milliseconds. */
function offsetAt(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(instant / 1000) * 1000;
}

/** Today in the zone. */
export function localToday(now: number, timeZone: string): LocalDate {
  const t = new Date(now + offsetAt(now, timeZone));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** The instant the zone's day begins. Where midnight is skipped, the first instant of the day. */
/** The end of a calendar date (YYYY-MM-DD) in a time zone: the start of the next day, as an instant. */
export function endOfDate(date: string, timeZone: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return startOfDay(addDays({ y, m, d }, 1), timeZone);
}

export function startOfDay(date: LocalDate, timeZone: string): string {
  const wall = Date.UTC(date.y, date.m - 1, date.d);
  let instant = wall - offsetAt(wall, timeZone);
  const corrected = wall - offsetAt(instant, timeZone);
  if (corrected !== instant) instant = Math.min(instant, corrected);
  return new Date(instant).toISOString();
}

function financialYearStart(today: LocalDate, cal: Calendar): LocalDate | Refusal {
  if (cal.financialYearStartMonth === null) {
    return {
      code: 'plan.financial_year_unset', reason: 'the organisation\'s calendar sets no financial year start, so a financial period cannot be resolved',
      element: { kind: 'calendar', name: 'financial_year_start_month' }, remedy: 'an administrator sets the financial year start in the organisation calendar',
    };
  }
  const month = cal.financialYearStartMonth;
  // The start day clamped to the month's length (a 31st start in a 30-day month).
  const startIn = (y: number): LocalDate => ({ y, m: month, d: Math.min(cal.financialYearStartDay, new Date(Date.UTC(y, month, 0)).getUTCDate()) });
  const start = startIn(today.y);
  return compare(today, start) >= 0 ? start : startIn(today.y - 1);
}

type Unit = 'day' | 'week' | 'month' | 'quarter' | 'year' | 'financial_quarter' | 'financial_year';

/** The period of a unit containing a day: its first day, and the first day of the next. */
function periodContaining(day: LocalDate, unit: Unit, cal: Calendar): { start: LocalDate; months: number; days: number } | Refusal {
  switch (unit) {
    case 'day': return { start: day, months: 0, days: 1 };
    case 'week': return { start: addDays(day, -((weekday(day) - cal.weekStartDay + 7) % 7)), months: 0, days: 7 };
    case 'month': return { start: { y: day.y, m: day.m, d: 1 }, months: 1, days: 0 };
    case 'quarter': return { start: { y: day.y, m: Math.floor((day.m - 1) / 3) * 3 + 1, d: 1 }, months: 3, days: 0 };
    case 'year': return { start: { y: day.y, m: 1, d: 1 }, months: 12, days: 0 };
    case 'financial_year': {
      const start = financialYearStart(day, cal);
      return 'code' in start ? start : { start, months: 12, days: 0 };
    }
    case 'financial_quarter': {
      const fy = financialYearStart(day, cal);
      if ('code' in fy) return fy;
      let start = fy;
      while (compare(addMonths(start, 3), day) <= 0) start = addMonths(start, 3);
      return { start, months: 3, days: 0 };
    }
  }
}

/**
 * The first day of the period of a unit containing a value (spec 37.8's time buckets): a date read
 * as a calendar date, an instant as its day in the organisation's zone. Undefined for a value that
 * is neither, or a financial unit the calendar cannot resolve (the planner refuses that first).
 */
export function bucketStart(value: string, basis: 'date' | 'timestamp', unit: Unit, cal: Calendar): string | undefined {
  let day: LocalDate | undefined;
  if (basis === 'date') {
    const m = DATE.exec(value);
    if (m !== null) day = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  } else if (INSTANT.test(value)) {
    day = localToday(Date.parse(value), cal.timeZone);
  }
  if (day === undefined) return undefined;
  const period = periodContaining(day, unit, cal);
  return 'code' in period ? undefined : iso(period.start);
}

const shift = (start: LocalDate, p: { months: number; days: number }, times: number): LocalDate =>
  p.months > 0 ? addMonths(start, p.months * times) : addDays(start, p.days * times);

/**
 * Resolves a period for a field of the given basis, now. Between takes its ends from the
 * parameters: dates, or instants with an offset for a timestamp field.
 */
export function resolvePeriod(expression: PeriodExpression, basis: 'date' | 'timestamp', cal: Calendar, now: number,
  parameters: PlanParameters): ResolvedRange | Refusal {
  const today = localToday(now, cal.timeZone);
  const asDate = (from: LocalDate, to: LocalDate): ResolvedRange =>
    basis === 'date' ? { from: iso(from), to: iso(to), basis } : { from: startOfDay(from, cal.timeZone), to: startOfDay(to, cal.timeZone), basis };
  const nowIso = new Date(now).toISOString();

  switch (expression.kind) {
    case 'calendar': {
      const p = periodContaining(today, expression.unit, cal);
      if ('code' in p) return p;
      const start = shift(p.start, p, expression.offset);
      return asDate(start, shift(start, p, 1));
    }
    case 'trailing': {
      const months = expression.unit === 'month' ? expression.count : expression.unit === 'year' ? expression.count * 12 : 0;
      const days = expression.unit === 'day' ? expression.count : expression.unit === 'week' ? expression.count * 7 : 0;
      if (basis === 'date') {
        const end = addDays(today, 1);
        return asDate(months > 0 ? addMonths(end, -months) : addDays(end, -days), end);
      }
      const back = new Date(now);
      if (months > 0) {
        const local = addMonths(today, -months);
        const time = now + offsetAt(now, cal.timeZone) - Date.UTC(today.y, today.m - 1, today.d);
        const wall = Date.UTC(local.y, local.m - 1, local.d) + time;
        return { from: new Date(wall - offsetAt(wall, cal.timeZone)).toISOString(), to: nowIso, basis };
      }
      back.setTime(now - days * 86_400_000);
      return { from: back.toISOString(), to: nowIso, basis };
    }
    case 'to_date': {
      const p = periodContaining(today, expression.unit, cal);
      if ('code' in p) return p;
      return basis === 'date' ? asDate(p.start, addDays(today, 1)) : { from: startOfDay(p.start, cal.timeZone), to: nowIso, basis };
    }
    case 'between': {
      const read = (ref: { param: string }): string | Refusal => {
        const value = parameters[ref.param];
        if (typeof value === 'string' && (DATE.test(value) || (basis === 'timestamp' && INSTANT.test(value)))) return value;
        return {
          code: 'plan.period_value_invalid', reason: `a period end must be a date${basis === 'timestamp' ? ' or an instant with its offset' : ''}`,
          element: { kind: 'parameter', name: ref.param },
        };
      };
      const from = read(expression.from);
      if (typeof from !== 'string') return from;
      const to = read(expression.to);
      if (typeof to !== 'string') return to;
      const edge = (text: string) => {
        if (basis === 'date') return text;
        const m = DATE.exec(text);
        return m ? startOfDay({ y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }, cal.timeZone) : new Date(text).toISOString();
      };
      const range = { from: edge(from), to: edge(to), basis };
      const before = basis === 'date' ? range.from < range.to : Date.parse(range.from) < Date.parse(range.to);
      if (!before) {
        return { code: 'plan.period_empty', reason: 'the period ends before it begins', element: { kind: 'parameter', name: expression.from.param } };
      }
      return range;
    }
  }
}
