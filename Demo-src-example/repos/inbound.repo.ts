import type { Executor } from '../infra/db.infra';
import type { ConnectionStatus } from '../models/connection.model';
import type { IntakeTarget } from '../models/inbound.model';
import { generateId } from '../utils/tokens.util';
import { parseDocument } from './connector.repo';

/**
 * Inbound events, and the address they arrive at.
 *
 * TWO TABLES AND ONE OF THEM IS `connections`. The intake columns —
 * `intake_token_hash`, `intake_retention_hours`, `intake_last_seen_at` — were
 * added to `connections` by 025 and belong to this domain rather than to the
 * connection record: nothing outside intake writes them and nothing outside
 * intake reads them. Keeping them here is what stops "mint an address" being
 * spelled two ways.
 *
 * THE LOOKUP GOES THROUGH A `SECURITY DEFINER` FUNCTION AND THE WRITES DO NOT.
 * Resolving a token happens before any organisation is known, which is what row
 * level security is designed to prevent — so 026 opens one narrow hole that
 * takes a hash and returns one row. Everything after it runs inside the tenant
 * the token identified, under the ordinary policies.
 */

/* ── The address ────────────────────────────────────────────────────────── */

interface TargetRow {
  id: string;
  organisation_id: string;
  intake_retention_hours: number;
  status: ConnectionStatus;
  document: unknown;
  schema_version: number;
}

function mapTarget(row: TargetRow): IntakeTarget {
  return {
    connectionId: row.id,
    organisationId: row.organisation_id,
    retentionHours: row.intake_retention_hours,
    status: row.status,
    /* Throws on a manifest this process cannot parse — a mapping failure, not a
       decision about the sender. See the note in `.test/utils/layering.test.ts`. */
    manifest: parseDocument(row.document, row.schema_version),
  };
}

/**
 * Which connection an address belongs to.
 *
 * BY HASH, SO THE TABLE NEVER HOLDS A VALUE THAT WOULD LET SOMEBODY POST AS
 * THIS CONNECTION. Null for an unknown token and null for a rotated one; the
 * caller gives both the same answer, because anything more specific tells
 * whoever is guessing whether they are close.
 */
export async function findByIntakeTokenHash(
  db: Executor,
  tokenHash: string,
): Promise<IntakeTarget | null> {
  const { rows } = await db.query<TargetRow>(`SELECT * FROM connection_by_intake_token($1)`, [
    tokenHash,
  ]);

  const row = rows[0];
  return row ? mapTarget(row) : null;
}

/**
 * Issue an address for a connection, replacing whatever it had.
 *
 * MINTING REPLACES. There is one address per connection — `connections_intake_token`
 * is unique — so issuing a new one invalidates the old, which is what makes
 * "rotate this because it leaked" mean something.
 *
 * `COALESCE($3, intake_retention_hours)` KEEPS THE WINDOW WHEN NONE IS GIVEN,
 * so rotating an address does not silently reset how long this connection keeps
 * what it receives. The returned value is the window that now applies, read back
 * from the row rather than assumed from the argument.
 */
export async function mintAddress(
  db: Executor,
  input: { connectionId: string; tokenHash: string; retentionHours: number | null },
): Promise<number> {
  const { rows } = await db.query<{ intake_retention_hours: number }>(
    `UPDATE connections
        SET intake_token_hash = $2,
            intake_retention_hours = COALESCE($3, intake_retention_hours)
      WHERE id = $1
      RETURNING intake_retention_hours`,
    [input.connectionId, input.tokenHash, input.retentionHours],
  );

  const row = rows[0];
  if (!row) throw new Error(`Connection ${input.connectionId} vanished between read and mint`);
  return row.intake_retention_hours;
}

/** That something arrived. Its own statement, because a stored event is not the only proof. */
export async function noteSeen(db: Executor, connectionId: string): Promise<void> {
  await db.query(`UPDATE connections SET intake_last_seen_at = now() WHERE id = $1`, [connectionId]);
}

/* ── What arrived ───────────────────────────────────────────────────────── */

/**
 * Store one event.
 *
 * THE EXPIRY IS COMPUTED IN THE STATEMENT, from the connection's own retention
 * window. Doing the arithmetic in the process would date the row by the
 * application server's clock rather than the database's, and `inbound_events_bounded`
 * is checked against `received_at`, which the database sets.
 */
/** How long this connection keeps what arrives: capped by the column's CHECK, not by intention. */
export async function retentionOf(db: Executor, connectionId: string): Promise<number | null> {
  const { rows } = await db.query<{ intake_retention_hours: number }>(
    `SELECT intake_retention_hours FROM connections WHERE id = $1`,
    [connectionId],
  );
  return rows[0]?.intake_retention_hours ?? null;
}

export async function recordEvent(
  db: Executor,
  input: {
    organisationId: string;
    connectionId: string;
    objectName: string;
    payload: Record<string, unknown>;
    sourceLabel: string | null;
    retentionHours: number;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO inbound_events
       (id, organisation_id, connection_id, object_name, payload, source_label, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(hours => $7))`,
    [
      generateId(),
      input.organisationId,
      input.connectionId,
      input.objectName,
      JSON.stringify(input.payload),
      input.sourceLabel,
      input.retentionHours,
    ],
  );
}

/**
 * Delete what has expired, in the tenant this transaction is running as.
 *
 * NO `organisation_id` IN THE `WHERE`, AND THAT IS THE POINT. `inbound_events`
 * is under FORCE row level security and the policy is `organisation_id =
 * app_org_id()`, so the DELETE reaches exactly the caller's rows — the same
 * mechanism every other statement in this file relies on, rather than a filter
 * a future caller could forget. Returns how many went, which is therefore a
 * count of the caller's own events and of nobody else's.
 *
 * IT USED TO GO THROUGH `sweep_inbound_events()`, WHICH SWEEPS EVERY TENANT.
 * That function is `SECURITY DEFINER` and takes no arguments, so the count it
 * returned to a member of one organisation counted expired events belonging to
 * all of them — an activity signal for other customers, a call at a time. 049
 * takes the app role's grant away so the two cannot be confused again.
 */
export async function sweepExpired(db: Executor): Promise<number> {
  const { rowCount } = await db.query(`DELETE FROM inbound_events WHERE expires_at <= now()`);
  return rowCount ?? 0;
}

/**
 * What arrived for one object, newest first, inside its retention window.
 *
 * EXPIRY IS APPLIED AT READ TIME, NOT LEFT TO THE SWEEP. A sweep that has not
 * run yet must not quietly extend retention, so a row past `expires_at` is not
 * returned whether or not it has been reclaimed.
 */
export async function readPayloads(
  db: Executor,
  input: { connectionId: string; objectName: string; limit: number },
): Promise<Array<Record<string, unknown>>> {
  const { rows } = await db.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM inbound_events
      WHERE connection_id = $1 AND object_name = $2 AND expires_at > now()
      ORDER BY received_at DESC
      LIMIT $3`,
    [input.connectionId, input.objectName, Math.min(input.limit, 10_000)],
  );
  return rows.map((row) => row.payload);
}
