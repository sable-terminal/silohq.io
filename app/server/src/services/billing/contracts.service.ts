// Enterprise contracts (spec 71.3, 74.3, 74.4, 74.8), on the staff path from the admin portal
// (contracts/billing/contract.contract.ts). The member of staff is the request's operatorId,
// set only by the admin portal (D45); the table's row-level security refuses a write without
// one, so no tenant endpoint can alter its own contract.
//
// - A quote is priced by the margin calculator (margin.service.ts). Below the floor a draft
//   waits for margin approval by someone other than its author (contract.manage).
// - Activation needs the customer's signatory and is Silo's countersignature. The contract is
//   then in force: entitlements derive from it (a new version; a self-serve subscription's
//   stop applying), its seats exist, and the organisation is on the Enterprise plan.
// - An amendment or renewal recomputes the margin; below the floor it needs a member of staff
//   other than the quote's author. Each writes a new entitlement version and moves seats:
//   added at once, released only from unassigned ones.
// - Term end is an explicit event: the sweep lapses a contract nobody renewed. Its
//   entitlements stand until staff act (renew it, or the customer moves to self-serve), so a
//   customer is never cut off by a date alone; what they pay is the invoices' business.

import { outboxRepo } from '../../repos/platform/index.repo.ts';
import { auditEventMessage } from '../../contracts/audit/auditEvent.contract.ts';
import { ENTERPRISE_CAPABILITIES } from './plans.service.ts';
import type { ContractsConfig } from '../../config/contracts.config.ts';
import type {
  ContractAmendment, ContractView, QuoteView, contractTerms, costLevers, customerContractView,
} from '../../contracts/billing/contract.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { Contract } from '../../models/billing/contract.model.ts';
import type { NewEntitlement } from '../../models/billing/entitlement.model.ts';
import { contractRepo, entitlementRepo, seatRepo, tokenTransactionRepo } from '../../repos/billing/index.repo.ts';
import { organisationRepo } from '../../repos/iam/index.repo.ts';
import { modelCallRepo } from '../../repos/platform/index.repo.ts';
import { AppError, fromDatabaseError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { recordEvent, SYSTEM, type BillingDeps } from './deps.service.ts';
import { quoteMargin, termMonths, type CompileSample, type CostLevers, type QuotedTerms } from './margin.service.ts';

type Terms = (typeof contractTerms)['_output'];
type Levers = (typeof costLevers)['_output'];
type CustomerContract = (typeof customerContractView)['_output'];

/** How many recent compiles the measured mean is taken over. */
const COMPILE_SAMPLE = 500;

const today = (): string => new Date().toISOString().slice(0, 10);

/** The member of staff the admin portal named. */
export function staffOf(ctx: Pick<HandlerContext, 'request'>): string {
  const operatorId = ctx.request.operatorId;
  if (operatorId === undefined) {
    throw new AppError('forbidden', 'contracts are kept by Silo staff, from the admin portal', { code: 'billing.staff_required' });
  }
  return operatorId;
}

export const contractViewOf = (c: Contract): ContractView => {
  const { organisationId: _o, updatedAt: _u, ...view } = c;
  return view;
};

export const customerViewOf = (c: Contract): CustomerContract => ({
  id: c.id, status: c.status, platformFee: c.platformFee, seatCount: c.seatCount, seatRate: c.seatRate, tokenAllocation: c.tokenAllocation,
  dailyTokenLimit: c.dailyTokenLimit, simulationAllocation: c.simulationAllocation, storageIncludedBytes: c.storageIncludedBytes,
  storageRate: c.storageRate, capabilities: c.capabilities, sovereign: c.sovereign, termStart: c.termStart, termEnd: c.termEnd,
  paymentTerms: c.paymentTerms, purchaseOrderRef: c.purchaseOrderRef, renewalState: c.renewalState, signedBy: c.signedBy,
  countersignedAt: c.countersignedAt,
});

const quotedOf = (t: Pick<Terms, 'platformFee' | 'seatCount' | 'seatRate' | 'tokenAllocation' | 'simulationAllocation' | 'sovereign'
  | 'fdeOnboardingBundled' | 'termStart' | 'termEnd'> & { storageIncludedBytes: number | string }): QuotedTerms => ({
  platformFee: Number(t.platformFee), seatCount: t.seatCount, seatRate: Number(t.seatRate), tokenAllocation: Number(t.tokenAllocation),
  simulationAllocation: t.simulationAllocation, storageIncludedBytes: Number(t.storageIncludedBytes), sovereign: t.sovereign,
  fdeOnboardingBundled: t.fdeOnboardingBundled, termStart: t.termStart, termEnd: t.termEnd,
});

const leversOf = (l: Levers): CostLevers => ({
  expectedCompilesPerSeatMonth: l.expectedCompilesPerSeatMonth, dedicatedCapacity: l.dedicatedCapacity, sovereignUplift: l.sovereignUplift,
  supportLoad: l.supportLoad, fdeEngagementCost: l.fdeEngagementCost,
});

/** A contract's terms with an amendment applied, as the calculator and the row see them. */
function amended(c: Contract, changes: ContractAmendment, termEnd?: string) {
  return {
    platformFee: changes.platformFee ?? c.platformFee,
    seatCount: changes.seatCount ?? c.seatCount,
    seatRate: changes.seatRate ?? c.seatRate,
    tokenAllocation: changes.tokenAllocation ?? Number(c.tokenAllocation),
    dailyTokenLimit: changes.dailyTokenLimit ?? c.dailyTokenLimit,
    simulationAllocation: changes.simulationAllocation ?? c.simulationAllocation,
    storageIncludedBytes: changes.storageIncludedBytes ?? Number(c.storageIncludedBytes),
    liveObjectsLimit: changes.liveObjectsLimit === undefined ? c.liveObjectsLimit : changes.liveObjectsLimit,
    storageRate: changes.storageRate ?? c.storageRate,
    capabilities: changes.capabilities ?? c.capabilities,
    termEnd: termEnd ?? changes.termEnd ?? c.termEnd,
    paymentTerms: changes.paymentTerms ?? c.paymentTerms,
    purchaseOrderRef: changes.purchaseOrderRef === undefined ? c.purchaseOrderRef : changes.purchaseOrderRef,
    sovereign: c.sovereign, fdeOnboardingBundled: c.fdeOnboardingBundled, termStart: c.termStart,
  };
}

const conflict = (message: string, code: string): AppError => new AppError('conflict', message, { code });

export function createContracts(deps: BillingDeps & { contracts: ContractsConfig }) {
  const control = deps.databases.pool('control');
  const config = deps.contracts;

  const sample = (): Promise<CompileSample> =>
    inTransaction(control, {}, (db) => modelCallRepo.compileSample(db, COMPILE_SAMPLE), { readOnly: true });

  const price = async (terms: QuotedTerms, levers: Levers): Promise<QuoteView> => quoteMargin(terms, leversOf(levers), await sample(), config);

  async function locked(db: Queryable, id: string, version: string): Promise<Contract> {
    const contract = await contractRepo.lockById(db, id);
    if (contract === undefined) throw new AppError('not_found', 'no such contract', { code: 'contract.not_found' });
    if (contract.version !== version) throw conflict('the contract changed; reload it', 'contract.version');
    return contract;
  }

  async function save(db: Queryable, contract: Contract, changes: Parameters<typeof contractRepo.updateAt>[3]): Promise<Contract> {
    try {
      const saved = await contractRepo.updateAt(db, contract.id, contract.version, changes);
      if (saved === undefined) throw conflict('the contract changed; reload it', 'contract.version');
      return saved;
    } catch (error) {
      // 23P01: contracts_no_overlap, one active contract per organisation per day.
      if (fromDatabaseError(error).code === 'db.23P01') throw conflict('another active contract covers these dates', 'contract.overlaps');
      throw error;
    }
  }

  /** The entitlement in force from now: the contract's (71.4), never updated in place. */
  async function entitle(db: Queryable, c: Contract, correlationId: string): Promise<void> {
    const capabilities = [...new Set([...c.capabilities, ...ENTERPRISE_CAPABILITIES, ...(c.sovereign ? ['sovereign' as const] : [])])];
    const before = await entitlementRepo.findOpen(db, c.organisationId);
    // live_bounds_changed (32.7): the organisation's live bound moves with its contract, from and to (null is the cell's default).
    if ((before?.liveObjectsLimit ?? null) !== c.liveObjectsLimit) {
      await outboxRepo.insert(db, {
        id: uuidv7(), organisationId: c.organisationId, topic: auditEventMessage.topic, orderingKey: c.organisationId, event: auditEventMessage.name,
        schemaVersion: auditEventMessage.version, correlationId,
        payload: auditEventMessage.schema.parse({
          event: 'live_bounds_changed', actor: { kind: 'service', service: 'billing' }, subjectMembershipId: null, scopeId: null,
          resource: { type: 'contract', id: c.id }, purposeSessionId: null, operatorAccessSessionId: null, ipHash: null,
          detail: { bound: 'live_objects_per_organisation', from: before?.liveObjectsLimit ?? null, to: c.liveObjectsLimit },
        }),
      });
    }
    await entitlementRepo.closeOpen(db, c.organisationId);
    await entitlementRepo.insertEffectiveNow(db, {
      id: uuidv7(), organisationId: c.organisationId, seats: c.seatCount, tokensPerSeatPeriod: Number(c.tokenAllocation),
      simulationsPerSeatPeriod: c.simulationAllocation, dailyTokenLimit: c.dailyTokenLimit, storageIncludedBytes: c.storageIncludedBytes,
      capabilities: capabilities as NewEntitlement['capabilities'], source: 'contract', subscriptionId: null, contractId: c.id,
      connectionsLimit: null, liveObjectsLimit: c.liveObjectsLimit,
    });
  }

  /** The contract's seats to its count: new ones at once; fewer only from unassigned ones (72.3). */
  async function seatsTo(db: Queryable, c: Contract, operatorId: string, correlationId: string): Promise<void> {
    const live = await seatRepo.liveForContract(db, c.id);
    if (live.length < c.seatCount) {
      for (let n = live.length; n < c.seatCount; n++) {
        const seat = await seatRepo.insert(db, { id: uuidv7(), organisationId: c.organisationId, contractId: c.id, planTier: 'enterprise' });
        await recordEvent(db, {
          organisationId: c.organisationId, correlationId, event: 'seat_allocated', actor: SYSTEM, resource: { type: 'seat', id: seat.id },
          detail: { source: 'contract', operator_id: operatorId },
        });
      }
      return;
    }
    const spare = live.filter((s) => s.status === 'unassigned').slice(0, live.length - c.seatCount);
    if (spare.length < live.length - c.seatCount) {
      throw conflict(`only ${spare.length} of the contract's seats are unassigned; reclaim seats before reducing the count`, 'contract.seats_assigned');
    }
    const at = new Date().toISOString();
    for (const s of spare) {
      await seatRepo.update(db, s.id, { status: 'released', releasedAt: at });
      await recordEvent(db, {
        organisationId: c.organisationId, correlationId, event: 'seat_released', actor: SYSTEM, resource: { type: 'seat', id: s.id },
        detail: { source: 'contract', operator_id: operatorId },
      });
    }
  }

  /** Below the floor, an amendment or renewal is signed off by staff other than the quote's author. */
  function signOff(c: Contract, quote: QuoteView, operatorId: string): { marginApprovedBy: string | null; marginApprovedAt: string | null } {
    if (!quote.belowFloor) return { marginApprovedBy: null, marginApprovedAt: null };
    if (operatorId === c.createdBy) {
      throw new AppError('forbidden', 'below the margin floor this needs sign-off from someone other than the quote\'s author', {
        code: 'contract.margin_needs_another', details: { margin: quote.margin, floor: quote.floor },
      });
    }
    return { marginApprovedBy: operatorId, marginApprovedAt: new Date().toISOString() };
  }

  return {
    quote: (_ctx: HandlerContext, body: { terms: Terms; levers: Levers }) => price(quotedOf(body.terms), body.levers),

    async create(ctx: HandlerContext, body: { terms: Terms; levers: Levers }): Promise<{ contract: ContractView; quote: QuoteView }> {
      const operatorId = staffOf(ctx);
      const organisationId = ctx.request.organisationId!;
      const quote = await price(quotedOf(body.terms), body.levers);
      const t = body.terms;
      const contract = await inTransaction(control, ctx.request, async (db) => {
        const row = await contractRepo.insert(db, {
          id: uuidv7(), organisationId, status: quote.belowFloor ? 'awaiting_margin_approval' : 'draft', platformFee: t.platformFee,
          seatCount: t.seatCount, seatRate: t.seatRate, tokenAllocation: String(t.tokenAllocation), dailyTokenLimit: t.dailyTokenLimit,
          simulationAllocation: t.simulationAllocation, storageIncludedBytes: String(t.storageIncludedBytes), storageRate: t.storageRate,
          liveObjectsLimit: t.liveObjectsLimit,
          capabilities: t.capabilities, sovereign: t.sovereign, fdeOnboardingBundled: t.fdeOnboardingBundled, termStart: t.termStart,
          termEnd: t.termEnd, paymentTerms: t.paymentTerms, purchaseOrderRef: t.purchaseOrderRef ?? null, quotedMargin: quote.margin.toFixed(4),
          createdBy: operatorId,
        });
        if (quote.belowFloor) {
          await recordEvent(db, {
            organisationId, correlationId: ctx.correlationId, event: 'margin_approval_requested', actor: SYSTEM,
            resource: { type: 'contract', id: row.id }, detail: { operator_id: operatorId, margin: quote.margin, floor: quote.floor },
          });
        }
        return row;
      });
      return { contract: contractViewOf(contract), quote };
    },

    async amendDraft(ctx: HandlerContext, id: string, body: { version: string; terms: Terms; levers: Levers }) {
      const operatorId = staffOf(ctx);
      const quote = await price(quotedOf(body.terms), body.levers);
      const t = body.terms;
      const contract = await inTransaction(control, ctx.request, async (db) => {
        const c = await locked(db, id, body.version);
        if (c.status !== 'draft' && c.status !== 'awaiting_margin_approval') throw conflict(`a ${c.status} contract is not a draft`, 'contract.not_draft');
        const saved = await save(db, c, {
          status: quote.belowFloor ? 'awaiting_margin_approval' : 'draft', platformFee: t.platformFee, seatCount: t.seatCount,
          seatRate: t.seatRate, tokenAllocation: String(t.tokenAllocation), dailyTokenLimit: t.dailyTokenLimit,
          simulationAllocation: t.simulationAllocation, storageIncludedBytes: String(t.storageIncludedBytes), storageRate: t.storageRate,
          liveObjectsLimit: t.liveObjectsLimit,
          capabilities: t.capabilities, sovereign: t.sovereign, fdeOnboardingBundled: t.fdeOnboardingBundled, termStart: t.termStart,
          termEnd: t.termEnd, paymentTerms: t.paymentTerms, purchaseOrderRef: t.purchaseOrderRef ?? null, quotedMargin: quote.margin.toFixed(4),
          // A changed quote needs its sign-off again.
          marginApprovedBy: null, marginApprovedAt: null,
        });
        if (quote.belowFloor) {
          await recordEvent(db, {
            organisationId: c.organisationId, correlationId: ctx.correlationId, event: 'margin_approval_requested', actor: SYSTEM,
            resource: { type: 'contract', id }, detail: { operator_id: operatorId, margin: quote.margin, floor: quote.floor },
          });
        }
        return saved;
      });
      return { contract: contractViewOf(contract), quote };
    },

    async approveMargin(ctx: HandlerContext, id: string, body: { version: string }): Promise<ContractView> {
      const operatorId = staffOf(ctx);
      return contractViewOf(await inTransaction(control, ctx.request, async (db) => {
        const c = await locked(db, id, body.version);
        if (c.status !== 'awaiting_margin_approval') throw conflict('this contract is not waiting for margin approval', 'contract.no_approval_needed');
        if (c.createdBy === operatorId) {
          throw new AppError('forbidden', 'a quote below the floor is approved by someone other than its author', { code: 'contract.margin_self_approval' });
        }
        const saved = await save(db, c, { status: 'draft', marginApprovedBy: operatorId, marginApprovedAt: new Date().toISOString() });
        await recordEvent(db, {
          organisationId: c.organisationId, correlationId: ctx.correlationId, event: 'margin_approval_granted', actor: SYSTEM,
          resource: { type: 'contract', id }, detail: { operator_id: operatorId, margin: Number(c.quotedMargin), floor: config.marginFloor },
        });
        return saved;
      }));
    },

    async activate(ctx: HandlerContext, id: string, body: { version: string; signedBy: string }): Promise<ContractView> {
      const operatorId = staffOf(ctx);
      return contractViewOf(await inTransaction(control, ctx.request, async (db) => {
        const c = await locked(db, id, body.version);
        if (c.status === 'awaiting_margin_approval') throw conflict('the quote is below the margin floor and not yet approved', 'contract.margin_unapproved');
        if (c.status !== 'draft') throw conflict(`a ${c.status} contract cannot be activated`, 'contract.not_draft');
        if (c.quotedMargin !== null && Number(c.quotedMargin) < config.marginFloor && c.marginApprovedBy === null) {
          throw conflict('the quote is below the margin floor and not yet approved', 'contract.margin_unapproved');
        }
        const now = today();
        if (c.termStart > now) throw new AppError('validation', 'a contract is activated once its term has started', { code: 'contract.not_started' });
        if (c.termEnd < now) throw new AppError('validation', 'the contract\'s term has already ended', { code: 'contract.term_ended' });
        const active = await save(db, c, {
          status: 'active', signedBy: body.signedBy, countersignedAt: new Date().toISOString(), countersignedBy: operatorId, renewalState: 'upcoming',
        });
        await entitle(db, active, ctx.correlationId);
        await seatsTo(db, active, operatorId, ctx.correlationId);
        await organisationRepo.setPlan(db, active.organisationId, 'enterprise');
        await recordEvent(db, {
          organisationId: c.organisationId, correlationId: ctx.correlationId, event: 'contract_created', actor: SYSTEM,
          resource: { type: 'contract', id }, detail: {
            operator_id: operatorId, seats: active.seatCount, term_start: active.termStart, term_end: active.termEnd,
            margin: active.quotedMargin === null ? null : Number(active.quotedMargin),
          },
        });
        return active;
      }));
    },

    async amend(ctx: HandlerContext, id: string, body: { version: string; changes: ContractAmendment; levers: Levers }) {
      const operatorId = staffOf(ctx);
      let quote!: QuoteView;
      const contract = await inTransaction(control, ctx.request, async (db) => {
        const c = await locked(db, id, body.version);
        if (c.status !== 'active') throw conflict('only an active contract is amended; a draft is edited', 'contract.not_active');
        const next = amended(c, body.changes);
        if (next.termEnd <= next.termStart || next.termEnd < today()) {
          throw new AppError('validation', 'the term must end after it starts and not before today', { code: 'contract.term_invalid' });
        }
        quote = await price(quotedOf(next), body.levers);
        const saved = await save(db, c, {
          platformFee: next.platformFee, seatCount: next.seatCount, seatRate: next.seatRate, tokenAllocation: String(next.tokenAllocation),
          dailyTokenLimit: next.dailyTokenLimit, simulationAllocation: next.simulationAllocation,
          storageIncludedBytes: String(next.storageIncludedBytes), storageRate: next.storageRate, capabilities: next.capabilities,
          liveObjectsLimit: next.liveObjectsLimit,
          termEnd: next.termEnd, paymentTerms: next.paymentTerms, purchaseOrderRef: next.purchaseOrderRef, quotedMargin: quote.margin.toFixed(4),
          ...signOff(c, quote, operatorId),
        });
        await entitle(db, saved, ctx.correlationId);
        await seatsTo(db, saved, operatorId, ctx.correlationId);
        await recordEvent(db, {
          organisationId: c.organisationId, correlationId: ctx.correlationId, event: 'contract_amended', actor: SYSTEM,
          resource: { type: 'contract', id }, detail: {
            operator_id: operatorId, changed: Object.keys(body.changes).sort().join(',').slice(0, 200), margin: quote.margin,
            below_floor: quote.belowFloor,
          },
        });
        return saved;
      });
      return { contract: contractViewOf(contract), quote };
    },

    async renew(ctx: HandlerContext, id: string, body: { version: string; termEnd: string; changes: Omit<ContractAmendment, 'termEnd'>; levers: Levers }) {
      const operatorId = staffOf(ctx);
      let quote!: QuoteView;
      const contract = await inTransaction(control, ctx.request, async (db) => {
        const c = await locked(db, id, body.version);
        if (!(c.status === 'active' || (c.status === 'expired' && c.renewalState === 'lapsed'))) {
          throw conflict(`a ${c.status} contract cannot be renewed`, 'contract.not_renewable');
        }
        if (body.termEnd <= c.termEnd || body.termEnd < today()) {
          throw new AppError('validation', 'a renewal ends after the current term and not before today', { code: 'contract.term_invalid' });
        }
        const next = amended(c, body.changes, body.termEnd);
        quote = await price(quotedOf(next), body.levers);
        const saved = await save(db, c, {
          status: 'active', renewalState: 'renewed', platformFee: next.platformFee, seatCount: next.seatCount, seatRate: next.seatRate,
          tokenAllocation: String(next.tokenAllocation), dailyTokenLimit: next.dailyTokenLimit, simulationAllocation: next.simulationAllocation,
          storageIncludedBytes: String(next.storageIncludedBytes), storageRate: next.storageRate, capabilities: next.capabilities,
          liveObjectsLimit: next.liveObjectsLimit,
          termEnd: next.termEnd, paymentTerms: next.paymentTerms, purchaseOrderRef: next.purchaseOrderRef, quotedMargin: quote.margin.toFixed(4),
          ...signOff(c, quote, operatorId),
        });
        await entitle(db, saved, ctx.correlationId);
        await seatsTo(db, saved, operatorId, ctx.correlationId);
        await recordEvent(db, {
          organisationId: c.organisationId, correlationId: ctx.correlationId, event: 'contract_renewed', actor: SYSTEM,
          resource: { type: 'contract', id }, detail: {
            operator_id: operatorId, term_end: saved.termEnd, after_lapse: c.status === 'expired', margin: quote.margin,
          },
        });
        return saved;
      });
      return { contract: contractViewOf(contract), quote };
    },

    async setRenewalState(ctx: HandlerContext, id: string, body: { version: string; renewalState: 'upcoming' | 'in_negotiation' }) {
      staffOf(ctx);
      return contractViewOf(await inTransaction(control, ctx.request, async (db) => {
        const c = await locked(db, id, body.version);
        if (c.status !== 'active') throw conflict('only an active contract is renewed', 'contract.not_active');
        return save(db, c, { renewalState: body.renewalState });
      }));
    },

    async list(ctx: HandlerContext, limit: number): Promise<{ contracts: ContractView[] }> {
      staffOf(ctx);
      const rows = await inTransaction(control, ctx.request, (db) => contractRepo.list(db, limit), { readOnly: true });
      return { contracts: rows.map(contractViewOf) };
    },

    async readOwn(ctx: HandlerContext): Promise<{ contracts: CustomerContract[] }> {
      const rows = await inTransaction(control, ctx.request, (db) => contractRepo.list(db, 20), { readOnly: true });
      // A draft is Silo's working paper until it is signed.
      return { contracts: rows.filter((c) => c.status === 'active' || c.status === 'expired' || c.status === 'terminated').map(customerViewOf) };
    },

    usage: (ctx: HandlerContext, id: string) =>
      inTransaction(control, ctx.request, async (db) => {
        const c = await contractRepo.findById(db, id);
        if (c === undefined) throw new AppError('not_found', 'no such contract', { code: 'contract.not_found' });
        return usageOf(db, c);
      }, { readOnly: true }),
  };
}

export type Contracts = ReturnType<typeof createContracts>;

/** Tokens used in the term against what the contract allocates (74.3); overage accrues and reports, never charges. */
export async function usageOf(db: Queryable, c: Contract) {
  const now = today();
  const months = termMonths(c.termStart, c.termEnd);
  const elapsed = c.termStart > now ? 0 : termMonths(c.termStart, now < c.termEnd ? now : c.termEnd);
  const perMonth = Number(c.tokenAllocation) * c.seatCount;
  const used = await tokenTransactionRepo.contractedTokensUsedSince(db, `${c.termStart}T00:00:00Z`);
  const allocatedToDate = perMonth * elapsed;
  return {
    contractId: c.id, termMonths: months, monthsElapsed: elapsed, tokensUsed: used, tokensAllocatedToDate: allocatedToDate,
    tokensAllocatedForTerm: perMonth * months, overage: Math.max(0, used - allocatedToDate),
  };
}
