// connect-runtime: the structure of one source object, observed from a live sample (spec 14.6:
// fields and types are derived from live responses; 17.3: drift between a connection and its
// manifest). The protocol engine reads a bounded sample exactly as a read would, the
// credential service placing the secret, and the record values stay in this process. What
// comes back is structure only, per field path: the JSON kinds seen and counts (present,
// null, distinct, date-like) and the mean string length. Never a value.
//
// Only a protocol whose records can be read whole is observable here (REST: a record is a
// JSON object). SQL selects named columns and GraphQL named fields, so for them the answer
// says it is not observable and why; their drift is seen through conformance (and, for SQL,
// catalogue introspection through the agent once the agent exists).

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

/** JSON kinds a value is counted under. A whole number is integer, any other number is number. */
export const OBSERVED_KINDS = ['string', 'integer', 'number', 'boolean', 'object', 'array'] as const;
export type ObservedKind = (typeof OBSERVED_KINDS)[number];

/** Paths are observed to this depth; deeper structure is counted as an object. */
export const OBSERVE_DEPTH = 4;
/** At most this many paths are reported; the rest are counted. */
export const OBSERVE_MAX_PATHS = 500;

export const observedField = z.object({
  /** A dot path into the record, as a manifest field's path names it. */
  path: z.string().max(500),
  /** Records where the path holds a value other than null. */
  present: z.int().min(0),
  /** Records where the path holds null. Records without the path count in neither. */
  nulls: z.int().min(0),
  kinds: z.object(Object.fromEntries(OBSERVED_KINDS.map((k) => [k, z.int().min(0)])) as Record<ObservedKind, z.ZodInt>),
  /** Distinct values among the present ones. */
  distinct: z.int().min(0),
  /** Strings that read as a date (YYYY-MM-DD) and as a date and time (ISO 8601). */
  dateLike: z.int().min(0),
  dateTimeLike: z.int().min(0),
  /** Strings that read as a number. */
  numericStrings: z.int().min(0),
  /** Mean length of the string values, rounded to one decimal; null without strings. */
  meanLength: z.number().min(0).nullable(),
});
export type ObservedField = z.infer<typeof observedField>;

export const observation = z.object({
  object: z.string(),
  protocol: z.string(),
  observable: z.boolean(),
  /** Why not, as a code: protocol:<kind>. */
  reason: z.string().max(100).nullable(),
  /** Records in the sample. */
  records: z.int().min(0),
  fields: z.array(observedField).max(OBSERVE_MAX_PATHS),
  /** Paths beyond OBSERVE_MAX_PATHS, counted and not reported. */
  omittedPaths: z.int().min(0),
});
export type Observation = z.infer<typeof observation>;

export const observeObject = defineContract({
  service: 'connect-runtime', name: 'observeObject', method: 'POST', path: '/v1/observations',
  callers: ['connector-maintenance', 'schema-inference', 'connector-builder', 'visual-builder'],
  // A probe read: it changes nothing at the source.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    connectionId: z.uuid(),
    object: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
    sampleRows: z.int().min(1).max(200).default(50),
  }),
  response: observation,
  maxBodyBytes: 2_048,
});
