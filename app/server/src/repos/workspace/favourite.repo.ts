// Data access for workspace.favourites, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { deleteRow, findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  favouriteTable,
  type Favourite,
  type FavouriteChanges,
  type NewFavourite,
} from '../../models/workspace/favourite.model.ts';

export const favouriteRepo = {
  insert(db: Queryable, row: NewFavourite): Promise<Favourite> {
    return insertRow(db, favouriteTable, row);
  },

  findById(db: Queryable, id: Favourite['id']): Promise<Favourite | undefined> {
    return findRow(db, favouriteTable, { id });
  },

  update(db: Queryable, id: Favourite['id'], changes: FavouriteChanges): Promise<Favourite | undefined> {
    return updateRow(db, favouriteTable, { id }, changes);
  },

  remove(db: Queryable, id: Favourite['id']): Promise<boolean> {
    return deleteRow(db, favouriteTable, { id });
  },

  async listForMember(db: Queryable, membershipId: string): Promise<Favourite[]> {
    const { rows } = await db.query(
      `select ${favouriteTable.select} from workspace.favourites where membership_id = $1 order by position, created_at`, [membershipId]);
    return rows as Favourite[];
  },

  /** The next position on Home for a member: max plus one, in the inserting transaction. */
  async nextPosition(db: Queryable, membershipId: string): Promise<number> {
    const { rows } = await db.query(
      'select coalesce(max(position), 0) + 1 as next from workspace.favourites where membership_id = $1', [membershipId]);
    return Number((rows[0] as { next: number }).next);
  },
};
