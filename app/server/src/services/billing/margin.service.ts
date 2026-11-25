// The margin floor calculator (spec 74.4): the cost of serving a contract as quoted, and
// the margin at its price. No database, so it can be tested on its own.
//
//   cost = seats x expected compiles x cost per compile
//        + simulations x unit cost
//        + included storage at the provider rate
//        + dedicated capacity + sovereign uplift + support load
//        + AI FDE engagement cost (where onboarding is bundled)
//   margin = (price - cost) / price
//
// Over the whole term. The price is the platform fee (annual, pro rata) plus seats at the
// seat rate (per seat per month). Expected compiles default to every allocated token spent
// on a compile (one token each, spec 73.2), the most a seat can cost; a quote may state
// fewer. Cost per compile is measured from the model call ledger once fifty compiles are
// logged, and estimated before that, with the spec's warning on every quote (74.7). Where
// fifty of them were priced at their routes' own prices (D106), their mean cost is the cost
// per compile; else the mean tokens at the configured price per million.

import type { ContractsConfig } from '../../config/contracts.config.ts';

/** Fifty real compiles settle the cost per compile (74.7). */
export const MEASURED_AFTER = 50;
/** The planning figure of 74.4: roughly £50k per enterprise customer per year, a reference line only. */
export const REFERENCE_ANNUAL_VALUE = 50_000;
export const UNMEASURED_WARNING = 'The calculator is wrong until cost per compile is measured: fewer than fifty compiles are logged (spec 74.7).';

export interface QuotedTerms {
  /** Pounds a year. */
  platformFee: number;
  seatCount: number;
  /** Pounds per seat per month. */
  seatRate: number;
  /** Tokens per seat per month. */
  tokenAllocation: number;
  /** Simulations per seat per month. */
  simulationAllocation: number;
  storageIncludedBytes: number;
  sovereign: boolean;
  fdeOnboardingBundled: boolean;
  termStart: string;
  termEnd: string;
}

/** What the quote states that no unit price covers, in pounds over the term. */
export interface CostLevers {
  expectedCompilesPerSeatMonth?: number | undefined;
  dedicatedCapacity?: number | undefined;
  sovereignUplift?: number | undefined;
  supportLoad?: number | undefined;
  fdeEngagementCost?: number | undefined;
}

export interface CompileSample {
  /** Compiles logged in the cell. */
  logged: number;
  /** Of which sampled for the mean. */
  sampled: number;
  meanTokens: number | null;
  /** Of the sampled, those priced at their route's prices, and their mean cost in pounds. */
  priced?: number | undefined;
  meanCost?: number | null | undefined;
}

export interface Quote {
  termMonths: number;
  price: number;
  cost: { compiles: number; simulations: number; storage: number; dedicated: number; sovereign: number; support: number; fde: number; total: number };
  margin: number;
  floor: number;
  belowFloor: boolean;
  costPerCompile: number;
  measured: boolean;
  /** route_prices: the mean priced cost; measured_tokens: mean tokens at the configured price; estimate: neither yet. */
  costBasis: 'route_prices' | 'measured_tokens' | 'estimate';
  warning: string | null;
  /** The quote's annual value against the planning figure of 74.4. */
  annualValue: number;
  referenceAnnualValue: number;
}

const GIB = 1024 ** 3;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Whole months the term covers, a part month counting as a month (both dates inclusive). */
export function termMonths(termStart: string, termEnd: string): number {
  const start = new Date(`${termStart}T00:00:00Z`);
  const end = new Date(`${termEnd}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  const months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth())
    + (end.getUTCDate() > start.getUTCDate() ? 1 : 0);
  return Math.max(1, months);
}

export function quoteMargin(terms: QuotedTerms, levers: CostLevers, sample: CompileSample,
  config: Pick<ContractsConfig, 'marginFloor' | 'compilePricePerMillionTokens' | 'estimatedTokensPerCompile' | 'simulationUnitCost'
    | 'storageCostPerGibMonth'>): Quote {
  const months = termMonths(terms.termStart, terms.termEnd);
  const priced = (sample.priced ?? 0) >= MEASURED_AFTER && sample.meanCost !== null && sample.meanCost !== undefined;
  const measured = priced || (sample.logged >= MEASURED_AFTER && sample.meanTokens !== null);
  const tokensPerCompile = measured && sample.meanTokens !== null ? sample.meanTokens : config.estimatedTokensPerCompile;
  const costPerCompile = priced ? sample.meanCost! : tokensPerCompile * config.compilePricePerMillionTokens / 1_000_000;
  const compilesPerSeatMonth = levers.expectedCompilesPerSeatMonth ?? terms.tokenAllocation;

  const price = terms.platformFee * months / 12 + terms.seatCount * terms.seatRate * months;
  const compiles = terms.seatCount * compilesPerSeatMonth * months * costPerCompile;
  const simulations = terms.seatCount * terms.simulationAllocation * months * config.simulationUnitCost;
  const storage = terms.storageIncludedBytes / GIB * config.storageCostPerGibMonth * months;
  const dedicated = levers.dedicatedCapacity ?? 0;
  const sovereign = terms.sovereign ? levers.sovereignUplift ?? 0 : 0;
  const support = levers.supportLoad ?? 0;
  const fde = terms.fdeOnboardingBundled ? levers.fdeEngagementCost ?? 0 : 0;
  const total = compiles + simulations + storage + dedicated + sovereign + support + fde;
  const raw = price > 0 ? (price - total) / price : total > 0 ? -1 : 0;
  // The table holds four decimal places in (-10, 10).
  const margin = Math.max(-9.9999, Math.min(0.9999, Math.round(raw * 10_000) / 10_000));

  return {
    termMonths: months,
    price: round2(price),
    cost: {
      compiles: round2(compiles), simulations: round2(simulations), storage: round2(storage), dedicated: round2(dedicated),
      sovereign: round2(sovereign), support: round2(support), fde: round2(fde), total: round2(total),
    },
    margin,
    floor: config.marginFloor,
    belowFloor: margin < config.marginFloor,
    costPerCompile: Math.round(costPerCompile * 1_000_000) / 1_000_000,
    measured,
    costBasis: priced ? 'route_prices' : measured ? 'measured_tokens' : 'estimate',
    warning: measured ? null : UNMEASURED_WARNING,
    annualValue: round2(price * 12 / months),
    referenceAnnualValue: REFERENCE_ANNUAL_VALUE,
  };
}
