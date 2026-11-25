// Narrowing a compile vocabulary by description embeddings (decision 2026-11-15): compile asks
// which of the reader's object types a question is most about. ontology embeds the question
// through the model gateway and ranks the types by their own descriptions, their properties'
// and their links' (metadata only), embedding first whatever changed on main.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const rankObjectTypes = defineContract({
  service: 'ontology', name: 'rankObjectTypes', method: 'POST', path: '/v1/ontology/type-rankings', callers: ['compile'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    question: z.string().min(1).max(2_000),
    /** The reader's own types: only these are ranked. */
    objectTypeIds: z.array(z.uuid()).min(1).max(5_000),
    limit: z.int().min(1).max(500),
  }),
  response: z.object({
    ranked: z.array(z.object({ objectTypeId: z.uuid(), score: z.number() })),
    /** Types with nothing embedded (not on main yet): compile keeps them. */
    unembedded: z.array(z.uuid()),
  }),
  maxBodyBytes: 256 * 1024,
});
