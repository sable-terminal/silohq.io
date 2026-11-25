// Data access for iam.permissions, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_auth, silo_report; written by no service.
// No row-level security: every caller sees every row.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, type Queryable } from '../base.repo.ts';
import { permissionTable, type Permission } from '../../models/iam/permission.model.ts';

export const permissionRepo = {
  findById(db: Queryable, id: Permission['id']): Promise<Permission | undefined> {
    return findRow(db, permissionTable, { id });
  },

  // The whole catalogue (spec 76): fixed, so a service loads it once at start.
  async listIds(db: Queryable): Promise<string[]> {
    const { rows } = await db.query('select id from iam.permissions order by id');
    return rows.map((r) => (r as { id: string }).id);
  },

  /** The catalogue with each permission's category (authorising: never a service principal's, spec 60.6). */
  async listCatalogue(db: Queryable): Promise<{ id: string; category: Permission['category'] }[]> {
    const { rows } = await db.query('select id, category from iam.permissions order by id');
    return rows as { id: string; category: Permission['category'] }[];
  },

  /** The catalogue with each permission's description, for a person reading what they may do. */
  async listDescribed(db: Queryable): Promise<{ id: string; description: string }[]> {
    const { rows } = await db.query('select id, description from iam.permissions order by id');
    return rows as { id: string; description: string }[];
  },
};
