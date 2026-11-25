// A sovereign customer's entitlement terms (D204; decision 2026-11-19): the contract is held in
// Silo's commercial billing (sovereign set, invoiced through Stripe as any Enterprise contract);
// billing is compiled out of the sovereign cell, so the terms it grants are entered here, in the
// sovereign cell's admin portal, by a UK cleared operator, by the commercial contract's reference
// and without price, and approved by a second one (the table's check too). Approved, they open the
// organisation's entitlement (source sovereign_terms; the open one before is closed, never edited)
// and bring its seats to their count: new seats at once, fewer only from unassigned ones. Only a
// sovereign cell takes them. Events: sovereign_terms_entered, _approved, _rejected.

import { auditEventMessage } from '../../contracts/audit/auditEvent.contract.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { SovereignTerm } from '../../models/billing/sovereignTerm.model.ts';
import type { NewEntitlement } from '../../models/billing/entitlement.model.ts';
import { entitlementRepo, seatRepo, sovereignTermRepo } from '../../repos/billing/index.repo.ts';
import { outboxRepo } from '../../repos/platform/index.repo.ts';
import { AppError, fromDatabaseError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import type { AdminPortalDeps, StaffContext } from './deps.service.ts';

export interface SovereignTermsInput {
  commercialContractRef: string;
  seats: number;
  tokensPerSeatPeriod: number;
  simulationsPerSeatPeriod: number;
  dailyTokenLimit: number;
  storageIncludedBytes: number;
  liveObjectsLimit: number | null;
  capabilities: NewEntitlement['capabilities'];
  termStart: string;
  termEnd: string;
}

const viewOf = (t: SovereignTerm) => ({
  id: t.id, organisationId: t.organisationId, commercialContractRef: t.commercialContractRef, seats: t.seats,
  tokensPerSeatPeriod: t.tokensPerSeatPeriod, simulationsPerSeatPeriod: t.simulationsPerSeatPeriod, dailyTokenLimit: t.dailyTokenLimit,
  storageIncludedBytes: Number(t.storageIncludedBytes), liveObjectsLimit: t.liveObjectsLimit, capabilities: [...t.capabilities],
  termStart: String(t.termStart).slice(0, 10), termEnd: String(t.termEnd).slice(0, 10), status: t.status, enteredBy: t.enteredBy,
  enteredAt: new Date(t.enteredAt).toISOString(), decidedBy: t.decidedBy, decidedAt: t.decidedAt === null ? null : new Date(t.decidedAt).toISOString(),
});
export type SovereignTermsView = ReturnType<typeof viewOf>;

async function record(db: Queryable, organisationId: string, correlationId: string, event: 'sovereign_terms_entered' | 'sovereign_terms_approved' | 'sovereign_terms_rejected',
  termsId: string, detail: Record<string, string | number | boolean | null>): Promise<void> {
  const payload = auditEventMessage.schema.parse({
    event, actor: { kind: 'service', service: 'admin-portal' }, subjectMembershipId: null, scopeId: null, resource: { type: 'sovereign_terms', id: termsId },
    purposeSessionId: null, operatorAccessSessionId: null, ipHash: null, detail,
  });
  await outboxRepo.insert(db, {
    id: uuidv7(), organisationId, topic: auditEventMessage.topic, orderingKey: organisationId, event: auditEventMessage.name,
    schemaVersion: auditEventMessage.version, payload, correlationId,
  });
}

export function createSovereignTerms(deps: Pick<AdminPortalDeps, 'databases' | 'cell' | 'logger'>) {
  const control = deps.databases.pool('control');
  const sovereignOnly = (): void => {
    if (!deps.cell.sovereign) {
      throw new AppError('conflict', 'entitlement terms are entered here only in the sovereign cell: elsewhere a contract in billing grants them', {
        code: 'sovereign_terms.not_sovereign_cell',
      });
    }
  };

  return {
    async enter(ctx: StaffContext, organisationId: string, input: SovereignTermsInput): Promise<SovereignTermsView> {
      sovereignOnly();
      const row = await inTransaction(control, { organisationId }, async (db) => {
        const inserted = await sovereignTermRepo.insert(db, {
          id: uuidv7(), organisationId, commercialContractRef: input.commercialContractRef, seats: input.seats, tokensPerSeatPeriod: input.tokensPerSeatPeriod,
          simulationsPerSeatPeriod: input.simulationsPerSeatPeriod, dailyTokenLimit: input.dailyTokenLimit, storageIncludedBytes: String(input.storageIncludedBytes),
          liveObjectsLimit: input.liveObjectsLimit, capabilities: [...new Set([...input.capabilities, 'sovereign' as const])] as never,
          termStart: input.termStart, termEnd: input.termEnd, enteredBy: ctx.staff.operator.id,
        });
        await record(db, organisationId, ctx.correlationId, 'sovereign_terms_entered', inserted.id, {
          operator_id: ctx.staff.operator.id, commercial_contract_ref: input.commercialContractRef, seats: input.seats,
        });
        return inserted;
      });
      return viewOf(row);
    },

    async list(organisationId: string, limit = 50): Promise<{ terms: SovereignTermsView[] }> {
      sovereignOnly();
      const rows = await inTransaction(control, { organisationId }, (db) => sovereignTermRepo.list(db, limit), { readOnly: true });
      return { terms: rows.map(viewOf) };
    },

    async decide(ctx: StaffContext, organisationId: string, termsId: string, decision: 'approve' | 'reject'): Promise<SovereignTermsView> {
      sovereignOnly();
      const operatorId = ctx.staff.operator.id;
      try {
        const row = await inTransaction(control, { organisationId }, async (db) => {
          const terms = await sovereignTermRepo.findById(db, termsId);
          if (terms === undefined) throw new AppError('not_found', 'no such terms', { code: 'sovereign_terms.not_found' });
          if (terms.status !== 'pending') throw new AppError('conflict', 'those terms are decided already', { code: 'sovereign_terms.decided' });
          if (terms.enteredBy === operatorId) {
            throw new AppError('forbidden', 'another operator decides the terms you entered (two-person rule)', { code: 'sovereign_terms.two_person' });
          }
          const now = new Date().toISOString();
          const decided = (await sovereignTermRepo.update(db, termsId, { status: decision === 'approve' ? 'approved' : 'rejected', decidedBy: operatorId, decidedAt: now }))!;
          if (decision === 'reject') {
            await record(db, organisationId, ctx.correlationId, 'sovereign_terms_rejected', termsId, { operator_id: operatorId });
            return decided;
          }
          // The entitlement in force from now: these terms' (never updated in place).
          await entitlementRepo.closeOpen(db, organisationId);
          await entitlementRepo.insertEffectiveNow(db, {
            id: uuidv7(), organisationId, seats: terms.seats, tokensPerSeatPeriod: terms.tokensPerSeatPeriod, simulationsPerSeatPeriod: terms.simulationsPerSeatPeriod,
            dailyTokenLimit: terms.dailyTokenLimit, storageIncludedBytes: terms.storageIncludedBytes, capabilities: terms.capabilities as NewEntitlement['capabilities'],
            source: 'sovereign_terms', subscriptionId: null, contractId: null, sovereignTermsId: terms.id, connectionsLimit: null, liveObjectsLimit: terms.liveObjectsLimit,
          });
          // Its seats to their count: new ones at once; fewer only from unassigned ones.
          const live = await seatRepo.liveForOrganisation(db);
          for (let n = live.length; n < terms.seats; n++) {
            await seatRepo.insert(db, { id: uuidv7(), organisationId, sovereignTermsId: terms.id, planTier: 'enterprise' });
          }
          if (live.length > terms.seats) {
            const spare = live.filter((s) => s.status === 'unassigned').slice(0, live.length - terms.seats);
            if (spare.length < live.length - terms.seats) {
              throw new AppError('conflict', `only ${spare.length} seats are unassigned; reclaim seats before reducing the count`, { code: 'sovereign_terms.seats_assigned' });
            }
            for (const seat of spare) await seatRepo.update(db, seat.id, { status: 'released', releasedAt: now });
          }
          await record(db, organisationId, ctx.correlationId, 'sovereign_terms_approved', termsId, {
            operator_id: operatorId, entered_by: terms.enteredBy, seats: terms.seats, commercial_contract_ref: terms.commercialContractRef,
          });
          return decided;
        });
        deps.logger.info('sovereign terms decided', { event: 'admin.sovereign_terms_decided', resourceType: 'organisation', resourceId: organisationId, outcome: decision });
        return viewOf(row);
      } catch (error) {
        throw fromDatabaseError(error);
      }
    },
  };
}

export type SovereignTerms = ReturnType<typeof createSovereignTerms>;
