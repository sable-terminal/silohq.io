// The organisation calendar (spec 26.6): the time zone today is reckoned in, where the
// financial year begins and how its years are named, and the first day of the week. Every
// relative period a question names (last quarter, this week, year to date) is resolved against
// it, so changing it changes the meaning of every saved period on its next run: calendar_changed
// is the event a reviewer reads first. Edited under calendar.manage.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const calendarFields = z.strictObject({
  /** An IANA time zone; the database refuses one it does not know. */
  timeZone: z.string().min(1).max(64),
  /** Null: the financial year is the calendar year. */
  financialYearStartMonth: z.int().min(1).max(12).nullable(),
  financialYearStartDay: z.int().min(1).max(31).default(1),
  /** ISO weekday: 1 is Monday, 7 Sunday. */
  weekStartDay: z.int().min(1).max(7).default(1),
  /** Whether a financial year is named by the calendar year it starts or ends in; null with no financial year. */
  financialYearLabel: z.enum(['start_year', 'end_year']).nullable(),
});

export const calendarView = calendarFields.extend({
  updatedBy: z.uuid().nullable(),
  updatedAt: z.string().nullable(),
  /** The organisation row's version: a change names the one it read. */
  version: z.int(),
});
export type CalendarView = z.infer<typeof calendarView>;

export const getOrganisationCalendar = defineContract({
  service: 'compile', name: 'getOrganisationCalendar', method: 'GET', path: '/v1/organisation/calendar', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  response: calendarView,
});

export const setOrganisationCalendar = defineContract({
  service: 'compile', name: 'setOrganisationCalendar', method: 'PUT', path: '/v1/organisation/calendar', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  body: calendarFields.extend({ version: z.int().min(0) }),
  response: calendarView,
});
