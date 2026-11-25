// A public document read for the AI builder (spec 16.3 inputs 1 to 3): a specification or
// documentation URL, or a description at a well-known address on a system's base URL. Read
// through the cell's egress like every other outbound call (public addresses only, bounded,
// never with a credential), so a URL a person types reaches only what the cell may reach.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

export const fetchDocument = defineContract({
  service: 'credential', name: 'fetchDocument', method: 'POST', path: '/v1/documents/fetches', callers: ['connector-builder'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ url: z.url({ protocol: /^https?$/ }).max(2_000) }),
  response: z.discriminatedUnion('outcome', [
    z.object({ outcome: z.literal('fetched'), url: z.string(), contentType: z.string(), text: z.string() }),
    /** Not there (404, 410), or not a document Silo reads (too large, not text). */
    z.object({ outcome: z.literal('absent'), status: z.int() }),
  ]),
  maxBodyBytes: 4_096,
});
