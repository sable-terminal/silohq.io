// Allowances (spec 72.5, 73.3, 73.7). An allowance exists only for an assigned seat:
// created on assignment, prorated to the rest of the period, and per membership and period
// by unique key, so it never pools or rolls over. A seat held into a new period gets that
// period's full allowance on its first charge there. The onboarding grant is given once.

import type { HandlerOutput } from '../../contracts/endpoint.contract.ts';
import type { grantAllowance, readAllowance } from '../../contracts/metering/allowance.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import {
  entitlementRepo, seatRepo, simulationAllowanceRepo, tokenAllowanceRepo, tokenBalanceRepo,
} from '../../repos/billing/index.repo.ts';
import type { BillingCalendar } from '../../repos/billing/tokenAllowance.repo.ts';
import type { SimulationAllowance } from '../../models/billing/simulationAllowance.model.ts';
import type { TokenAllowance } from '../../models/billing/tokenAllowance.model.ts';
import type { TokenBalance } from '../../models/billing/tokenBalance.model.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { actorOf, recordEvent, requirePermission, type MeteringDeps } from './deps.service.ts';
import { fromUnits, ONBOARDING_GRANT, prorate, remainingFraction, toUnits } from './funds.service.ts';

export async function calendarOf(db: Queryable, organisationId: string): Promise<BillingCalendar> {
  const calendar = await tokenAllowanceRepo.calendar(db, organisationId);
  if (calendar === undefined) throw new AppError('not_found', 'no such organisation', { code: 'metering.organisation_unknown' });
  return calendar;
}

/**
 * Creates the period's allowances for a membership on an assigned seat, at the full
 * entitlement (a seat held from an earlier period). False when it holds no seat or the
 * organisation has no entitlement. Call inside the charge transaction.
 */
export async function renewAllowances(db: Queryable, organisationId: string, membershipId: string, calendar: BillingCalendar,
  correlationId: string): Promise<boolean> {
  const seat = await seatRepo.findAssigned(db, membershipId);
  const entitlement = seat === undefined ? undefined : await entitlementRepo.findOpen(db, organisationId);
  if (entitlement === undefined) return false;
  const base = { organisationId, membershipId, periodStart: calendar.periodStart, periodEnd: calendar.periodEnd };
  const tokens = await tokenAllowanceRepo.insertIfAbsent(db, {
    id: uuidv7(), ...base, tokensGranted: entitlement.tokensPerSeatPeriod, dailyLimit: entitlement.dailyTokenLimit,
  });
  await simulationAllowanceRepo.insertIfAbsent(db, { id: uuidv7(), ...base, simulationsGranted: entitlement.simulationsPerSeatPeriod });
  if (tokens !== undefined) {
    await recordEvent(db, {
      organisationId, correlationId, event: 'allowance_granted', actor: { kind: 'service', service: 'metering' },
      subjectMembershipId: membershipId, detail: {
        tokens_granted: entitlement.tokensPerSeatPeriod, simulations_granted: entitlement.simulationsPerSeatPeriod,
        prorated: false, renewal: true,
      },
    });
  }
  return true;
}

type TokenView = NonNullable<HandlerOutput<typeof readAllowance>['tokens']>;
type SimulationView = NonNullable<HandlerOutput<typeof readAllowance>['simulations']>;

export function tokenView(row: TokenAllowance, today: string): TokenView {
  const dailyConsumed = row.dailyConsumedOn === today ? row.dailyConsumed : 0;
  return {
    granted: row.tokensGranted, consumed: row.tokensConsumed, remaining: row.tokensGranted - row.tokensConsumed,
    dailyLimit: row.dailyLimit, dailyConsumed, dailyRemaining: Math.max(0, row.dailyLimit - dailyConsumed),
  };
}

export function simulationView(row: SimulationAllowance): SimulationView {
  const consumed = toUnits(row.simulationsConsumed);
  return {
    granted: row.simulationsGranted, consumed: fromUnits(consumed),
    remaining: fromUnits(BigInt(row.simulationsGranted) * 10_000n - consumed),
  };
}

function balanceView(row: TokenBalance | undefined): HandlerOutput<typeof readAllowance>['balance'] {
  return {
    autoTopup: row?.autoTopup ?? false,
    onboardingGrantRemaining: row?.onboardingGrantRemaining ?? 0,
    purchasedRemaining: row?.purchasedRemaining ?? 0,
    simulationsPurchasedRemaining: fromUnits(toUnits(row?.simulationsPurchasedRemaining ?? '0')),
  };
}

/** Auth assigns a seat, then calls this (spec 72.5). */
export async function grant(deps: MeteringDeps, ctx: HandlerContext, membershipId: string): Promise<HandlerOutput<typeof grantAllowance>> {
  const organisationId = ctx.request.organisationId!;
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const seat = await seatRepo.findAssigned(db, membershipId);
    if (seat === undefined) {
      throw new AppError('conflict', 'an allowance is created when a seat is assigned, and this membership holds none', {
        code: 'metering.no_seat',
      });
    }
    const entitlement = await entitlementRepo.findOpen(db, organisationId);
    if (entitlement === undefined) {
      throw new AppError('conflict', 'the organisation has no entitlement in force', { code: 'metering.no_entitlement' });
    }
    const calendar = await calendarOf(db, organisationId);
    const fraction = remainingFraction(calendar, calendar.now);
    const tokensGranted = prorate(entitlement.tokensPerSeatPeriod, fraction);
    const simulationsGranted = prorate(entitlement.simulationsPerSeatPeriod, fraction);
    const base = { organisationId, membershipId, periodStart: calendar.periodStart, periodEnd: calendar.periodEnd };
    const createdTokens = await tokenAllowanceRepo.insertIfAbsent(db, {
      id: uuidv7(), ...base, tokensGranted, dailyLimit: entitlement.dailyTokenLimit,
    });
    const createdSimulations = await simulationAllowanceRepo.insertIfAbsent(db, { id: uuidv7(), ...base, simulationsGranted });
    const opened = await tokenBalanceRepo.grantOnboarding(db, { id: uuidv7(), organisationId, membershipId, tokens: ONBOARDING_GRANT });
    if (createdTokens !== undefined || opened !== undefined) {
      await recordEvent(db, {
        organisationId, correlationId: ctx.correlationId, event: 'allowance_granted', actor: actorOf(ctx.request),
        subjectMembershipId: membershipId, detail: {
          tokens_granted: createdTokens?.tokensGranted ?? 0, simulations_granted: createdSimulations?.simulationsGranted ?? 0,
          prorated: fraction < 1, onboarding_grant: opened === undefined ? 0 : ONBOARDING_GRANT,
        },
      });
    }
    const tokens = createdTokens ?? await tokenAllowanceRepo.findCurrent(db, membershipId);
    const simulations = createdSimulations ?? await simulationAllowanceRepo.findCurrent(db, membershipId);
    if (tokens === undefined || simulations === undefined) {
      throw new AppError('internal', 'the allowance was not found after it was granted', { code: 'metering.allowance_missing' });
    }
    return {
      period: { start: calendar.periodStart, end: calendar.periodEnd },
      tokens: tokenView(tokens, calendar.today),
      simulations: simulationView(simulations),
      granted: createdTokens !== undefined,
      onboardingGranted: opened !== undefined,
    };
  });
}

/** A person reads their own allowance; anyone else's needs billing.view. */
export async function read(deps: MeteringDeps, ctx: HandlerContext, membershipId: string): Promise<HandlerOutput<typeof readAllowance>> {
  if (ctx.request.membershipId !== membershipId) await requirePermission(deps, ctx, 'billing.view');
  const organisationId = ctx.request.organisationId!;
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const calendar = await calendarOf(db, organisationId);
    const tokens = await tokenAllowanceRepo.findCurrent(db, membershipId);
    const simulations = await simulationAllowanceRepo.findCurrent(db, membershipId);
    const balance = await tokenBalanceRepo.findByMembership(db, membershipId);
    return {
      period: { start: calendar.periodStart, end: calendar.periodEnd },
      tokens: tokens === undefined ? null : tokenView(tokens, calendar.today),
      simulations: simulations === undefined ? null : simulationView(simulations),
      balance: balanceView(balance),
    };
  }, { readOnly: true });
}
