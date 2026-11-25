import type { Executor } from '../infra/db.infra';
import type { Verification } from '../engine/mutation/execute.mutation';
import type { Receipt, ReceiptExecution } from '../engine/mutation/receipt.mutation';

/**
 * A change carried out: claims on the run, each system's execution, each
 * record's verification, and the receipt.
 *
 * SQL, AND THE MAPPING BETWEEN A ROW AND A MODEL. What to write, whether a
 * record may still be written and what its outcome is are the engine's; who may
 * run a change is the service's.
 */

export type Phase = 'canary' | 'remainder' | 'full';

/* ── The run ─────────────────────────────────────────────────────────────── */

/**
 * Take a mutation for running, from one of the statuses it may be run from.
 *
 * ONE UPDATE, SO ONE WINNER. Two instances asked to run the same change race on
 * this row, and the one whose `WHERE` no longer matches gets nothing back.
 */
export async function claim(
  db: Executor,
  input: { id: string; from: readonly string[]; executedBy?: string | null },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE mutations
        SET status = 'executing', claimed_at = now(), executed_by = COALESCE($3, executed_by)
      WHERE id = $1 AND status = ANY($2::text[])`,
    [input.id, [...input.from], input.executedBy ?? null],
  );
  return (rowCount ?? 0) > 0;
}

/** Still running: a long run keeps its claim fresh so nothing mistakes it for abandoned. */
export async function heartbeat(db: Executor, id: string): Promise<void> {
  await db.query(`UPDATE mutations SET claimed_at = now() WHERE id = $1 AND status = 'executing'`, [id]);
}

/** Move a run on, from the status it is in, to the next. */
export async function settleRun(
  db: Executor,
  input: { id: string; status: 'canary_paused' | 'executed' | 'partially_executed' | 'failed' },
): Promise<void> {
  await db.query(`UPDATE mutations SET status = $2, claimed_at = now() WHERE id = $1`, [input.id, input.status]);
}

export async function confirmCanary(db: Executor, input: { id: string; by: string }): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE mutations
        SET status = 'executing', claimed_at = now(), canary_confirmed_at = now(), canary_confirmed_by = $2
      WHERE id = $1 AND status = 'canary_paused'`,
    [input.id, input.by],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Runs an instance abandoned, and canaries nobody decided on.
 *
 * CROSS-TENANT, SO THE MIGRATOR'S. Called by the scheduled pickup.
 */
export async function stranded(
  db: Executor,
  input: { runningMinutes: number; pausedHours: number },
): Promise<Array<{ id: string; organisationId: string; status: 'executing' | 'canary_paused' }>> {
  const { rows } = await db.query<{ id: string; organisation_id: string; status: 'executing' | 'canary_paused' }>(
    `SELECT id, organisation_id, status FROM mutations
      WHERE (status = 'executing' AND claimed_at < now() - make_interval(mins => $1))
         OR (status = 'canary_paused' AND claimed_at < now() - make_interval(hours => $2))
      ORDER BY claimed_at`,
    [input.runningMinutes, input.pausedHours],
  );
  return rows.map((row) => ({ id: row.id, organisationId: row.organisation_id, status: row.status }));
}

/* ── Executions ──────────────────────────────────────────────────────────── */

/** Open this system's execution for a phase, or return the one an earlier attempt opened. */
export async function openExecution(
  db: Executor,
  input: { id: string; mutationId: string; organisationId: string; connectionId: string; phase: Phase },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO mutation_executions (id, mutation_id, organisation_id, connection_id, phase)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (mutation_id, connection_id, phase) DO UPDATE SET status = mutation_executions.status
     RETURNING id`,
    [input.id, input.mutationId, input.organisationId, input.connectionId, input.phase],
  );
  return rows[0]!.id;
}

export async function closeExecution(
  db: Executor,
  input: {
    id: string;
    status: ReceiptExecution['status'];
    records: number;
    applied: number;
    failed: number;
    error: string | null;
  },
): Promise<void> {
  await db.query(
    `UPDATE mutation_executions
        SET status = $2, records = $3, applied = $4, failed = $5, error = $6,
            completed_at = CASE WHEN $2 = 'running' THEN NULL ELSE now() END
      WHERE id = $1`,
    [input.id, input.status, input.records, input.applied, input.failed, input.error],
  );
}

type ExecutionRow = {
  connection_id: string;
  phase: Phase;
  status: ReceiptExecution['status'];
  records: number;
  applied: number;
  failed: number;
  attempted_at: Date;
  completed_at: Date | null;
  error: string | null;
};

export async function executions(db: Executor, mutationId: string): Promise<ReceiptExecution[]> {
  const { rows } = await db.query<ExecutionRow>(
    `SELECT connection_id, phase, status, records, applied, failed, attempted_at, completed_at, error
       FROM mutation_executions WHERE mutation_id = $1
      ORDER BY attempted_at, connection_id`,
    [mutationId],
  );
  return rows.map((row) => ({
    connectionId: row.connection_id,
    phase: row.phase,
    status: row.status,
    records: row.records,
    applied: row.applied,
    failed: row.failed,
    attemptedAt: row.attempted_at,
    completedAt: row.completed_at,
    error: row.error,
  }));
}

/* ── Verifications ───────────────────────────────────────────────────────── */

/** Records of this system that have an outcome already, in any phase. */
export async function settledRefs(db: Executor, input: { mutationId: string; connectionId: string }): Promise<Set<string>> {
  const { rows } = await db.query<{ ref: string }>(
    `SELECT DISTINCT v.ref
       FROM mutation_verifications v
       JOIN mutation_executions e ON e.id = v.execution_id
      WHERE e.mutation_id = $1 AND v.connection_id = $2`,
    [input.mutationId, input.connectionId],
  );
  return new Set(rows.map((row) => row.ref));
}

/**
 * One execution's records and what became of each.
 *
 * A RECORD REACHED THE SOURCE IF ANY FIELD OF IT DID; it is verified only if
 * every field is. Counted here from the rows rather than kept as running totals,
 * so a run resumed after a crash counts what was actually recorded.
 */
export async function outcomesOf(
  db: Executor,
  executionId: string,
): Promise<Array<{ ref: string; applied: boolean; diverged: boolean; verified: boolean }>> {
  const { rows } = await db.query<{ ref: string; applied: boolean; diverged: boolean; verified: boolean }>(
    `SELECT ref,
            bool_or(outcome <> 'failed')    AS applied,
            bool_or(outcome = 'diverged')   AS diverged,
            bool_and(outcome = 'verified')  AS verified
       FROM mutation_verifications WHERE execution_id = $1
      GROUP BY ref
      ORDER BY ref`,
    [executionId],
  );
  return rows;
}

/**
 * Take over a run whose claim has gone quiet.
 *
 * CONDITIONAL ON THE CLAIM STILL BEING OLD, so two pickups that found the same
 * stranded run cannot both take it.
 */
export async function reclaim(db: Executor, input: { id: string; minutes: number }): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE mutations SET claimed_at = now()
      WHERE id = $1 AND status = 'executing' AND claimed_at < now() - make_interval(mins => $2)`,
    [input.id, input.minutes],
  );
  return (rowCount ?? 0) > 0;
}

const CHUNK = 2_000;

export async function insertVerifications(
  db: Executor,
  input: { executionId: string; organisationId: string; connectionId: string; rows: readonly Verification[] },
): Promise<void> {
  for (let start = 0; start < input.rows.length; start += CHUNK) {
    /*
     * WRAPPED, SO A VALUE THAT WAS READ AS EMPTY SURVIVES AS JSON `null` and one
     * never read is SQL NULL. A recordset turns a bare JSON null into SQL NULL,
     * and "the field was empty" would become "nothing came back".
     */
    const chunk = input.rows.slice(start, start + CHUNK).map((row) => ({
      ref: row.ref,
      field: row.field,
      intended: 'intended' in row && row.intended !== undefined ? { v: row.intended } : null,
      observed: 'observed' in row && row.observed !== undefined ? { v: row.observed } : null,
      outcome: row.outcome,
      detail: row.detail,
    }));

    await db.query(
      `INSERT INTO mutation_verifications
         (execution_id, organisation_id, connection_id, ref, field, intended, observed, outcome, detail)
       SELECT $2, $3, $4, r.ref, r.field, r.intended -> 'v', r.observed -> 'v', r.outcome, r.detail
         FROM jsonb_to_recordset($1::jsonb)
           AS r(ref text, field text, intended jsonb, observed jsonb, outcome text, detail text)
       ON CONFLICT DO NOTHING`,
      [JSON.stringify(chunk), input.executionId, input.organisationId, input.connectionId],
    );
  }
}

export async function verifications(
  db: Executor,
  mutationId: string,
): Promise<Array<Verification & { connectionId: string }>> {
  const { rows } = await db.query<{
    connection_id: string;
    ref: string;
    field: string | null;
    intended: unknown;
    observed: unknown;
    outcome: Verification['outcome'];
    detail: string | null;
    unintended: boolean;
    unread: boolean;
  }>(
    /* The driver reads SQL NULL and JSON null alike as null, so which it was is asked for. */
    `SELECT v.connection_id, v.ref, v.field, v.intended, v.observed, v.outcome, v.detail,
            v.intended IS NULL AS unintended, v.observed IS NULL AS unread
       FROM mutation_verifications v
       JOIN mutation_executions e ON e.id = v.execution_id
      WHERE e.mutation_id = $1
      ORDER BY v.connection_id, v.ref, v.field NULLS FIRST`,
    [mutationId],
  );
  return rows.map((row) => ({
    connectionId: row.connection_id,
    ref: row.ref,
    field: row.field,
    ...(row.unintended ? {} : { intended: row.intended }),
    ...(row.unread ? {} : { observed: row.observed }),
    outcome: row.outcome,
    detail: row.detail,
  }));
}

/* ── The receipt ─────────────────────────────────────────────────────────── */

export async function insertReceipt(
  db: Executor,
  input: {
    id: string;
    mutationId: string;
    organisationId: string;
    document: Receipt;
    digest: string;
    retainUntil: Date;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO mutation_receipts (id, mutation_id, organisation_id, document, digest, retain_until)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [input.id, input.mutationId, input.organisationId, JSON.stringify(input.document), input.digest, input.retainUntil],
  );
}

/**
 * A receipt, while it is inside its window.
 *
 * PAST ITS WINDOW IT CANNOT BE READ, EVEN BEFORE THE SWEEP DELETES IT. The
 * window is the shorter of the date it was written with and the organisation's
 * current choice, so shortening the window ends older receipts at once.
 */
export async function receiptFor(
  db: Executor,
  mutationId: string,
): Promise<{ id: string; document: Receipt; digest: string; createdAt: Date; retainUntil: Date } | null> {
  const { rows } = await db.query<{
    id: string;
    document: Receipt;
    digest: string;
    created_at: Date;
    retain_until: Date;
  }>(
    `SELECT r.id, r.document, r.digest, r.created_at,
            LEAST(r.retain_until, r.created_at + make_interval(days => o.mutation_receipt_days)) AS retain_until
       FROM mutation_receipts r
       JOIN organisations o ON o.id = r.organisation_id
      WHERE r.mutation_id = $1
        AND r.retain_until > now()
        AND r.created_at + make_interval(days => o.mutation_receipt_days) > now()`,
    [mutationId],
  );
  const row = rows[0];
  return row
    ? { id: row.id, document: row.document, digest: row.digest, createdAt: row.created_at, retainUntil: row.retain_until }
    : null;
}

/**
 * Remove every receipt past its retention date, with the mutation it records
 * and everything under it.
 *
 * CROSS-TENANT, SO THE MIGRATOR'S, like every sweep.
 */
export async function sweepReceipts(db: Executor): Promise<Array<{ id: string; organisationId: string }>> {
  const { rows } = await db.query<{ id: string; organisation_id: string }>(
    `DELETE FROM mutations m
      USING mutation_receipts r, organisations o
      WHERE r.mutation_id = m.id
        AND o.id = r.organisation_id
        AND (r.retain_until <= now() OR r.created_at + make_interval(days => o.mutation_receipt_days) <= now())
      RETURNING m.id, m.organisation_id`,
  );
  return rows.map((row) => ({ id: row.id, organisationId: row.organisation_id }));
}

/* ── The organisation's window ───────────────────────────────────────────── */

export async function receiptDays(db: Executor, organisationId: string): Promise<number> {
  const { rows } = await db.query<{ days: number }>(
    'SELECT mutation_receipt_days AS days FROM organisations WHERE id = $1',
    [organisationId],
  );
  return rows[0]?.days ?? 365;
}

export async function setReceiptDays(db: Executor, input: { organisationId: string; days: number }): Promise<void> {
  await db.query('UPDATE organisations SET mutation_receipt_days = $2 WHERE id = $1', [input.organisationId, input.days]);
}

/** Remove a change and everything kept for it: the purge's one statement. */
export async function purge(db: Executor, mutationId: string): Promise<boolean> {
  const { rowCount } = await db.query('DELETE FROM mutations WHERE id = $1', [mutationId]);
  return (rowCount ?? 0) > 0;
}
