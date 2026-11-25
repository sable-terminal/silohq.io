// Text embeddings through the model gateway (decision 2026-11-15; spec 7.4, 62.7): the
// descriptions of the organisation's own ontology elements, and a question to rank them by.
// Metadata only. The gateway screens every text as it screens a prompt (a value pattern is
// refused, never stripped), sends it on the cell's embedding route (a zero-retention Vertex AI
// endpoint in the commercial cells, the self-hosted model in the sovereign one), and records
// the call in platform.model_calls with its counts, never its text.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { usage } from './call.contract.ts';

/** Texts in one request, and the longest one. */
export const MAX_EMBED_TEXTS = 100;
export const MAX_EMBED_TEXT = 4_000;

export const embedTexts = defineContract({
  service: 'model-gateway', name: 'embedTexts', method: 'POST', path: '/v1/embeddings', callers: ['ontology'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    texts: z.array(z.string().min(1).max(MAX_EMBED_TEXT)).min(1).max(MAX_EMBED_TEXTS),
    /** document: a description kept for retrieval; query: what it is retrieved by. */
    task: z.enum(['document', 'query']),
  }),
  response: z.object({
    /** One vector per text, in order, each of the route's dimensions. */
    vectors: z.array(z.array(z.number())),
    model: z.string(),
    route: z.string(),
    usage,
    latencyMs: z.int().min(0),
  }),
  maxBodyBytes: 512 * 1024,
});
