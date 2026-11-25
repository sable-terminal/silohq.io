// Data access for gov.lineage_nodes, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { uuidv7 } from '../../utils/id.util.ts';
import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  lineageNodeTable,
  type LineageNode,
  type LineageNodePrimaryKey,
  type NewLineageNode,
} from '../../models/gov/lineageNode.model.ts';

export const lineageNodeRepo = {
  insert(db: Queryable, row: NewLineageNode): Promise<LineageNode> {
    return insertRow(db, lineageNodeTable, row);
  },

  findByKey(db: Queryable, key: LineageNodePrimaryKey): Promise<LineageNode | undefined> {
    return findRow(db, lineageNodeTable, key);
  },

  findByKindAndRefIdAndVersion(
    db: Queryable,
    key: Pick<LineageNode, 'organisationId' | 'kind' | 'refId' | 'version'>,
  ): Promise<LineageNode | undefined> {
    return findRow(db, lineageNodeTable, key);
  },

  /**
   * Each reference as a node, created where it does not exist yet (nodes are immutable, so
   * an existing one is simply used). Returns every node asked for, by reference.
   */
  async ensure(db: Queryable, organisationId: string, refs: readonly NodeKey[], createdBy: Creator): Promise<LineageNode[]> {
    if (refs.length === 0) return [];
    const unique = [...new Map(refs.map((r) => [keyOf(r), r])).values()];
    const params = [organisationId, unique.map((r) => r.kind), unique.map((r) => r.refId), unique.map((r) => r.version),
      unique.map(() => uuidv7()), createdBy.membershipId ?? null, createdBy.servicePrincipalId ?? null];
    await db.query(
      `insert into gov.lineage_nodes (id, organisation_id, kind, ref_id, version, created_by_membership_id, created_by_service_principal_id)
       select w.id, $1, w.kind, w.ref_id, w.version, $6, $7
       from unnest($2::text[], $3::uuid[], $4::text[], $5::uuid[]) as w (kind, ref_id, version, id)
       on conflict (organisation_id, kind, ref_id, version) do nothing`, params);
    // A separate statement, so it sees rows a concurrent writer committed while this one waited.
    const { rows } = await db.query(
      `select ${lineageNodeTable.select} from gov.lineage_nodes n
       join unnest($2::text[], $3::uuid[], $4::text[]) as w (w_kind, w_ref_id, w_version)
         on n.kind = w.w_kind and n.ref_id = w.w_ref_id and n.version = w.w_version
       where n.organisation_id = $1`, params.slice(0, 4));
    return rows as LineageNode[];
  },

  /** The latest version of a resource's node: the one its current markings are read from. */
  async findLatest(db: Queryable, organisationId: string, kind: LineageNode['kind'], refId: string): Promise<LineageNode | undefined> {
    const { rows } = await db.query(
      `select ${lineageNodeTable.select} from gov.lineage_nodes
       where organisation_id = $1 and kind = $2 and ref_id = $3 order by created_at desc, id desc limit 1`, [organisationId, kind, refId]);
    return rows[0] as LineageNode | undefined;
  },

  /** Every version of a resource's node. */
  async findVersions(db: Queryable, organisationId: string, kind: LineageNode['kind'], refId: string, limit: number): Promise<LineageNode[]> {
    const { rows } = await db.query(
      `select ${lineageNodeTable.select} from gov.lineage_nodes
       where organisation_id = $1 and kind = $2 and ref_id = $3 order by created_at, id limit $4`, [organisationId, kind, refId, limit]);
    return rows as LineageNode[];
  },

  async findMany(db: Queryable, organisationId: string, ids: readonly string[]): Promise<LineageNode[]> {
    if (ids.length === 0) return [];
    const { rows } = await db.query(
      `select ${lineageNodeTable.select} from gov.lineage_nodes where organisation_id = $1 and id = any($2::uuid[])`, [organisationId, ids]);
    return rows as LineageNode[];
  },

  /**
   * The markings these nodes carry now: direct markings on the resource each references
   * (gov.resource_markings, iam.object_type_markings, by kind and ref_id) and live stored
   * ones (gov.artefact_markings). Pending propagations are read apart (markingPropagationRepo).
   */
  async markings(db: Queryable, organisationId: string, ids: readonly string[]): Promise<NodeMarking[]> {
    if (ids.length === 0) return [];
    const { rows } = await db.query(
      `select n.id as "nodeId", rm.marking_id as "markingId", 'direct' as origin, null::uuid as "inheritedFromNodeId"
       from gov.lineage_nodes n
       join gov.resource_markings rm on rm.organisation_id = n.organisation_id and (
            (n.kind = 'connection' and rm.connection_id = n.ref_id)
         or (n.kind = 'source_field' and rm.property_mapping_id = n.ref_id)
         or (n.kind = 'property' and rm.property_id = n.ref_id)
         or (n.kind = 'link_type_version' and rm.link_type_id = n.ref_id)
         or (n.kind = 'action_type_version' and rm.action_type_id = n.ref_id)
         or (n.kind = 'function_version' and rm.function_id = n.ref_id)
         or (n.kind = 'silo' and rm.silo_id = n.ref_id)
         or (n.kind = 'view' and rm.view_id = n.ref_id)
         or (n.kind = 'app_version' and rm.app_id = n.ref_id))
       where n.organisation_id = $1 and n.id = any($2::uuid[])
       union
       select n.id, otm.marking_id, 'direct', null::uuid
       from gov.lineage_nodes n
       join iam.object_type_markings otm on otm.organisation_id = n.organisation_id and otm.object_type_id = n.ref_id
       where n.organisation_id = $1 and n.kind = 'object_type_version' and n.id = any($2::uuid[])
       union
       select am.lineage_node_id, am.marking_id, am.origin, am.inherited_from_node_id
       from gov.artefact_markings am
       where am.organisation_id = $1 and am.lineage_node_id = any($2::uuid[]) and am.removed_at is null`,
      [organisationId, ids]);
    return rows as NodeMarking[];
  },

  /**
   * The nodes within depth hops of the roots, upstream (towards inputs) or downstream, each
   * at its least depth, plus the edges among them. Asks one past maxNodes, so the caller can
   * refuse rather than truncate, and reports whether a node at the depth bound has edges
   * beyond it.
   */
  async traverse(db: Queryable, organisationId: string, roots: readonly string[], direction: 'upstream' | 'downstream', depth: number,
    maxNodes: number): Promise<Traversal> {
    const [next, back] = direction === 'upstream' ? ['from_node_id', 'to_node_id'] : ['to_node_id', 'from_node_id'];
    const { rows } = await db.query(
      `with recursive walk (node_id, depth) as (
         select r, 0 from unnest($2::uuid[]) as r
         union
         select e.${next}, w.depth + 1 from walk w
         join gov.lineage_edges e on e.organisation_id = $1 and e.${back} = w.node_id
         where w.depth < $3
       )
       select node_id as "nodeId", min(depth)::int as depth from walk group by node_id order by min(depth), node_id limit $4`,
      [organisationId, roots, depth, maxNodes + 1]);
    const reached = rows as { nodeId: string; depth: number }[];
    if (reached.length > maxNodes) return { nodes: reached, edges: [], overNodes: true, beyondDepth: false };
    const ids = reached.map((r) => r.nodeId);
    const edges = await db.query(
      `select distinct from_node_id as "from", to_node_id as "to", relation from gov.lineage_edges
       where organisation_id = $1 and from_node_id = any($2::uuid[]) and to_node_id = any($2::uuid[])`, [organisationId, ids]);
    const frontier = reached.filter((r) => r.depth === depth).map((r) => r.nodeId);
    const beyond = frontier.length === 0 ? [] : (await db.query(
      `select 1 from gov.lineage_edges where organisation_id = $1 and ${back} = any($2::uuid[]) limit 1`, [organisationId, frontier])).rows;
    return { nodes: reached, edges: edges.rows as TraversedEdge[], overNodes: false, beyondDepth: beyond.length > 0 };
  },
};

export interface NodeKey { kind: LineageNode['kind']; refId: string; version: string }
export interface Creator { membershipId?: string | undefined; servicePrincipalId?: string | undefined }
export interface NodeMarking { nodeId: string; markingId: string; origin: 'direct' | 'inherited'; inheritedFromNodeId: string | null }
export interface TraversedEdge { from: string; to: string; relation: string }
export interface Traversal {
  nodes: { nodeId: string; depth: number }[];
  edges: TraversedEdge[];
  /** More nodes than asked for: the caller refuses. */
  overNodes: boolean;
  /** A node at the depth bound has edges beyond it: the caller refuses. */
  beyondDepth: boolean;
}

const keyOf = (r: NodeKey): string => `${r.kind}\u0000${r.refId}\u0000${r.version}`;
