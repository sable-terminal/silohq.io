// Data access for recognition.lenses, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import { lensTable, type Lens, type LensChanges, type NewLens } from '../../models/recognition/lens.model.ts';

export const lensRepo = {
  insert(db: Queryable, row: NewLens): Promise<Lens> {
    return insertRow(db, lensTable, row);
  },

  findById(db: Queryable, id: Lens['id']): Promise<Lens | undefined> {
    return findRow(db, lensTable, { id });
  },

  update(db: Queryable, id: Lens['id'], changes: LensChanges): Promise<Lens | undefined> {
    return updateRow(db, lensTable, { id }, changes);
  },

  async listForMember(db: Queryable, membershipId: string): Promise<Lens[]> {
    const { rows } = await db.query(
      `select ${lensTable.select} from recognition.lenses where membership_id = $1 and archived_at is null order by created_at, id`, [membershipId]);
    return rows as Lens[];
  },

  /** Optimistic: undefined when the Lens moved since it was read. */
  async updateAtVersion(db: Queryable, id: string, version: number, changes: { name?: string; workingSets?: unknown; archivedAt?: string })
    : Promise<Lens | undefined> {
    const { rows } = await db.query(
      `update recognition.lenses set name = coalesce($3, name), working_sets = coalesce($4::jsonb, working_sets),
              archived_at = coalesce($5, archived_at), version = version + 1
        where id = $1 and version = $2 and archived_at is null returning ${lensTable.select}`,
      [id, version, changes.name ?? null, changes.workingSets === undefined ? null : JSON.stringify(changes.workingSets), changes.archivedAt ?? null]);
    return rows[0] as Lens | undefined;
  },
};
