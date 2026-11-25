// Data access for connect.discovery_findings, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  discoveryFindingTable,
  type DiscoveryFinding,
  type DiscoveryFindingChanges,
  type NewDiscoveryFinding,
} from '../../models/connect/discoveryFinding.model.ts';

export const discoveryFindingRepo = {
  insert(db: Queryable, row: NewDiscoveryFinding): Promise<DiscoveryFinding> {
    return insertRow(db, discoveryFindingTable, row);
  },

  findById(db: Queryable, id: DiscoveryFinding['id']): Promise<DiscoveryFinding | undefined> {
    return findRow(db, discoveryFindingTable, { id });
  },

  update(
    db: Queryable,
    id: DiscoveryFinding['id'],
    changes: DiscoveryFindingChanges,
  ): Promise<DiscoveryFinding | undefined> {
    return updateRow(db, discoveryFindingTable, { id }, changes);
  },

  /** Newest first, by run and decision when given. */
  async list(db: Queryable, filter: { runId?: string | undefined; decision?: string | undefined; limit: number }): Promise<DiscoveryFinding[]> {
    const { rows } = await db.query(
      `select ${discoveryFindingTable.select} from connect.discovery_findings
       where ($1::uuid is null or run_id = $1) and ($2::text is null or review_decision = $2)
       order by created_at desc, id desc limit $3`, [filter.runId ?? null, filter.decision ?? null, filter.limit]);
    return rows as DiscoveryFinding[];
  },

  /** The finding, locked for its review. */
  async findForUpdate(db: Queryable, id: string): Promise<DiscoveryFinding | undefined> {
    const { rows } = await db.query(`select ${discoveryFindingTable.select} from connect.discovery_findings where id = $1 for update`, [id]);
    return rows[0] as DiscoveryFinding | undefined;
  },
};
