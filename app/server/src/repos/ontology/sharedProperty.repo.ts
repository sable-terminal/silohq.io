// Data access for ontology.shared_properties, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  sharedPropertyTable,
  type NewSharedProperty,
  type SharedProperty,
  type SharedPropertyChanges,
} from '../../models/ontology/sharedProperty.model.ts';

export const sharedPropertyRepo = {
  insert(db: Queryable, row: NewSharedProperty): Promise<SharedProperty> {
    return insertRow(db, sharedPropertyTable, row);
  },

  findById(db: Queryable, id: SharedProperty['id']): Promise<SharedProperty | undefined> {
    return findRow(db, sharedPropertyTable, { id });
  },

  findByApiName(
    db: Queryable,
    key: Pick<SharedProperty, 'organisationId' | 'apiName'>,
  ): Promise<SharedProperty | undefined> {
    return findRow(db, sharedPropertyTable, key);
  },

  update(
    db: Queryable,
    id: SharedProperty['id'],
    changes: SharedPropertyChanges,
  ): Promise<SharedProperty | undefined> {
    return updateRow(db, sharedPropertyTable, { id }, changes);
  },
};
