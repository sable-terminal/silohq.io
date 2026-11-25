import type { Executor } from '../infra/db.infra';
import type { AuthEvent, AuditEntry } from '../utils/audit.util';

/**
 * The audit trail.
 *
 * INSERT AND SELECT ONLY, ENFORCED BY GRANT. The application role has no UPDATE
 * and no DELETE on this table — checked in `002_auth.sql` and provable with a
 * query against `information_schema`. There is no function here to change a row
 * because there is no privilege to do it.
 *
 * WRITTEN IN THE SAME TRANSACTION AS THE THING IT RECORDS. A separate transaction
 * can commit while the action rolls back, producing an audit trail describing
 * something that never happened — or the reverse, which is worse.
 */

export interface StoredEvent {
  id: string;
  organisationId: string;
  membershipId: string | null;
  userId: string | null;
  event: AuthEvent;
  detail: Record<string, unknown>;
  ipHash: string | null;
  occurredAt: Date;
}

interface Row {
  id: string;
  organisation_id: string;
  membership_id: string | null;
  user_id: string | null;
  event: AuthEvent;
  detail: Record<string, unknown>;
  ip_hash: string | null;
  occurred_at: Date;
}

function map(row: Row): StoredEvent {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    membershipId: row.membership_id,
    userId: row.user_id,
    event: row.event,
    detail: row.detail,
    ipHash: row.ip_hash,
    occurredAt: row.occurred_at,
  };
}

export async function write(db: Executor, entry: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO auth_events (organisation_id, membership_id, user_id, event, detail, ip_hash, occurred_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [
      entry.organisationId,
      entry.membershipId,
      entry.userId,
      entry.event,
      JSON.stringify(entry.detail),
      entry.ipHash ?? null,
      entry.occurredAt,
    ],
  );
}

/**
 * The reviewer's query: what happened here, in this window.
 *
 * KEYSET PAGINATION ON `(occurred_at, id)`, NOT `OFFSET`. This table grows without
 * bound, and `OFFSET 50000` makes Postgres walk fifty thousand rows to discard
 * them. The composite key is needed because two events can share a timestamp, and
 * ordering by time alone makes the page boundary non-deterministic — a row is
 * then shown twice or skipped.
 */
export async function list(
  db: Executor,
  filter: {
    from?: Date;
    to?: Date;
    event?: AuthEvent;
    membershipId?: string;
    before?: { occurredAt: Date; id: string };
    limit?: number;
  } = {},
): Promise<StoredEvent[]> {
  const { rows } = await db.query<Row>(
    `SELECT id::text, organisation_id, membership_id, user_id, event, detail, ip_hash, occurred_at
       FROM auth_events
      WHERE ($1::timestamptz IS NULL OR occurred_at >= $1)
        AND ($2::timestamptz IS NULL OR occurred_at <= $2)
        AND ($3::text IS NULL OR event = $3)
        AND ($4::uuid IS NULL OR membership_id = $4)
        AND ($5::timestamptz IS NULL OR (occurred_at, id) < ($5, $6::bigint))
      ORDER BY occurred_at DESC, id DESC
      LIMIT $7`,
    [
      filter.from ?? null,
      filter.to ?? null,
      filter.event ?? null,
      filter.membershipId ?? null,
      filter.before?.occurredAt ?? null,
      filter.before?.id ?? null,
      filter.limit ?? 100,
    ],
  );
  return rows.map(map);
}
