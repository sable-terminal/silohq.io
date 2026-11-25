import type { Executor } from '../infra/db.infra';
import { generateId } from '../utils/tokens.util';

/**
 * Siloes (138) — what Silo has worked out about a kept concept: which table of
 * it is being served, and the Postgres stand-in for where the rows live.
 *
 * SQL, and the mapping between a row and a model. What is worked out, and who
 * may read it, is the service's.
 */

export type LearnedKind = 'matches' | 'fields' | 'values';

export interface Learned {
  id: string;
  siloId: string;
  conceptId: string;
  kind: LearnedKind;
  batchId: string;
  madeAt: Date;
  rows: number;
  /** Counts, for the Silo's page. Never a value from a record. */
  summary: Record<string, unknown>;
  organisationId: string;
}

interface Row {
  id: string;
  silo_id: string;
  concept_id: string;
  kind: LearnedKind;
  batch_id: string;
  made_at: Date;
  rows: number;
  summary: Record<string, unknown>;
  organisation_id: string;
}

const map = (row: Row): Learned => ({
  id: row.id,
  siloId: row.silo_id,
  conceptId: row.concept_id,
  kind: row.kind,
  batchId: row.batch_id,
  madeAt: row.made_at,
  rows: row.rows,
  summary: row.summary,
  organisationId: row.organisation_id,
});

/**
 * What is served of these concepts, inside each one's Silo's window.
 *
 * THE WINDOW IS DECIDED HERE, as it is for a copy: a table older than it is
 * unreadable from the moment it is, swept or not.
 */
export async function forConcepts(db: Executor, conceptIds: readonly string[]): Promise<Learned[]> {
  if (conceptIds.length === 0) return [];
  const { rows } = await db.query<Row>(
    `SELECT l.id, l.silo_id, l.concept_id, l.kind, l.batch_id, l.made_at, l.rows, l.summary, l.organisation_id
       FROM silo_learned l
       JOIN siloes s ON s.id = l.silo_id
      WHERE l.concept_id = ANY($1) AND l.made_at >= now() - make_interval(days => s.retention_days)
      ORDER BY l.concept_id, l.kind`,
    [[...conceptIds]],
  );
  return rows.map(map);
}

/** A newly made table is the one served. Returns the batch it replaced, if there was one. */
export async function serve(
  db: Executor,
  input: {
    organisationId: string;
    siloId: string;
    conceptId: string;
    kind: LearnedKind;
    batchId: string;
    madeAt: Date;
    rows: number;
    summary: Record<string, unknown>;
  },
): Promise<string | null> {
  const before = await db.query<{ batch_id: string }>(`SELECT batch_id FROM silo_learned WHERE concept_id = $1 AND kind = $2`, [input.conceptId, input.kind]);

  await db.query(
    `INSERT INTO silo_learned (id, organisation_id, silo_id, concept_id, kind, batch_id, made_at, rows, summary)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (concept_id, kind) DO UPDATE
       SET silo_id = EXCLUDED.silo_id, batch_id = EXCLUDED.batch_id, made_at = EXCLUDED.made_at, rows = EXCLUDED.rows, summary = EXCLUDED.summary`,
    [generateId(), input.organisationId, input.siloId, input.conceptId, input.kind, input.batchId, input.madeAt, input.rows, JSON.stringify(input.summary)],
  );
  await db.query(`DELETE FROM silo_learned_rows WHERE concept_id = $1 AND kind = $2 AND batch_id <> $3`, [input.conceptId, input.kind, input.batchId]);

  return before.rows[0]?.batch_id ?? null;
}

/** Stop serving some or all of what was worked out about a concept, and remove the stand-in's rows. Returns what went. */
export async function forget(db: Executor, conceptId: string, kinds?: readonly LearnedKind[]): Promise<Array<{ kind: LearnedKind; batchId: string }>> {
  const which = kinds ? [...kinds] : ['matches', 'fields', 'values'];
  const { rows } = await db.query<{ kind: LearnedKind; batch_id: string }>(
    `DELETE FROM silo_learned WHERE concept_id = $1 AND kind = ANY($2) RETURNING kind, batch_id`,
    [conceptId, which],
  );
  await db.query(`DELETE FROM silo_learned_rows WHERE concept_id = $1 AND kind = ANY($2)`, [conceptId, which]);
  return rows.map((row) => ({ kind: row.kind, batchId: row.batch_id }));
}

/**
 * Tables older than their Silo's window, across every organisation.
 *
 * FOR THE RETENTION SWEEP, ON ITS OWN CONNECTION. Already unreadable; this is
 * what finds them to be deleted.
 */
export async function expired(db: Executor): Promise<Array<{ organisationId: string; siloId: string; conceptId: string; kind: LearnedKind; batchId: string }>> {
  const { rows } = await db.query<{ organisation_id: string; silo_id: string; concept_id: string; kind: LearnedKind; batch_id: string }>(
    `SELECT l.organisation_id, l.silo_id, l.concept_id, l.kind, l.batch_id
       FROM silo_learned l JOIN siloes s ON s.id = l.silo_id
      WHERE l.made_at < now() - make_interval(days => s.retention_days)`,
  );
  return rows.map((row) => ({ organisationId: row.organisation_id, siloId: row.silo_id, conceptId: row.concept_id, kind: row.kind, batchId: row.batch_id }));
}

/* ── The Postgres stand-in for the warehouse ─────────────────────────────── */

export async function insertRows(
  db: Executor,
  input: { organisationId: string; conceptId: string; kind: LearnedKind; batchId: string; at: Date; rows: ReadonlyArray<Record<string, unknown>> },
): Promise<void> {
  if (input.rows.length === 0) return;
  await db.query(
    `INSERT INTO silo_learned_rows (id, organisation_id, concept_id, kind, batch_id, record, made_at)
     SELECT gen_random_uuid(), $1, $2, $3, $4, value, $5 FROM jsonb_array_elements($6::jsonb)`,
    [input.organisationId, input.conceptId, input.kind, input.batchId, input.at, JSON.stringify(input.rows)],
  );
}

/** Rows of one table as served. `where` narrows by a column's text, for the one read a question makes. */
export async function readRows(
  db: Executor,
  input: { conceptId: string; kind: LearnedKind; batchId: string; where?: { field: string; equals: string }; limit: number },
): Promise<Array<Record<string, unknown>>> {
  const args: unknown[] = [input.conceptId, input.kind, input.batchId];
  let narrowed = '';
  if (input.where) {
    args.push(input.where.field, input.where.equals);
    narrowed = `AND r.record->>$4 = $5`;
  }
  args.push(input.limit);

  const { rows } = await db.query<{ record: Record<string, unknown> }>(
    `SELECT r.record FROM silo_learned_rows r
      WHERE r.concept_id = $1 AND r.kind = $2 AND r.batch_id = $3 ${narrowed}
      LIMIT $${args.length}`,
    args,
  );
  return rows.map((row) => row.record);
}
