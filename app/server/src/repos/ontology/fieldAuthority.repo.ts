// Data access for ontology.field_authorities, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  fieldAuthorityTable,
  type FieldAuthority,
  type FieldAuthorityChanges,
  type NewFieldAuthority,
} from '../../models/ontology/fieldAuthority.model.ts';

export const fieldAuthorityRepo = {
  insert(db: Queryable, row: NewFieldAuthority): Promise<FieldAuthority> {
    return insertRow(db, fieldAuthorityTable, row);
  },

  findById(db: Queryable, id: FieldAuthority['id']): Promise<FieldAuthority | undefined> {
    return findRow(db, fieldAuthorityTable, { id });
  },

  update(
    db: Queryable,
    id: FieldAuthority['id'],
    changes: FieldAuthorityChanges,
  ): Promise<FieldAuthority | undefined> {
    return updateRow(db, fieldAuthorityTable, { id }, changes);
  },

  /** The live authorities on main for a type, newest first (field_authorities_live): loaded once per merge. */
  async liveForType(db: Queryable, objectTypeId: string): Promise<FieldAuthority[]> {
    const { rows } = await db.query(
      `select ${fieldAuthorityTable.select} from ontology.field_authorities
       where object_type_id = $1 and revoked_at is null and origin_branch_id is null order by declared_at desc, id desc`, [objectTypeId]);
    return rows as FieldAuthority[];
  },

  /** A type's declarations on main, newest first, revoked ones too when asked. */
  async listForType(db: Queryable, objectTypeId: string, includeRevoked: boolean): Promise<FieldAuthority[]> {
    const { rows } = await db.query(
      `select ${fieldAuthorityTable.select} from ontology.field_authorities
       where object_type_id = $1 and origin_branch_id is null and ($2 or revoked_at is null) order by declared_at desc, id desc`,
      [objectTypeId, includeRevoked]);
    return rows as FieldAuthority[];
  },

  /** Revokes a live declaration. Undefined when it was not live. */
  async revoke(db: Queryable, id: string, revokedBy: string): Promise<FieldAuthority | undefined> {
    const { rows } = await db.query(
      `update ontology.field_authorities set revoked_by = $2, revoked_at = now()
       where id = $1 and revoked_at is null returning ${fieldAuthorityTable.select}`, [id, revokedBy]);
    return rows[0] as FieldAuthority | undefined;
  },
};
