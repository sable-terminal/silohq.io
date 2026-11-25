// Crediting a purchase (spec 73.4, 73.8): the purchase row and the beneficiary's balance in
// one transaction, exactly once per purchase id, with tokens_purchased.

import type { creditPurchase } from '../../contracts/metering/purchase.contract.ts';
import type { HandlerOutput, ParsedInput } from '../../contracts/endpoint.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { purchaseRepo, tokenBalanceRepo } from '../../repos/billing/index.repo.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { recordEvent, type MeteringDeps } from './deps.service.ts';
import { fromUnits, toUnits } from './funds.service.ts';

type Body = ParsedInput<typeof creditPurchase>['body'];

export async function credit(deps: MeteringDeps, ctx: HandlerContext, body: Body): Promise<HandlerOutput<typeof creditPurchase>> {
  const organisationId = ctx.request.organisationId!;
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const recorded = await purchaseRepo.insertIfAbsent(db, {
      id: body.purchaseId, organisationId, kind: body.kind, quantity: body.quantity, amount: body.amount, currency: body.currency,
      purchasedBy: body.purchasedBy, beneficiaryMembershipId: body.beneficiaryMembershipId, autoTopup: body.autoTopup,
      stripeInvoiceId: body.providerInvoiceId ?? null,
    });
    const balance = recorded === undefined
      ? await tokenBalanceRepo.findByMembership(db, body.beneficiaryMembershipId)
      : await tokenBalanceRepo.credit(db, {
        id: uuidv7(), organisationId, membershipId: body.beneficiaryMembershipId,
        tokens: body.kind === 'tokens' ? body.quantity : 0, simulations: body.kind === 'simulations' ? body.quantity : 0,
      });
    if (recorded !== undefined) {
      await recordEvent(db, {
        organisationId, correlationId: ctx.correlationId, event: 'tokens_purchased',
        actor: { kind: 'membership', membershipId: body.purchasedBy },
        subjectMembershipId: body.beneficiaryMembershipId === body.purchasedBy ? null : body.beneficiaryMembershipId,
        resource: { type: 'purchase', id: body.purchaseId },
        detail: { kind: body.kind, quantity: body.quantity, auto_topup: body.autoTopup },
      });
    }
    return {
      purchaseId: body.purchaseId,
      credited: recorded !== undefined,
      balance: {
        purchasedRemaining: balance?.purchasedRemaining ?? 0,
        simulationsPurchasedRemaining: fromUnits(toUnits(balance?.simulationsPurchasedRemaining ?? '0')),
      },
    };
  });
}
