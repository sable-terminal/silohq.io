// A Silo as a source (spec 66.5): an Import Silo answers queries through the same path as any
// connector. When its definition is published, siloes-import registers what it holds here: a
// private connector of source route silo, a manifest version generated from the definition
// (SQL objects in the Silo's dataset, transport store silo), and one connection to it, owned
// by the person who published, in the organisation's root scope, active at once: the store
// is Silo's own, so there is no customer system to probe, and nothing is ever written to it.
// The Silo's markings travel to the connection (a copy carries its source's markings, 58.4).
// A definition published again moves the connection to the new version; the same document
// again changes nothing. A whole-Silo wipe halts the connection when it starts, so nothing
// reads what is being removed, and revokes it when the Silo is disabled.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const registerSiloSource = defineContract({
  service: 'connect-registry', name: 'registerSiloSource', method: 'PUT', path: '/v1/silo-sources/:siloId', callers: ['siloes-import'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ siloId: z.uuid() }),
  body: z.strictObject({
    name: z.string().trim().min(1).max(200),
    /** The generated manifest: transport store silo naming this Silo, SQL objects in its dataset. */
    document: z.record(z.string(), z.json()),
    markingIds: z.array(z.uuid()).max(100).default([]),
  }),
  response: z.object({
    connectorId: z.uuid(),
    connectionId: z.uuid(),
    manifestId: z.uuid(),
    version: z.string(),
    /** False when the document was the connection's already. */
    changed: z.boolean(),
  }),
  maxBodyBytes: 512 * 1024,
});

export const retireSiloSource = defineContract({
  service: 'connect-registry', name: 'retireSiloSource', method: 'POST', path: '/v1/silo-sources/:siloId/retirements', callers: ['siloes-capture'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ siloId: z.uuid() }),
  body: z.strictObject({ move: z.enum(['halt', 'revoke']) }),
  /** Null when the Silo never answered as a source. */
  response: z.object({ connectionId: z.uuid().nullable(), status: z.string().nullable() }),
});
