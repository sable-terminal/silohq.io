// Enterprise contracts (spec 74.3 to 74.8): the margin floor calculator's prices and floor,
// and the billing sweeps.
//
// The spec states the calculator's terms but not their prices or the floor, so these are
// this build's defaults, each a setting:
// - BILLING_MARGIN_FLOOR: below this quoted margin a deal needs sign-off under
//   contract.manage (74.4). Default 0.6; spec 74.7 calls a 40% margin a failure.
// - BILLING_COMPILE_PRICE_PER_MILLION_TOKENS: pounds per million model tokens of a compile.
//   Default 1.03, the price that gives spec 74.7's "roughly 84%" Standard margin at 15,000
//   tokens a compile.
// - BILLING_ESTIMATED_TOKENS_PER_COMPILE: used until fifty compiles are logged (74.7), when
//   the measured mean replaces it. Default 15,000 (74.7).
// - BILLING_SIMULATION_UNIT_COST: pounds per simulation run. Default 0.50.
// - BILLING_STORAGE_COST_PER_GIB_MONTH: pounds per GiB-month of included Silo storage, which
//   accrues whether or not it is used. Default 0.02.
// - BILLING_RENEWAL_NOTICE_DAYS: a renewed contract's next renewal becomes upcoming this
//   many days before its term ends. Default 90.
// - BILLING_SWEEP_SECONDS: how often renewals, overdue invoices and overage are swept.
// - BILLING_AUTO_TOPUPS_PER_DAY: the most auto top-ups (73.4) one membership may make in a
//   day, so a runaway loop of charges cannot spend without limit. Default 5 (500 tokens, £100).

import { z } from 'zod';
import { parseSection, read, zPositiveInt, type Env } from './env.config.ts';

const pounds = z.coerce.number().min(0).max(1_000_000);

const schema = z.object({
  marginFloor: z.coerce.number().min(0).max(0.99).default(0.6),
  compilePricePerMillionTokens: pounds.default(1.03),
  estimatedTokensPerCompile: zPositiveInt(1_000_000).default(15_000),
  simulationUnitCost: pounds.default(0.5),
  storageCostPerGibMonth: pounds.default(0.02),
  renewalNoticeDays: zPositiveInt(366).default(90),
  sweepSeconds: zPositiveInt(86_400).default(3_600),
  autoTopupsPerDay: zPositiveInt(100).default(5),
});

export type ContractsConfig = z.output<typeof schema>;

export const CONTRACTS_DEFAULTS: ContractsConfig = schema.parse({});

export function loadContractsConfig(env: Env, problems: string[]): ContractsConfig | undefined {
  return parseSection(schema, {
    marginFloor: read(env, 'BILLING_MARGIN_FLOOR'),
    compilePricePerMillionTokens: read(env, 'BILLING_COMPILE_PRICE_PER_MILLION_TOKENS'),
    estimatedTokensPerCompile: read(env, 'BILLING_ESTIMATED_TOKENS_PER_COMPILE'),
    simulationUnitCost: read(env, 'BILLING_SIMULATION_UNIT_COST'),
    storageCostPerGibMonth: read(env, 'BILLING_STORAGE_COST_PER_GIB_MONTH'),
    renewalNoticeDays: read(env, 'BILLING_RENEWAL_NOTICE_DAYS'),
    sweepSeconds: read(env, 'BILLING_SWEEP_SECONDS'),
    autoTopupsPerDay: read(env, 'BILLING_AUTO_TOPUPS_PER_DAY'),
  }, {
    marginFloor: 'BILLING_MARGIN_FLOOR', compilePricePerMillionTokens: 'BILLING_COMPILE_PRICE_PER_MILLION_TOKENS',
    estimatedTokensPerCompile: 'BILLING_ESTIMATED_TOKENS_PER_COMPILE', simulationUnitCost: 'BILLING_SIMULATION_UNIT_COST',
    storageCostPerGibMonth: 'BILLING_STORAGE_COST_PER_GIB_MONTH', renewalNoticeDays: 'BILLING_RENEWAL_NOTICE_DAYS',
    sweepSeconds: 'BILLING_SWEEP_SECONDS', autoTopupsPerDay: 'BILLING_AUTO_TOPUPS_PER_DAY',
  }, problems);
}
