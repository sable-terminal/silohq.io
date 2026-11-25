// Data access for gov.marking_propagations, in plain SQL; no ORM.
// Read and written by silo_app. Row-level security applies: call it inside inTransaction
// with the request context, except queue(), which lists across organisations through a
// definer function returning identifiers only.
//
// A direct marking applied upstream is requested here by a trigger, in the transaction
// that applies it (spec 58.6); the lineage service walks it downstream in bounded batches,
// and until a request completes, policy evaluates it at read time (pendingFor).

import type { Queryable } from '../base.repo.ts';
import { markingPropagationTable, type MarkingPropagation } from '../../models/gov/index.model.ts';

const SELECT = markingPropagationTable.select;

export const markingPropagationRepo = {
  /** Oldest first, across organisations: the worker's queue. */
  async queue(db: Queryable, limit: number): Promise<{ organisationId: string; id: string }[]> {
    const { rows } = await db.query(
      'select organisation_id as "organisationId", id from gov.pending_marking_propagations($1)', [limit]);
    return rows as { organisationId: string; id: string }[];
  },

  /** The request, locked for this worker; undefined when another replica holds it or it is done. */
  async claim(db: Queryable, id: string): Promise<MarkingPropagation | undefined> {
    const { rows } = await db.query(
      `select ${SELECT} from gov.marking_propagations where id = $1 and completed_at is null for update skip locked`, [id]);
    return rows[0] as MarkingPropagation | undefined;
  },

  async findById(db: Queryable, id: string): Promise<MarkingPropagation | undefined> {
    const { rows } = await db.query(`select ${SELECT} from gov.marking_propagations where id = $1`, [id]);
    return rows[0] as MarkingPropagation | undefined;
  },

  /** Whether the source still carries the marking directly (a declassification may have removed it). */
  async sourceStillMarked(db: Queryable, p: MarkingPropagation): Promise<boolean> {
    const column = SOURCE_COLUMNS[p.sourceKind];
    if (column === undefined) return false;
    const { rows } = column === 'object_type_id'
      ? await db.query('select 1 from iam.object_type_markings where organisation_id = $1 and object_type_id = $2 and marking_id = $3',
        [p.organisationId, p.sourceRefId, p.markingId])
      : await db.query(`select 1 from gov.resource_markings where organisation_id = $1 and ${column} = $2 and marking_id = $3`,
        [p.organisationId, p.sourceRefId, p.markingId]);
    return rows.length > 0;
  },

  /**
   * The next nodes downstream of the source that do not carry the marking live, nearest
   * first, each with its nearest upstream node (the one it inherits from). Depth-bounded:
   * lineage is acyclic, but the walk never relies on it.
   */
  async nextUnmarked(db: Queryable, p: MarkingPropagation, depth: number, limit: number)
    : Promise<{ nodeId: string; parentId: string; depth: number }[]> {
    const { rows } = await db.query(
      `with recursive src as (
         select id from gov.lineage_nodes where organisation_id = $1 and kind = $2 and ref_id = $3
       ),
       walk (node_id, parent_id, depth) as (
         select id, null::uuid, 0 from src
         union
         select e.to_node_id, w.node_id, w.depth + 1 from walk w
         join gov.lineage_edges e on e.organisation_id = $1 and e.from_node_id = w.node_id
         where w.depth < $5
       ),
       nearest as (
         select distinct on (node_id) node_id, parent_id, depth from walk where depth > 0 order by node_id, depth, parent_id
       )
       select n.node_id as "nodeId", n.parent_id as "parentId", n.depth from nearest n
       where not exists (select 1 from src where src.id = n.node_id)
         and not exists (select 1 from gov.artefact_markings am
                         where am.organisation_id = $1 and am.lineage_node_id = n.node_id and am.marking_id = $4 and am.removed_at is null)
       order by n.depth, n.node_id limit $6`,
      [p.organisationId, p.sourceKind, p.sourceRefId, p.markingId, depth, limit]);
    return rows as { nodeId: string; parentId: string; depth: number }[];
  },

  /** Whether the walk is cut short: some node at the depth bound has edges beyond it. */
  async beyondDepth(db: Queryable, p: MarkingPropagation, depth: number): Promise<boolean> {
    const { rows } = await db.query(
      `with recursive walk (node_id, depth) as (
         select id, 0 from gov.lineage_nodes where organisation_id = $1 and kind = $2 and ref_id = $3
         union
         select e.to_node_id, w.depth + 1 from walk w
         join gov.lineage_edges e on e.organisation_id = $1 and e.from_node_id = w.node_id
         where w.depth < $4
       )
       select 1 from walk w join gov.lineage_edges e on e.organisation_id = $1 and e.from_node_id = w.node_id
       where w.depth = $4 limit 1`,
      [p.organisationId, p.sourceKind, p.sourceRefId, depth]);
    return rows.length > 0;
  },

  async progress(db: Queryable, id: string, changes: { added: number; firstPassAt?: true; completedAt?: true;
    refusedReason?: MarkingPropagation['refusedReason'] }): Promise<void> {
    await db.query(
      `update gov.marking_propagations set nodes_marked = nodes_marked + $2,
         first_pass_at = case when $3 then coalesce(first_pass_at, now()) else first_pass_at end,
         completed_at = case when $4 then now() else completed_at end,
         refused_reason = coalesce($5, refused_reason)
       where id = $1`,
      [id, changes.added, changes.firstPassAt === true, changes.completedAt === true, changes.refusedReason ?? null]);
  },

  /**
   * Markings these nodes inherit from an upstream source whose propagation has not
   * completed: what policy adds at read time until the walk reaches them (spec 58.6).
   */
  async pendingFor(db: Queryable, organisationId: string, ids: readonly string[], depth: number)
    : Promise<{ nodeId: string; markingId: string; sourceNodeId: string }[]> {
    if (ids.length === 0) return [];
    const any = await db.query(
      'select 1 from gov.marking_propagations where organisation_id = $1 and completed_at is null limit 1', [organisationId]);
    if (any.rows.length === 0) return [];
    const { rows } = await db.query(
      `with recursive walk (target, node_id, depth) as (
         select t, t, 0 from unnest($2::uuid[]) as t
         union
         select w.target, e.from_node_id, w.depth + 1 from walk w
         join gov.lineage_edges e on e.organisation_id = $1 and e.to_node_id = w.node_id
         where w.depth < $3
       )
       select distinct w.target as "nodeId", p.marking_id as "markingId", n.id as "sourceNodeId"
       from walk w
       join gov.lineage_nodes n on n.organisation_id = $1 and n.id = w.node_id
       join gov.marking_propagations p on p.organisation_id = $1 and p.completed_at is null
         and p.source_kind = n.kind and p.source_ref_id = n.ref_id`,
      [organisationId, ids, depth]);
    return rows as { nodeId: string; markingId: string; sourceNodeId: string }[];
  },
};

// Which direct-marking column a source kind is read from: a closed map, so no caller's text
// reaches a statement.
const SOURCE_COLUMNS: Record<string, string> = {
  connection: 'connection_id', source_field: 'property_mapping_id', property: 'property_id', object_type_version: 'object_type_id',
  link_type_version: 'link_type_id', action_type_version: 'action_type_id', function_version: 'function_id', silo: 'silo_id',
  view: 'view_id', app_version: 'app_id',
};
