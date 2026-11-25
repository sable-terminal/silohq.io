// The Estate map (spec 32): the clone model applied to the organisation's systems, from
// metadata the control plane already holds (names, kinds, statuses, counts, timestamps),
// never a record value.
//
// Nodes: Silo Agents, connections, change streams, object types; link types are edges
// between types. Discovered systems, source structure and Siloes join when discovery and
// Siloes exist; the map names what is missing rather than drawing nothing silently.
// Every node answers the four questions of 32.2: what it is, what it links to and why (the
// evidence on each edge), when it last updated, and its size.
//
// Health uses the five visual states under Silo's own rules: a connection is failed when
// halted or revoked, warning when a token refresh failed, stale past its daily check,
// unknown when never probed; an agent is failed when offline or revoked, warning when
// unhealthy, stale when its heartbeat is older than 60 seconds. Trust tier is a label,
// never a state. A node without an owner says so.
//
// Filtered by the viewer's connection grants and markings: what they may not see is absent,
// and the map states that part of the estate is not visible, with no count, because a
// count is a disclosure (32.1). It opens as a graph only when the scope has something a
// person can act on (a connection awaiting credentials or confirmation, a proposed object
// type); otherwise as a list with the graph offered (32.2).

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { CLONE_STATES } from './stateRule.contract.ts';

export const ESTATE_NODE_KINDS = ['agent', 'connection', 'change_stream', 'object_type'] as const;
export const ESTATE_EDGE_KINDS = ['serves', 'streams', 'maps_to', 'link'] as const;

export const estateNode = z.object({
  id: z.uuid(),
  kind: z.enum(ESTATE_NODE_KINDS),
  label: z.string(),
  /** Null where the node has no health of its own. */
  health: z.enum(CLONE_STATES).nullable(),
  /** Why the health is what it is: a closed reason, never a value. */
  healthReason: z.string().nullable(),
  trustTier: z.string().nullable(),
  /** Null: "no owner". */
  ownerMembershipId: z.uuid().nullable(),
  updatedAt: z.string().nullable(),
  size: z.object({ measure: z.enum(['connections_served', 'contributing_connections', 'objects_streamed', 'mapped_properties']), value: z.int() }),
  /** Closed attributes: status, version, kind, state rule presence and the like. */
  attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  /** Whether a person can act here now (approve, supply credentials, confirm). */
  actionable: z.boolean(),
});
export type EstateNode = z.infer<typeof estateNode>;

export const estateEdge = z.object({
  from: z.uuid(),
  to: z.uuid(),
  kind: z.enum(ESTATE_EDGE_KINDS),
  /** Why the edge exists: the agent pool, a declared foreign key, a confirmed mapping, a person's declaration. */
  evidence: z.enum(['agent_pool', 'change_stream', 'confirmed_mapping', 'declared_fk', 'person_declared']),
  /** Proposed edges are drawn dashed and used for nothing until confirmed. */
  confirmed: z.boolean(),
});
export type EstateEdge = z.infer<typeof estateEdge>;

export const estateMap = z.object({
  nodes: z.array(estateNode),
  edges: z.array(estateEdge),
  /** graph only when there is something to act on; list otherwise, with the graph offered. */
  opensAs: z.enum(['graph', 'list']),
  /** Spec 32.1: present when anything was withheld, never with a count. */
  statement: z.string().nullable(),
  /** What the map cannot draw yet, and why. */
  missing: z.array(z.object({ kind: z.enum(['discovered_systems', 'source_structure', 'siloes', 'object_counts', 'change_streams']), reason: z.string() })),
  generatedAt: z.string(),
});
export type EstateMap = z.infer<typeof estateMap>;

const CALLERS = ['gateway', 'fde-orchestrator'] as const;

export const getEstateMap = defineContract({
  service: 'canvas-layout', name: 'getEstateMap', method: 'GET', path: '/v1/estate/map', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  response: estateMap,
});

export const estateSnapshotView = z.object({
  id: z.uuid(),
  takenAt: z.string(),
  discoveryRunId: z.uuid().nullable(),
  /** Per kind and health, as the snapshot's taker saw them. */
  nodeCounts: z.record(z.string(), z.record(z.string(), z.int())),
  edgeCounts: z.record(z.string(), z.int()),
});

/** Daily and after each discovery run (32.4): counts and ids, no values. */
export const takeEstateSnapshot = defineContract({
  service: 'canvas-layout', name: 'takeEstateSnapshot', method: 'POST', path: '/v1/estate/snapshots',
  callers: ['gateway', 'scheduler', 'discovery'], context: 'organisation', idempotency: 'none',
  body: z.strictObject({ discoveryRunId: z.uuid().optional() }),
  response: estateSnapshotView,
  status: 201,
});

export const listEstateSnapshots = defineContract({
  service: 'canvas-layout', name: 'listEstateSnapshots', method: 'GET', path: '/v1/estate/snapshots', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ limit: z.coerce.number().int().min(1).max(100).default(30) }),
  response: z.object({ snapshots: z.array(estateSnapshotView.pick({ id: true, takenAt: true, discoveryRunId: true })) }),
});

/**
 * Two times compared (32.4): what appeared and went, per kind. The one comparison that needs
 * no Capture, because it compares metadata. Only what the viewer may see now is listed,
 * and no counts are given for the rest.
 */
export const compareEstateSnapshots = defineContract({
  service: 'canvas-layout', name: 'compareEstateSnapshots', method: 'GET', path: '/v1/estate/snapshots/compare', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ from: z.uuid(), to: z.uuid() }),
  response: z.object({
    from: z.object({ id: z.uuid(), takenAt: z.string() }),
    to: z.object({ id: z.uuid(), takenAt: z.string() }),
    added: z.record(z.string(), z.array(z.uuid())),
    removed: z.record(z.string(), z.array(z.uuid())),
    statement: z.string().nullable(),
  }),
});
