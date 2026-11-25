// The payment provider the billing service uses (spec 74.5): Silo's own platform
// supplier, reached only through src/infra/payments/. Nothing else in the product reads
// it (spec 71.4). Compiled out of the sovereign build with the 'stripe' capability.
//
// Values Fleet delivers:
// - PAYMENTS_API_URL: the provider's API base; a local fake in tests.
// - PAYMENTS_API_KEY, PAYMENTS_WEBHOOK_SECRET: secrets, as NAME or NAME_FILE.
// - PAYMENTS_WEBHOOK_TOLERANCE_SECONDS: how old a signed webhook may be (default 300).
// - PAYMENTS_PRICE_<PLAN>_<TERM>: the provider's price for each self-serve plan and term
//   (PAYMENTS_PRICE_STANDARD_MONTHLY and so on). The discount ladder of spec 72.1 is the
//   price's own volume tiers; Silo records the tier it applied.
// - PAYMENTS_SIMULATION_TOPUP_PENCE: the per-simulation top-up price. Unset until the
//   open decision of spec 73.7 is settled, and simulation purchases are refused until then.

import { z } from 'zod';
import { parseSection, read, readSecret, zPositiveInt, type Env } from './env.config.ts';

export const SELF_SERVE_PLANS = ['standard', 'business'] as const;
export const TERMS = ['monthly', 'annual'] as const;
export type SelfServePlan = (typeof SELF_SERVE_PLANS)[number];
/** The header the provider's webhooks carry their signature in; the gateway forwards it verbatim to billing. */
export const PAYMENT_SIGNATURE_HEADER = 'stripe-signature';
export type Term = (typeof TERMS)[number];

const priceId = z.string().regex(/^[A-Za-z0-9_]{3,255}$/, 'must be a price identifier');

const schema = z.object({
  apiUrl: z.url({ protocol: /^https?$/ }).default('https://api.stripe.com'),
  apiKey: z.string().min(8).optional(),
  webhookSecret: z.string().min(8).optional(),
  webhookToleranceSeconds: zPositiveInt(3600).default(300),
  timeoutMs: zPositiveInt(60_000).default(10_000),
  standardMonthly: priceId.optional(),
  standardAnnual: priceId.optional(),
  businessMonthly: priceId.optional(),
  businessAnnual: priceId.optional(),
  simulationTopupPence: zPositiveInt(1_000_000).optional(),
});

export interface PlanPrice {
  plan: SelfServePlan;
  term: Term;
  priceId: string;
}

export interface PaymentsConfig {
  apiUrl: string;
  apiKey: string | undefined;
  webhookSecret: string | undefined;
  webhookToleranceSeconds: number;
  timeoutMs: number;
  /** The configured self-serve prices; a plan and term without one cannot be bought. */
  prices: readonly PlanPrice[];
  simulationTopupPence: number | undefined;
}

export function loadPaymentsConfig(env: Env, problems: string[]): PaymentsConfig | undefined {
  const parsed = parseSection(schema, {
    apiUrl: read(env, 'PAYMENTS_API_URL'),
    apiKey: readSecret(env, 'PAYMENTS_API_KEY', problems),
    webhookSecret: readSecret(env, 'PAYMENTS_WEBHOOK_SECRET', problems),
    webhookToleranceSeconds: read(env, 'PAYMENTS_WEBHOOK_TOLERANCE_SECONDS'),
    timeoutMs: read(env, 'PAYMENTS_TIMEOUT_MS'),
    standardMonthly: read(env, 'PAYMENTS_PRICE_STANDARD_MONTHLY'),
    standardAnnual: read(env, 'PAYMENTS_PRICE_STANDARD_ANNUAL'),
    businessMonthly: read(env, 'PAYMENTS_PRICE_BUSINESS_MONTHLY'),
    businessAnnual: read(env, 'PAYMENTS_PRICE_BUSINESS_ANNUAL'),
    simulationTopupPence: read(env, 'PAYMENTS_SIMULATION_TOPUP_PENCE'),
  }, {
    apiUrl: 'PAYMENTS_API_URL', apiKey: 'PAYMENTS_API_KEY', webhookSecret: 'PAYMENTS_WEBHOOK_SECRET',
    webhookToleranceSeconds: 'PAYMENTS_WEBHOOK_TOLERANCE_SECONDS', timeoutMs: 'PAYMENTS_TIMEOUT_MS',
    standardMonthly: 'PAYMENTS_PRICE_STANDARD_MONTHLY', standardAnnual: 'PAYMENTS_PRICE_STANDARD_ANNUAL',
    businessMonthly: 'PAYMENTS_PRICE_BUSINESS_MONTHLY', businessAnnual: 'PAYMENTS_PRICE_BUSINESS_ANNUAL',
    simulationTopupPence: 'PAYMENTS_SIMULATION_TOPUP_PENCE',
  }, problems);
  if (!parsed) return undefined;
  const prices: PlanPrice[] = [];
  const add = (plan: SelfServePlan, term: Term, id: string | undefined): void => {
    if (id !== undefined) prices.push({ plan, term, priceId: id });
  };
  add('standard', 'monthly', parsed.standardMonthly);
  add('standard', 'annual', parsed.standardAnnual);
  add('business', 'monthly', parsed.businessMonthly);
  add('business', 'annual', parsed.businessAnnual);
  if (new Set(prices.map((p) => p.priceId)).size !== prices.length) {
    problems.push('PAYMENTS_PRICE_*: each plan and term needs its own price');
  }
  return {
    apiUrl: parsed.apiUrl.replace(/\/+$/, ''),
    apiKey: parsed.apiKey,
    webhookSecret: parsed.webhookSecret,
    webhookToleranceSeconds: parsed.webhookToleranceSeconds,
    timeoutMs: parsed.timeoutMs,
    prices,
    simulationTopupPence: parsed.simulationTopupPence,
  };
}
