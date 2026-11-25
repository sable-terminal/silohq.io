import type { Executor } from '../infra/db.infra';
import type { TextSpan, ValueLocation } from '../models/document.model';

/**
 * Import §5 — where each value that is not certain was read.
 *
 * POSITIONS, A METHOD AND A SCORE. No value and no raw text is written or read
 * here; see 070 for why.
 */

export interface SiloExtraction {
  id: string;
  fileId: string;
  objectName: string;
  rowRef: string;
  fieldName: string;
  method: 'near' | 'inferred';
  confidence: number | null;
  location: ValueLocation | null;
  span: TextSpan | null;
  confirmedBy: string | null;
  confirmedAt: Date | null;
}

type Row = {
  id: string;
  file_id: string;
  object_name: string;
  row_ref: string;
  field_name: string;
  method: 'near' | 'inferred';
  confidence: string | null;
  page: number | null;
  box_x: string | null;
  box_y: string | null;
  box_width: string | null;
  box_height: string | null;
  text_offset: number | null;
  text_length: number | null;
  confirmed_by: string | null;
  confirmed_at: Date | null;
};

const map = (row: Row): SiloExtraction => ({
  id: row.id,
  fileId: row.file_id,
  objectName: row.object_name,
  rowRef: row.row_ref,
  fieldName: row.field_name,
  method: row.method,
  confidence: row.confidence === null ? null : Number(row.confidence),
  location:
    row.page === null
      ? null
      : {
          page: row.page,
          x: Number(row.box_x),
          y: Number(row.box_y),
          width: Number(row.box_width),
          height: Number(row.box_height),
        },
  span: row.text_offset === null || row.text_length === null ? null : { offset: row.text_offset, length: row.text_length },
  confirmedBy: row.confirmed_by,
  confirmedAt: row.confirmed_at,
});

/** One file's flagged values, in batches. Returns how many. */
export async function insertForFile(
  db: Executor,
  input: {
    organisationId: string;
    siloId: string;
    sourceId: string;
    fileId: string;
    extractions: Array<{
      objectName: string;
      rowRef: string;
      field: string;
      method: 'near' | 'inferred';
      confidence: number | null;
      location: ValueLocation | null;
      span: TextSpan | null;
    }>;
  },
): Promise<number> {
  let written = 0;

  for (let start = 0; start < input.extractions.length; start += 1000) {
    const batch = input.extractions.slice(start, start + 1000).map((one) => ({
      object_name: one.objectName,
      row_ref: one.rowRef,
      field_name: one.field,
      method: one.method,
      confidence: one.confidence,
      page: one.location?.page ?? null,
      box_x: one.location?.x ?? null,
      box_y: one.location?.y ?? null,
      box_width: one.location?.width ?? null,
      box_height: one.location?.height ?? null,
      text_offset: one.span?.offset ?? null,
      text_length: one.span?.length ?? null,
    }));

    const { rowCount } = await db.query(
      `INSERT INTO silo_extractions
         (id, organisation_id, silo_id, source_id, file_id, object_name, row_ref, field_name, method,
          confidence, page, box_x, box_y, box_width, box_height, text_offset, text_length)
       SELECT gen_random_uuid(), $1, $2, $3, $4, e.object_name, e.row_ref, e.field_name, e.method,
              e.confidence, e.page, e.box_x, e.box_y, e.box_width, e.box_height, e.text_offset, e.text_length
         FROM jsonb_to_recordset($5::jsonb) AS e(
           object_name text, row_ref text, field_name text, method text, confidence numeric,
           page integer, box_x numeric, box_y numeric, box_width numeric, box_height numeric,
           text_offset integer, text_length integer)
       ON CONFLICT (file_id, object_name, row_ref, field_name) DO NOTHING`,
      [input.organisationId, input.siloId, input.sourceId, input.fileId, JSON.stringify(batch)],
    );
    written += rowCount ?? 0;
  }

  return written;
}

/**
 * Every flagged value in one file, unconfirmed first.
 *
 * WITHOUT THIS THERE IS NO REVIEW. A flag could be explained and confirmed
 * only by somebody who already knew its object, row and field — which nothing
 * could tell them, so the two endpoints that act on a flag were unreachable
 * from the app. A list is what makes them a queue.
 *
 * STILL NO VALUES. Positions, a method and a score, as 070 says; the value is
 * in the rows and the raw text is read back out of the document when a flag is
 * opened.
 */
export async function flaggedOfFile(db: Executor, fileId: string): Promise<SiloExtraction[]> {
  const { rows } = await db.query<Row>(
    `SELECT id, file_id, object_name, row_ref, field_name, method, confidence, page,
            box_x, box_y, box_width, box_height, text_offset, text_length, confirmed_by, confirmed_at
       FROM silo_extractions
      WHERE file_id = $1
      ORDER BY confirmed_at NULLS FIRST, method DESC, confidence NULLS FIRST, row_ref, field_name`,
    [fileId],
  );
  return rows.map(map);
}

/**
 * How many values each of these files was unsure about, and how many nobody
 * has confirmed.
 *
 * COUNTED HERE BECAUSE THIS IS THE ONE REPO THAT MAY NAME THE TABLE. A
 * standing check (`importValueEgress`) holds the SQL for where uncertain
 * values were read to a single file, so the file listing asks for the counts
 * rather than joining to them itself.
 */
export async function countsOfFiles(
  db: Executor,
  fileIds: string[],
): Promise<Map<string, { flagged: number; unconfirmed: number }>> {
  if (fileIds.length === 0) return new Map();

  const { rows } = await db.query<{ file_id: string; flagged: string; unconfirmed: string }>(
    `SELECT file_id,
            count(*)::text AS flagged,
            count(*) FILTER (WHERE confirmed_at IS NULL)::text AS unconfirmed
       FROM silo_extractions
      WHERE file_id = ANY($1)
      GROUP BY file_id`,
    [fileIds],
  );

  return new Map(rows.map((row) => [row.file_id, { flagged: Number(row.flagged), unconfirmed: Number(row.unconfirmed) }]));
}

export async function find(
  db: Executor,
  input: { fileId: string; objectName: string; rowRef: string; field: string },
): Promise<SiloExtraction | null> {
  const { rows } = await db.query<Row>(
    `SELECT id, file_id, object_name, row_ref, field_name, method, confidence, page,
            box_x, box_y, box_width, box_height, text_offset, text_length, confirmed_by, confirmed_at
       FROM silo_extractions
      WHERE file_id = $1 AND object_name = $2 AND row_ref = $3 AND field_name = $4`,
    [input.fileId, input.objectName, input.rowRef, input.field],
  );
  return rows[0] ? map(rows[0]) : null;
}

/** With the file: its values' confirmations first, because they reference the values. */
export async function deleteOfFile(db: Executor, fileId: string): Promise<number> {
  await db.query(`DELETE FROM extraction_confirmations WHERE file_id = $1`, [fileId]);
  const { rowCount } = await db.query(`DELETE FROM silo_extractions WHERE file_id = $1`, [fileId]);
  return rowCount ?? 0;
}

/**
 * A file read again replaces what nobody has confirmed, and keeps what somebody
 * has. §5 — "it becomes certain, permanently, for that value."
 */
export async function deleteUnconfirmedOfFile(db: Executor, fileId: string): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM silo_extractions WHERE file_id = $1 AND confirmed_at IS NULL`,
    [fileId],
  );
  return rowCount ?? 0;
}

/** The values in a file somebody has confirmed, as `object\u0000row\u0000field`. */
export async function confirmedKeysOf(db: Executor, fileId: string): Promise<Set<string>> {
  const { rows } = await db.query<{ object_name: string; row_ref: string; field_name: string }>(
    `SELECT object_name, row_ref, field_name FROM silo_extractions
      WHERE file_id = $1 AND confirmed_at IS NOT NULL`,
    [fileId],
  );
  return new Set(rows.map((row) => `${row.object_name}\u0000${row.row_ref}\u0000${row.field_name}`));
}

/** Null when it was already confirmed: a value is confirmed once. */
export async function confirm(db: Executor, input: { id: string; membershipId: string }): Promise<Date | null> {
  const { rows } = await db.query<{ confirmed_at: Date }>(
    `UPDATE silo_extractions SET confirmed_by = $2, confirmed_at = now()
      WHERE id = $1 AND confirmed_at IS NULL
  RETURNING confirmed_at`,
    [input.id, input.membershipId],
  );
  return rows[0]?.confirmed_at ?? null;
}

export async function recordConfirmation(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    extractionId: string;
    fileId: string;
    membershipId: string;
    previousMethod: 'near' | 'inferred';
  },
): Promise<void> {
  await db.query(
    `INSERT INTO extraction_confirmations (id, organisation_id, extraction_id, file_id, membership_id, previous_method)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [input.id, input.organisationId, input.extractionId, input.fileId, input.membershipId, input.previousMethod],
  );
}

export async function deleteOfObject(db: Executor, input: { sourceId: string; objectName: string }): Promise<number> {
  await db.query(
    `DELETE FROM extraction_confirmations
      WHERE extraction_id IN (SELECT id FROM silo_extractions WHERE source_id = $1 AND object_name = $2)`,
    [input.sourceId, input.objectName],
  );
  const { rowCount } = await db.query(
    `DELETE FROM silo_extractions WHERE source_id = $1 AND object_name = $2`,
    [input.sourceId, input.objectName],
  );
  return rowCount ?? 0;
}
