// The commercial rules billing applies (spec 71.2, 72.1, 75.1), with no database, so they
// can be tested on their own.

import type { PaymentsConfig, SelfServePlan, Term } from '../../config/payments.config.ts';
import type { ProviderSubscriptionStatus } from '../../infra/payments/payments.infra.ts';
import type { NewEntitlement } from '../../models/billing/entitlement.model.ts';
import type { Subscription } from '../../models/billing/subscription.model.ts';

export type BillingStatus = 'active' | 'past_due' | 'suspended' | 'cancelled';

/**
 * Spec 71.2 per self-serve plan. Storage included per plan is an open decision (74.2);
 * until it is settled none is included, so all Silo storage bills at cost plus 10%.
 *
 * Connections per plan (decision 2026-11-14 amending 71.2, D76): Standard 5 (the core
 * systems: accounts, CRM, operations), Business 15 (the range a small firm runs), Enterprise
 * unlimited. The figures are untested with customers; changing them here is the whole change.
 * Self-serve plans carry neither builder capability: the AI connector builder and the
 * no-code builder are Enterprise only.
 */
export const PLAN_ENTITLEMENTS: Record<SelfServePlan, Pick<NewEntitlement,
  'tokensPerSeatPeriod' | 'simulationsPerSeatPeriod' | 'dailyTokenLimit' | 'storageIncludedBytes' | 'capabilities' | 'connectionsLimit'>> = {
  standard: { tokensPerSeatPeriod: 300, dailyTokenLimit: 20, simulationsPerSeatPeriod: 0, storageIncludedBytes: '0', capabilities: [], connectionsLimit: 5 },
  business: { tokensPerSeatPeriod: 1000, dailyTokenLimit: 40, simulationsPerSeatPeriod: 5, storageIncludedBytes: '0', capabilities: ['sso'], connectionsLimit: 15 },
};

/** Capabilities every Enterprise contract's entitlements carry, whatever else it names (D76). */
export const ENTERPRISE_CAPABILITIES = ['ai_connector_builder', 'nocode_connector_builder'] as const;

/** Spec 72.1: the seat discount ladder. 500 and above is quoted, so not self-serve. */
export function discountTier(seats: number): Subscription['discountTier'] {
  if (seats >= 500) return 'quoted';
  if (seats >= 250) return 'tier_250_499';
  if (seats >= 100) return 'tier_100_249';
  if (seats >= 25) return 'tier_25_99';
  return 'list';
}

export function priceFor(config: PaymentsConfig, plan: SelfServePlan, term: Term): string | undefined {
  return config.prices.find((p) => p.plan === plan && p.term === term)?.priceId;
}

export function planOfPrice(config: PaymentsConfig, priceId: string | undefined): { plan: SelfServePlan; term: Term } | undefined {
  const price = config.prices.find((p) => p.priceId === priceId);
  return price === undefined ? undefined : { plan: price.plan, term: price.term };
}

/**
 * The provider's subscription status as billing status (spec 75.1, 75.3). An unpaid or
 * paused subscription suspends; one not yet paid for (incomplete) is not mirrored at all.
 */
export function billingStatusOf(status: ProviderSubscriptionStatus): BillingStatus | undefined {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
      return 'past_due';
    case 'unpaid':
    case 'paused':
      return 'suspended';
    case 'canceled':
      return 'cancelled';
    default:
      return undefined;
  }
}

/** Top-up is £20 per 100 tokens (spec 73.4), in pence. The seat discount never applies (72.1). */
export const TOKEN_TOPUP_PENCE_PER_HUNDRED = 2_000;

/** YYYY-MM, or YYYY-MM/YYYY-MM for an invoice covering more than one month. */
export function periodCovered(start: string, end: string): string {
  const first = start.slice(0, 7);
  // The end is exclusive: a period ending at midnight on the 1st covers the month before.
  const last = new Date(Date.parse(end) - 1000).toISOString().slice(0, 7);
  return first === last || Date.parse(end) - Date.parse(start) <= 32 * 86_400_000 ? first : `${first}/${last}`;
}

/** Minor units to the two-decimal major amount the tables hold. */
export function majorAmount(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(minor));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
