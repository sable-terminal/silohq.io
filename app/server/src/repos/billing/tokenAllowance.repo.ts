// Data access for billing.token_allowances, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  tokenAllowanceTable,
  type NewTokenAllowance,
  type TokenAllowance,
  type TokenAllowanceChanges,
} from '../../models/billing/tokenAllowance.model.ts';

export const tokenAllowanceRepo = {
  insert(db: Queryable, row: NewTokenAllowance): Promise<TokenAllowance> {
    return insertRow(db, tokenAllowanceTable, row);
  },

  findById(db: Queryable, id: TokenAllowance['id']): Promise<TokenAllowance | undefined> {
    return findRow(db, tokenAllowanceTable, { id });
  },

  findByMembershipIdAndPeriodStart(
    db: Queryable,
    key: Pick<TokenAllowance, 'organisationId' | 'membershipId' | 'periodStart'>,
  ): Promise<TokenAllowance | undefined> {
    return findRow(db, tokenAllowanceTable, key);
  },

  update(
    db: Queryable,
    id: TokenAllowance['id'],
    changes: TokenAllowanceChanges,
  ): Promise<TokenAllowance | undefined> {
    return updateRow(db, tokenAllowanceTable, { id }, changes);
  },

  // The allowance period in force now and today's date, both in the organisation's time
  // zone (spec 73.3; design: daily_consumed_on). A period is a calendar month there.
  async calendar(db: Queryable, organisationId: string): Promise<BillingCalendar | undefined> {
    const { rows } = await db.query(
      `select date_trunc('month', now() at time zone o.calendar_time_zone) at time zone o.calendar_time_zone as "periodStart",
              (date_trunc('month', now() at time zone o.calendar_time_zone) + interval '1 month')
                at time zone o.calendar_time_zone as "periodEnd",
              to_char(now() at time zone o.calendar_time_zone, 'YYYY-MM-DD') as today,
              now() as now
       from iam.organisations o where o.id = $1`, [organisationId]);
    return rows[0] as BillingCalendar | undefined;
  },

  // The membership's allowance for the period in force, locked for a charge.
  async lockCurrent(db: Queryable, membershipId: string): Promise<TokenAllowance | undefined> {
    const { rows } = await db.query(
      `select ${tokenAllowanceTable.select} from ${tokenAllowanceTable.sql}
       where membership_id = $1 and period_start <= now() and period_end > now() for update`, [membershipId]);
    return rows[0] as TokenAllowance | undefined;
  },

  // The membership's allowance for the period in force, unlocked.
  async findCurrent(db: Queryable, membershipId: string): Promise<TokenAllowance | undefined> {
    const { rows } = await db.query(
      `select ${tokenAllowanceTable.select} from ${tokenAllowanceTable.sql}
       where membership_id = $1 and period_start <= now() and period_end > now()`, [membershipId]);
    return rows[0] as TokenAllowance | undefined;
  },

  // The charge, as one statement (design: billing.token_allowances): consumes the weight only
  // when it fits both the allowance and the day's limit, resetting the day's counter on a
  // new date. Undefined when it does not fit.
  async consume(db: Queryable, id: string, weight: number, today: string): Promise<TokenAllowance | undefined> {
    const { rows } = await db.query(
      `update billing.token_allowances
          set tokens_consumed = tokens_consumed + $2,
              daily_consumed = (case when daily_consumed_on = $3::date then daily_consumed else 0 end) + $2,
              daily_consumed_on = $3::date
        where id = $1 and tokens_consumed + $2 <= tokens_granted
          and (case when daily_consumed_on = $3::date then daily_consumed else 0 end) + $2 <= daily_limit
       returning ${tokenAllowanceTable.select}`, [id, weight, today]);
    return rows[0] as TokenAllowance | undefined;
  },

  // Creates the period's allowance unless one exists (the unique key on membership and
  // period start: allowances do not pool or roll over). Undefined when one existed.
  async insertIfAbsent(db: Queryable, row: NewTokenAllowance): Promise<TokenAllowance | undefined> {
    const { rows } = await db.query(
      `insert into billing.token_allowances (id, organisation_id, membership_id, period_start, period_end, tokens_granted, daily_limit)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (organisation_id, membership_id, period_start) do nothing
       returning ${tokenAllowanceTable.select}`,
      [row.id, row.organisationId, row.membershipId, row.periodStart, row.periodEnd, row.tokensGranted, row.dailyLimit]);
    return rows[0] as TokenAllowance | undefined;
  },
};

export interface BillingCalendar {
  periodStart: string;
  periodEnd: string;
  /** YYYY-MM-DD in the organisation's time zone. */
  today: string;
  now: string;
}
