// Data access for fleet.events, in plain SQL through base.repo.ts; no ORM.
// Read by directory_reader, fleet_writer; written by fleet_writer.
// No row-level security: every caller sees every row.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import { eventTable, type Event, type NewEvent } from '../../models/fleet/event.model.ts';

/** An event as read back, with its place in the chain. */
export interface FleetEventRow {
  seq: number; event: string; occurredAt: string; releaseId: string | null; rolloutId: string | null; cellId: string | null;
  channel: string | null; operatorId: string | null; detail: Record<string, string | number | boolean | null>; previousHash: Buffer | null; hash: Buffer;
}

export const eventRepo = {
  insert(db: Queryable, row: NewEvent): Promise<Event> {
    return insertRow(db, eventTable, row);
  },

  findBySeq(db: Queryable, seq: Event['seq']): Promise<Event | undefined> {
    return findRow(db, eventTable, { seq });
  },

  findByHash(db: Queryable, hash: Event['hash']): Promise<Event | undefined> {
    return findRow(db, eventTable, { hash });
  },

  /** The hash of the last event: what the next one chains to. */
  /** When an event was last recorded for a cell, or for a residency where it names none (spec 6.3; D203). */
  async lastAbout(db: Queryable, event: string, about: string): Promise<string | undefined> {
    const { rows } = await db.query(
      `select occurred_at as "occurredAt" from fleet.events where event = $1 and coalesce(cell_id, detail->>'residency') = $2 order by seq desc limit 1`,
      [event, about]);
    const at = (rows[0] as { occurredAt: Date | string } | undefined)?.occurredAt;
    return at === undefined ? undefined : new Date(at).toISOString();
  },

  async headHash(db: Queryable): Promise<Buffer | null> {
    const { rows } = await db.query('select hash from fleet.events order by seq desc limit 1');
    return (rows[0] as { hash: Buffer } | undefined)?.hash ?? null;
  },

  /** One event, at the end of the chain. */
  async append(db: Queryable, row: {
    event: string; occurredAt: string; releaseId: string | null; rolloutId: string | null; cellId: string | null; channel: string | null;
    operatorId: string | null; detail: Record<string, unknown>; previousHash: Buffer | null; hash: Buffer;
  }): Promise<void> {
    await db.query(
      `insert into fleet.events (event, occurred_at, release_id, rollout_id, cell_id, channel, operator_id, detail, previous_hash, hash)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [row.event, row.occurredAt, row.releaseId, row.rolloutId, row.cellId, row.channel, row.operatorId, JSON.stringify(row.detail),
        row.previousHash, row.hash]);
  },

  /** Events after a sequence, oldest first, for a release or a cell when named. */
  async list(db: Queryable, filter: { after: number; releaseId?: string | undefined; cellId?: string | undefined; limit: number }): Promise<FleetEventRow[]> {
    const { rows } = await db.query(
      `select seq::integer as seq, event, occurred_at as "occurredAt", release_id as "releaseId", rollout_id as "rolloutId", cell_id as "cellId",
              channel, operator_id as "operatorId", detail, previous_hash as "previousHash", hash
         from fleet.events
        where seq > $1 and ($2::text is null or release_id = $2) and ($3::text is null or cell_id = $3)
        order by seq limit $4`, [filter.after, filter.releaseId ?? null, filter.cellId ?? null, filter.limit]);
    return rows as FleetEventRow[];
  },

  /** The hash of the event before a sequence, or null at the start. */
  async hashBefore(db: Queryable, seq: number): Promise<Buffer | null> {
    const { rows } = await db.query('select hash from fleet.events where seq < $1 order by seq desc limit 1', [seq]);
    return (rows[0] as { hash: Buffer } | undefined)?.hash ?? null;
  },

  async migrationRecorded(db: Queryable, cellId: string, releaseId: string, database: string, version: string): Promise<boolean> {
    const { rows } = await db.query(
      `select exists (select 1 from fleet.events where event = 'migration_applied' and cell_id = $1 and release_id = $2
                        and detail ->> 'database' = $3 and detail ->> 'version' = $4) as found`, [cellId, releaseId, database, version]);
    return (rows[0] as { found: boolean }).found;
  },
};
