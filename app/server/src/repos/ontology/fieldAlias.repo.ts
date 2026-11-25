// Data access for ontology.field_aliases, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  fieldAliasTable,
  type FieldAlias,
  type FieldAliasChanges,
  type NewFieldAlias,
} from '../../models/ontology/fieldAlias.model.ts';

export const fieldAliasRepo = {
  insert(db: Queryable, row: NewFieldAlias): Promise<FieldAlias> {
    return insertRow(db, fieldAliasTable, row);
  },

  findById(db: Queryable, id: FieldAlias['id']): Promise<FieldAlias | undefined> {
    return findRow(db, fieldAliasTable, { id });
  },

  update(db: Queryable, id: FieldAlias['id'], changes: FieldAliasChanges): Promise<FieldAlias | undefined> {
    return updateRow(db, fieldAliasTable, { id }, changes);
  },

  /** The column's live alias. */
  async liveForField(db: Queryable, connectionId: string, fieldPath: string): Promise<FieldAlias | undefined> {
    const { rows } = await db.query(
      `select ${fieldAliasTable.select} from ontology.field_aliases where connection_id = $1 and field_path = $2 and removed_at is null`, [connectionId, fieldPath]);
    return rows[0] as FieldAlias | undefined;
  },

  /** The organisation's live aliases, or one connection's. */
  async live(db: Queryable, connectionId?: string): Promise<FieldAlias[]> {
    const { rows } = await db.query(
      `select ${fieldAliasTable.select} from ontology.field_aliases
        where removed_at is null and ($1::uuid is null or connection_id = $1) order by connection_id, field_path`, [connectionId ?? null]);
    return rows as FieldAlias[];
  },
};
