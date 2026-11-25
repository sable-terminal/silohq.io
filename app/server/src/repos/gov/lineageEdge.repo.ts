// Data access for gov.lineage_edges, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  lineageEdgeTable,
  type LineageEdge,
  type LineageEdgePrimaryKey,
  type NewLineageEdge,
} from '../../models/gov/lineageEdge.model.ts';

export const lineageEdgeRepo = {
  insert(db: Queryable, row: NewLineageEdge): Promise<LineageEdge> {
    return insertRow(db, lineageEdgeTable, row);
  },

  findByKey(db: Queryable, key: LineageEdgePrimaryKey): Promise<LineageEdge | undefined> {
    return findRow(db, lineageEdgeTable, key);
  },

  /**
   * Inserts the edges not already recorded (a producer retrying its write records nothing
   * twice). Edges are append-only: never updated or deleted.
   */
  async insertMissing(db: Queryable, organisationId: string, edges: readonly { from: string; to: string; relation: string }[]): Promise<number> {
    if (edges.length === 0) return 0;
    const unique = [...new Map(edges.map((e) => [`${e.from}:${e.to}:${e.relation}`, e])).values()];
    const { rowCount } = await db.query(
      `insert into gov.lineage_edges (organisation_id, from_node_id, to_node_id, relation)
       select $1, w.from_node_id, w.to_node_id, w.relation
       from unnest($2::uuid[], $3::uuid[], $4::text[]) as w (from_node_id, to_node_id, relation)
       where not exists (select 1 from gov.lineage_edges e
                         where e.organisation_id = $1 and e.to_node_id = w.to_node_id and e.relation = w.relation
                           and e.from_node_id = w.from_node_id)`,
      [organisationId, unique.map((e) => e.from), unique.map((e) => e.to), unique.map((e) => e.relation)]);
    return rowCount ?? 0;
  },

  /** The direct inputs of a node, with the relation. */
  async inputsOf(db: Queryable, organisationId: string, nodeId: string): Promise<{ from: string; relation: string }[]> {
    const { rows } = await db.query(
      `select distinct from_node_id as "from", relation from gov.lineage_edges where organisation_id = $1 and to_node_id = $2`,
      [organisationId, nodeId]);
    return rows as { from: string; relation: string }[];
  },
};
