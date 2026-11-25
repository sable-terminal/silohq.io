// Data access for ontology.functions, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  functionTable,
  type NewOntologyFunction,
  type OntologyFunction,
  type OntologyFunctionChanges,
} from '../../models/ontology/function.model.ts';

export const functionRepo = {
  insert(db: Queryable, row: NewOntologyFunction): Promise<OntologyFunction> {
    return insertRow(db, functionTable, row);
  },

  findById(db: Queryable, id: OntologyFunction['id']): Promise<OntologyFunction | undefined> {
    return findRow(db, functionTable, { id });
  },

  findByApiName(
    db: Queryable,
    key: Pick<OntologyFunction, 'organisationId' | 'apiName'>,
  ): Promise<OntologyFunction | undefined> {
    return findRow(db, functionTable, key);
  },

  update(
    db: Queryable,
    id: OntologyFunction['id'],
    changes: OntologyFunctionChanges,
  ): Promise<OntologyFunction | undefined> {
    return updateRow(db, functionTable, { id }, changes);
  },
};
