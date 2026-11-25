// The billing endpoints: contracts to the billing services. Nothing here decides anything.

import type { receivePaymentEvent } from '../../contracts/billing/paymentEvent.contract.ts';
import type { purchase } from '../../contracts/billing/purchase.contract.ts';
import type { setBillingStatus } from '../../contracts/billing/staff.contract.ts';
import type { openBillingPortal, readBilling, startCheckout } from '../../contracts/billing/subscription.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { BillingDeps } from '../../services/billing/deps.service.ts';
import * as purchases from '../../services/billing/purchases.service.ts';
import * as staff from '../../services/billing/staff.service.ts';
import * as subscriptions from '../../services/billing/subscriptions.service.ts';
import { receive } from '../../services/billing/webhook.service.ts';

export function billingController(deps: BillingDeps): {
  receivePaymentEvent: RouteHandlers<typeof receivePaymentEvent>;
  startCheckout: RouteHandlers<typeof startCheckout>;
  openBillingPortal: RouteHandlers<typeof openBillingPortal>;
  readBilling: RouteHandlers<typeof readBilling>;
  purchase: RouteHandlers<typeof purchase>;
  setBillingStatus: RouteHandlers<typeof setBillingStatus>;
} {
  return {
    receivePaymentEvent: {
      handle: async (input, ctx) => ({ outcome: await receive(deps, input.body.payload, input.body.signature, ctx.correlationId) }),
    },
    startCheckout: {
      handle: (input, ctx) => subscriptions.start(deps, ctx, input.body),
      resultRef: (output) => output.checkoutId,
      replay: (ref) => subscriptions.replayStart(deps, ref),
    },
    openBillingPortal: { handle: (_input, ctx) => subscriptions.portal(deps, ctx) },
    readBilling: { handle: (_input, ctx) => subscriptions.read(deps, ctx) },
    purchase: {
      handle: (input, ctx) => purchases.buy(deps, ctx, input.body),
      resultRef: (output) => output.purchaseId,
      replay: (ref, ctx) => purchases.replayBuy(deps, ctx, ref),
    },
    setBillingStatus: { handle: (input, ctx) => staff.setStatus(deps, ctx, input.body) },
  };
}
