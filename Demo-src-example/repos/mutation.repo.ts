import type { Executor } from '../infra/db.infra';
import type { MutationManifest, MutationOperation, ResolutionPolicy } from '../engine/mutation/resolve.mutation';
import type { MutationPreview, PriorState, RecordChange, Target } from '../engine/mutation/preview.mutation';

/**
 * Mutations: what was proposed, the records it lands on, and what they held.
 *
 * SQL, AND THE MAPPING BETWEEN A ROW AND A MODEL. Who may propose, who may see a
 * preview, and whether a mutation has lapsed are the service's decisions.
 */

export type MutationStatus =
  | 'previewed'
  | 'awaiting_approval'
  | 'approved'
  | 'rejected'
  | 'executing'
  | 'canary_paused'
  | 'executed'
  | 'partially_executed'
  | 'failed';

export interface Mutation {
  id: string;
  conceptId: string;
  /** The user's own words. */
  intent: string;
  manifest: MutationManifest;
  operation: MutationOperation;
  resolution: ResolutionPolicy;
  status: MutationStatus;
  proposedBy: string;
  /** The preview WITHOUT its per-record changes, which are read a page at a time. */
  preview: Omit<MutationPreview, 'changes'>;
  previewDigest: string;
  records: number;
  createdAt: Date;
  expiresAt: Date;
  /** Who ran it: the last approver, or where execution is separated, the person who ran it. */
  executedBy: string | null;
  canaryConfirmedBy: string | null;
  canaryConfirmedAt: Date | null;
}

type Row = {
  id: string;
  concept_id: string;
  intent: string;
  manifest: MutationManifest;
  operation: MutationOperation;
  resolution: ResolutionPolicy;
  status: MutationStatus;
  proposed_by: string;
  preview: Omit<MutationPreview, 'changes'>;
  preview_digest: string;
  records: number;
  created_at: Date;
  expires_at: Date;
  executed_by: string | null;
  canary_confirmed_by: string | null;
  canary_confirmed_at: Date | null;
};

/*
 * `preview - 'changes'`: a fifty-thousand-record diff is tens of megabytes, and
 * nothing that lists or summarises a mutation needs it.
 */
const COLUMNS = `id, concept_id, intent, manifest, operation, resolution, status, proposed_by,
                 preview - 'changes' AS preview, preview_digest, records, created_at, expires_at,
                 executed_by, canary_confirmed_by, canary_confirmed_at`;

/*
 * A CHANGE WHOSE RECEIPT IS PAST ITS WINDOW IS GONE TO EVERY READER, before the
 * sweep deletes it: its preview carries the same values the receipt does.
 */
const WITHIN_WINDOW = `NOT EXISTS (
  SELECT 1 FROM mutation_receipts r
    JOIN organisations o ON o.id = r.organisation_id
   WHERE r.mutation_id = mutations.id
     AND (r.retain_until <= now() OR r.created_at + make_interval(days => o.mutation_receipt_days) <= now())
)`;

const map = (row: Row): Mutation => ({
  id: row.id,
  conceptId: row.concept_id,
  intent: row.intent,
  manifest: row.manifest,
  operation: row.operation,
  resolution: row.resolution,
  status: row.status,
  proposedBy: row.proposed_by,
  preview: row.preview,
  previewDigest: row.preview_digest,
  records: row.records,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  executedBy: row.executed_by,
  canaryConfirmedBy: row.canary_confirmed_by,
  canaryConfirmedAt: row.canary_confirmed_at,
});

export async function insert(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    conceptId: string;
    intent: string;
    manifest: MutationManifest;
    proposedBy: string;
    preview: MutationPreview;
    previewDigest: string;
    expiresAt: Date;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO mutations
       (id, organisation_id, concept_id, intent, manifest, operation, resolution,
        proposed_by, preview, preview_digest, records, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      input.id,
      input.organisationId,
      input.conceptId,
      input.intent,
      JSON.stringify(input.manifest),
      input.manifest.operation,
      input.manifest.resolution,
      input.proposedBy,
      JSON.stringify(input.preview),
      input.previewDigest,
      input.preview.records,
      input.expiresAt,
    ],
  );
}

/*
 * IN CHUNKS, AS ONE JSON PARAMETER EACH. A bound of fifty thousand records per
 * system is fifty thousand rows here, and a statement with a parameter per value
 * passes Postgres's limit of 65,535 parameters long before that.
 */
const CHUNK = 2_000;

export async function insertTargets(
  db: Executor,
  input: { mutationId: string; organisationId: string; operation: MutationOperation; targets: readonly Target[] },
): Promise<void> {
  for (let start = 0; start < input.targets.length; start += CHUNK) {
    const chunk = input.targets.slice(start, start + CHUNK).map((target) => ({
      connection_id: target.connectionId,
      entity: target.entity,
      ref: target.ref,
      identifier: target.identifier,
      fields: target.fields,
    }));

    await db.query(
      `INSERT INTO mutation_targets
         (mutation_id, organisation_id, connection_id, entity, ref, identifier, operation, fields)
       SELECT $2, $3, r.connection_id, r.entity, r.ref, r.identifier, $4,
              ARRAY(SELECT jsonb_array_elements_text(r.fields))
         FROM jsonb_to_recordset($1::jsonb)
           AS r(connection_id uuid, entity integer, ref text, identifier jsonb, fields jsonb)`,
      [JSON.stringify(chunk), input.mutationId, input.organisationId, input.operation],
    );
  }
}

export async function insertPriorStates(
  db: Executor,
  input: { mutationId: string; organisationId: string; readAt: Date; states: readonly PriorState[] },
): Promise<void> {
  for (let start = 0; start < input.states.length; start += CHUNK) {
    const chunk = input.states.slice(start, start + CHUNK).map((state) => ({
      connection_id: state.connectionId,
      ref: state.ref,
      field: state.field,
      column_name: state.column,
      value: state.value,
    }));

    /* A JSON `null` arrives as SQL NULL from the recordset; it is stored as the
       JSON null it was, because "it was empty" is a prior state. */
    await db.query(
      `INSERT INTO prior_states
         (mutation_id, organisation_id, connection_id, ref, field, column_name, value, read_at)
       SELECT $2, $3, r.connection_id, r.ref, r.field, r.column_name,
              COALESCE(r.value, 'null'::jsonb), $4
         FROM jsonb_to_recordset($1::jsonb)
           AS r(connection_id uuid, ref text, field text, column_name text, value jsonb)`,
      [JSON.stringify(chunk), input.mutationId, input.organisationId, input.readAt],
    );
  }
}

export async function find(db: Executor, id: string): Promise<Mutation | null> {
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM mutations WHERE id = $1 AND ${WITHIN_WINDOW}`, [id]);
  return rows[0] ? map(rows[0]) : null;
}

/** The mutation, locked for the length of the transaction deciding what happens to it. */
export async function lock(db: Executor, id: string): Promise<Mutation | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM mutations WHERE id = $1 AND ${WITHIN_WINDOW} FOR UPDATE`,
    [id],
  );
  return rows[0] ? map(rows[0]) : null;
}

export async function list(
  db: Executor,
  input: { proposedBy?: string; status?: MutationStatus; limit: number },
): Promise<Mutation[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM mutations
      WHERE ($1::uuid IS NULL OR proposed_by = $1)
        AND ($2::text IS NULL OR status = $2)
        AND ${WITHIN_WINDOW}
      ORDER BY created_at DESC
      LIMIT $3`,
    [input.proposedBy ?? null, input.status ?? null, input.limit],
  );
  return rows.map(map);
}

/**
 * Move a mutation to a new status, and optionally bring its expiry forward.
 *
 * ONLY THESE TWO COLUMNS CAN MOVE; the trigger in 073 refuses anything else.
 */
export async function setStatus(
  db: Executor,
  input: { id: string; status: MutationStatus; expiresAt?: Date },
): Promise<void> {
  await db.query(
    `UPDATE mutations SET status = $2, expires_at = COALESCE($3, expires_at) WHERE id = $1`,
    [input.id, input.status, input.expiresAt ?? null],
  );
}

/** A page of the stored diff, in the order it was computed. */
export async function changes(
  db: Executor,
  input: { id: string; offset: number; limit: number },
): Promise<RecordChange[]> {
  const { rows } = await db.query<{ change: RecordChange }>(
    `SELECT c.change
       FROM mutations m,
            jsonb_array_elements(m.preview -> 'changes') WITH ORDINALITY AS c(change, position)
      WHERE m.id = $1
      ORDER BY c.position
      OFFSET $2 LIMIT $3`,
    [input.id, input.offset, input.limit],
  );
  return rows.map((row) => row.change);
}

/**
 * The whole preview, changes included.
 *
 * FOR THE TWO CALLERS THAT NEED EVERY RECORD: the run that writes them and the
 * receipt that records them. Everything else pages.
 */
export async function fullPreview(db: Executor, id: string): Promise<MutationPreview | null> {
  const { rows } = await db.query<{ preview: MutationPreview }>('SELECT preview FROM mutations WHERE id = $1', [id]);
  return rows[0]?.preview ?? null;
}

/** The records a mutation lands on, in the order they were resolved. */
export async function targets(db: Executor, mutationId: string): Promise<Target[]> {
  const { rows } = await db.query<{
    entity: number;
    connection_id: string;
    ref: string;
    identifier: Record<string, unknown>;
    fields: string[];
  }>(
    `SELECT entity, connection_id, ref, identifier, fields
       FROM mutation_targets WHERE mutation_id = $1
      ORDER BY entity, connection_id, ref`,
    [mutationId],
  );
  return rows.map((row) => ({
    entity: row.entity,
    connectionId: row.connection_id,
    ref: row.ref,
    identifier: row.identifier,
    fields: row.fields,
  }));
}

/** What each targeted record held, as read before anything was written. */
export async function priorStates(db: Executor, mutationId: string): Promise<PriorState[]> {
  const { rows } = await db.query<{
    connection_id: string;
    ref: string;
    field: string;
    column_name: string;
    value: unknown;
  }>(
    `SELECT connection_id, ref, field, column_name, value
       FROM prior_states WHERE mutation_id = $1
      ORDER BY connection_id, ref, field`,
    [mutationId],
  );
  return rows.map((row) => ({
    connectionId: row.connection_id,
    ref: row.ref,
    field: row.field,
    column: row.column_name,
    value: row.value,
  }));
}

/**
 * Remove every mutation past its expiry that nothing carried through.
 *
 * CROSS-TENANT, SO THE MIGRATOR'S. Called by the retention sweep; the
 * application role has no DELETE on `mutations`. Targets, prior states and the
 * approval chain go with the row.
 *
 * APPROVED BUT NOT RUN IS DISCARDED TOO. §9: "On expiry the mutation is
 * discarded, not held." An approval of a plan computed against yesterday's data
 * is not an approval of today's.
 */
export async function discardExpired(
  db: Executor,
): Promise<Array<{ id: string; organisationId: string; status: MutationStatus }>> {
  const { rows } = await db.query<{ id: string; organisation_id: string; status: MutationStatus }>(
    `DELETE FROM mutations
      WHERE expires_at <= now()
        AND status IN ('previewed', 'awaiting_approval', 'approved', 'rejected')
      RETURNING id, organisation_id, status`,
  );
  return rows.map((row) => ({ id: row.id, organisationId: row.organisation_id, status: row.status }));
}
