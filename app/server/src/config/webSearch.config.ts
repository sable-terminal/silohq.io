// Ask's web search provider (spec 36.7; decision 2026-11-14): Brave Search, off unless
// configured, and refused in the sovereign build (no UK-resident provider is configured
// there). The API key is a secret: from a file in production, like every other.

import { z } from 'zod';
import { parseSection, read, readSecret, zBool, zPositiveInt, type Env } from './env.config.ts';

export const WEB_SEARCH_PROVIDERS = ['brave'] as const;

const schema = z.object({
  provider: z.enum(WEB_SEARCH_PROVIDERS),
  endpoint: z.url({ protocol: /^https?$/ }).default('https://api.search.brave.com/res/v1/web/search'),
  apiKey: z.string().min(8),
  timeoutMs: zPositiveInt(30_000).default(5_000),
  results: zPositiveInt(10).default(5),
  allowHttp: zBool.default(false),
});

export type WebSearchConfig = z.output<typeof schema>;

export function loadWebSearchConfig(env: Env, problems: string[], sovereign: boolean): WebSearchConfig | undefined {
  const provider = read(env, 'WEB_SEARCH_PROVIDER');
  if (provider === undefined || provider === 'none') return undefined;
  if (sovereign) {
    problems.push('WEB_SEARCH_PROVIDER: web search is off in the sovereign build');
    return undefined;
  }
  return parseSection(schema, {
    provider, endpoint: read(env, 'WEB_SEARCH_ENDPOINT'), apiKey: readSecret(env, 'WEB_SEARCH_API_KEY', problems),
    timeoutMs: read(env, 'WEB_SEARCH_TIMEOUT_MS'), results: read(env, 'WEB_SEARCH_RESULTS'), allowHttp: read(env, 'WEB_SEARCH_ALLOW_HTTP'),
  }, {
    provider: 'WEB_SEARCH_PROVIDER', endpoint: 'WEB_SEARCH_ENDPOINT', apiKey: 'WEB_SEARCH_API_KEY', timeoutMs: 'WEB_SEARCH_TIMEOUT_MS',
    results: 'WEB_SEARCH_RESULTS', allowHttp: 'WEB_SEARCH_ALLOW_HTTP',
  }, problems);
}
