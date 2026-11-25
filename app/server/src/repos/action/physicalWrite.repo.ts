// Data access for action.physical_writes, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  physicalWriteTable,
  type NewPhysicalWrite,
  type PhysicalWrite,
} from '../../models/action/physicalWrite.model.ts';

export const physicalWriteRepo = {
  insert(db: Queryable, row: NewPhysicalWrite): Promise<PhysicalWrite> {
    return insertRow(db, physicalWriteTable, row);
  },

  findById(db: Queryable, id: PhysicalWrite['id']): Promise<PhysicalWrite | undefined> {
    return findRow(db, physicalWriteTable, { id });
  },

  /** When an allow-list entry's node was last written (applied, or no answer), outside dry runs. */
  async lastWritten(db: Queryable, entryId: string): Promise<string | undefined> {
    const { rows } = await db.query(
      `select max(written_at) as at from action.physical_writes
        where allowlist_entry_id = $1 and outcome in ('applied', 'unknown') and not dry_run`, [entryId]);
    const at = rows[0]?.at as string | Date | null | undefined;
    return at === null || at === undefined ? undefined : new Date(at).toISOString();
  },

  /** A connection's physical writes since a time (applied, or no answer), outside dry runs. */
  async writtenSince(db: Queryable, connectionId: string, since: string): Promise<number> {
    const { rows } = await db.query(
      `select count(*)::int as n from action.physical_writes
        where connection_id = $1 and written_at >= $2 and outcome in ('applied', 'unknown') and not dry_run`, [connectionId, since]);
    return rows[0].n as number;
  },

  /** A mutation's nodes, in the order written. */
  async listForMutation(db: Queryable, mutationId: string): Promise<PhysicalWrite[]> {
    const { rows } = await db.query(
      `select ${physicalWriteTable.select} from action.physical_writes where mutation_id = $1 order by written_at, id`, [mutationId]);
    return rows as PhysicalWrite[];
  },
};
