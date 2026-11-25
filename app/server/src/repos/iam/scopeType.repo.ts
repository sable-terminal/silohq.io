// Data access for iam.scope_types, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  scopeTypeTable,
  type NewScopeType,
  type ScopeType,
  type ScopeTypeChanges,
} from '../../models/iam/scopeType.model.ts';

export const scopeTypeRepo = {
  insert(db: Queryable, row: NewScopeType): Promise<ScopeType> {
    return insertRow(db, scopeTypeTable, row);
  },

  findById(db: Queryable, id: ScopeType['id']): Promise<ScopeType | undefined> {
    return findRow(db, scopeTypeTable, { id });
  },

  findByName(db: Queryable, key: Pick<ScopeType, 'organisationId' | 'name'>): Promise<ScopeType | undefined> {
    return findRow(db, scopeTypeTable, key);
  },

  update(db: Queryable, id: ScopeType['id'], changes: ScopeTypeChanges): Promise<ScopeType | undefined> {
    return updateRow(db, scopeTypeTable, { id }, changes);
  },

  async list(db: Queryable): Promise<ScopeType[]> {
    const { rows } = await db.query(`select ${scopeTypeTable.select} from iam.scope_types order by name`);
    return rows as ScopeType[];
  },
};
