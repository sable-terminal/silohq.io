// Auto top-up's purchase (contracts/billing/autoTopup.contract.ts; spec 73.4, 73.8). Metering
// asks only for a membership that opted in, when a charge would otherwise be refused. The
// payment is one paid invoice on the organisation's payment method at the top-up price; then
// metering records the purchase as automatic and credits the membership.
//
// - Bounded per membership and day (BILLING_AUTO_TOPUPS_PER_DAY), counted from the purchases
//   recorded as automatic, so a loop of charges cannot spend without limit.
// - Keyed: the purchase id is derived from the organisation and the caller's request key, and
//   every provider call from it, so a retried charge finds the same payment and credits once.

import { creditPurchase } from '../../contracts/metering/purchase.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { purchaseRepo, subscriptionRepo } from '../../repos/billing/index.repo.ts';
import { membershipRepo } from '../../repos/iam/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import type { BillingDeps } from './deps.service.ts';
import { majorAmount, TOKEN_TOPUP_PENCE_PER_HUNDRED } from './plans.service.ts';
import { purchaseIdFor } from './purchases.service.ts';

export async function autoTopUp(deps: BillingDeps & { autoTopupsPerDay: number }, ctx: HandlerContext,
  body: { membershipId: string; tokens: number; requestKey: string }) {
  const organisationId = ctx.request.organisationId!;
  const purchaseId = purchaseIdFor(organisationId, `auto:${body.requestKey}`);
  const dayStart = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').toISOString();
  const { customerId, already } = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const member = await membershipRepo.findById(db, body.membershipId);
    if (member === undefined || member.status !== 'active') {
      throw new AppError('not_found', 'the member is not an active member of this organisation', { code: 'billing.beneficiary_unknown' });
    }
    const found = await purchaseRepo.findById(db, purchaseId);
    if (found === undefined && await purchaseRepo.countAutoTopups(db, body.membershipId, dayStart) >= deps.autoTopupsPerDay) {
      throw new AppError('bounds', `auto top-up has bought tokens ${deps.autoTopupsPerDay} times today, its daily limit; buy tokens to continue`, {
        code: 'billing.auto_topup_limit', retryable: false, details: { bound: 'auto_topups_per_day', limit: deps.autoTopupsPerDay },
      });
    }
    return { customerId: (await subscriptionRepo.findLive(db, organisationId))?.stripeCustomerId, already: found };
  }, { readOnly: true });
  const amountMinor = (body.tokens / 100) * TOKEN_TOPUP_PENCE_PER_HUNDRED;
  const amount = majorAmount(amountMinor);
  if (already !== undefined) return { purchaseId, tokens: already.quantity, amount: already.amount, currency: already.currency };
  if (customerId === undefined) {
    throw new AppError('conflict', 'auto top-up needs a payment method on file: start a subscription, or buy tokens', { code: 'billing.no_payment_method' });
  }
  const currency = 'GBP';
  const payment = await deps.payments.chargeOnce({
    customerId, amountMinor, currency, description: `${body.tokens} Silo tokens (auto top-up)`,
    metadata: { organisation_id: organisationId, cell_id: deps.config.cell.id, purchase_id: purchaseId, kind: 'auto_topup' },
  }, `purchase-${purchaseId}`);
  if (payment.outcome !== 'paid') {
    throw new AppError('conflict', payment.outcome === 'requires_action'
      ? 'the bank asked to confirm the auto top-up payment; update the payment method in the billing portal'
      : 'the auto top-up payment was declined; nothing was charged. Update the payment method in the billing portal.', {
      code: payment.outcome === 'requires_action' ? 'billing.payment_requires_action' : 'billing.payment_declined', retryable: false,
    });
  }
  await deps.services.call(creditPurchase, {
    body: {
      purchaseId, kind: 'tokens', quantity: body.tokens, amount, currency, purchasedBy: body.membershipId, beneficiaryMembershipId: body.membershipId,
      autoTopup: true, providerInvoiceId: payment.invoiceId,
    },
  }, { request: ctx.request, correlationId: ctx.correlationId });
  return { purchaseId, tokens: body.tokens, amount, currency };
}
