// Data access for gov.artefact_markings, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { uuidv7 } from '../../utils/id.util.ts';
import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  artefactMarkingTable,
  type ArtefactMarking,
  type ArtefactMarkingChanges,
  type ArtefactMarkingPrimaryKey,
  type NewArtefactMarking,
} from '../../models/gov/artefactMarking.model.ts';

export const artefactMarkingRepo = {
  insert(db: Queryable, row: NewArtefactMarking): Promise<ArtefactMarking> {
    return insertRow(db, artefactMarkingTable, row);
  },

  findByKey(db: Queryable, key: ArtefactMarkingPrimaryKey): Promise<ArtefactMarking | undefined> {
    return findRow(db, artefactMarkingTable, key);
  },

  update(
    db: Queryable,
    key: ArtefactMarkingPrimaryKey,
    changes: ArtefactMarkingChanges,
  ): Promise<ArtefactMarking | undefined> {
    return updateRow(db, artefactMarkingTable, key, changes);
  },

  /**
   * Stores markings on a node where it does not carry them live already (one live row per
   * node and marking: artefact_markings_live). Returns how many were added.
   */
  async addMissing(db: Queryable, organisationId: string, rows: readonly StoredMarking[]): Promise<number> {
    if (rows.length === 0) return 0;
    const { rowCount } = await db.query(
      `insert into gov.artefact_markings (id, organisation_id, lineage_node_id, marking_id, origin, inherited_from_node_id)
       select w.id, $1, w.node_id, w.marking_id, w.origin, w.inherited_from
       from unnest($2::uuid[], $3::uuid[], $4::uuid[], $5::text[], $6::uuid[]) as w (id, node_id, marking_id, origin, inherited_from)
       on conflict (organisation_id, lineage_node_id, marking_id) where removed_at is null do nothing`,
      [organisationId, rows.map(() => uuidv7()), rows.map((r) => r.nodeId), rows.map((r) => r.markingId), rows.map((r) => r.origin),
        rows.map((r) => r.inheritedFromNodeId)]);
    return rowCount ?? 0;
  },

  /** A live marking on a node ends, named by the declassification that removed it (spec 58.9). */
  async removeLive(db: Queryable, organisationId: string, nodeId: string, markingId: string, declassificationId: string): Promise<boolean> {
    const { rowCount } = await db.query(
      `update gov.artefact_markings set removed_at = now(), declassification_id = $4
        where organisation_id = $1 and lineage_node_id = $2 and marking_id = $3 and removed_at is null`,
      [organisationId, nodeId, markingId, declassificationId]);
    return (rowCount ?? 0) > 0;
  },

  /** What a declassification removed, as it stood, for a revert to put back. */
  async removedBy(db: Queryable, organisationId: string, declassificationId: string): Promise<StoredMarking[]> {
    const { rows } = await db.query(
      `select lineage_node_id as "nodeId", marking_id as "markingId", origin, inherited_from_node_id as "inheritedFromNodeId"
         from gov.artefact_markings where organisation_id = $1 and declassification_id = $2`, [organisationId, declassificationId]);
    return rows as StoredMarking[];
  },
};

export interface StoredMarking {
  nodeId: string;
  markingId: string;
  origin: 'direct' | 'inherited';
  /** The nearest upstream node carrying the marking; null for direct. */
  inheritedFromNodeId: string | null;
}
