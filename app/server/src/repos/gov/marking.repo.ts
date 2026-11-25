// Data access for gov.markings, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  markingTable,
  type Marking,
  type MarkingChanges,
  type NewMarking,
} from '../../models/gov/marking.model.ts';

export const markingRepo = {
  insert(db: Queryable, row: NewMarking): Promise<Marking> {
    return insertRow(db, markingTable, row);
  },

  findById(db: Queryable, id: Marking['id']): Promise<Marking | undefined> {
    return findRow(db, markingTable, { id });
  },

  findByName(db: Queryable, key: Pick<Marking, 'organisationId' | 'name'>): Promise<Marking | undefined> {
    return findRow(db, markingTable, key);
  },

  update(db: Queryable, id: Marking['id'], changes: MarkingChanges): Promise<Marking | undefined> {
    return updateRow(db, markingTable, { id }, changes);
  },

  async list(db: Queryable, includeRetired: boolean): Promise<Marking[]> {
    const { rows } = await db.query(
      `select ${markingTable.select} from gov.markings where ($1 or retired_at is null) order by kind, rank nulls last, name`,
      [includeRetired]);
    return rows as Marking[];
  },

  /** Every marking the organisation has defined, retired ones too. */
  async listIds(db: Queryable, organisationId: string): Promise<string[]> {
    const { rows } = await db.query('select id::text as id from gov.markings where organisation_id = $1 order by id', [organisationId]);
    return (rows as { id: string }[]).map((r) => r.id);
  },
};
