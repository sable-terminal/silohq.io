// Enterprise contracts, Stripe Invoicing and manual payments (spec 71.3, 74.3 to 74.8),
// reached from the admin portal, which names the member of staff in the request context
// (operatorId, D45): staff work, not break-glass. The customer reads its own contracts and
// their usage through the gateway, without the quote's cost and margin.
//
// The life of a contract:
//   quote → draft (or awaiting margin approval, below the floor) → margin approved by
//   someone other than its author → activated once signed and countersigned: entitlements,
//   seats and the Enterprise plan follow → amended or renewed (each a new entitlement
//   version) → at term end, renewed or lapsed.
// Overage accrues and is reported, never charged (74.3). Invoices live in Stripe, or are
// recorded manually when paid through a supplier portal (74.6).

import { z } from 'zod';
import { contractSchema } from '../../schemas/billing/contract.schema.ts';
import { invoiceSchema } from '../../schemas/billing/invoice.schema.ts';
import { defineContract } from '../endpoint.contract.ts';

export const CONTRACT_CAPABILITIES = ['sso', 'scim', 'custom_roles', 'dedicated', 'sovereign'] as const;

const pounds = (digits: number) => z.string().regex(new RegExp(`^\\d{1,${digits}}(?:\\.\\d{1,2})?$`), 'pounds, up to two decimal places');
const perSeatMonth = z.int().min(0).max(2_147_483_647);

export const contractTerms = z.strictObject({
  /** Pounds a year. */
  platformFee: pounds(12),
  seatCount: z.int().min(1).max(1_000_000),
  /** Pounds per seat per month. */
  seatRate: pounds(8),
  /** Tokens per seat per month (73.3). */
  tokenAllocation: perSeatMonth,
  dailyTokenLimit: perSeatMonth,
  /** Simulations per seat per month (73.7). */
  simulationAllocation: perSeatMonth,
  storageIncludedBytes: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  /** Distinct live objects the organisation may hold at once (9.5, 30.5: contractual on Enterprise); null keeps the cell's default. */
  liveObjectsLimit: z.int().min(1).max(100_000_000).nullable().default(null),
  /** Margin over provider cost for Silo storage above what is included, as a fraction (0.1 is 10%). */
  storageRate: z.string().regex(/^\d(?:\.\d{1,4})?$/, 'a fraction with up to four decimal places').default('0.1'),
  capabilities: z.array(z.enum(CONTRACT_CAPABILITIES)).max(CONTRACT_CAPABILITIES.length).default([]),
  sovereign: z.boolean().default(false),
  fdeOnboardingBundled: z.boolean().default(false),
  termStart: z.iso.date(),
  termEnd: z.iso.date(),
  paymentTerms: z.string().trim().min(1).max(100),
  purchaseOrderRef: z.string().trim().min(1).max(100).optional(),
}).refine((t) => t.termEnd > t.termStart, { message: 'the term ends after it starts', path: ['termEnd'] });

/** What the quote states that no unit price covers: pounds over the whole term, or a compile count. */
export const costLevers = z.strictObject({
  expectedCompilesPerSeatMonth: z.int().min(0).max(1_000_000).optional(),
  dedicatedCapacity: z.number().min(0).max(100_000_000).optional(),
  sovereignUplift: z.number().min(0).max(100_000_000).optional(),
  supportLoad: z.number().min(0).max(100_000_000).optional(),
  fdeEngagementCost: z.number().min(0).max(100_000_000).optional(),
}).default({});

export const quoteView = z.object({
  termMonths: z.int(),
  price: z.number(),
  cost: z.object({
    compiles: z.number(), simulations: z.number(), storage: z.number(), dedicated: z.number(), sovereign: z.number(),
    support: z.number(), fde: z.number(), total: z.number(),
  }),
  margin: z.number(),
  floor: z.number(),
  belowFloor: z.boolean(),
  costPerCompile: z.number(),
  measured: z.boolean(),
  /** route_prices: priced at each model route's own prices; measured_tokens: logged tokens at the configured price; estimate. */
  costBasis: z.enum(['route_prices', 'measured_tokens', 'estimate']),
  /** Shown on every quote until fifty compiles are logged (74.7). */
  warning: z.string().nullable(),
  annualValue: z.number(),
  referenceAnnualValue: z.number(),
});
export type QuoteView = z.infer<typeof quoteView>;

/** The staff view: everything, the quote's margin and its sign-off included. */
export const contractView = contractSchema.omit({ organisationId: true, updatedAt: true });
export type ContractView = z.infer<typeof contractView>;

/** The customer's view: its commercial terms, never Silo's cost, margin or staff. */
export const customerContractView = contractSchema.pick({
  id: true, status: true, platformFee: true, seatCount: true, seatRate: true, tokenAllocation: true, dailyTokenLimit: true,
  simulationAllocation: true, storageIncludedBytes: true, storageRate: true, capabilities: true, sovereign: true, termStart: true,
  termEnd: true, paymentTerms: true, purchaseOrderRef: true, renewalState: true, signedBy: true, countersignedAt: true,
});

export const invoiceView = invoiceSchema.omit({ organisationId: true, updatedAt: true });

const contractId = z.strictObject({ contractId: z.uuid() });
const version = z.string().regex(/^[1-9]\d{0,18}$/, 'the version you read');
const withQuote = z.object({ contract: contractView, quote: quoteView });
const STAFF = ['admin-portal'] as const;

export const quoteContract = defineContract({
  service: 'billing', name: 'quoteContract', method: 'POST', path: '/v1/contracts/quote', callers: STAFF,
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ terms: contractTerms, levers: costLevers }),
  response: quoteView,
  maxBodyBytes: 8_192,
});

export const createContract = defineContract({
  service: 'billing', name: 'createContract', method: 'POST', path: '/v1/contracts', callers: STAFF,
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ terms: contractTerms, levers: costLevers }),
  response: withQuote,
  status: 201,
  maxBodyBytes: 8_192,
});

export const amendContractDraft = defineContract({
  service: 'billing', name: 'amendContractDraft', method: 'PATCH', path: '/v1/contracts/:contractId', callers: STAFF,
  context: 'organisation', idempotency: 'none',
  params: contractId,
  body: z.strictObject({ version, terms: contractTerms, levers: costLevers }),
  response: withQuote,
  maxBodyBytes: 8_192,
});

export const approveContractMargin = defineContract({
  service: 'billing', name: 'approveContractMargin', method: 'POST', path: '/v1/contracts/:contractId/margin-approval', callers: STAFF,
  context: 'organisation', idempotency: 'none',
  params: contractId,
  body: z.strictObject({ version }),
  response: contractView,
});

export const activateContract = defineContract({
  service: 'billing', name: 'activateContract', method: 'POST', path: '/v1/contracts/:contractId/activate', callers: STAFF,
  context: 'organisation', idempotency: 'none',
  params: contractId,
  /** The customer's signatory; Silo's countersignature is the member of staff activating it. */
  body: z.strictObject({ version, signedBy: z.string().trim().min(1).max(200) }),
  response: contractView,
});

const amendable = z.strictObject({
  platformFee: pounds(12).optional(),
  seatCount: z.int().min(1).max(1_000_000).optional(),
  seatRate: pounds(8).optional(),
  tokenAllocation: perSeatMonth.optional(),
  dailyTokenLimit: perSeatMonth.optional(),
  simulationAllocation: perSeatMonth.optional(),
  storageIncludedBytes: z.int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  liveObjectsLimit: z.int().min(1).max(100_000_000).nullable().optional(),
  storageRate: z.string().regex(/^\d(?:\.\d{1,4})?$/).optional(),
  capabilities: z.array(z.enum(CONTRACT_CAPABILITIES)).max(CONTRACT_CAPABILITIES.length).optional(),
  termEnd: z.iso.date().optional(),
  paymentTerms: z.string().trim().min(1).max(100).optional(),
  purchaseOrderRef: z.string().trim().min(1).max(100).nullable().optional(),
});
export type ContractAmendment = z.infer<typeof amendable>;

export const amendContract = defineContract({
  service: 'billing', name: 'amendContract', method: 'POST', path: '/v1/contracts/:contractId/amend', callers: STAFF,
  context: 'organisation', idempotency: 'none',
  params: contractId,
  body: z.strictObject({ version, changes: amendable, levers: costLevers }),
  response: withQuote,
  maxBodyBytes: 8_192,
});

export const renewContract = defineContract({
  service: 'billing', name: 'renewContract', method: 'POST', path: '/v1/contracts/:contractId/renew', callers: STAFF,
  context: 'organisation', idempotency: 'none',
  params: contractId,
  body: z.strictObject({ version, termEnd: z.iso.date(), changes: amendable.omit({ termEnd: true }).default({}), levers: costLevers }),
  response: withQuote,
  maxBodyBytes: 8_192,
});

export const setContractRenewalState = defineContract({
  service: 'billing', name: 'setContractRenewalState', method: 'POST', path: '/v1/contracts/:contractId/renewal-state', callers: STAFF,
  context: 'organisation', idempotency: 'none',
  params: contractId,
  body: z.strictObject({ version, renewalState: z.enum(['upcoming', 'in_negotiation']) }),
  response: contractView,
});

export const listContracts = defineContract({
  service: 'billing', name: 'listContracts', method: 'GET', path: '/v1/contracts', callers: STAFF,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ limit: z.coerce.number().int().min(1).max(100).default(20) }),
  response: z.object({ contracts: z.array(contractView) }),
});

export const readOwnContracts = defineContract({
  service: 'billing', name: 'readOwnContracts', method: 'GET', path: '/v1/contracts/own', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  response: z.object({ contracts: z.array(customerContractView) }),
});

export const contractUsageView = z.object({
  contractId: z.uuid(),
  termMonths: z.int(),
  monthsElapsed: z.int(),
  tokensUsed: z.int(),
  tokensAllocatedToDate: z.int(),
  tokensAllocatedForTerm: z.int(),
  /** Accrued and reported, never charged (74.3). */
  overage: z.int(),
});

export const contractUsage = defineContract({
  service: 'billing', name: 'contractUsage', method: 'GET', path: '/v1/contracts/:contractId/usage', callers: ['admin-portal', 'gateway'],
  context: 'organisation', idempotency: 'none',
  params: contractId,
  response: contractUsageView,
});

export const raiseContractInvoice = defineContract({
  service: 'billing', name: 'raiseContractInvoice', method: 'POST', path: '/v1/contracts/:contractId/invoices', callers: STAFF,
  // The idempotency key is the provider's: a retried request with the same key is the same invoice.
  context: 'organisation', idempotency: 'none',
  params: contractId,
  body: z.strictObject({
    lines: z.array(z.strictObject({ description: z.string().trim().min(1).max(200), amount: pounds(12) })).min(1).max(20),
    periodStart: z.iso.date(),
    periodEnd: z.iso.date(),
    /** Default: from the contract's payment terms ("net 30"), else 30. */
    daysUntilDue: z.int().min(0).max(365).optional(),
    purchaseOrder: z.string().trim().min(1).max(100).optional(),
    /** The same key raises the same invoice once. */
    requestKey: z.uuid(),
  }),
  response: invoiceView,
  maxBodyBytes: 8_192,
});

export const recordManualInvoice = defineContract({
  service: 'billing', name: 'recordManualInvoice', method: 'POST', path: '/v1/invoices/manual', callers: STAFF,
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    contractId: z.uuid().optional(),
    periodCovered: z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])(\/[0-9]{4}-(0[1-9]|1[0-2]))?$/),
    amount: pounds(12),
    currency: z.string().regex(/^[A-Z]{3}$/).default('GBP'),
    terms: z.string().trim().min(1).max(100),
    dueDate: z.iso.date(),
    purchaseOrder: z.string().trim().min(1).max(100).optional(),
  }),
  response: invoiceView,
  status: 201,
});

export const recordManualPayment = defineContract({
  service: 'billing', name: 'recordManualPayment', method: 'POST', path: '/v1/invoices/:invoiceId/manual-payment', callers: STAFF,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ invoiceId: z.uuid() }),
  /** When the payment arrived through the customer's supplier portal; default now. */
  body: z.strictObject({ paidAt: z.iso.datetime({ offset: true }).optional() }),
  response: invoiceView,
});
