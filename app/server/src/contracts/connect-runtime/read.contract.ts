// connect-runtime: read one source object for a plan step (spec 14.5). The generic engine
// executes the connection's manifest: authentication through the credential service,
// pushdown, paging, rate limits, retries and error classification. What cannot be pushed
// down is computed after, bounded; a bound is a refusal, never a partial answer.

import { z } from 'zod';
import { planStep, pushdownSplit } from '../connect/step.contract.ts';
import { defineContract } from '../endpoint.contract.ts';

export const readObject = defineContract({
  service: 'connect-runtime', name: 'readObject', method: 'POST', path: '/v1/reads',
  callers: ['executor', 'planner', 'conformance', 'connector-builder', 'schema-inference', 'connector-maintenance', 'change-stream',
    // visual-builder: a draft tried against the live system (spec 16.4).
    'visual-builder',
    // search: federated object search pushes a filter on the title to each source (spec 24.5).
    'state-plane', 'search',
    // resolution: keys and identifiers only, for a type's runs and a proposal's preview (spec 23.2).
    'resolution',
    // actions: the blast radius walk, identifiers of the records that reference a target (spec 43.7).
    'actions',
    // ontology: identifiers and candidate key values, bounded, for inferred links (D75), only where the organisation turned it on.
    'ontology'],
  // A read changes nothing at the source.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    connectionId: z.uuid(),
    /**
     * probe: building and verifying, before the connection is active. change_stream:
     * polling with a watermark (spec 18.1), on an active connection.
     */
    reason: z.enum(['query', 'probe', 'change_stream']),
    step: planStep,
    /**
     * Conformance only (spec 17.2, the error class), with reason probe: the credential
     * service places a wrong value for every field, and no token is refreshed, so the read
     * shows how the source refuses a bad credential.
     */
    invalidCredentials: z.literal(true).optional(),
    /**
     * Conformance only: push down everything the manifest declares. Otherwise pushdown that
     * failed the latest conformance run on this version is computed after the source.
     */
    declaredPushdown: z.literal(true).optional(),
    /**
     * Conformance only, with reason probe: read through this version of the connection's
     * connector instead of the version the connection runs, so a repair is tested before it
     * is applied (spec 17.3: propose, sandbox test, apply).
     */
    manifestId: z.uuid().optional(),
  }),
  response: z.object({
    /** Record values, keyed by field name. */
    rows: z.array(z.record(z.string(), z.json())),
    pushdown: pushdownSplit,
    /** The Import Silo whose store holds these records (66.5), where the connection is a Silo's; null for a customer system. */
    siloId: z.uuid().nullable().default(null),
    stats: z.object({
      pages: z.number().int(),
      sourceRows: z.number().int(),
      /** Values that did not match their declared type and were returned as null. Counts only. */
      typeMismatches: z.number().int(),
      retries: z.number().int(),
    }),
  }),
  maxBodyBytes: 256 * 1024,
});
