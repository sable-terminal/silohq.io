// The charge (spec 73). One transaction locks the payer's balance and period allowance,
// picks the source by the consumption order, applies it with a guarded statement and
// writes the ledger row: all of it commits or none of it does. A refusal writes nothing
// and names what was exhausted and how to continue; it raises allowance_exhausted or
// daily_limit_reached once per membership and day. The non-charging rules are applied
// before anything is read.
//
// Auto top-up (73.4): a member's charge that would be refused (grant, allowance and purchased
// tokens spent, or the daily limit reached with nothing purchased) asks billing to buy the
// smallest number of hundreds that covers it, where the member opted in, and is tried once
// more. When billing cannot (no payment method, a declined card, the day's limit), the refusal
// stands and says why.
//
// AI FDE work (73.5, 52.6) draws from the contract allocation when the organisation's
// entitlement comes from a contract (overage accrues and is reported, never refused,
// 74.3), otherwise from the engaging membership's purchased balance, never anyone's
// allowance; each charge adds to the engagement's running total within its token budget.

import { autoTopUp } from '../../contracts/billing/autoTopup.contract.ts';
import type { charge } from '../../contracts/metering/charge.contract.ts';
import type { HandlerOutput, ParsedInput } from '../../contracts/endpoint.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { chargeWindowKeys, meteringNoticeKeys } from '../../infra/keyspaces.infra.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { TokenTransaction } from '../../models/billing/tokenTransaction.model.ts';
import {
  entitlementRepo, simulationAllowanceRepo, tokenAllowanceRepo, tokenBalanceRepo, tokenTransactionRepo,
} from '../../repos/billing/index.repo.ts';
import { fdeEngagementRepo, fdePrincipalRepo } from '../../repos/fde/index.repo.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { calendarOf, renewAllowances } from './allowances.service.ts';
import { recordEvent, type MeteringDeps } from './deps.service.ts';
import {
  chooseSimulationSource, chooseTokenSource, fromUnits, poolOf, toUnits, weightOf, type Pool, type Source,
} from './funds.service.ts';

type ChargeBody = ParsedInput<typeof charge>['body'];
type ChargeOutput = HandlerOutput<typeof charge>;
type Charged = Extract<ChargeOutput, { charged: true }>;

const references = (body: ChargeBody) => ({
  siloFileId: body.siloFileId ?? null, simulationRunId: body.simulationRunId ?? null,
  healProposalId: body.healProposalId ?? null, connectorManifestId: body.connectorManifestId ?? null,
});

function chargedView(row: TokenTransaction): Charged {
  return { charged: true, transactionId: row.id, operation: row.operation, pool: row.pool, weight: fromUnits(toUnits(row.weight)), source: row.source };
}

// ----------------------------------------------------------------------------- refusals

type Refusal = 'daily_limit_reached' | 'allowance_exhausted' | 'no_allowance' | 'purchased_exhausted' | 'engagement_budget';

function refusal(kind: Refusal, pool: Pool, weight: string, details: Record<string, string | number>): AppError {
  const unit = pool === 'tokens' ? 'tokens' : 'simulations';
  const messages: Record<Refusal, string> = {
    daily_limit_reached: `refused: today's limit of ${details['limit']} ${unit} from the allowance is reached. It resets tomorrow; `
      + `buy ${unit} to continue today.`,
    allowance_exhausted: `refused: this period's allowance of ${details['limit']} ${unit} is used and no purchased ${unit} remain. `
      + `Buy ${unit} to continue, or wait for the next period.`,
    no_allowance: `refused: this membership has no ${unit} allowance this period (no seat is assigned) and no purchased ${unit}. `
      + `Ask an administrator for a seat, or buy ${unit}.`,
    purchased_exhausted: `refused: the engagement is paid from the engaging member's purchased ${unit}, and too few remain. `
      + `Buy ${unit} to continue.`,
    engagement_budget: `refused: the engagement's token budget of ${details['limit']} is reached. Raise the budget to continue.`,
  };
  const bound: Record<Refusal, string> = {
    daily_limit_reached: 'daily_token_limit', allowance_exhausted: `${pool === 'tokens' ? 'token' : 'simulation'}_allowance`,
    no_allowance: `${pool === 'tokens' ? 'token' : 'simulation'}_allowance`, purchased_exhausted: `purchased_${unit}`,
    engagement_budget: 'engagement_token_budget',
  };
  return new AppError('bounds', messages[kind], {
    code: `metering.${kind}`, retryable: false, details: { bound: bound[kind], pool, weight, ...details },
  });
}

// One notice per membership, kind and day (spec 73.9), after the refused transaction.
async function notice(deps: MeteringDeps, ctx: HandlerContext, error: AppError, pool: Pool, operation: string): Promise<void> {
  const kind = error.code === 'metering.daily_limit_reached' ? 'daily_limit_reached'
    : error.code === 'metering.allowance_exhausted' ? 'allowance_exhausted' : undefined;
  const organisationId = ctx.request.organisationId!;
  const membershipId = ctx.request.membershipId;
  const day = typeof error.details['day'] === 'string' ? error.details['day'] : undefined;
  if (kind === undefined || membershipId === undefined || day === undefined) return;
  try {
    const first = await deps.data.put(meteringNoticeKeys, meteringNoticeKeys.key(organisationId, { membershipId, notice: kind, day }), 1,
      { ifAbsent: true });
    if (!first) return;
    await inTransaction(deps.databases.pool('control'), ctx.request, (db) => recordEvent(db, {
      organisationId, correlationId: ctx.correlationId, event: kind, actor: { kind: 'membership', membershipId },
      detail: { pool, operation, limit: Number(error.details['limit'] ?? 0) },
    }));
  } catch (cause) {
    deps.logger.failure('a metering notice was not recorded', cause, { event: 'metering.notice_failed' });
  }
}

// ----------------------------------------------------------------------------- payers

async function chargeMember(deps: MeteringDeps, ctx: HandlerContext, body: ChargeBody, pool: Pool, weight: string): Promise<Charged> {
  const organisationId = ctx.request.organisationId!;
  const membershipId = ctx.request.membershipId;
  if (membershipId === undefined) {
    throw new AppError('validation', 'a charge is for a membership, or for an engagement', { code: 'metering.no_payer' });
  }
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const calendar = await calendarOf(db, organisationId);
    const balance = await tokenBalanceRepo.lockByMembership(db, membershipId);
    let source: Source;
    if (pool === 'tokens') {
      const w = Number(weight);
      const allowance = await tokenAllowanceRepo.lockCurrent(db, membershipId)
        ?? (await renewAllowances(db, organisationId, membershipId, calendar, ctx.correlationId)
          ? await tokenAllowanceRepo.lockCurrent(db, membershipId) : undefined);
      const dailyConsumed = allowance?.dailyConsumedOn === calendar.today ? allowance.dailyConsumed : 0;
      const choice = chooseTokenSource({
        grant: balance?.onboardingGrantRemaining ?? 0,
        allowance: allowance && { remaining: allowance.tokensGranted - allowance.tokensConsumed, dailyRemaining: allowance.dailyLimit - dailyConsumed },
        purchased: balance?.purchasedRemaining ?? 0,
      }, w);
      if ('refused' in choice) {
        const limit = choice.refused === 'daily_limit_reached' ? allowance!.dailyLimit : allowance?.tokensGranted ?? 0;
        throw refusal(choice.refused, pool, weight, { limit, day: calendar.today });
      }
      source = choice.source;
      const applied = source === 'allowance'
        ? await tokenAllowanceRepo.consume(db, allowance!.id, w, calendar.today)
        : await tokenBalanceRepo.debit(db, balance!.id, { grant: source === 'grant' ? w : 0, purchased: source === 'purchase' ? w : 0, simulations: '0' });
      if (applied === undefined) throw new AppError('conflict', 'the balance changed during the charge; retry', { code: 'metering.charge_conflict', retryable: true });
    } else {
      const units = toUnits(weight);
      const allowance = await simulationAllowanceRepo.lockCurrent(db, membershipId)
        ?? (await renewAllowances(db, organisationId, membershipId, calendar, ctx.correlationId)
          ? await simulationAllowanceRepo.lockCurrent(db, membershipId) : undefined);
      const choice = chooseSimulationSource({
        allowanceRemaining: allowance && BigInt(allowance.simulationsGranted) * 10_000n - toUnits(allowance.simulationsConsumed),
        purchased: toUnits(balance?.simulationsPurchasedRemaining ?? '0'),
      }, units);
      if ('refused' in choice) {
        throw refusal(choice.refused, pool, weight, { limit: allowance?.simulationsGranted ?? 0, day: calendar.today });
      }
      source = choice.source;
      const applied = source === 'allowance'
        ? await simulationAllowanceRepo.consume(db, allowance!.id, weight)
        : await tokenBalanceRepo.debit(db, balance!.id, { grant: 0, purchased: 0, simulations: weight });
      if (applied === undefined) throw new AppError('conflict', 'the balance changed during the charge; retry', { code: 'metering.charge_conflict', retryable: true });
    }
    const row = await tokenTransactionRepo.insert(db, {
      organisationId, membershipId, operation: body.operation, pool, weight, source, correlationId: body.correlationId,
      ...references(body), engagementId: null,
    });
    return chargedView(row);
  });
}

async function chargeEngagement(deps: MeteringDeps, ctx: HandlerContext, body: ChargeBody, pool: Pool, weight: string): Promise<Charged> {
  const organisationId = ctx.request.organisationId!;
  const engagementId = body.engagementId!;
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const engagement = await fdeEngagementRepo.findById(db, engagementId);
    if (engagement === undefined) throw new AppError('not_found', 'no such engagement', { code: 'metering.engagement_unknown' });
    const entitlement = await entitlementRepo.findOpen(db, organisationId);
    let source: Source;
    let membershipId: string | null;
    // A sovereign customer's terms are its contract's (D204): no purchased balance there.
    if (entitlement?.source === 'contract' || entitlement?.source === 'sovereign_terms') {
      source = 'contract';
      membershipId = null;
    } else {
      source = 'purchase';
      membershipId = engagement.engagingMembershipId;
      await debitPurchased(db, membershipId, pool, weight);
    }
    if (pool === 'tokens') {
      const total = await fdeEngagementRepo.addTokensConsumed(db, engagementId, Number(weight));
      if (total === undefined) {
        if (engagement.status !== 'active') {
          throw new AppError('conflict', `the engagement is ${engagement.status}; nothing more is charged to it`, { code: 'metering.engagement_not_active' });
        }
        throw refusal('engagement_budget', pool, weight, { limit: Number(engagement.tokenBudget) });
      }
    }
    const row = await tokenTransactionRepo.insert(db, {
      organisationId, membershipId, operation: body.operation, pool, weight, source, correlationId: body.correlationId,
      ...references(body), engagementId,
    });
    return chargedView(row);
  });
}

async function debitPurchased(db: Queryable, membershipId: string, pool: Pool, weight: string): Promise<void> {
  const balance = await tokenBalanceRepo.lockByMembership(db, membershipId);
  const enough = pool === 'tokens'
    ? (balance?.purchasedRemaining ?? 0) >= Number(weight)
    : toUnits(balance?.simulationsPurchasedRemaining ?? '0') >= toUnits(weight);
  if (balance === undefined || !enough) {
    throw refusal('purchased_exhausted', pool, weight, {
      remaining: pool === 'tokens' ? balance?.purchasedRemaining ?? 0 : balance?.simulationsPurchasedRemaining ?? '0',
    });
  }
  await tokenBalanceRepo.debit(db, balance.id, {
    grant: 0, purchased: pool === 'tokens' ? Number(weight) : 0, simulations: pool === 'tokens' ? '0' : weight,
  });
}

// ----------------------------------------------------------------------------- auto top-up

/** The refusals auto top-up answers: what purchased tokens would have paid for. */
const TOPPED_UP: ReadonlySet<string> = new Set(['metering.allowance_exhausted', 'metering.no_allowance', 'metering.daily_limit_reached']);

/** For a member who opted in, buys the tokens a refused charge needs and charges again; undefined where it does not apply. */
async function afterTopUp(deps: MeteringDeps, ctx: HandlerContext, body: ChargeBody, pool: Pool, weight: string, error: unknown)
  : Promise<Charged | undefined> {
  const membershipId = ctx.request.membershipId;
  if (pool !== 'tokens' || body.engagementId !== undefined || membershipId === undefined || !isAppError(error) || !TOPPED_UP.has(error.code)) {
    return undefined;
  }
  const balance = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => tokenBalanceRepo.findByMembership(db, membershipId), { readOnly: true });
  if (balance?.autoTopup !== true) return undefined;
  const tokens = Math.max(100, Math.ceil(Number(weight) / 100) * 100);
  try {
    await deps.services.call(autoTopUp, {
      body: { membershipId, tokens, requestKey: `${membershipId}:${ctx.idempotencyKey ?? body.correlationId}` },
    }, { request: ctx.request, correlationId: ctx.correlationId });
  } catch (cause) {
    const why = isAppError(cause) ? cause.message : 'billing could not be reached';
    throw new AppError('bounds', `${error.message} Auto top-up could not buy tokens: ${why}`, {
      code: error.code, retryable: false,
      details: { ...error.details, autoTopup: 'failed', autoTopupCode: isAppError(cause) ? cause.code : 'unavailable' },
    });
  }
  return chargeMember(deps, ctx, body, pool, weight);
}

// ----------------------------------------------------------------------------- entry

export async function chargeOperation(deps: MeteringDeps, ctx: HandlerContext, body: ChargeBody): Promise<ChargeOutput> {
  // Spec 73.2: never metered, enforced here, whatever the caller's interface does.
  if (body.trigger !== 'authored') return { charged: false, reason: 'never_metered' };
  const organisationId = ctx.request.organisationId!;
  const membershipId = ctx.request.membershipId;
  const pool = poolOf(body.operation);
  const weight = weightOf(body.operation, deps.settings);

  if (body.rephraseOf !== undefined && membershipId !== undefined) {
    const prior = await deps.data.read(chargeWindowKeys, chargeWindowKeys.key(organisationId, { correlationId: body.rephraseOf }));
    if (prior?.membershipId === membershipId) return { charged: false, reason: 'rephrase_window' };
  }

  // An AI FDE principal's operation (the builder drafting a connector for it, 51.4) is its engagement's, whoever calls.
  if (body.engagementId === undefined && membershipId === undefined && ctx.request.servicePrincipalId !== undefined) {
    const fde = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => fdePrincipalRepo.findByServicePrincipalId(db, {
      organisationId, servicePrincipalId: ctx.request.servicePrincipalId!,
    }), { readOnly: true });
    if (fde !== undefined) body = { ...body, engagementId: fde.engagementId };
  }
  let charged: Charged | undefined;
  try {
    charged = body.engagementId !== undefined
      ? await chargeEngagement(deps, ctx, body, pool, weight)
      : await chargeMember(deps, ctx, body, pool, weight);
  } catch (error) {
    try {
      charged = await afterTopUp(deps, ctx, body, pool, weight, error);
    } catch (refused) {
      if (isAppError(refused) && refused.category === 'bounds') await notice(deps, ctx, refused, pool, body.operation);
      throw refused;
    }
    if (charged === undefined) {
      if (isAppError(error) && error.category === 'bounds') await notice(deps, ctx, error, pool, body.operation);
      throw error;
    }
  }

  // The window opens on the compile that was charged, for its own member only.
  if ((body.operation === 'compile' || body.operation === 'advanced_compile') && membershipId !== undefined) {
    await deps.data.put(chargeWindowKeys, chargeWindowKeys.key(organisationId, { correlationId: body.correlationId }),
      { membershipId, operation: body.operation }, { ttlSeconds: deps.settings.rephraseWindowSeconds })
      .catch((cause: unknown) => deps.logger.failure('the rephrase window was not recorded', cause, { event: 'metering.window_failed' }));
  }
  return charged;
}

/** The identifier kept with the Idempotency-Key, so a retry returns the first result. */
export function chargeRef(output: ChargeOutput): string {
  return output.charged ? `tx.${output.transactionId}` : `none.${output.reason}`;
}

export async function replayCharge(deps: MeteringDeps, ctx: HandlerContext, ref: string | undefined): Promise<ChargeOutput> {
  if (ref === 'none.never_metered' || ref === 'none.rephrase_window') {
    return { charged: false, reason: ref === 'none.never_metered' ? 'never_metered' : 'rephrase_window' };
  }
  const id = /^tx\.(\d{1,19})$/.exec(ref ?? '')?.[1];
  const row = id === undefined ? undefined
    : await inTransaction(deps.databases.pool('control'), ctx.request, (db) => tokenTransactionRepo.findById(db, id), { readOnly: true });
  if (row === undefined) throw new AppError('internal', 'the charged ledger row was not found', { code: 'metering.replay_missing' });
  return chargedView(row);
}
