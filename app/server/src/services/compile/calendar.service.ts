// The organisation calendar (spec 26.6): read by any member, changed under calendar.manage
// (organisation-wide), naming the organisation version it read. calendar_changed records what
// changed, never a question or a period.

import type { CalendarView } from '../../contracts/compile/calendar.contract.ts';
import { authorise } from '../../contracts/policy/decision.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { Organisation } from '../../models/iam/index.model.ts';
import { organisationRepo } from '../../repos/iam/index.repo.ts';
import { AppError, fromDatabaseError, isAppError } from '../../utils/errors.util.ts';
import { recordCompileEvent } from '../executor/events.service.ts';
import type { CompileDeps } from './compile.service.ts';

type Context = Pick<HandlerContext, 'request' | 'correlationId'>;

const viewOf = (o: Organisation): CalendarView => ({
  timeZone: o.calendarTimeZone, financialYearStartMonth: o.financialYearStartMonth, financialYearStartDay: o.financialYearStartDay,
  weekStartDay: o.weekStartDay, financialYearLabel: o.financialYearLabel, updatedBy: o.calendarUpdatedBy, updatedAt: o.calendarUpdatedAt,
  version: o.version,
});

export async function getCalendar(deps: Pick<CompileDeps, 'databases'>, ctx: Context): Promise<CalendarView> {
  const o = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => organisationRepo.findById(db, ctx.request.organisationId!), { readOnly: true });
  if (o === undefined) throw new AppError('not_found', 'no such organisation', { code: 'compile.organisation_unknown' });
  return viewOf(o);
}

export async function setCalendar(deps: Pick<CompileDeps, 'databases' | 'services'>, ctx: Context, input: {
  timeZone: string; financialYearStartMonth: number | null; financialYearStartDay: number; weekStartDay: number;
  financialYearLabel: 'start_year' | 'end_year' | null; version: number;
}): Promise<CalendarView> {
  const membershipId = ctx.request.membershipId;
  const decision = membershipId === undefined ? undefined : await deps.services.call(authorise, {
    body: { permission: 'calendar.manage', organisationWide: true },
  }, { request: ctx.request, correlationId: ctx.correlationId });
  if (decision?.decision !== 'allow') {
    throw new AppError('forbidden', 'you do not hold calendar.manage', { code: 'compile.not_permitted', details: { permission: 'calendar.manage' } });
  }
  if ((input.financialYearStartMonth === null) !== (input.financialYearLabel === null)) {
    throw new AppError('validation', 'a financial year has a start and a label, or neither', { code: 'calendar.financial_year_incomplete' });
  }
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const before = await organisationRepo.findById(db, ctx.request.organisationId!);
    if (before === undefined) throw new AppError('not_found', 'no such organisation', { code: 'compile.organisation_unknown' });
    if (before.version !== input.version) throw new AppError('conflict', 'the calendar changed since you read it', { code: 'calendar.version_stale' });
    const changed = {
      time_zone: before.calendarTimeZone !== input.timeZone,
      financial_year: before.financialYearStartMonth !== input.financialYearStartMonth || before.financialYearStartDay !== input.financialYearStartDay
        || before.financialYearLabel !== input.financialYearLabel,
      week_start: before.weekStartDay !== input.weekStartDay,
    };
    if (!changed.time_zone && !changed.financial_year && !changed.week_start) return viewOf(before);
    let after: Organisation;
    try {
      after = (await organisationRepo.update(db, before.id, {
        calendarTimeZone: input.timeZone, financialYearStartMonth: input.financialYearStartMonth, financialYearStartDay: input.financialYearStartDay,
        weekStartDay: input.weekStartDay, financialYearLabel: input.financialYearLabel, calendarUpdatedBy: membershipId!,
        calendarUpdatedAt: new Date().toISOString(), version: before.version + 1,
      }))!;
    } catch (error) {
      const mapped = isAppError(error) ? error : fromDatabaseError(error);
      if (mapped.details['sqlstate'] === '23514') throw new AppError('validation', 'the database refuses this calendar (an unknown time zone?)', { code: 'calendar.invalid' });
      throw mapped;
    }
    await recordCompileEvent(db, ctx.request, ctx.correlationId, 'calendar_changed', {
      ...changed, from_time_zone: before.calendarTimeZone, to_time_zone: input.timeZone,
      financial_year_start_month: input.financialYearStartMonth, week_start_day: input.weekStartDay,
    });
    return viewOf(after);
  });
}
