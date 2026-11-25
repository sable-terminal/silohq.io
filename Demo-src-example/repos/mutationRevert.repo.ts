import type { Executor } from '../infra/db.infra';
import type { Conflict, ConflictChoice } from '../engine/mutation/revert.mutation';
import type { MutationStatus } from './mutation.repo';

/**
 * Reverts: which change a revert undoes, and what was found and decided when it
 * was asked for.
 *
 * SQL, AND THE MAPPING BETWEEN A ROW AND A MODEL. What a revert writes is the
 * engine's three-way comparison; who may ask is the service's.
 */

export async function insert(
  db: Executor,
  input: {
    mutationId: string;
    organisationId: string;
    revertedMutationId: string;
    receiptId: string;
    conflicts: readonly Conflict[];
    choices: readonly ConflictChoice[];
    requestedBy: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO mutation_reverts
       (mutation_id, organisation_id, reverted_mutation_id, receipt_id, conflicts, resolutions, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.mutationId,
      input.organisationId,
      input.revertedMutationId,
      input.receiptId,
      JSON.stringify(input.conflicts),
      JSON.stringify(input.choices),
      input.requestedBy,
    ],
  );
}

/** Every revert asked for of one change, newest first, with where each has got to. */
export async function revertsOf(
  db: Executor,
  revertedMutationId: string,
): Promise<Array<{ mutationId: string; status: MutationStatus; requestedAt: Date }>> {
  const { rows } = await db.query<{ mutation_id: string; status: MutationStatus; requested_at: Date }>(
    `SELECT r.mutation_id, m.status, r.requested_at
       FROM mutation_reverts r
       JOIN mutations m ON m.id = r.mutation_id
      WHERE r.reverted_mutation_id = $1
      ORDER BY r.requested_at DESC`,
    [revertedMutationId],
  );
  return rows.map((row) => ({ mutationId: row.mutation_id, status: row.status, requestedAt: row.requested_at }));
}

/**
 * Changes made through Silo to these records' fields after a given moment.
 *
 * "WHO CHANGED THEM WHERE KNOWABLE" (§13). A change made through Silo is
 * knowable: it has a receipt naming who ran it. A change made in the source
 * directly is not, and the conflict says nothing rather than guessing.
 */
export async function laterWrites(
  db: Executor,
  input: { after: Date; excluding: string; records: ReadonlyArray<{ connectionId: string; ref: string }> },
): Promise<Array<{ mutationId: string; executedBy: string | null; connectionId: string; ref: string; fields: string[] }>> {
  if (input.records.length === 0) return [];

  const { rows } = await db.query<{
    mutation_id: string;
    executed_by: string | null;
    connection_id: string;
    ref: string;
    fields: string[];
  }>(
    `SELECT m.id AS mutation_id, m.executed_by, t.connection_id, t.ref, t.fields
       FROM mutation_targets t
       JOIN mutations m ON m.id = t.mutation_id
       JOIN jsonb_to_recordset($3::jsonb) AS r(connection_id uuid, ref text)
         ON r.connection_id = t.connection_id AND r.ref = t.ref
      WHERE m.status IN ('executed', 'partially_executed')
        AND m.created_at > $1
        AND m.id <> $2
      ORDER BY m.created_at`,
    [
      input.after,
      input.excluding,
      JSON.stringify(input.records.map((one) => ({ connection_id: one.connectionId, ref: one.ref }))),
    ],
  );

  return rows.map((row) => ({
    mutationId: row.mutation_id,
    executedBy: row.executed_by,
    connectionId: row.connection_id,
    ref: row.ref,
    fields: row.fields,
  }));
}
