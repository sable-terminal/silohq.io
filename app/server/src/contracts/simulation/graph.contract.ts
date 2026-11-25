// The dependency graph (spec 39.2, 39.3, 39.10).
//
// An edge says one object type depends on another, evaluated over a link type: hard (the
// downstream cannot happen without the upstream), soft (it proceeds degraded, at a stated
// delay) or resource (contention; propagation ships last). An edge records its source:
// structure (a link type proposed it; never usable as it stands), history (observed lead
// times, once Capture holds them) or stated (a person supplied it).
//
// No edge is live until a person confirms it (graph.confirm, a membership: never a service
// principal). Every confirmation, revision or retirement increments the organisation's
// graph version and is recorded. The AI FDE may propose; it never confirms.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const EDGE_KINDS = ['hard', 'soft', 'resource'] as const;
export const DURATION_UNITS = ['minutes', 'hours', 'days', 'weeks'] as const;

export const duration = z.strictObject({ value: z.number().min(0).max(100_000), unit: z.enum(DURATION_UNITS) });
export type Duration = z.infer<typeof duration>;

export const edgeView = z.object({
  id: z.uuid(),
  fromObjectTypeId: z.uuid(),
  toObjectTypeId: z.uuid(),
  viaLinkTypeId: z.uuid(),
  kind: z.enum(EDGE_KINDS),
  leadTime: duration.nullable(),
  buffer: duration.nullable(),
  source: z.enum(['structure', 'history', 'stated']),
  status: z.enum(['proposed', 'confirmed', 'retired']),
  confirmedBy: z.uuid().nullable(),
  confirmedAt: z.string().nullable(),
  version: z.int(),
  /** Resource edges (decision 2026-11-14): capacity on the resource, demand on the dependant, consumption per unit. */
  capacity: z.object({
    consumption: z.number(), capacityPropertyId: z.uuid(), demandPropertyId: z.uuid(), period: z.enum(['day', 'week', 'month']),
  }).nullable(),
});
export type EdgeView = z.infer<typeof edgeView>;

export const edgeCapacity = z.strictObject({
  /** Units of the resource one unit of the dependant consumes. */
  consumption: z.number().positive().max(1e12),
  /** A numeric property of the resource (the edge's from type): its capacity per period. */
  capacityPropertyId: z.uuid(),
  /** A numeric property of the dependant (the edge's to type): its units per period. */
  demandPropertyId: z.uuid(),
  period: z.enum(['day', 'week', 'month']),
});

const CALLERS = ['gateway', 'fde-orchestrator'] as const;

/** graph.propose: proposals from the ontology's link types (39.3 structure), never live. */
export const deriveEdges = defineContract({
  service: 'simulation', name: 'deriveEdges', method: 'POST', path: '/v1/simulation/edges/derivations', callers: CALLERS,
  shed: 'simulation', context: 'organisation', idempotency: 'none',
  body: z.strictObject({ linkTypeIds: z.array(z.uuid()).max(200).optional() }),
  response: z.object({ proposed: z.array(edgeView), alreadyPresent: z.int() }),
  maxBodyBytes: 16_384,
});

/** graph.propose: a person states an edge; it is still a proposal until confirmed. */
export const proposeEdge = defineContract({
  service: 'simulation', name: 'proposeEdge', method: 'POST', path: '/v1/simulation/edges', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    fromObjectTypeId: z.uuid(), toObjectTypeId: z.uuid(), viaLinkTypeId: z.uuid(), kind: z.enum(EDGE_KINDS),
    leadTime: duration.optional(), buffer: duration.optional(),
  }),
  response: edgeView,
  status: 201,
});

export const listEdges = defineContract({
  service: 'simulation', name: 'listEdges', method: 'GET', path: '/v1/simulation/edges', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ status: z.enum(['proposed', 'confirmed', 'retired']).optional() }),
  response: z.object({ edges: z.array(edgeView), graphVersion: z.int() }),
});

/** graph.confirm (a membership): the person states the kind and lead time; the edge goes live. */
export const confirmEdge = defineContract({
  // fde-orchestrator applies a person's accepted AI FDE edge proposal, as that person (spec 49.6).
  service: 'simulation', name: 'confirmEdge', method: 'POST', path: '/v1/simulation/edges/:edgeId/confirmation', callers: ['gateway', 'fde-orchestrator'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ edgeId: z.uuid() }),
  body: z.strictObject({
    kind: z.enum(EDGE_KINDS), leadTime: duration, buffer: duration.nullable().default(null), reason: z.string().trim().min(1).max(500),
    version: z.int().min(1),
    /** Resource edges only, and required for them (decision 2026-11-14). */
    capacity: edgeCapacity.optional(),
  }).refine((b) => (b.kind === 'resource') === (b.capacity !== undefined), 'a resource edge states its capacity, and only it'),
  response: z.object({ edge: edgeView, graphVersion: z.int() }),
});

/**
 * graph.propose (39.3, 67.4): an observed lead time for a proposed edge, from the history
 * Siloes Capture holds: for each upstream object's transition of the upstream property, the
 * time to the next transition of the downstream property on each object it links to. The
 * edge is proposed with source history, its lead time the median, its evidence the
 * distribution and the sample size. Fewer observations than the minimum: nothing is proposed,
 * and the answer says how many there are and how many are needed.
 */
export const observeLeadTimes = defineContract({
  service: 'simulation', name: 'observeLeadTimes', method: 'POST', path: '/v1/simulation/edges/:edgeId/observations', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ edgeId: z.uuid() }),
  body: z.strictObject({
    upstreamProperty: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
    downstreamProperty: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
    version: z.int().min(1),
  }),
  response: z.object({
    state: z.enum(['observed', 'building', 'unavailable']),
    have: z.int(),
    need: z.int(),
    /** Seconds, over the observations: never a record value. */
    distribution: z.object({ observations: z.int(), min: z.number(), p10: z.number(), p50: z.number(), p90: z.number(), max: z.number() }).nullable(),
    edge: edgeView,
  }),
});

/** graph.confirm: revise a confirmed edge (a lead time true in March may not be true in September). */
export const reviseEdge = defineContract({
  service: 'simulation', name: 'reviseEdge', method: 'PATCH', path: '/v1/simulation/edges/:edgeId', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ edgeId: z.uuid() }),
  body: z.strictObject({
    kind: z.enum(EDGE_KINDS).optional(), leadTime: duration.optional(), buffer: duration.nullable().optional(),
    reason: z.string().trim().min(1).max(500), version: z.int().min(1),
    capacity: edgeCapacity.optional(),
  }),
  response: z.object({ edge: edgeView, graphVersion: z.int() }),
});

export const retireEdge = defineContract({
  service: 'simulation', name: 'retireEdge', method: 'POST', path: '/v1/simulation/edges/:edgeId/retirement', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ edgeId: z.uuid() }),
  body: z.strictObject({ reason: z.string().trim().min(1).max(500), version: z.int().min(1) }),
  response: z.object({ edge: edgeView, graphVersion: z.int() }),
});
