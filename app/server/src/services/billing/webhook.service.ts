// The payment webhook (spec 74.5, 75.3): verified, then applied.
//
//   provider event → signature verified → tenant from the event's metadata (this cell only)
//   → subscription mirrored → entitlements versioned → billing status written with
//   subscriptions.status mirrored → billing_status_changed → entitlement readers apply the ladder
//
// Subscription events are applied from the provider's current state of the subscription,
// fetched afresh, so events arriving out of order or twice converge on the same rows. Every
// change is compared with the locked rows first: a repeated event writes nothing and raises
// no event. An event for an organisation not in this cell is acknowledged and ignored.

import type { Organisation } from '../../models/iam/organisation.model.ts';
import type { PaymentInvoice, PaymentSubscription } from '../../infra/payments/payments.infra.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import { contractRepo, entitlementRepo, invoiceRepo, seatRepo, subscriptionRepo } from '../../repos/billing/index.repo.ts';
import type { Invoice } from '../../models/billing/invoice.model.ts';
import type { Subscription } from '../../models/billing/subscription.model.ts';
import { organisationRepo } from '../../repos/iam/index.repo.ts';
import { fromDatabaseError } from '../../utils/errors.util.ts';
import { isUuid, uuidv7 } from '../../utils/id.util.ts';
import { recordEvent, SYSTEM, type BillingDeps } from './deps.service.ts';
import {
  billingStatusOf, discountTier, majorAmount, periodCovered, PLAN_ENTITLEMENTS, planOfPrice, type BillingStatus,
} from './plans.service.ts';

export type Outcome = 'applied' | 'ignored';

export async function receive(deps: BillingDeps, payload: string, signature: string, correlationId: string): Promise<Outcome> {
  const event = deps.payments.verifyEvent(payload, signature);
  const log = deps.logger.child({ eventId: event.id });
  if (event.kind === 'subscription') {
    const subscription = await deps.payments.getSubscription(event.subscriptionId);
    return applySubscription(deps, subscription, event.id, correlationId, log);
  }
  if (event.kind === 'invoice') return applyInvoice(deps, event.invoice, correlationId, log);
  return 'ignored';
}

type Log = BillingDeps['logger'];

// The tenant comes from the verified object's metadata, set when Silo created it.
function tenantOf(deps: BillingDeps, metadata: Readonly<Record<string, string>>, log: Log): string | undefined {
  const organisationId = metadata['organisation_id'];
  const cellId = metadata['cell_id'];
  if (organisationId === undefined || !isUuid(organisationId)) {
    log.warn('a payment event names no organisation', { event: 'payment_event.ignored', reason: 'no_organisation' });
    return undefined;
  }
  if (cellId !== undefined && cellId !== deps.config.cell.id) {
    log.debug('a payment event is for another cell', { event: 'payment_event.ignored', reason: 'other_cell' });
    return undefined;
  }
  return organisationId;
}

/** Mirrors the provider's subscription (from its webhook, or as a seat change answered). */
export async function applySubscription(deps: BillingDeps, provider: PaymentSubscription, providerEventId: string, correlationId: string,
  log: Log): Promise<Outcome> {
  const organisationId = tenantOf(deps, provider.metadata, log);
  if (organisationId === undefined) return 'ignored';
  const priced = planOfPrice(deps.config.payments!, provider.priceId);
  if (priced === undefined) {
    log.error('a subscription has a price no plan is configured for', { event: 'payment_event.ignored', reason: 'unknown_price', organisationId });
    return 'ignored';
  }
  const status = billingStatusOf(provider.status);
  if (status === undefined) return 'ignored';

  return inTransaction(deps.databases.pool('control'), { organisationId }, async (db) => {
    const current = await organisationRepo.lockBillingStatus(db, organisationId);
    if (current === undefined) {
      log.warn('a payment event names an organisation not in this cell', { event: 'payment_event.ignored', reason: 'unknown_organisation' });
      return 'ignored';
    }
    const fields = {
      plan: priced.plan, seatCount: Math.max(1, provider.quantity), term: priced.term, discountTier: discountTier(provider.quantity),
      currentPeriodStart: provider.currentPeriodStart, currentPeriodEnd: provider.currentPeriodEnd, status,
      cancelledAt: status === 'cancelled' ? provider.cancelledAt ?? new Date().toISOString() : null,
    } satisfies Partial<Subscription>;

    let mirror = await subscriptionRepo.lockByStripeSubscriptionId(db, provider.id);
    let entitlementChanged = false;
    if (mirror === undefined) {
      // Never mirrored and already ended: nothing to keep.
      if (status === 'cancelled') return 'ignored';
      if (await subscriptionRepo.findLive(db, organisationId) !== undefined) {
        log.error('a second live subscription arrived for an organisation', { event: 'payment_event.ignored', reason: 'second_subscription', organisationId });
        return 'ignored';
      }
      try {
        mirror = await subscriptionRepo.insert(db, {
          id: uuidv7(), organisationId, stripeCustomerId: provider.customerId, stripeSubscriptionId: provider.id, ...fields,
        });
      } catch (error) {
        throw fromDatabaseError(error);
      }
      await recordEvent(db, {
        organisationId, correlationId, event: 'subscription_created', actor: SYSTEM, resource: { type: 'subscription', id: mirror.id },
        detail: { plan: fields.plan, seats: fields.seatCount, term: fields.term, provider_event_id: providerEventId },
      });
      entitlementChanged = true;
    } else {
      const before = mirror;
      const changed = (Object.keys(fields) as (keyof typeof fields)[]).some((key) => {
        const a = before[key];
        const b = fields[key];
        return key.endsWith('At') || key.startsWith('currentPeriod') ? !sameInstant(a as string | null, b as string | null) : a !== b;
      });
      if (changed) mirror = (await subscriptionRepo.update(db, before.id, fields)) ?? before;
      if (before.plan !== fields.plan) {
        await recordEvent(db, {
          organisationId, correlationId, event: 'plan_changed', actor: SYSTEM, resource: { type: 'subscription', id: before.id },
          detail: { from: before.plan, to: fields.plan, seats: fields.seatCount, provider_event_id: providerEventId },
        });
      }
      entitlementChanged = before.plan !== fields.plan || before.seatCount !== fields.seatCount;
    }

    if (entitlementChanged && status !== 'cancelled') {
      await writeEntitlement(db, organisationId, mirror);
      await syncSeats(db, organisationId, mirror, correlationId, log);
    }
    await writeBillingStatus(db, organisationId, current, status, correlationId, { source: 'payment_webhook', provider_event_id: providerEventId });
    return 'applied';
  });
}

/**
 * Purchased seats follow the subscription's count (spec 72.2): seats bought arrive
 * unassigned, billed from purchase; a lower count releases spare seats (unassigned or
 * reclaimed), never one a member occupies. A count below the seats in use is reported.
 */
async function syncSeats(db: Queryable, organisationId: string, subscription: Subscription, correlationId: string, log: BillingDeps['logger'])
  : Promise<void> {
  const live = await seatRepo.liveForSubscription(db, subscription.id);
  if (live.length < subscription.seatCount) {
    const added = subscription.seatCount - live.length;
    for (let n = 0; n < added; n++) await seatRepo.insert(db, { id: uuidv7(), organisationId, subscriptionId: subscription.id, planTier: subscription.plan });
    await recordEvent(db, {
      organisationId, correlationId, event: 'seat_allocated', actor: SYSTEM, resource: { type: 'subscription', id: subscription.id },
      detail: { seats: added, plan_tier: subscription.plan },
    });
  } else if (live.length > subscription.seatCount) {
    const excess = live.length - subscription.seatCount;
    const spare = live.filter((s) => s.status !== 'assigned').slice(0, excess);
    const at = new Date().toISOString();
    for (const s of spare) await seatRepo.update(db, s.id, { status: 'released', releasedAt: at });
    if (spare.length > 0) {
      await recordEvent(db, {
        organisationId, correlationId, event: 'seat_released', actor: SYSTEM, resource: { type: 'subscription', id: subscription.id },
        detail: { seats: spare.length, reason: 'subscription_reduced' },
      });
    }
    if (spare.length < excess) {
      log.warn('the subscription holds fewer seats than are assigned; unassign seats to match', {
        event: 'billing.seats_over_count', organisationId,
      });
    }
  }
}

const sameInstant = (a: string | null, b: string | null): boolean =>
  a === b || (a !== null && b !== null && Date.parse(a) === Date.parse(b));

/**
 * Entitlement rows are never updated in place: close the open one and insert its successor
 * (spec 71.4). While an Enterprise contract is active its entitlements stand: a self-serve
 * subscription in the same organisation changes nothing then.
 */
async function writeEntitlement(db: Queryable, organisationId: string, subscription: Subscription): Promise<void> {
  if (await contractRepo.findActive(db, organisationId) !== undefined) return;
  await entitlementRepo.closeOpen(db, organisationId);
  await entitlementRepo.insertEffectiveNow(db, {
    id: uuidv7(), organisationId, seats: subscription.seatCount, ...PLAN_ENTITLEMENTS[subscription.plan],
    source: 'subscription', subscriptionId: subscription.id, contractId: null,
  });
}

/**
 * Writes billing status and mirrors it on the live subscription, in one transaction, with
 * billing_status_changed naming its source (spec 75.3). Nothing when it is unchanged.
 */
export async function writeBillingStatus(db: Queryable, organisationId: string, current: Organisation['billingStatus'], next: BillingStatus,
  correlationId: string, source: Record<string, string>, actor = SYSTEM): Promise<boolean> {
  if (current === next) return false;
  await organisationRepo.setBillingStatus(db, organisationId, next);
  const live = await subscriptionRepo.findLive(db, organisationId);
  if (live !== undefined && live.status !== next) {
    await subscriptionRepo.update(db, live.id, {
      status: next, ...(next === 'cancelled' ? { cancelledAt: live.cancelledAt ?? new Date().toISOString() } : {}),
    });
  }
  await recordEvent(db, {
    organisationId, correlationId, event: 'billing_status_changed', actor, detail: { from: current, to: next, ...source },
  });
  return true;
}

const INVOICE_STATUS: Record<PaymentInvoice['status'], 'draft' | 'open' | 'paid' | 'void' | 'overdue'> = {
  draft: 'draft', open: 'open', paid: 'paid', void: 'void', uncollectible: 'overdue',
};

async function applyInvoice(deps: BillingDeps, invoice: PaymentInvoice, correlationId: string, log: Log): Promise<Outcome> {
  const metadata = invoice.metadata['organisation_id'] === undefined
    ? { ...await deps.payments.customerMetadata(invoice.customerId), ...invoice.metadata }
    : invoice.metadata;
  const organisationId = tenantOf(deps, metadata, log);
  if (organisationId === undefined) return 'ignored';
  // The table holds billed amounts only; a zero invoice bills nothing.
  if (invoice.amountDue <= 0) return 'ignored';
  const status = INVOICE_STATUS[invoice.status];
  const contractId = metadata['contract_id'] !== undefined && isUuid(metadata['contract_id']) ? metadata['contract_id'] : null;

  return inTransaction(deps.databases.pool('control'), { organisationId }, async (db) => {
    const billingStatus = await organisationRepo.lockBillingStatus(db, organisationId);
    if (billingStatus === undefined) return 'ignored';
    await upsertProviderInvoice(db, organisationId, invoice, contractId, billingStatus, correlationId);
    return 'applied';
  });
}

/**
 * Mirrors one provider invoice, raising invoice_raised and invoice_paid as it moves. An
 * invoice the overdue sweep marked overdue stays overdue while the provider still calls it
 * open. Paid, it may lift a past-due status that overdue invoices caused (75.3). Call with
 * the organisation's billing status locked.
 */
export async function upsertProviderInvoice(db: Queryable, organisationId: string, invoice: PaymentInvoice, contractId: string | null,
  billingStatus: Organisation['billingStatus'], correlationId: string): Promise<Invoice> {
  const mapped = INVOICE_STATUS[invoice.status];
  const existing = await invoiceRepo.lockByStripeInvoiceId(db, invoice.id);
  const status = existing?.status === 'overdue' && mapped === 'open' ? 'overdue' : mapped;
  const fields = {
    periodCovered: periodCovered(invoice.periodStart, invoice.periodEnd),
    amount: majorAmount(invoice.amountDue),
    currency: invoice.currency,
    terms: invoice.collection === 'send_invoice' ? `net ${invoice.daysUntilDue ?? 30}` : 'card, charged automatically',
    dueDate: invoice.dueDate ?? invoice.createdAt.slice(0, 10),
    status,
    paidAt: status === 'paid' ? invoice.paidAt ?? new Date().toISOString() : null,
  };
  const row = existing === undefined
    ? await invoiceRepo.insert(db, { id: uuidv7(), organisationId, stripeInvoiceId: invoice.id, manual: false, contractId, ...fields })
    : await invoiceRepo.update(db, existing.id, fields) ?? existing;
  const was = existing?.status;
  if ((was === undefined || was === 'draft') && (status === 'open' || status === 'paid')) {
    await recordEvent(db, {
      organisationId, correlationId, event: 'invoice_raised', actor: SYSTEM, resource: { type: 'invoice', id: row.id },
      detail: { amount: fields.amount, currency: fields.currency, period: fields.periodCovered },
    });
  }
  if (was !== 'paid' && status === 'paid') {
    await recordEvent(db, {
      organisationId, correlationId, event: 'invoice_paid', actor: SYSTEM, resource: { type: 'invoice', id: row.id },
      detail: { amount: fields.amount, currency: fields.currency },
    });
    await settleOverdue(db, organisationId, billingStatus, correlationId);
  }
  return row;
}

/**
 * Once no invoice is overdue, a past-due status the overdue sweep set lifts (75.3), unless a
 * self-serve subscription is itself past due. Call with the billing status locked.
 */
export async function settleOverdue(db: Queryable, organisationId: string, billingStatus: Organisation['billingStatus'],
  correlationId: string): Promise<boolean> {
  if (billingStatus !== 'past_due' || await invoiceRepo.countOverdue(db) > 0) return false;
  const live = await subscriptionRepo.findLive(db, organisationId);
  if (live !== undefined && live.status === 'past_due') return false;
  return writeBillingStatus(db, organisationId, billingStatus, 'active', correlationId, { source: 'overdue_invoices_paid' });
}
