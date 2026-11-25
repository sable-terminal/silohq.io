// Data access for action.id_remappings, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  idRemappingTable,
  type IdRemapping,
  type NewIdRemapping,
} from '../../models/action/idRemapping.model.ts';

export const idRemappingRepo = {
  insert(db: Queryable, row: NewIdRemapping): Promise<IdRemapping> {
    return insertRow(db, idRemappingTable, row);
  },

  findById(db: Queryable, id: IdRemapping['id']): Promise<IdRemapping | undefined> {
    return findRow(db, idRemappingTable, { id });
  },

  findByRevertIdAndConnectionIdAndOldReference(
    db: Queryable,
    key: Pick<IdRemapping, 'organisationId' | 'revertId' | 'connectionId' | 'oldReference'>,
  ): Promise<IdRemapping | undefined> {
    return findRow(db, idRemappingTable, key);
  },
};
