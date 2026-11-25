// A schedule asked for in Ask (spec 36.4 "Propose a Cron", 40.3, 40.7): the model says how
// often and when in words it is given a closed set for; compile writes the five-field
// expression itself, never the model, so a schedule is exactly what was described. Times are
// the organisation's (40.7: a daily 09:00 run means the organisation's 09:00). The condition is
// a result condition (40.3) and the action notifies or reports (40.4): a Cron that only
// watches is the safe first choice. Pure: words in, a draft out.

import { z } from 'zod';

export const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;

export const modelScheduleSchema = z.object({
  every: z.enum(['hour', 'day', 'weekday', 'week', 'month']),
  /** HH:MM in the organisation's time zone; for every hour, the minute past the hour is used. Absent: 09:00, or on the hour. */
  at: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/).optional(),
  /** every week: the days. */
  weekdays: z.array(z.enum(WEEKDAYS)).min(1).max(7).optional(),
  /** every month: the day (to the 28th, so every month has it). */
  dayOfMonth: z.int().min(1).max(28).optional(),
  /** Absent: always (a schedule with no condition always fires). No default here: the model gateway refuses a schema carrying sample values. */
  when: z.enum(['always', 'returned_rows', 'returned_none', 'differs_from_previous', 'count_above', 'count_below']).optional(),
  threshold: z.int().min(0).max(1_000_000_000).optional(),
  /** Absent: notify. */
  then: z.enum(['notify', 'report']).optional(),
  /** The asker's words for it. */
  asWritten: z.string().max(200),
});
export type ModelSchedule = z.infer<typeof modelScheduleSchema>;

/** As createCron takes it (spec 40): the trigger, the result condition (none: always fires) and the first action. */
export interface TranslatedSchedule {
  schedule: string;
  condition: { kind: 'result'; operator: 'returned_rows' | 'returned_none' | 'differs_from_previous' | 'count_crossed'; threshold?: number; direction?: 'above' | 'below' } | null;
  action: 'notify' | 'report';
  asWritten: string;
}

/** Five-field day-of-week numbers: Sunday is 0. */
const DOW: Readonly<Record<(typeof WEEKDAYS)[number], number>> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

export function translateSchedule(given: ModelSchedule): TranslatedSchedule | { code: string; reason: string } {
  const s = { ...given, when: given.when ?? 'always', then: given.then ?? 'notify' };
  const [hour, minute] = (s.at ?? (s.every === 'hour' ? '00:00' : '09:00')).split(':').map(Number) as [number, number];
  if (s.every !== 'week' && s.weekdays !== undefined) return { code: 'compile.schedule_invalid', reason: 'days of the week are for a weekly schedule' };
  if (s.every !== 'month' && s.dayOfMonth !== undefined) return { code: 'compile.schedule_invalid', reason: 'a day of the month is for a monthly schedule' };
  const counted = s.when === 'count_above' || s.when === 'count_below';
  if (counted !== (s.threshold !== undefined)) {
    return { code: 'compile.schedule_invalid', reason: counted ? 'say the number the count goes above or below' : 'a number is for a count condition' };
  }
  const days = [...new Set((s.weekdays ?? ['monday']).map((d) => DOW[d]))].sort((a, b) => a - b).join(',');
  const schedule = s.every === 'hour' ? `${minute} * * * *`
    : s.every === 'day' ? `${minute} ${hour} * * *`
      : s.every === 'weekday' ? `${minute} ${hour} * * 1-5`
        : s.every === 'week' ? `${minute} ${hour} * * ${days}`
          : `${minute} ${hour} ${s.dayOfMonth ?? 1} * *`;
  const condition: TranslatedSchedule['condition'] = s.when === 'always' ? null
    : counted ? { kind: 'result', operator: 'count_crossed', threshold: s.threshold!, direction: s.when === 'count_above' ? 'above' : 'below' }
      : { kind: 'result', operator: s.when as 'returned_rows' | 'returned_none' | 'differs_from_previous' };
  return { schedule, condition, action: s.then, asWritten: s.asWritten };
}
