// Billing and tokens in the product (spec 71 to 75): the billing page and the provider's
// checkout and portal for billing.view and billing.manage holders, token and simulation
// purchases under tokens.purchase (keyed, so a retried click pays once), a member's own
// allowance, anyone's under billing.view, the token ledger and an engagement's cost.
//
// And the payment provider's webhook (spec 74.5): no session and no browser. The edge
// takes the body as raw bytes and forwards it unparsed with the signature header, and
// billing verifies the signature over exactly those bytes.

import { setAutoTopup as autoTopupSwitch } from '../metering/autoTopup.contract.ts';
import { buySeats as seatPurchase } from '../billing/seats.contract.ts';
import { listSiloCharges as siloCharges } from '../billing/siloCharges.contract.ts';
import { z } from 'zod';
import { PAYMENT_SIGNATURE_HEADER } from '../../config/payments.config.ts';
import { contractUsage, readOwnContracts } from '../billing/contract.contract.ts';
import { MAX_PAYMENT_EVENT_BYTES, receivePaymentEvent } from '../billing/paymentEvent.contract.ts';
import { purchase as buy } from '../billing/purchase.contract.ts';
import { openBillingPortal as portal, readBilling as billing, startCheckout as checkout } from '../billing/subscription.contract.ts';
import { readAllowance as allowance } from '../metering/allowance.contract.ts';
import { engagementCost as cost, listLedger as ledger } from '../metering/ledger.contract.ts';
import { definePublicRoute, webhookBody } from './publicRoute.contract.ts';

/** The organisation's Enterprise contracts as signed: its commercial terms, never Silo's cost or margin (74.3). */
export const readContracts = definePublicRoute({
  name: 'readContracts', method: 'GET', path: '/billing/contracts', session: 'complete',
  permission: { permission: 'billing.view' },
  response: readOwnContracts.response,
  forwards: readOwnContracts,
  call: () => ({}),
  reply: (output) => output,
});

/** Tokens used in the term against the contract's allocation; overage accrues and is reported, never charged (74.3). */
export const readContractUsage = definePublicRoute({
  name: 'readContractUsage', method: 'GET', path: '/billing/contracts/:contractId/usage', session: 'complete',
  permission: { permission: 'billing.view' },
  params: contractUsage.params,
  response: contractUsage.response,
  forwards: contractUsage,
  call: (input) => ({ params: input.params }),
  reply: (output) => output,
});

/** A closed month's Siloes at provider cost plus 10%: each line's provider cost and its 10% (74.1). */
export const listSiloCharges = definePublicRoute({
  name: 'listSiloCharges', method: 'GET', path: '/billing/silo-charges', session: 'complete',
  permission: { permission: 'billing.view' },
  query: siloCharges.query, response: siloCharges.response,
  forwards: siloCharges,
  call: (input) => ({ query: input.query }),
  reply: (output) => output,
});

/** More seats on the self-serve subscription, prorated and invoiced now (72.2). */
export const buySeats = definePublicRoute({
  name: 'buySeats', method: 'POST', path: '/billing/seats', session: 'complete',
  permission: { permission: 'billing.manage' },
  body: seatPurchase.body, response: seatPurchase.response, status: 201,
  forwards: seatPurchase,
  call: (input) => ({ body: input.body }),
  reply: (output) => output,
});

/** A member's auto top-up, on or off: tokens.purchase, since it spends the organisation's money (73.4). */
export const setAutoTopup = definePublicRoute({
  name: 'setAutoTopup', method: 'PUT', path: '/billing/balances/:membershipId/auto-topup', session: 'complete',
  permission: { permission: 'tokens.purchase' },
  params: autoTopupSwitch.params, body: autoTopupSwitch.body, response: autoTopupSwitch.response,
  forwards: autoTopupSwitch,
  call: (input) => ({ params: input.params, body: input.body }),
  reply: (output) => output,
});

export const readBilling = definePublicRoute({
  name: 'readBilling', method: 'GET', path: '/billing', session: 'complete',
  permission: { permission: 'billing.view' },
  response: billing.response,
  forwards: billing,
  call: () => ({}),
  reply: (output) => output,
});

export const startCheckout = definePublicRoute({
  name: 'startCheckout', method: 'POST', path: '/billing/checkout', session: 'complete',
  permission: { permission: 'billing.manage' },
  body: checkout.body,
  response: checkout.response,
  status: 201,
  forwards: checkout,
  call: (input) => ({ body: input.body }),
  reply: (output) => output,
});

export const openBillingPortal = definePublicRoute({
  name: 'openBillingPortal', method: 'POST', path: '/billing/portal', session: 'complete',
  permission: { permission: 'billing.manage' },
  response: portal.response,
  status: 201,
  forwards: portal,
  call: () => ({}),
  reply: (output) => output,
});

export const purchase = definePublicRoute({
  name: 'purchase', method: 'POST', path: '/purchases', session: 'complete',
  permission: { permission: 'tokens.purchase' },
  body: buy.body,
  response: buy.response,
  status: 201,
  forwards: buy,
  call: (input) => ({ body: input.body }),
  reply: (output) => output,
});

export const readOwnAllowance = definePublicRoute({
  name: 'readOwnAllowance', method: 'GET', path: '/allowance', session: 'complete', ownRecords: true,
  response: allowance.response,
  forwards: allowance,
  call: (_input, ctx) => ({ params: { membershipId: ctx.session.membershipId } }),
  reply: (output) => output,
});

export const readMemberAllowance = definePublicRoute({
  name: 'readMemberAllowance', method: 'GET', path: '/members/:membershipId/allowance', session: 'complete',
  permission: { permission: 'billing.view' },
  params: allowance.params,
  response: allowance.response,
  forwards: allowance,
  call: (input) => ({ params: input.params }),
  reply: (output) => output,
});

export const listTokenLedger = definePublicRoute({
  name: 'listTokenLedger', method: 'GET', path: '/token-ledger', session: 'complete',
  permission: { permission: 'billing.view' },
  query: ledger.query,
  response: ledger.response,
  forwards: ledger,
  call: (input) => ({ query: input.query }),
  reply: (output) => output,
});

export const readEngagementCost = definePublicRoute({
  name: 'readEngagementCost', method: 'GET', path: '/engagements/:engagementId/cost', session: 'complete',
  permission: { permission: 'billing.view' },
  params: cost.params,
  response: cost.response,
  forwards: cost,
  call: (input) => ({ params: input.params }),
  reply: (output) => output,
});

export const paymentWebhook = definePublicRoute({
  name: 'paymentWebhook', method: 'POST', path: '/hooks/payments', session: 'none',
  webhook: { signatureHeader: PAYMENT_SIGNATURE_HEADER, maxBytes: MAX_PAYMENT_EVENT_BYTES },
  body: webhookBody,
  response: z.object({ received: z.literal(true) }),
  forwards: receivePaymentEvent,
  call: (input) => ({ body: input.body }),
  // The provider needs only to know it arrived; what billing did with it stays inside.
  reply: () => ({ received: true as const }),
});
