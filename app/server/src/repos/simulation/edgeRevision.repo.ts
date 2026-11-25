// Data access for simulation.edge_revisions, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  edgeRevisionTable,
  type EdgeRevision,
  type NewEdgeRevision,
} from '../../models/simulation/edgeRevision.model.ts';

export const edgeRevisionRepo = {
  insert(db: Queryable, row: NewEdgeRevision): Promise<EdgeRevision> {
    return insertRow(db, edgeRevisionTable, row);
  },

  findById(db: Queryable, id: EdgeRevision['id']): Promise<EdgeRevision | undefined> {
    return findRow(db, edgeRevisionTable, { id });
  },

  findByGraphVersion(
    db: Queryable,
    key: Pick<EdgeRevision, 'organisationId' | 'graphVersion'>,
  ): Promise<EdgeRevision | undefined> {
    return findRow(db, edgeRevisionTable, key);
  },
};
