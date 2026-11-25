// Buying tokens and simulations (spec 73.4, 73.8), under tokens.purchase. The payment is one
// paid invoice on the organisation's payment method; then metering records the purchase and
// credits the beneficiary in one transaction.
//
// The purchase id is derived from the organisation and the request's Idempotency-Key, and
// every provider call is keyed from it. So a retry after any failure (the payment taken but
// the credit not yet made, say) finds the same payment rather than taking a second, and the
// credit, keyed by the purchase id, is made once.

import type { HandlerOutput, ParsedInput } from '../../contracts/endpoint.contract.ts';
import type { purchase } from '../../contracts/billing/purchase.contract.ts';
import { creditPurchase } from '../../contracts/metering/purchase.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { purchaseRepo, subscriptionRepo } from '../../repos/billing/index.repo.ts';
import { membershipRepo } from '../../repos/iam/index.repo.ts';
import { sha256 } from '../../utils/crypto.util.ts';
import { AppError } from '../../utils/errors.util.ts';
import { requirePermission, type BillingDeps } from './deps.service.ts';
import { majorAmount, TOKEN_TOPUP_PENCE_PER_HUNDRED } from './plans.service.ts';

type Body = ParsedInput<typeof purchase>['body'];
type Output = HandlerOutput<typeof purchase>;

/** A stable UUID (version 8, RFC 9562) for one purchase request. */
export function purchaseIdFor(organisationId: string, idempotencyKey: string): string {
  const bytes = sha256(`purchase:${organisationId}:${idempotencyKey}`).subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function priceOf(deps: BillingDeps, body: Body): number {
  if (body.kind === 'tokens') {
    if (body.quantity % 100 !== 0 || body.quantity < 100) {
      throw new AppError('validation', 'tokens are bought in hundreds', { code: 'billing.tokens_in_hundreds' });
    }
    return (body.quantity / 100) * TOKEN_TOPUP_PENCE_PER_HUNDRED;
  }
  const each = deps.config.payments!.simulationTopupPence;
  if (each === undefined) {
    throw new AppError('unavailable', 'simulation top-ups are not priced yet', { code: 'billing.simulation_price_unset', retryable: false });
  }
  if (body.quantity > 1_000) throw new AppError('validation', 'at most 1,000 simulations at once', { code: 'billing.simulations_quantity' });
  return body.quantity * each;
}

export async function buy(deps: BillingDeps, ctx: HandlerContext, body: Body): Promise<Output> {
  await requirePermission(deps, ctx, 'tokens.purchase');
  const organisationId = ctx.request.organisationId!;
  const purchasedBy = ctx.request.membershipId!;
  const beneficiary = body.beneficiaryMembershipId ?? purchasedBy;
  const amountMinor = priceOf(deps, body);
  const purchaseId = purchaseIdFor(organisationId, ctx.idempotencyKey!);

  const customerId = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const member = await membershipRepo.findById(db, beneficiary);
    if (member === undefined || member.status !== 'active') {
      throw new AppError('not_found', 'the beneficiary is not an active member of this organisation', { code: 'billing.beneficiary_unknown' });
    }
    return (await subscriptionRepo.findLive(db, organisationId))?.stripeCustomerId;
  }, { readOnly: true });
  if (customerId === undefined) {
    throw new AppError('conflict', 'the organisation has no payment method on file; start a subscription first', {
      code: 'billing.no_payment_method',
    });
  }

  const currency = 'GBP';
  const payment = await deps.payments.chargeOnce({
    customerId, amountMinor, currency,
    description: body.kind === 'tokens' ? `${body.quantity} Silo tokens` : `${body.quantity} Silo simulations`,
    metadata: { organisation_id: organisationId, cell_id: deps.config.cell.id, purchase_id: purchaseId, kind: 'purchase' },
  }, `purchase-${purchaseId}`);
  if (payment.outcome !== 'paid') {
    throw new AppError('conflict', payment.outcome === 'requires_action'
      ? 'the bank asked to confirm this payment; update the payment method in the billing portal and try again'
      : 'the payment was declined; nothing was charged or credited. Update the payment method in the billing portal.', {
      code: payment.outcome === 'requires_action' ? 'billing.payment_requires_action' : 'billing.payment_declined', retryable: false,
    });
  }

  const amount = majorAmount(amountMinor);
  await deps.services.call(creditPurchase, {
    body: {
      purchaseId, kind: body.kind, quantity: body.quantity, amount, currency, purchasedBy, beneficiaryMembershipId: beneficiary,
      autoTopup: false, providerInvoiceId: payment.invoiceId,
    },
  }, { request: ctx.request, correlationId: ctx.correlationId });
  return { purchaseId, kind: body.kind, quantity: body.quantity, amount, currency };
}

export async function replayBuy(deps: BillingDeps, ctx: HandlerContext, purchaseId: string | undefined): Promise<Output> {
  const row = purchaseId === undefined ? undefined
    : await inTransaction(deps.databases.pool('control'), ctx.request, (db) => purchaseRepo.findById(db, purchaseId), { readOnly: true });
  if (row === undefined || row.kind === 'seats') throw new AppError('internal', 'the purchase was not recorded', { code: 'billing.replay_missing' });
  return { purchaseId: row.id, kind: row.kind, quantity: row.quantity, amount: row.amount, currency: row.currency };
}
