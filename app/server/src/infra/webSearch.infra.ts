// Ask's web search (spec 36.7; decision 2026-11-14): Brave Search, one GET per answered
// question with the outside-context query only. Bounded by a timeout and a response size;
// HTTPS unless development allows http; a failure is reported as unavailable, never with
// the provider's text. Results keep a title, the URL and a plain-text snippet.

import { z } from 'zod';
import type { WebSearchConfig } from '../config/webSearch.config.ts';
import { AppError } from '../utils/errors.util.ts';

export interface WebResult { title: string; url: string; snippet: string }

export interface WebSearch {
  search(query: string): Promise<WebResult[]>;
}

const MAX_RESPONSE_BYTES = 1_000_000;

const answer = z.looseObject({
  web: z.looseObject({
    results: z.array(z.looseObject({ title: z.string().max(1000), url: z.url(), description: z.string().max(5000).optional() })).max(50),
  }).optional(),
});

const plain = (text: string): string => text.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim().slice(0, 500);

export function createWebSearch(config: WebSearchConfig): WebSearch {
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== 'https:' && !config.allowHttp) {
    throw new AppError('configuration', 'the web search endpoint must be HTTPS', { code: 'config.web_search' });
  }
  return {
    async search(query) {
      const url = new URL(endpoint);
      url.searchParams.set('q', query);
      url.searchParams.set('count', String(config.results));
      url.searchParams.set('safesearch', 'strict');
      let response: Response;
      try {
        response = await fetch(url, {
          headers: { accept: 'application/json', 'x-subscription-token': config.apiKey }, redirect: 'manual',
          signal: AbortSignal.timeout(config.timeoutMs),
        });
      } catch (error) {
        throw new AppError('upstream', 'the web search could not be reached', { code: 'web_search.unreachable', retryable: true, cause: error });
      }
      if (!response.ok) throw new AppError('upstream', 'the web search refused the query', { code: 'web_search.refused', details: { status: response.status } });
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) throw new AppError('bounds', 'the web search answer is too large', { code: 'web_search.too_large' });
      const parsed = answer.safeParse(JSON.parse(text));
      if (!parsed.success) throw new AppError('upstream', 'the web search answer was not understood', { code: 'web_search.malformed' });
      return (parsed.data.web?.results ?? []).slice(0, config.results)
        .map((r) => ({ title: plain(r.title), url: r.url, snippet: plain(r.description ?? '') }));
    },
  };
}
