// Findings (spec 38.3, 38.5, 38.7, 38.10, 38.11).
//
// A finding is a stated fact about named objects, produced by one detector in one run. It
// holds the detector and version, the object type and object ids, the property names
// examined, the contributing connections, the computation (statistic, threshold crossed,
// population, sample size), coverage and its markings (from lineage), plus a score within
// its detector, links to other findings about the same objects, and its run. Never a
// record value. A finding is visible only to a viewer who can see its object type and
// every property it names, and who holds every marking on it.
//
// Dispositions: an organisation disposition (finding.disposition) counts toward tuning the
// detector's threshold (38.5); a disposition in a Lens is personal and never does (38.9).
//
// Ranking (38.7): a model reads a summary of the reader's current findings and proposes an
// order. It cannot introduce a finding (a placement naming none is discarded and counted),
// it must cite (an uncited placement is discarded), and what it leaves out stays visible,
// listed as unranked.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const DISPOSITIONS = ['confirmed', 'dismissed', 'deferred'] as const;

export const computationView = z.object({
  /** The statistic's name, e.g. robust_z, fill_rate, group_size, disputed_properties. */
  statistic: z.string(),
  /** The statistic's value for this finding: a computed figure, never a record value. */
  value: z.number(),
  threshold: z.number(),
  /** ge: raised when the value is at least the threshold; le: at most. */
  comparison: z.enum(['ge', 'le']),
  population: z.int(),
  sampleSize: z.int(),
});

export const coverageView = z.object({ decided: z.int(), disputed: z.int(), empty: z.int(), unchecked: z.int() });

export const findingView = z.object({
  id: z.uuid(),
  detector: z.string(),
  detectorVersion: z.string(),
  runId: z.uuid(),
  objectTypeId: z.uuid(),
  /** Silo object ids. */
  objectIds: z.array(z.uuid()),
  /** Property API names examined. */
  properties: z.array(z.string()),
  connectionIds: z.array(z.uuid()),
  markingIds: z.array(z.uuid()),
  computation: computationView,
  coverage: coverageView,
  score: z.number(),
  links: z.array(z.object({ findingId: z.uuid(), sharedObjects: z.int() })),
  orgDisposition: z.enum(DISPOSITIONS).nullable(),
  /** The disposition in the Lens the request named, if any. */
  lensDisposition: z.enum(DISPOSITIONS).nullable(),
  /**
   * Where the organisation turned inference on for findings (D73): the chance a finding of this
   * detector on this type is confirmed rather than dismissed, from the organisation's own
   * dispositions (a uniform prior), with its 95% interval and evidence. Null otherwise. The
   * finding stays a computed fact; this says how often such facts proved useful.
   */
  usefulness: z.object({
    probability: z.number(), interval: z.tuple([z.number(), z.number()]), confirmed: z.int(), dismissed: z.int(), statement: z.string(),
  }).nullable(),
  current: z.boolean(),
  raisedAt: z.string(),
  /** When a later run no longer raised it, or raised it again; null while current. */
  supersededAt: z.string().nullable(),
  /** The finding's version: an organisation disposition names it, so two people deciding at once do not overwrite each other. */
  version: z.int().min(1),
});
export type FindingView = z.infer<typeof findingView>;

// ask: explaining a finding (36.4).
const CALLERS = ['gateway', 'scheduler', 'fde-orchestrator', 'studio', 'canvas-layout', 'ask'] as const;

/**
 * Findings raised after a moment on these object types, as the reader may see them: Home's
 * "new findings on object sets the person follows" (spec 33.7), the types being those of the
 * sets. Current findings only; one dismissed for the organisation is not new to anyone.
 */
export const listFindingsRaisedSince = defineContract({
  service: 'recognition', name: 'listFindingsRaisedSince', method: 'POST', path: '/v1/findings/raised-since', callers: ['workspace'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    since: z.iso.datetime({ offset: true }),
    objectTypeIds: z.array(z.uuid()).min(1).max(50),
    limit: z.int().min(1).max(100).default(20),
  }),
  response: z.object({
    findings: z.array(z.object({ finding: findingView, detectorName: z.string(), objectTypeName: z.string(), objectTypePlural: z.string() })),
    more: z.boolean(),
    /** Findings left out because the reader may not see what they examined (38.11): a count, never which. */
    withheld: z.int(),
  }),
  maxBodyBytes: 4096,
});

export const listFindings = defineContract({
  service: 'recognition', name: 'listFindings', method: 'GET', path: '/v1/recognition/findings', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({
    objectTypeId: z.uuid().optional(),
    detector: z.string().regex(/^[a-z][a-z0-9_]*$/).optional(),
    /** A detector by its id, as a Cron's finding condition names it (40.3). */
    detectorId: z.uuid().optional(),
    /** Superseded findings too. */
    includeSuperseded: z.enum(['true', 'false']).default('false'),
    /** Apply a Lens: its dismissed findings are silenced for its owner (38.9). */
    lensId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  }),
  response: z.object({
    findings: z.array(findingView),
    /** Findings left out because the reader cannot see them. Counted, never described. */
    withheld: z.int(),
    /** Findings silenced by the Lens's dismissals. */
    silenced: z.int(),
  }),
});

export const getFinding = defineContract({
  service: 'recognition', name: 'getFinding', method: 'GET', path: '/v1/recognition/findings/:findingId', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ findingId: z.uuid() }),
  query: z.strictObject({ lensId: z.uuid().optional() }),
  response: findingView,
});

/** The findings panel of an object view or a clone (38.10). */
export const listObjectFindings = defineContract({
  service: 'recognition', name: 'listObjectFindings', method: 'GET', path: '/v1/recognition/object-types/:objectTypeId/objects/:objectId/findings',
  callers: CALLERS, context: 'organisation', idempotency: 'none',
  params: z.strictObject({ objectTypeId: z.uuid(), objectId: z.uuid() }),
  query: z.strictObject({ lensId: z.uuid().optional() }),
  response: z.object({ findings: z.array(findingView), withheld: z.int() }),
});

/** finding.disposition: an organisation disposition, which counts toward tuning (38.5). */
export const dispositionFinding = defineContract({
  service: 'recognition', name: 'dispositionFinding', method: 'POST', path: '/v1/recognition/findings/:findingId/disposition',
  callers: ['gateway'], context: 'organisation', idempotency: 'none',
  params: z.strictObject({ findingId: z.uuid() }),
  body: z.strictObject({ disposition: z.enum(DISPOSITIONS), version: z.int().min(1) }),
  response: z.object({
    finding: findingView,
    /** The threshold movement this disposition caused, if any. */
    tuned: z.object({ from: z.number(), to: z.number() }).nullable(),
  }),
});

export const rankingView = z.object({
  ranked: z.array(z.object({ findingId: z.uuid(), position: z.int(), citation: z.string() })),
  /** Visible findings the model left out, listed below the ranking. */
  unranked: z.array(z.uuid()),
  discarded: z.object({ unknown: z.int(), uncited: z.int(), duplicate: z.int() }),
});

/** recognition.run: a model's proposed order of the reader's current findings (38.7). */
export const rankFindings = defineContract({
  service: 'recognition', name: 'rankFindings', method: 'POST', path: '/v1/recognition/rankings',
  callers: ['gateway', 'fde-orchestrator'], shed: 'recognition_run', context: 'organisation', idempotency: 'none',
  body: z.strictObject({ objectTypeId: z.uuid().optional(), limit: z.int().min(1).max(200).default(50) }),
  response: rankingView,
  maxBodyBytes: 2048,
});
