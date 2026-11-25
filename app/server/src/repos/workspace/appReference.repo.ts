// Data access for workspace.app_references, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  appReferenceTable,
  type AppReference,
  type AppReferenceChanges,
  type NewAppReference,
} from '../../models/workspace/appReference.model.ts';

export const appReferenceRepo = {
  insert(db: Queryable, row: NewAppReference): Promise<AppReference> {
    return insertRow(db, appReferenceTable, row);
  },

  findById(db: Queryable, id: AppReference['id']): Promise<AppReference | undefined> {
    return findRow(db, appReferenceTable, { id });
  },

  update(
    db: Queryable,
    id: AppReference['id'],
    changes: AppReferenceChanges,
  ): Promise<AppReference | undefined> {
    return updateRow(db, appReferenceTable, { id }, changes);
  },
};
