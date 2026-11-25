// Keyed hashes for the entity graph (spec 23.3; design: ontology.match_keys): HMAC-SHA-256
// of a source identifier or a normalised match key under the organisation's HMAC key
// (iam.organisation_keys, purpose hmac). The key is a data key wrapped by the cell KEK,
// so only the credential service holds it (spec 61.3, the single mediator); the resolution
// engine sends the values it was handed on the answering path and stores only the hashes.
//
// The values are record values in flight: never logged, never stored, never echoed. The
// purpose is part of the hashed input, so an identifier and a key with the same text never
// collide. The response names the key version used, which the entity graph records with
// each row (match_keys.hmac_key_version_id), so a rotation can re-hash in batches.

import { z } from 'zod';
import { recordValue } from '../../utils/recordValue.util.ts';
import { defineContract } from '../endpoint.contract.ts';

/** cron_result: the digest of a Cron run's whole answer, so "differs from previous" keeps a keyed hash, never the rows (spec 40.3). */
export const ENTITY_HASH_PURPOSES = ['source_identifier', 'match_key', 'cron_result'] as const;
export type EntityHashPurpose = (typeof ENTITY_HASH_PURPOSES)[number];

export const MAX_ENTITY_HASH_VALUES = 5000;

export const hashForEntityGraph = defineContract({
  service: 'credential', name: 'hashForEntityGraph', method: 'POST', path: '/v1/entity-hashes',
  callers: ['resolution', 'scheduler'],
  // A hash changes nothing; the organisation's key is created on first use.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    purpose: z.enum(ENTITY_HASH_PURPOSES),
    values: recordValue(z.array(z.string().max(4096)).min(1).max(MAX_ENTITY_HASH_VALUES)),
  }),
  response: z.object({
    /** The iam.organisation_keys row (purpose hmac) the hashes were made under. */
    keyVersionId: z.uuid(),
    /** Hex, in the order of the values. */
    hashes: z.array(z.string().regex(/^[0-9a-f]{64}$/)),
  }),
  maxBodyBytes: 8 * 1024 * 1024,
});
