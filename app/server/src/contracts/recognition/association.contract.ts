// Association analysis, outcomes and investigation (spec 38.6, 38.8).
//
// Association analysis states co-occurrence over named populations, always with the sample
// size: the objects a detector's current findings name, or the objects a designated outcome
// holds for. Temporal order where timestamps permit ("precedes in N of M instances"), and
// structural direction where a link type joins two types ("is linked through"). The language
// is fixed and never causal: "occurs together with", "precedes in N of M instances", "is
// linked through". Each computation records the set it replaced.
//
// An outcome of interest is a yes/no property of a type, or a finding kind (a detector) on
// it. Designating one never changes what a detector raises; association analysis reports
// what co-occurs with it under the same rules.
//
// Investigation asks four questions of the estate, each composed from detector output,
// association analysis and federated reads. Without a Capture Silo for the type it answers
// the current part and names what it cannot answer; it never computes a history-dependent
// answer from current state. It never asserts fraud: it reports clusters and repetition in
// the fixed language, and a person decides what they mean.

import { z } from 'zod';
import { apiName } from '../ontology/manifest.contract.ts';
import { defineContract } from '../endpoint.contract.ts';
import { findingView } from './finding.contract.ts';

const detectorKey = z.string().regex(/^[a-z][a-z0-9_]*$/).max(63);

export const outcomeView = z.object({
  id: z.uuid(),
  objectTypeId: z.uuid(),
  /** A yes/no property's API name; null for a finding kind. */
  property: z.string().nullable(),
  /** A detector key (a finding kind); null for a property. */
  detector: z.string().nullable(),
  designatedBy: z.uuid(),
  designatedAt: z.string(),
});
export type OutcomeView = z.infer<typeof outcomeView>;

/** One side of an association: a named population. */
export const populationView = z.object({
  objectTypeId: z.uuid(),
  property: z.string().nullable(),
  detector: z.string().nullable(),
  /** Its name as stated: the detector's or the property's display name. */
  name: z.string(),
  /** A designated outcome of interest. */
  outcome: z.boolean(),
});

export const temporalOrderView = z.object({
  /** Instances where the left population's object was named first. */
  precedes: z.int(),
  /** Instances where the right was first. */
  follows: z.int(),
  /** Instances where neither was seen without the other: the order is not known. */
  unordered: z.int(),
  of: z.int(),
});

export const associationView = z.object({
  id: z.uuid(),
  left: populationView,
  right: populationView,
  /** occurs_together: one type; linked_through: two populations joined by a link type, in its direction. */
  relation: z.enum(['occurs_together', 'linked_through']),
  linkTypeId: z.uuid().nullable(),
  linkDirection: z.enum(['forward', 'reverse']).nullable(),
  coOccurrence: z.int(),
  /** Objects of the left type examined: always stated. */
  sampleSize: z.int(),
  temporalOrder: temporalOrderView.nullable(),
  statement: z.string(),
  computedAt: z.string(),
});
export type AssociationView = z.infer<typeof associationView>;

export const computationView = z.object({
  id: z.uuid(),
  computedAt: z.string(),
  /** The set this one replaced: an earlier set existed. */
  supersedes: z.uuid().nullable(),
});

const CALLERS = ['gateway', 'scheduler', 'fde-orchestrator'] as const;

/** outcome.designate: a yes/no property, or a finding kind, of a type the designator can see. */
export const designateOutcome = defineContract({
  service: 'recognition', name: 'designateOutcome', method: 'POST', path: '/v1/recognition/outcomes', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    objectTypeId: z.uuid(),
    property: apiName.optional(),
    detector: detectorKey.optional(),
  }).refine((b) => (b.property === undefined) !== (b.detector === undefined), 'a property or a detector, one of the two'),
  response: outcomeView,
  status: 201,
  maxBodyBytes: 1024,
});

/** outcome.designate: revoked, never deleted. Associations already computed keep their record. */
export const revokeOutcome = defineContract({
  service: 'recognition', name: 'revokeOutcome', method: 'POST', path: '/v1/recognition/outcomes/:outcomeId/revoke', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ outcomeId: z.uuid() }),
  response: outcomeView.extend({ revokedAt: z.string() }),
});

export const listOutcomes = defineContract({
  service: 'recognition', name: 'listOutcomes', method: 'GET', path: '/v1/recognition/outcomes', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ objectTypeId: z.uuid().optional() }),
  response: z.object({
    outcomes: z.array(outcomeView),
    /** Outcomes on types or properties the reader cannot see: counted, never described. */
    withheld: z.int(),
  }),
});

/**
 * recognition.run: compute the organisation's associations afresh from current findings and
 * designated outcomes. The new set supersedes the last; nothing is deleted.
 */
export const computeAssociations = defineContract({
  service: 'recognition', name: 'computeAssociations', method: 'POST', path: '/v1/recognition/associations/computations', callers: CALLERS,
  shed: 'recognition_run', context: 'organisation', idempotency: 'none',
  response: z.object({
    computation: computationView,
    associations: z.int(),
    /** Populations that could not be read whole (an outcome's values, a link type's pairs): left out, with why. */
    skipped: z.array(z.object({
      kind: z.enum(['outcome', 'link_type']), id: z.uuid(), reason: z.enum(['bounded', 'source_unreachable', 'not_visible', 'retired']),
    })),
  }),
  status: 201,
  timeoutMs: 270_000,
});

export const listAssociations = defineContract({
  service: 'recognition', name: 'listAssociations', method: 'GET', path: '/v1/recognition/associations', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({
    objectTypeId: z.uuid().optional(),
    /** Only what co-occurs with this outcome. */
    outcomeId: z.uuid().optional(),
  }),
  response: z.object({
    computation: computationView.nullable(),
    associations: z.array(associationView),
    /** Associations over what the reader cannot see: counted, never described. */
    withheld: z.int(),
  }),
});

export const QUESTIONS = ['gaps', 'contradictions', 'anomalies', 'clusters'] as const;
export type Question = (typeof QUESTIONS)[number];

export const PART_KINDS = [
  // gaps
  'empty_values', 'unmatched_records', 'single_system', 'open_resolution_proposals', 'became_empty',
  // contradictions
  'disputed_values', 'last_changed_by',
  // anomalies, clusters
  'findings', 'detector_state', 'outcome_association', 'shared_identifier',
] as const;

/** One computed fact, in fixed language: counts, names and moments, never a record value. */
export const answerPart = z.object({
  kind: z.enum(PART_KINDS),
  property: z.string().nullable(),
  detector: z.string().nullable(),
  connectionId: z.uuid().nullable(),
  count: z.int(),
  of: z.int().nullable(),
  /** The earliest moment, for a history part. */
  at: z.string().nullable(),
  statement: z.string(),
});
export type AnswerPart = z.infer<typeof answerPart>;

/** recognition.run: a question of the estate about one object type (38.8). */
export const investigate = defineContract({
  service: 'recognition', name: 'investigate', method: 'POST', path: '/v1/recognition/investigations', callers: ['gateway', 'fde-orchestrator'],
  shed: 'recognition_run', context: 'organisation', idempotency: 'none',
  body: z.strictObject({ question: z.enum(QUESTIONS), objectTypeId: z.uuid() }),
  response: z.object({
    question: z.enum(QUESTIONS),
    objectTypeId: z.uuid(),
    /**
     * held: a Capture Silo holds history of the type that the reader may read; not_held: none
     * does, or Siloes are off; unavailable: Capture could not be asked now.
     */
    history: z.enum(['held', 'not_held', 'unavailable']),
    /** Captured properties the reader may read, where held. */
    capturedProperties: z.array(z.string()),
    /** Objects of the type read for the current part; null when not read. */
    population: z.int().nullable(),
    /** The current part could not be read whole: why, named. */
    incomplete: z.object({ reason: z.enum(['bounded', 'source_unreachable']), detail: z.record(z.string(), z.union([z.string(), z.number()])) }).nullable(),
    /** What current state answers. */
    current: z.array(answerPart),
    /** What captured history answers; empty without it. */
    historical: z.array(answerPart),
    /** What this question cannot answer without Capture, named; empty when history is held. */
    requiresCapture: z.array(z.string()),
    /** The findings it drew on, as the reader may see them. */
    findings: z.array(findingView),
    /** The associations it drew on (clusters: over designated outcomes). */
    associations: z.array(associationView),
    /** Findings or associations left out because the reader cannot see them: counted, never described. */
    withheld: z.int(),
  }),
  maxBodyBytes: 1024,
  timeoutMs: 200_000,
});
