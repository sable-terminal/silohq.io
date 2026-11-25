// Data access for ontology.function_versions, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  functionVersionTable,
  type FunctionVersion,
  type FunctionVersionChanges,
  type NewFunctionVersion,
} from '../../models/ontology/functionVersion.model.ts';

export const functionVersionRepo = {
  insert(db: Queryable, row: NewFunctionVersion): Promise<FunctionVersion> {
    return insertRow(db, functionVersionTable, row);
  },

  findById(db: Queryable, id: FunctionVersion['id']): Promise<FunctionVersion | undefined> {
    return findRow(db, functionVersionTable, { id });
  },

  findByFunctionIdAndVersion(
    db: Queryable,
    key: Pick<FunctionVersion, 'organisationId' | 'functionId' | 'version'>,
  ): Promise<FunctionVersion | undefined> {
    return findRow(db, functionVersionTable, key);
  },

  update(
    db: Queryable,
    id: FunctionVersion['id'],
    changes: FunctionVersionChanges,
  ): Promise<FunctionVersion | undefined> {
    return updateRow(db, functionVersionTable, { id }, changes);
  },

  async maxVersion(db: Queryable, functionId: string): Promise<number> {
    const { rows } = await db.query('select coalesce(max(version), 0)::int as n from ontology.function_versions where function_id = $1', [functionId]);
    return (rows[0] as { n: number }).n;
  },
};
