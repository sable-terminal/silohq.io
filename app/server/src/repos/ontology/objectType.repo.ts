// Data access for ontology.object_types, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  objectTypeTable,
  type NewObjectType,
  type ObjectType,
  type ObjectTypeChanges,
} from '../../models/ontology/objectType.model.ts';

export const objectTypeRepo = {
  insert(db: Queryable, row: NewObjectType): Promise<ObjectType> {
    return insertRow(db, objectTypeTable, row);
  },

  findById(db: Queryable, id: ObjectType['id']): Promise<ObjectType | undefined> {
    return findRow(db, objectTypeTable, { id });
  },

  findByApiName(
    db: Queryable,
    key: Pick<ObjectType, 'organisationId' | 'apiName'>,
  ): Promise<ObjectType | undefined> {
    return findRow(db, objectTypeTable, key);
  },

  update(db: Queryable, id: ObjectType['id'], changes: ObjectTypeChanges): Promise<ObjectType | undefined> {
    return updateRow(db, objectTypeTable, { id }, changes);
  },

  async listByIds(db: Queryable, ids: readonly string[]): Promise<ObjectType[]> {
    if (ids.length === 0) return [];
    const { rows } = await db.query(`select ${objectTypeTable.select} from ontology.object_types where id = any($1::uuid[])`, [ids]);
    return rows as ObjectType[];
  },
};
