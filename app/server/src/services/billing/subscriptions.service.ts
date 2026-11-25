// Self-serve billing (spec 71.3, 72.1, 74.5). Starting a subscription opens the provider's
// hosted checkout for a plan, term and seat count; nothing is written until the verified
// webhook reports the subscription. Changing the plan, seats, payment method or cancelling
// happens in the provider's billing portal, and arrives the same way.

import type { HandlerOutput, ParsedInput } from '../../contracts/endpoint.contract.ts';
import type { readBilling, startCheckout } from '../../contracts/billing/subscription.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { contractRepo, entitlementRepo, invoiceRepo, subscriptionRepo } from '../../repos/billing/index.repo.ts';
import { organisationRepo } from '../../repos/iam/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { requirePermission, type BillingDeps } from './deps.service.ts';
import { priceFor } from './plans.service.ts';

const returnUrl = (deps: BillingDeps, outcome?: string): string =>
  `https://${deps.config.cell.hosts.app}/settings/billing${outcome === undefined ? '' : `?checkout=${outcome}`}`;

export async function start(deps: BillingDeps, ctx: HandlerContext, body: ParsedInput<typeof startCheckout>['body'])
  : Promise<HandlerOutput<typeof startCheckout>> {
  await requirePermission(deps, ctx, 'billing.manage');
  const organisationId = ctx.request.organisationId!;
  const priceId = priceFor(deps.config.payments!, body.plan, body.term);
  if (priceId === undefined) {
    throw new AppError('unavailable', `the ${body.plan} plan is not offered ${body.term} in this cell`, {
      code: 'billing.plan_unavailable', retryable: false, details: { plan: body.plan, term: body.term },
    });
  }
  const { organisation, previous } = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    if (await subscriptionRepo.findLive(db, organisationId) !== undefined) {
      throw new AppError('conflict', 'the organisation already has a subscription; change it in the billing portal', {
        code: 'billing.subscription_live',
      });
    }
    if (await contractRepo.findActive(db, organisationId) !== undefined) {
      throw new AppError('conflict', 'the organisation is on an Enterprise contract', { code: 'billing.contract_active' });
    }
    return { organisation: await organisationRepo.findById(db, organisationId), previous: await subscriptionRepo.findLatest(db, organisationId) };
  }, { readOnly: true });
  if (organisation === undefined) throw new AppError('not_found', 'no such organisation', { code: 'billing.organisation_unknown' });

  // One provider customer per organisation; the key makes a repeated first checkout reuse it.
  const customerId = previous?.stripeCustomerId ?? (await deps.payments.createCustomer(
    { organisationId, cellId: deps.config.cell.id, name: organisation.name }, `customer-${organisationId}`)).id;
  const checkout = await deps.payments.createCheckout({
    customerId, priceId, quantity: body.seats, organisationId, cellId: deps.config.cell.id,
    successUrl: returnUrl(deps, 'complete'), cancelUrl: returnUrl(deps, 'cancelled'),
  }, `checkout-${organisationId}-${ctx.idempotencyKey}`);
  return { checkoutId: checkout.id, checkoutUrl: checkout.url };
}

export async function replayStart(deps: BillingDeps, checkoutId: string | undefined): Promise<HandlerOutput<typeof startCheckout>> {
  if (checkoutId === undefined) throw new AppError('internal', 'the checkout was not recorded', { code: 'billing.replay_missing' });
  const checkout = await deps.payments.getCheckout(checkoutId);
  return { checkoutId: checkout.id, checkoutUrl: checkout.url };
}

export async function portal(deps: BillingDeps, ctx: HandlerContext): Promise<{ portalUrl: string }> {
  await requirePermission(deps, ctx, 'billing.manage');
  const latest = await inTransaction(deps.databases.pool('control'), ctx.request,
    (db) => subscriptionRepo.findLatest(db, ctx.request.organisationId!), { readOnly: true });
  if (latest === undefined) {
    throw new AppError('not_found', 'the organisation has no subscription yet; start one first', { code: 'billing.no_customer' });
  }
  const session = await deps.payments.createPortal({ customerId: latest.stripeCustomerId, returnUrl: returnUrl(deps) });
  return { portalUrl: session.url };
}

export async function read(deps: BillingDeps, ctx: HandlerContext): Promise<HandlerOutput<typeof readBilling>> {
  await requirePermission(deps, ctx, 'billing.view');
  const organisationId = ctx.request.organisationId!;
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const organisation = await organisationRepo.findById(db, organisationId);
    if (organisation === undefined) throw new AppError('not_found', 'no such organisation', { code: 'billing.organisation_unknown' });
    const subscription = await subscriptionRepo.findLive(db, organisationId) ?? await subscriptionRepo.findLatest(db, organisationId);
    const entitlement = await entitlementRepo.findOpen(db, organisationId);
    const invoices = await invoiceRepo.listRecent(db, organisationId, 24);
    return {
      billingStatus: organisation.billingStatus,
      subscription: subscription === undefined ? null : {
        plan: subscription.plan, seatCount: subscription.seatCount, term: subscription.term, discountTier: subscription.discountTier,
        currentPeriodStart: subscription.currentPeriodStart, currentPeriodEnd: subscription.currentPeriodEnd, status: subscription.status,
      },
      entitlement: entitlement === undefined ? null : {
        seats: entitlement.seats, tokensPerSeatPeriod: entitlement.tokensPerSeatPeriod,
        simulationsPerSeatPeriod: entitlement.simulationsPerSeatPeriod, dailyTokenLimit: entitlement.dailyTokenLimit,
        storageIncludedBytes: entitlement.storageIncludedBytes, capabilities: entitlement.capabilities, source: entitlement.source,
        connectionsLimit: entitlement.connectionsLimit ?? null, effectiveFrom: entitlement.effectiveFrom,
      },
      invoices: invoices.map((i) => ({
        id: i.id, periodCovered: i.periodCovered, amount: i.amount, currency: i.currency, status: i.status, dueDate: i.dueDate, paidAt: i.paidAt,
      })),
    };
  }, { readOnly: true });
}
