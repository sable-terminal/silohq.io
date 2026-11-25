// What billing does on its own, on a timer (spec 74.3, 75.3), across organisations: each pass
// lists identifiers through a security definer function, then acts on each under that
// organisation's own context, with its audit event in the same transaction.
//
// - Renewals: a contract whose term ended unrenewed lapses (contract_lapsed); a renewed one's
//   next renewal becomes upcoming within the notice window.
// - Overdue invoices: an open invoice past its due date is overdue, and an active
//   organisation moves to past due (billing_status_changed, source overdue_invoice). Paying
//   the last one lifts it (settleOverdue). Suspension stays a staff decision.
// - Overage: tokens used in a contract's term beyond what it has allocated so far is
//   reported when it grows (overage_reported); never charged.
// - Silo charges: the closed month's Siloes at provider cost plus 10%, invoiced in arrears
//   (siloCharges.service; spec 74.1).
// - Seat counts: a live subscription counted above its billable seats is lowered at the
//   provider, with no refund (seats.service; spec 72.2).

import { createSeatSync } from './seats.service.ts';
import { closedPeriod, createSiloCharges } from './siloCharges.service.ts';
import type { ContractsConfig } from '../../config/contracts.config.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { contractRepo, invoiceRepo } from '../../repos/billing/index.repo.ts';
import { organisationRepo } from '../../repos/iam/index.repo.ts';
import { usageOf } from './contracts.service.ts';
import { recordEvent, SYSTEM, type BillingDeps } from './deps.service.ts';
import { writeBillingStatus } from './webhook.service.ts';

const BATCH = 200;

export interface SweepCounts {
  lapsed: number;
  upcoming: number;
  overdue: number;
  overageReported: number;
  siloInvoices: number;
  seatCounts: number;
}

export function createSweeps(deps: BillingDeps & { contracts: ContractsConfig }, now: () => Date = () => new Date()) {
  const control = deps.databases.pool('control');
  const notice = deps.contracts.renewalNoticeDays;
  const siloCharges = createSiloCharges(deps);
  const seatSync = createSeatSync(deps);

  async function renewals(correlationId: string, counts: SweepCounts): Promise<void> {
    const today = now().toISOString().slice(0, 10);
    const due = await inTransaction(control, {}, (db) => contractRepo.toAdvance(db, today, notice, BATCH), { readOnly: true });
    for (const { organisationId, id } of due) {
      await inTransaction(control, { organisationId }, async (db) => {
        const moved = await contractRepo.advanceRenewal(db, id, today, notice);
        if (moved === 'lapsed') {
          counts.lapsed += 1;
          await recordEvent(db, {
            organisationId, correlationId, event: 'contract_lapsed', actor: SYSTEM, resource: { type: 'contract', id }, detail: { on: today },
          });
        } else if (moved === 'upcoming') counts.upcoming += 1;
      });
    }
  }

  async function overdue(correlationId: string, counts: SweepCounts): Promise<void> {
    const today = now().toISOString().slice(0, 10);
    const due = await inTransaction(control, {}, (db) => invoiceRepo.pastDue(db, today, BATCH), { readOnly: true });
    for (const { organisationId, id } of due) {
      await inTransaction(control, { organisationId }, async (db) => {
        const status = await organisationRepo.lockBillingStatus(db, organisationId);
        const invoice = await invoiceRepo.lockById(db, id);
        if (status === undefined || invoice === undefined || invoice.status !== 'open' || invoice.dueDate >= today) return;
        await invoiceRepo.update(db, id, { status: 'overdue' });
        counts.overdue += 1;
        if (status === 'active') {
          await writeBillingStatus(db, organisationId, status, 'past_due', correlationId, { source: 'overdue_invoice', invoice_id: id });
        }
      });
    }
  }

  async function overage(correlationId: string, counts: SweepCounts): Promise<void> {
    let after: string | null = null;
    for (;;) {
      const page = await inTransaction(control, {}, (db) => contractRepo.active(db, BATCH, after), { readOnly: true });
      for (const { organisationId, id } of page) {
        await inTransaction(control, { organisationId }, async (db) => {
          const contract = await contractRepo.findById(db, id);
          if (contract === undefined || contract.status !== 'active') return;
          const usage = await usageOf(db, contract);
          if (usage.overage > Number(contract.overageReportedTokens) && await contractRepo.recordOverage(db, id, usage.overage)) {
            counts.overageReported += 1;
            await recordEvent(db, {
              organisationId, correlationId, event: 'overage_reported', actor: SYSTEM, resource: { type: 'contract', id },
              detail: { tokens_used: usage.tokensUsed, tokens_allocated: usage.tokensAllocatedToDate, overage: usage.overage },
            });
          }
        });
      }
      if (page.length < BATCH) return;
      after = page.at(-1)!.id;
    }
  }

  return {
    async run(correlationId: string): Promise<SweepCounts> {
      const counts: SweepCounts = { lapsed: 0, upcoming: 0, overdue: 0, overageReported: 0, siloInvoices: 0, seatCounts: 0 };
      await renewals(correlationId, counts);
      await overdue(correlationId, counts);
      await overage(correlationId, counts);
      counts.siloInvoices = (await siloCharges.sweep(closedPeriod(now()), correlationId, BATCH)).invoiced;
      counts.seatCounts = await seatSync.sweep(correlationId, BATCH);
      return counts;
    },
  };
}

export type Sweeps = ReturnType<typeof createSweeps>;
