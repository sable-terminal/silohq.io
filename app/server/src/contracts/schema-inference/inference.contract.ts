// schema-inference (catalogue; spec 14.6, 16.3 probe and reconcile): what a source holds, read
// from the live system through connect-runtime and the Silo Agent, never from a record a
// person pasted.
//
// It infers objects, fields, types, identifiers and relationships, each with a confidence
// and the evidence for it. Evidence is counts only: how many records were sampled, how
// many had the field, how many were null, unique or of each type. Record values are read
// into memory to be counted and are never kept, logged or sent to a model (spec 62.2); what
// is kept, in connect.probe_runs, is structure and counts.
//
// Two modes, by the connection's protocol:
// - records (REST, GraphQL): each manifest object is read as a probe. A field of type json
//   is expanded: a probe manifest captures each whole record (or the whole response
//   envelope) in one json field, so the record's own structure is inferred; where the
//   envelope holds the records, the records path and the paging hints are found in it.
//   Typed fields are observed as declared: their null rates and type mismatches, for the
//   builder's reconcile stage (documented against observed; the probe is the source of
//   truth).
// - catalogue (SQL): the manifest declares the ANSI information_schema views as objects
//   (CATALOGUE_OBJECTS); tables become objects, columns fields, primary keys identifiers
//   and foreign keys relationships, all at confidence 1.

import { z } from 'zod';
import { FIELD_TYPES } from '../connect/manifest.contract.ts';
import { defineContract } from '../endpoint.contract.ts';

const name = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const confidence = z.number().min(0).max(1);
const count = z.number().int().min(0);

export const inferredField = z.object({
  name,
  /** Where the field sits in the record: a dot path (REST, GraphQL) or the column (SQL). */
  path: z.string().min(1).max(500),
  type: z.enum(FIELD_TYPES),
  nullable: z.boolean(),
  /** A detected string format: date, date-time, uuid, email, uri, decimal. Never a value. */
  format: z.string().max(40).nullable(),
  confidence,
  evidence: z.object({
    sampled: count,
    present: count,
    nulls: count,
    distinct: count,
    /** Records whose value had each type. */
    types: z.record(z.string(), count),
  }),
});
export type InferredField = z.infer<typeof inferredField>;

export const inferredRelationship = z.object({
  field: name,
  targetObject: name,
  targetField: name,
  kind: z.enum(['foreign_key', 'reference', 'parent']),
  confidence,
  /** Counts only: values of the field checked, and how many matched the target's identifiers. */
  evidence: z.object({ declared: z.boolean(), checked: count, matched: count }),
});
export type InferredRelationship = z.infer<typeof inferredRelationship>;

export const pagingHint = z.object({
  style: z.enum(['cursor', 'next_url', 'page', 'offset']),
  /** Where the cursor, next link or page count sits in the envelope: a dot path. */
  path: z.string().max(200),
  confidence,
});
export type PagingHint = z.infer<typeof pagingHint>;

export const inferredObject = z.object({
  name,
  /** The manifest object it was read through. */
  object: name,
  /** REST and GraphQL: where the records sit in the response, as a JSONata path; "$" for the body itself. */
  recordsPath: z.string().max(200).nullable(),
  /** SQL: the table. */
  table: z.object({ schema: z.string().max(128).nullable(), table: z.string().max(128) }).nullable(),
  sampled: count,
  identifier: z.object({ fields: z.array(name).min(1).max(8), confidence, evidence: z.object({ unique: count, nonNull: count }) }).nullable(),
  fields: z.array(inferredField).max(2_000),
  relationships: z.array(inferredRelationship).max(100),
  paging: z.array(pagingHint).max(10),
  /** Declared fields as observed: what reconcile compares (records mode, typed fields only). */
  declared: z.array(z.object({ field: name, sampled: count, nulls: count })).max(2_000),
  /** Values that did not fit their declared type in this read (the runtime counts them per read). */
  typeMismatches: count,
});
export type InferredObject = z.infer<typeof inferredObject>;

export const inferredSchema = z.object({
  mode: z.enum(['records', 'catalogue']),
  objects: z.array(inferredObject).max(500),
});
export type InferredSchema = z.infer<typeof inferredSchema>;

/** An object the probe could not read, by stage and the source's meaning. Codes only. */
export const probeFailure = z.object({
  object: name,
  code: z.string().max(100),
  meaning: z.string().max(40).nullable(),
});
export type ProbeFailure = z.infer<typeof probeFailure>;

/** The information_schema views a catalogue manifest declares, each as an object of these names. */
export const CATALOGUE_OBJECTS = {
  columns: 'catalogue_columns',
  constraints: 'catalogue_constraints',
  keys: 'catalogue_keys',
  references: 'catalogue_references',
} as const;

export const inferConnection = defineContract({
  service: 'schema-inference', name: 'inferConnection', method: 'POST', path: '/v1/schema-inferences',
  callers: ['gateway', 'connector-builder', 'visual-builder', 'connector-maintenance'],
  // A probe changes nothing at the source; each call is a new probe run.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    connectionId: z.uuid(),
    /** The manifest objects to read; all when absent. */
    objects: z.array(name).min(1).max(100).optional(),
    /** Records read per object (records mode). */
    sampleSize: z.int().min(1).max(500).default(100),
    /**
     * Catalogue mode: the database schemas to read, filtered at the source. Absent: every
     * schema the login can see except information_schema, which may include a database's
     * own system schemas; the builder asks the person which to read.
     */
    schemas: z.array(z.string().min(1).max(128)).min(1).max(50).optional(),
  }),
  response: z.object({
    probeRunId: z.uuid(),
    manifestId: z.uuid(),
    schema: inferredSchema,
    failures: z.array(probeFailure),
  }),
  maxBodyBytes: 8_192,
});
