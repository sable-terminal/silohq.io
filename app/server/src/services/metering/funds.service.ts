// The metering rules that need no database, so they can be tested on their own: token
// weights (spec 73.1), the consumption order (73.4) and simulation units (73.7).

import type { Operation } from '../../contracts/metering/charge.contract.ts';
import type { MeteringSettings } from './deps.service.ts';

/** Spec 73.1, the only definition. A compile is advanced by compile's own rule; metering charges what it is told. */
export const TOKEN_WEIGHTS = {
  compile: 1, advanced_compile: 3, repair_proposal: 2, connector_generation: 6, document_extraction: 6,
} as const satisfies Partial<Record<Operation, number>>;

/** Spec 73.4: 200 tokens on first activation of a membership, outside the allowance. */
export const ONBOARDING_GRANT = 200;

export type Pool = 'tokens' | 'simulations';
export type Source = 'grant' | 'allowance' | 'purchase' | 'contract';

export function poolOf(operation: Operation): Pool {
  return operation === 'simulation' || operation === 'simulation_rerun' ? 'simulations' : 'tokens';
}

/** The weight of an operation, as the ledger's numeric text: whole tokens, or simulations to four places. */
export function weightOf(operation: Operation, settings: MeteringSettings): string {
  if (operation === 'simulation') return '1';
  if (operation === 'simulation_rerun') return settings.simulationRerunWeight;
  return String(TOKEN_WEIGHTS[operation]);
}

// Simulation amounts are numeric(10,4): held here as whole ten-thousandths, so sums never round.
const SCALE = 10_000n;

export function toUnits(text: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,4})\d*)?$/.exec(text.trim());
  if (!match) throw new TypeError('not a non-negative decimal');
  return BigInt(match[1]!) * SCALE + BigInt((match[2] ?? '').padEnd(4, '0'));
}

export function fromUnits(units: bigint): string {
  const whole = units / SCALE;
  const fraction = units % SCALE;
  return fraction === 0n ? whole.toString() : `${whole}.${fraction.toString().padStart(4, '0').replace(/0+$/, '')}`;
}

export interface TokenFunds {
  grant: number;
  /** Undefined when the membership has no allowance this period (no assigned seat). */
  allowance: { remaining: number; dailyRemaining: number } | undefined;
  purchased: number;
}

export type TokenRefusal = 'daily_limit_reached' | 'allowance_exhausted' | 'no_allowance';

/**
 * Spec 73.4: onboarding grant, then the period allowance within the daily limit, then the
 * purchased balance; the first that covers the whole weight pays, so every charge is one
 * ledger row with one source. The daily limit counts allowance use only, so purchased
 * tokens raise the ceiling.
 */
export function chooseTokenSource(funds: TokenFunds, weight: number): { source: Source } | { refused: TokenRefusal } {
  if (funds.grant >= weight) return { source: 'grant' };
  const allowance = funds.allowance;
  if (allowance !== undefined && allowance.remaining >= weight && allowance.dailyRemaining >= weight) return { source: 'allowance' };
  if (funds.purchased >= weight) return { source: 'purchase' };
  if (allowance === undefined) return { refused: 'no_allowance' };
  return { refused: allowance.remaining >= weight ? 'daily_limit_reached' : 'allowance_exhausted' };
}

/** Spec 73.7: the period's simulation allowance, then purchased simulations. Never the token pool. */
export function chooseSimulationSource(
  funds: { allowanceRemaining: bigint | undefined; purchased: bigint }, weight: bigint,
): { source: Source } | { refused: 'allowance_exhausted' | 'no_allowance' } {
  if (funds.allowanceRemaining !== undefined && funds.allowanceRemaining >= weight) return { source: 'allowance' };
  if (funds.purchased >= weight) return { source: 'purchase' };
  return { refused: funds.allowanceRemaining === undefined ? 'no_allowance' : 'allowance_exhausted' };
}

/** The share of a period still to run at a moment: what a mid-period seat's allowance is prorated by (spec 72.2). */
export function remainingFraction(period: { periodStart: string; periodEnd: string }, now: string): number {
  const start = Date.parse(period.periodStart);
  const end = Date.parse(period.periodEnd);
  const at = Date.parse(now);
  if (!(end > start)) return 0;
  return Math.min(1, Math.max(0, (end - at) / (end - start)));
}

/** A prorated allowance, rounded up so a seat assigned at any moment of the period gets its share. */
export function prorate(full: number, fraction: number): number {
  return Math.max(0, Math.min(full, Math.ceil(full * fraction - 1e-9)));
}
