// The AI FDE (spec 49 to 54): how often the orchestrator looks at its engagements, and the
// model provider's price, so provider cost is measured in pounds on every task (52.6). The
// price is per million tokens of the cell's fde model route; with none set, cost reads 0 and
// margin is unmeasured (open decision 52.6).

import { z } from 'zod';
import { parseSection, read, zPositiveInt, type Env } from './env.config.ts';

const price = z.coerce.number().min(0).max(10_000);

const schema = z.object({
  tickSeconds: zPositiveInt(3_600).default(15),
  inputPerMillion: price.default(0),
  outputPerMillion: price.default(0),
});

export interface FdeConfig {
  tickSeconds: number;
  providerPrice: { inputPerMillion: number; outputPerMillion: number };
}

export function loadFdeConfig(env: Env, problems: string[]): FdeConfig | undefined {
  const parsed = parseSection(schema, {
    tickSeconds: read(env, 'FDE_TICK_SECONDS'),
    inputPerMillion: read(env, 'FDE_PROVIDER_PRICE_INPUT_PER_MILLION'),
    outputPerMillion: read(env, 'FDE_PROVIDER_PRICE_OUTPUT_PER_MILLION'),
  }, {
    tickSeconds: 'FDE_TICK_SECONDS', inputPerMillion: 'FDE_PROVIDER_PRICE_INPUT_PER_MILLION', outputPerMillion: 'FDE_PROVIDER_PRICE_OUTPUT_PER_MILLION',
  }, problems);
  return parsed === undefined ? undefined : {
    tickSeconds: parsed.tickSeconds, providerPrice: { inputPerMillion: parsed.inputPerMillion, outputPerMillion: parsed.outputPerMillion },
  };
}
