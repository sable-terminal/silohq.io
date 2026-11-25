// Data access for platform.outbox, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  outboxTable,
  type NewOutbox,
  type Outbox,
  type OutboxPrimaryKey,
} from '../../models/platform/outbox.model.ts';

/** An outbox row as the relay claims it: what publishing needs, nothing more. */
export interface ClaimedOutboxRow {
  id: string;
  createdAt: string;
  seq: string;
  organisationId: string;
  topic: string;
  orderingKey: string;
  event: string;
  schemaVersion: number;
  payload: unknown;
  correlationId: string;
  attempts: number;
}

export const outboxRepo = {
  insert(db: Queryable, row: NewOutbox): Promise<Outbox> {
    return insertRow(db, outboxTable, row);
  },

  /**
   * A purge's entry in the purge ledger (spec 8.2; D251), in the transaction that completes the
   * purge: an outbox row the relay delivers to object-backup. The entry is
   * contracts/platform/purgeLedger.contract.ts's, references only; the relay checks it.
   */
  recordPurge(db: Queryable, input: { organisationId: string; correlationId: string; entry: { kind: string } & Record<string, unknown> }): Promise<Outbox> {
    return insertRow(db, outboxTable, {
      id: crypto.randomUUID(), organisationId: input.organisationId, topic: 'platform.purge_ledger', orderingKey: input.organisationId,
      event: 'purge_recorded', schemaVersion: 1, payload: input.entry as never, correlationId: input.correlationId,
    });
  },

  findByKey(db: Queryable, key: OutboxPrimaryKey): Promise<Outbox | undefined> {
    return findRow(db, outboxTable, key);
  },

  // The relay's three statements (design D21). Each is a security definer function, so the
  // relay's role reads across organisations without any table privilege. Only the head of
  // each ordering key is claimed: events of one key publish strictly in sequence.

  /** Claims due heads, leasing them for `leaseSeconds`; a crashed relay's lease runs out and the rows return. */
  /**
   * One audit event into every customer organisation's log (not the system or synthetic
   * organisation's): for what changes the whole cell, written by the migration role (D210).
   * How many logs it went to.
   */
  async insertForEveryOrganisation(db: Queryable, e: { topic: string; event: string; schemaVersion: number; payload: unknown; correlationId: string }): Promise<number> {
    const result = await db.query(
      `insert into platform.outbox (id, organisation_id, topic, ordering_key, event, schema_version, payload, correlation_id)
       select gen_random_uuid(), o.id, $1, o.id::text, $2, $3, $4, $5 from iam.organisations o where not o.is_system and not o.is_synthetic`,
      [e.topic, e.event, e.schemaVersion, JSON.stringify(e.payload), e.correlationId]);
    return result.rowCount ?? 0;
  },

  async claim(db: Queryable, limit: number, leaseSeconds: number): Promise<ClaimedOutboxRow[]> {
    const { rows } = await db.query(
      `select id, created_at as "createdAt", seq, organisation_id as "organisationId", topic, ordering_key as "orderingKey",
              event, schema_version as "schemaVersion", payload, correlation_id as "correlationId", attempts
       from platform.outbox_claim($1, make_interval(secs => $2))`, [limit, leaseSeconds]);
    return rows as ClaimedOutboxRow[];
  },

  /** Marks rows published on broker acknowledgement. Returns how many were still pending. */
  async markPublished(db: Queryable, keys: readonly { id: string; createdAt: string }[]): Promise<number> {
    if (keys.length === 0) return 0;
    const { rows } = await db.query('select platform.outbox_mark_published($1::uuid[], $2::timestamptz[]) as n',
      [keys.map((k) => k.id), keys.map((k) => k.createdAt)]);
    return (rows[0] as { n: number }).n;
  },

  /** Records a failed publish: a category only, and when to try again. Dead-letters a row older than 7 days. */
  async markFailed(db: Queryable, key: { id: string; createdAt: string }, errorCategory: string, retryAfterSeconds: number)
    : Promise<void> {
    await db.query('select platform.outbox_mark_failed($1, $2, $3, make_interval(secs => $4))',
      [key.id, key.createdAt, errorCategory, retryAfterSeconds]);
  },

  /** What waits to be published (up to 100,000) and the oldest's age in seconds: a release's health gate (spec 11.2). */
  async backlog(db: Queryable): Promise<{ pending: number; oldestSeconds: number }> {
    const { rows } = await db.query('select pending, oldest_seconds as "oldestSeconds" from platform.outbox_backlog()');
    return rows[0] as { pending: number; oldestSeconds: number };
  },
};
