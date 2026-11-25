// Data access for simulation.edge_observations, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  edgeObservationTable,
  type EdgeObservation,
  type NewEdgeObservation,
} from '../../models/simulation/edgeObservation.model.ts';

export const edgeObservationRepo = {
  insert(db: Queryable, row: NewEdgeObservation): Promise<EdgeObservation> {
    return insertRow(db, edgeObservationTable, row);
  },

  findById(db: Queryable, id: EdgeObservation['id']): Promise<EdgeObservation | undefined> {
    return findRow(db, edgeObservationTable, { id });
  },

  findByEdgeIdAndComputedAt(
    db: Queryable,
    key: Pick<EdgeObservation, 'organisationId' | 'edgeId' | 'computedAt'>,
  ): Promise<EdgeObservation | undefined> {
    return findRow(db, edgeObservationTable, key);
  },
};
