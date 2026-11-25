// Enterprise invoices (spec 74.5, 74.6), on the staff path from the admin portal.
//
// - A contract invoice is Stripe Invoicing without a subscription: its lines, payment terms
//   for bank transfer, the purchase order as a field on the invoice. It is mirrored at once
//   (invoice_raised), and the webhook keeps it current; paid, it settles.
// - Some enterprises pay through their own supplier portal. Such an invoice is recorded
//   manually, with no Stripe identifier, and marked paid by a member of staff holding
//   payment.record: one field (recorded_by with paid_at), one permission and one audit event,
//   payment_recorded_manually, which names who recorded it.
// - Paying the last overdue invoice lifts a past-due status the overdue sweep set (75.3).

import type { raiseContractInvoice, recordManualInvoice } from '../../contracts/billing/contract.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { Invoice } from '../../models/billing/invoice.model.ts';
import { contractRepo, invoiceRepo } from '../../repos/billing/index.repo.ts';
import { organisationRepo } from '../../repos/iam/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { staffOf } from './contracts.service.ts';
import { recordEvent, SYSTEM, type BillingDeps } from './deps.service.ts';
import { settleOverdue, upsertProviderInvoice } from './webhook.service.ts';

type RaiseBody = (typeof raiseContractInvoice)['body']['_output'];
type ManualBody = (typeof recordManualInvoice)['body']['_output'];

export const invoiceViewOf = (i: Invoice) => {
  const { organisationId: _o, updatedAt: _u, ...view } = i;
  return view;
};

/** Pounds as pence, exactly. */
const pence = (pounds: string): number => {
  const [whole, fraction = ''] = pounds.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
};

/** Days until due from payment terms such as "net 30"; 30 when the terms name none. */
export function daysFromTerms(terms: string): number {
  const days = /\bnet\s*(\d{1,3})\b/i.exec(terms)?.[1];
  return days === undefined ? 30 : Math.min(365, Number(days));
}

export function createInvoicing(deps: BillingDeps) {
  const control = deps.databases.pool('control');

  return {
    async raise(ctx: HandlerContext, contractId: string, body: RaiseBody) {
      const operatorId = staffOf(ctx);
      const organisationId = ctx.request.organisationId!;
      if (body.periodEnd < body.periodStart) throw new AppError('validation', 'the period ends after it starts', { code: 'invoice.period_invalid' });
      // The customer is created once, under the contract, before any invoice.
      const { contract, organisationName } = await inTransaction(control, ctx.request, async (db) => {
        const c = await contractRepo.findById(db, contractId);
        if (c === undefined) throw new AppError('not_found', 'no such contract', { code: 'contract.not_found' });
        if (c.status !== 'active' && c.status !== 'expired') throw new AppError('conflict', `a ${c.status} contract is not invoiced`, { code: 'invoice.contract_not_signed' });
        return { contract: c, organisationName: (await organisationRepo.findById(db, organisationId))!.name };
      }, { readOnly: true });
      let customerId = contract.stripeCustomerId;
      if (customerId === null) {
        customerId = (await deps.payments.createCustomer({ organisationId, cellId: deps.config.cell.id, name: organisationName }, `contract-customer:${contractId}`)).id;
        await inTransaction(control, ctx.request, (db) => contractRepo.update(db, contractId, { stripeCustomerId: customerId }));
      }
      const invoice = await deps.payments.createContractInvoice({
        customerId, currency: 'GBP', daysUntilDue: body.daysUntilDue ?? daysFromTerms(contract.paymentTerms),
        lines: body.lines.map((l) => ({ description: l.description, amountMinor: pence(l.amount) })),
        purchaseOrder: body.purchaseOrder ?? contract.purchaseOrderRef ?? undefined,
        periodStart: `${body.periodStart}T00:00:00Z`, periodEnd: `${body.periodEnd}T23:59:59Z`,
        metadata: { organisation_id: organisationId, cell_id: deps.config.cell.id, contract_id: contractId, raised_by: operatorId },
      }, `contract-invoice:${body.requestKey}`);
      return invoiceViewOf(await inTransaction(control, { organisationId }, async (db) => {
        const status = await organisationRepo.lockBillingStatus(db, organisationId);
        return upsertProviderInvoice(db, organisationId, invoice, contractId, status!, ctx.correlationId);
      }));
    },

    async recordManual(ctx: HandlerContext, body: ManualBody) {
      const operatorId = staffOf(ctx);
      const organisationId = ctx.request.organisationId!;
      return invoiceViewOf(await inTransaction(control, ctx.request, async (db) => {
        if (body.contractId !== undefined && await contractRepo.findById(db, body.contractId) === undefined) {
          throw new AppError('not_found', 'no such contract', { code: 'contract.not_found' });
        }
        const row = await invoiceRepo.insert(db, {
          id: uuidv7(), organisationId, stripeInvoiceId: null, manual: true, contractId: body.contractId ?? null, periodCovered: body.periodCovered,
          amount: body.amount, currency: body.currency, terms: body.terms, dueDate: body.dueDate, status: 'open',
          purchaseOrder: body.purchaseOrder ?? null,
        });
        await recordEvent(db, {
          organisationId, correlationId: ctx.correlationId, event: 'invoice_raised', actor: SYSTEM, resource: { type: 'invoice', id: row.id },
          detail: { amount: row.amount, currency: row.currency, period: row.periodCovered, manual: true, operator_id: operatorId },
        });
        return row;
      }));
    },

    async recordPayment(ctx: HandlerContext, invoiceId: string, body: { paidAt?: string | undefined }) {
      const operatorId = staffOf(ctx);
      const organisationId = ctx.request.organisationId!;
      const paidAt = body.paidAt ?? new Date().toISOString();
      if (Date.parse(paidAt) > Date.now() + 60_000) throw new AppError('validation', 'a payment is recorded once it has arrived', { code: 'invoice.paid_in_future' });
      return invoiceViewOf(await inTransaction(control, ctx.request, async (db) => {
        const billingStatus = await organisationRepo.lockBillingStatus(db, organisationId);
        const invoice = await invoiceRepo.lockById(db, invoiceId);
        if (invoice === undefined) throw new AppError('not_found', 'no such invoice', { code: 'invoice.not_found' });
        if (!invoice.manual) {
          throw new AppError('conflict', 'a Stripe invoice is paid in Stripe; its webhook records the payment', { code: 'invoice.not_manual' });
        }
        if (invoice.status !== 'open' && invoice.status !== 'overdue') {
          throw new AppError('conflict', `a ${invoice.status} invoice cannot be marked paid`, { code: 'invoice.not_payable' });
        }
        const paid = (await invoiceRepo.update(db, invoiceId, { status: 'paid', paidAt, recordedBy: operatorId }))!;
        await recordEvent(db, {
          organisationId, correlationId: ctx.correlationId, event: 'payment_recorded_manually', actor: SYSTEM,
          resource: { type: 'invoice', id: invoiceId }, detail: { operator_id: operatorId, amount: paid.amount, currency: paid.currency, paid_at: paidAt },
        });
        await recordEvent(db, {
          organisationId, correlationId: ctx.correlationId, event: 'invoice_paid', actor: SYSTEM, resource: { type: 'invoice', id: invoiceId },
          detail: { amount: paid.amount, currency: paid.currency, manual: true },
        });
        await settleOverdue(db, organisationId, billingStatus!, ctx.correlationId);
        return paid;
      }));
    },
  };
}

export type Invoicing = ReturnType<typeof createInvoicing>;
