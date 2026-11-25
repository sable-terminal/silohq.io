// Lineage (spec 59): a graph of immutable versioned nodes and typed edges recording where
// every value, object, artefact and Action came from, and the markings that flow along it
// (spec 58.6).
//
// Writing is not an endpoint. Spec 59.3: "Every artefact-producing service writes the
// artefact's node and input edges, and its inherited markings, in the transaction that
// creates it. An artefact cannot exist without its lineage." A call to another process
// cannot share that transaction, and an outbox message would let the artefact exist
// before its lineage, so producers call the lineage writer in process
// (services/lineage/writer.service.ts, writeLineage) inside their own transaction.
//
// Node references. A node is (kind, refId, version), unique per organisation; refId is the
// resource's stable id, so direct markings (gov.resource_markings, iam.object_type_markings)
// find every version of a resource:
//   source_field         refId the ontology.property_mappings row (the field map entry),
//                        version the connector manifest version id it was read through
//   connector_version    refId the connector, version its manifest version id
//   connection           refId the connection, version the manifest version id it ran
//   property             refId the ontology.properties row, version its object type version id
//   object_type_version  refId the object type, version the object type version id
//   link_type_version    refId the link type, version the ontology version id it was read in
//   action_type_version  refId the action type, version the action type version id
//   function_version     refId the function, version the CEL source hash
//   object_set           refId the saved object set, version its definition hash
//   view                 refId the saved view, version its compiled manifest hash
//   app_version          refId the app, version the app version id
//   export, ask_prompt, action, receipt, scenario, simulation_result, silo, import_file, finding
//                        refId the resource itself, version '1' unless it has versions
// An edge runs from an input node to the node derived from it (spec 59.2).
//
// Reads (spec 59.4, 59.5): lineage.view shows the lineage of an artefact the reader can
// already see; lineage.read queries the graph across the organisation. Both are bounded by
// depth (default 32) and node count, and refuse with the bound named when exceeded
// (invariant 2). Neither bypasses markings: a node whose markings the reader does not
// satisfy is withheld, counted but never named, and traversal does not pass through it.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const NODE_KINDS = [
  'source_field', 'connector_version', 'connection', 'property', 'object_type_version', 'link_type_version', 'action_type_version',
  'function_version', 'object_set', 'view', 'app_version', 'export', 'ask_prompt', 'action', 'receipt', 'scenario', 'simulation_result',
  'silo', 'import_file', 'finding',
  // A workbook (D232): its exports derive from it and from what its live ranges read.
  'workbook',
  // A report (D233): likewise, from it and what its blocks read.
  'report',
  // A process analysis (D234): from it and the events it mined.
  'process_analysis',
  // A notebook (D239): from it and what its cells read.
  'notebook',
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const RELATIONS = [
  'read_via', 'maps_to', 'member_of', 'derives', 'filters_on', 'traverses', 'compiles_to', 'uses', 'exported_from', 'writes',
  'receipted_by', 'reverts', 'simulates',
] as const;
export type Relation = (typeof RELATIONS)[number];

/** The node kinds a direct marking can sit on (spec 58.4): the rest only inherit. */
export const MARKABLE_KINDS = [
  'connection', 'source_field', 'property', 'object_type_version', 'link_type_version', 'action_type_version', 'function_version', 'silo',
  'view', 'app_version',
] as const satisfies readonly NodeKind[];

export const nodeRef = z.strictObject({
  kind: z.enum(NODE_KINDS),
  refId: z.uuid(),
  version: z.string().trim().min(1).max(200),
});
export type NodeRef = z.infer<typeof nodeRef>;

/** What a producer hands the writer, inside its own transaction. */
export const lineageWrite = z.strictObject({
  artefact: nodeRef,
  inputs: z.array(z.strictObject({ node: nodeRef, relation: z.enum(RELATIONS) })).max(2_000),
  /** Markings the artefact carries itself (a frozen export, a confirmed marking at creation). */
  directMarkings: z.array(z.uuid()).max(100).default([]),
}).superRefine((w, ctx) => {
  w.inputs.forEach((input, i) => {
    if (input.node.kind === w.artefact.kind && input.node.refId === w.artefact.refId && input.node.version === w.artefact.version) {
      ctx.addIssue({ code: 'custom', path: ['inputs', i], message: 'an artefact is not its own input' });
    }
  });
});
export type LineageWriteInput = z.input<typeof lineageWrite>;

export const DEFAULT_DEPTH = 32;
export const MAX_DEPTH = 32;

export const nodeView = z.object({
  id: z.uuid(),
  kind: z.enum(NODE_KINDS),
  refId: z.uuid(),
  version: z.string(),
  /** Hops from the node asked about. */
  depth: z.int().min(0),
  createdAt: z.string(),
  markingIds: z.array(z.uuid()),
});
export type NodeView = z.infer<typeof nodeView>;

export const edgeView = z.object({ from: z.uuid(), to: z.uuid(), relation: z.enum(RELATIONS) });

export const graphView = z.object({
  root: z.uuid(),
  direction: z.enum(['upstream', 'downstream']),
  nodes: z.array(nodeView),
  edges: z.array(edgeView),
  /** Nodes reached whose markings the reader does not satisfy: counted, never named. */
  withheld: z.int().min(0),
});
export type GraphView = z.infer<typeof graphView>;

const bounds = {
  depth: z.coerce.number().int().min(1).max(MAX_DEPTH).default(DEFAULT_DEPTH),
  maxNodes: z.coerce.number().int().min(1).max(10_000).default(2_000),
};
const nodeQuery = z.strictObject({
  kind: z.enum(NODE_KINDS),
  refId: z.uuid(),
  /** The latest version when absent. */
  version: z.string().trim().min(1).max(200).optional(),
  ...bounds,
});

const READERS = ['gateway', 'admin-portal'] as const;

/** lineage.view: the upstream of an artefact the reader can already see (spec 59.1, 59.5). */
export const getLineage = defineContract({
  service: 'lineage', name: 'getLineage', method: 'GET', path: '/v1/lineage/upstream', callers: [...READERS, 'workspace', 'ask', 'studio', 'executor'],
  context: 'organisation', idempotency: 'none',
  query: nodeQuery,
  response: graphView,
});

/** lineage.read: every source field, connector version and connection that fed an artefact (spec 59.4). */
export const queryUpstream = defineContract({
  service: 'lineage', name: 'queryUpstream', method: 'GET', path: '/v1/lineage/review/upstream', callers: READERS,
  context: 'organisation', idempotency: 'none',
  query: nodeQuery,
  response: graphView,
});

/** lineage.read: every artefact a resource reached, such as a newly restricted field (spec 59.4). */
export const queryDownstream = defineContract({
  service: 'lineage', name: 'queryDownstream', method: 'GET', path: '/v1/lineage/review/downstream', callers: READERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({
    kind: z.enum(NODE_KINDS),
    refId: z.uuid(),
    /** Every version of the resource when absent. */
    version: z.string().trim().min(1).max(200).optional(),
    ...bounds,
  }),
  response: graphView,
});

export const markingPathStep = z.object({ nodeId: z.uuid(), kind: z.enum(NODE_KINDS), refId: z.uuid(), version: z.string() });

/** lineage.read: each marking an artefact carries and the path by which it was inherited (spec 59.4). */
export const explainMarkings = defineContract({
  service: 'lineage', name: 'explainMarkings', method: 'GET', path: '/v1/lineage/review/markings', callers: READERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({
    kind: z.enum(NODE_KINDS),
    refId: z.uuid(),
    version: z.string().trim().min(1).max(200).optional(),
  }),
  response: z.object({
    node: z.uuid(),
    markings: z.array(z.object({
      markingId: z.uuid(),
      /** direct: on the resource itself; inherited: stored by propagation; pending: an upstream marking still being propagated. */
      origin: z.enum(['direct', 'inherited', 'pending']),
      /** From the artefact up to the node that carries the marking directly; empty for direct. */
      path: z.array(markingPathStep),
    })),
  }),
});

/** lineage.read: how many memberships opened the artefacts downstream of a resource (spec 59.4, from audit). */
export const accessOverlay = defineContract({
  service: 'lineage', name: 'accessOverlay', method: 'GET', path: '/v1/lineage/review/access', callers: READERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({
    kind: z.enum(NODE_KINDS),
    refId: z.uuid(),
    since: z.iso.datetime({ offset: true }).optional(),
    ...bounds,
  }),
  response: z.object({
    artefacts: z.int().min(0),
    /** Distinct memberships with an audit event on any artefact of the set. Counts only. */
    memberships: z.int().min(0),
    withheld: z.int().min(0),
  }),
});
