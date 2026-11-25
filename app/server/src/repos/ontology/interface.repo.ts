// Data access for ontology.interfaces, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  interfaceTable,
  type Interface,
  type InterfaceChanges,
  type NewInterface,
} from '../../models/ontology/interface.model.ts';

export const interfaceRepo = {
  insert(db: Queryable, row: NewInterface): Promise<Interface> {
    return insertRow(db, interfaceTable, row);
  },

  findById(db: Queryable, id: Interface['id']): Promise<Interface | undefined> {
    return findRow(db, interfaceTable, { id });
  },

  findByApiName(
    db: Queryable,
    key: Pick<Interface, 'organisationId' | 'apiName'>,
  ): Promise<Interface | undefined> {
    return findRow(db, interfaceTable, key);
  },

  update(db: Queryable, id: Interface['id'], changes: InterfaceChanges): Promise<Interface | undefined> {
    return updateRow(db, interfaceTable, { id }, changes);
  },
};
