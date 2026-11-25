// resolveRecords: the executor's call on the answering path (spec 23.3 to 23.6, 24.7, 24.8,
// 27.5). Given the rows a plan read from a type's contributing objects, it says which Silo
// object each row is, writes the entity graph as it goes, and merges each object's values
// under field authority, with coverage. The executor (and the state plane, search and the
// rest of the data path) calls it once its reads of a type are complete, re-reads included.
//
// Request
//   objectTypeId, ontologyVersionId   the type and the immutable ontology version the plan
//                                     runs against: its match keys, normalisations,
//                                     contributing objects and mappings are read there.
//   sources[]                         one entry per contributing object read:
//     connectionId, sourceObject      as the version's contributingObjects name them.
//     rows[]                          each row as read: `identifier` is the contributing
//                                     object's identifier field; `values` holds the raw
//                                     source values by property identity id, at least the
//                                     match key properties and every property to merge.
//     unchecked                       true when this contributing object could not be asked
//                                     by identity for the objects it did not return (spec
//                                     23.5): its absences then count as unchecked, never
//                                     as settled.
//   properties                        the property identities to merge; default every one
//                                     present in any row's values.
//
// Resolution (exact only, spec 23.1): each row's match key is the type's match key
// properties, normalised by their declared CEL normalisation and then by every confirmed
// normalisation rule of the type (oldest first), as one composite key. Rows with equal
// keys are one object. A row with an empty key component cannot be resolved and is its own
// object (counted as unkeyed). A single-source type is keyed by its source identifier.
// Identifiers and keys are stored only as keyed hashes; the Silo object id is derived
// (UUIDv5, spec 24.7) on first resolution, recorded, and never recomputed: later key
// changes remap, merges redirect, and a merged id answers with its target.
//
// Response
//   objects[]                         one per resolved object, in first-seen order:
//     siloObjectId                    the object (a redirect target when merged).
//     redirectedFrom                  the ids that were merged into it and that a row of
//                                     this request still resolved through, if any.
//     rows[]                          { source, row }: indexes into sources[] and its rows.
//     absentFrom[]                    contributing objects of the type that returned no row
//                                     for it: the executor re-reads these by identity
//                                     before it trusts the merge (spec 23.5).
//     properties                      by property identity id: { state, value?, from?,
//                                     authorityId? }. state is declared, agreed, only,
//                                     disputed, empty or unchecked; a value is present only
//                                     for declared, agreed and only. A disputed value is
//                                     never averaged, chosen by recency or by a model
//                                     (spec 23.4). `from` is the connection the value came
//                                     from (declared or only).
//   coverage                          spec 23.6: population (objects), decided (declared +
//                                     agreed + only on every merged property), disputed
//                                     (any property disputed), empty (no reading on any
//                                     property), unchecked (any property unchecked, none
//                                     disputed), and byProperty: the same five counts per
//                                     property api name. A figure computed from these
//                                     objects carries this coverage.
//   unkeyed                           rows that could not be resolved by key.
//
// Values in both directions are record values in flight: never logged, cached or stored
// here (spec 24.1). The caller has already applied the person's vocabulary (markings,
// grants, field policies) to what it sends.

import { z } from 'zod';
import { recordValue } from '../../utils/recordValue.util.ts';
import { defineContract } from '../endpoint.contract.ts';

export const VALUE_STATES = ['declared', 'agreed', 'only', 'disputed', 'empty', 'unchecked'] as const;
export type ValueState = (typeof VALUE_STATES)[number];

export const MAX_RESOLVE_ROWS = 5000;

const sourceRows = z.strictObject({
  connectionId: z.uuid(),
  sourceObject: z.string().min(1).max(200),
  rows: recordValue(z.array(z.strictObject({
    identifier: z.union([z.string().min(1).max(1024), z.number()]),
    values: z.record(z.uuid(), z.json()),
  })).max(MAX_RESOLVE_ROWS)),
  unchecked: z.boolean().default(false),
});

const counts = z.object({
  population: z.int().min(0),
  decided: z.int().min(0),
  disputed: z.int().min(0),
  empty: z.int().min(0),
  unchecked: z.int().min(0),
});
export type CoverageCounts = z.infer<typeof counts>;

export const coverage = counts.extend({ byProperty: z.record(z.string(), counts) });
export type Coverage = z.infer<typeof coverage>;

export const mergedValue = z.object({
  state: z.enum(VALUE_STATES),
  value: recordValue(z.json()).optional(),
  from: z.uuid().optional(),
  authorityId: z.uuid().optional(),
});
export type MergedValue = z.infer<typeof mergedValue>;

export const resolvedObject = z.object({
  siloObjectId: z.uuid(),
  redirectedFrom: z.array(z.uuid()),
  rows: z.array(z.object({ source: z.int().min(0), row: z.int().min(0) })),
  absentFrom: z.array(z.object({ connectionId: z.uuid(), sourceObject: z.string() })),
  properties: z.record(z.uuid(), mergedValue),
});
export type ResolvedObject = z.infer<typeof resolvedObject>;

/** The data path: the services that read records and must merge them. */
export const RESOLVERS = ['executor', 'planner', 'state-plane', 'search', 'ask', 'workspace', 'studio', 'simulation', 'actions'] as const;

export const resolveRecords = defineContract({
  service: 'resolution', name: 'resolveRecords', method: 'POST', path: '/v1/resolution/resolve',
  callers: RESOLVERS,
  // Writing the entity graph is idempotent: a row resolves to the same object every time.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    objectTypeId: z.uuid(),
    ontologyVersionId: z.uuid(),
    sources: z.array(sourceRows).min(1).max(20),
    properties: z.array(z.uuid()).max(500).optional(),
  }),
  response: z.object({
    objects: z.array(resolvedObject),
    coverage,
    unkeyed: z.int().min(0),
  }),
  maxBodyBytes: 16 * 1024 * 1024,
});

/**
 * Whether the entity graph contradicts a type's declared disjoint split (spec 27.7): any object
 * bound to live records in more than one of its contributing objects. The planner asks before
 * it lets each system compute its share of an aggregate. Identifiers only, never a value.
 */
export const checkSourcePartition = defineContract({
  service: 'resolution', name: 'checkSourcePartition', method: 'GET', path: '/v1/resolution/object-types/:objectTypeId/source-partition',
  callers: ['planner', 'executor'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ objectTypeId: z.uuid() }),
  response: z.object({ overlapping: z.boolean() }),
});
