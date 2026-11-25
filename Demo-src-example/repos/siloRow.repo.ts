import type { Executor } from '../infra/db.infra';
import type { ExtractedRow, ExtractionMethod, StoredField, StoredFieldType } from '../models/rowStore.model';

/**
 * Import §7 — the Postgres stand-in for the BigQuery row store.
 *
 * THE SAME CONTRACT AS `bigquery.infra`, so the query path cannot tell which is
 * underneath: parameterised reads with typed comparisons, deletes by file,
 * object and source, and a byte count for metering.
 *
 * FIELD NAMES ARE PARAMETERS HERE, not interpolated. `record->>$1` takes the
 * name as a value, so no identifier from a definition is ever spliced into SQL.
 */

export type Comparison = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'is_null';

export interface StoredRow {
  values: Record<string, unknown>;
  fileId: string;
  rowRef: string;
  methods: Record<string, Exclude<ExtractionMethod, 'certain'>>;
}

const CAST: Record<StoredFieldType, string> = {
  string: 'text',
  number: 'numeric',
  boolean: 'boolean',
  date: 'date',
  datetime: 'timestamptz',
  json: 'jsonb',
};

/** Insert one file's rows for one object, in batches. Returns how many. */
export async function insertRows(
  db: Executor,
  input: {
    organisationId: string;
    siloId: string;
    sourceId: string;
    fileId: string;
    objectName: string;
    receivedAt: Date;
    rows: ExtractedRow[];
  },
): Promise<number> {
  let written = 0;

  for (let start = 0; start < input.rows.length; start += 1000) {
    const batch = input.rows.slice(start, start + 1000).map((row) => ({
      row_ref: row.rowRef,
      record: row.values,
      methods: row.methods,
    }));

    const { rowCount } = await db.query(
      `INSERT INTO silo_rows
         (id, organisation_id, silo_id, source_id, file_id, object_name, row_ref, record, methods, received_at)
       SELECT gen_random_uuid(), $1, $2, $3, $4, $5, r.row_ref, r.record, r.methods, $6
         FROM jsonb_to_recordset($7::jsonb) AS r(row_ref text, record jsonb, methods jsonb)`,
      [
        input.organisationId, input.siloId, input.sourceId, input.fileId, input.objectName,
        input.receivedAt, JSON.stringify(batch),
      ],
    );
    written += rowCount ?? 0;
  }

  return written;
}

/**
 * Read one object's rows under a query the engine planned.
 *
 * `neq` INCLUDES NULL, as the engine's in-memory `matches` does: a missing value
 * is not equal to anything. A JSON field cannot be compared, in either store.
 */
export async function readRows(
  db: Executor,
  input: {
    sourceId: string;
    objectName: string;
    fields: StoredField[];
    filters: Array<{ field: string; op: Comparison; value?: unknown }>;
    sort: Array<{ field: string; direction: 'asc' | 'desc' }>;
    limit: number;
    sinceReceived: Date;
  },
): Promise<{ rows: StoredRow[]; bytes: number }> {
  const types = new Map(input.fields.map((f) => [f.name, f.type]));
  const args: unknown[] = [input.sourceId, input.objectName, input.sinceReceived];
  const conditions: string[] = [];

  const typeOf = (name: string): StoredFieldType => {
    const type = types.get(name);
    if (!type) throw new Error(`${name} is not a field of ${input.objectName}.`);
    return type;
  };
  const param = (value: unknown) => {
    args.push(value);
    return `$${args.length}`;
  };

  for (const filter of input.filters) {
    const type = typeOf(filter.field);
    if (type === 'json') throw new Error(`${filter.field} holds JSON and cannot be filtered.`);

    const expr = `(r.record->>${param(filter.field)})::${CAST[type]}`;

    switch (filter.op) {
      case 'is_null':
        conditions.push(`${expr} IS NULL`);
        break;
      case 'in': {
        const values = (Array.isArray(filter.value) ? filter.value : [filter.value]).map((v) =>
          v === null || v === undefined ? null : String(v),
        );
        conditions.push(`${expr} = ANY(${param(values)}::${CAST[type]}[])`);
        break;
      }
      case 'neq':
        conditions.push(`(${expr} IS NULL OR ${expr} <> ${param(String(filter.value))}::${CAST[type]})`);
        break;
      default: {
        const operator = { eq: '=', gt: '>', gte: '>=', lt: '<', lte: '<=' }[filter.op];
        conditions.push(`${expr} ${operator} ${param(String(filter.value))}::${CAST[type]}`);
      }
    }
  }

  const order = input.sort.length
    ? input.sort
        .map((one) => `(r.record->>${param(one.field)})::${CAST[typeOf(one.field)]} ${one.direction === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`)
        .join(', ')
    : 'r.received_at DESC, r.row_ref';

  const limit = param(input.limit);

  const { rows } = await db.query<{
    record: Record<string, unknown>;
    methods: StoredRow['methods'];
    file_id: string;
    row_ref: string;
    bytes: number;
  }>(
    `SELECT r.record, r.methods, r.file_id, r.row_ref, pg_column_size(r.*) AS bytes
       FROM silo_rows r
      WHERE r.source_id = $1 AND r.object_name = $2 AND r.received_at >= $3
        ${conditions.map((c) => `AND ${c}`).join('\n        ')}
      ORDER BY ${order}
      LIMIT ${limit}`,
    args,
  );

  return {
    rows: rows.map((row) => ({
      values: row.record,
      fileId: row.file_id,
      rowRef: row.row_ref,
      methods: row.methods,
    })),
    bytes: rows.reduce((sum, row) => sum + Number(row.bytes), 0),
  };
}

/** §5 — a confirmed value stops being marked: its field leaves the row's methods. */
export async function certifyField(
  db: Executor,
  input: { fileId: string; objectName: string; rowRef: string; field: string },
): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE silo_rows SET methods = methods - $4::text
      WHERE file_id = $1 AND object_name = $2 AND row_ref = $3`,
    [input.fileId, input.objectName, input.rowRef, input.field],
  );
  return rowCount ?? 0;
}

export async function deleteRowsOfFile(db: Executor, fileId: string): Promise<number> {
  const { rowCount } = await db.query(`DELETE FROM silo_rows WHERE file_id = $1`, [fileId]);
  return rowCount ?? 0;
}

export async function deleteRowsOfObject(
  db: Executor,
  input: { sourceId: string; objectName: string },
): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM silo_rows WHERE source_id = $1 AND object_name = $2`,
    [input.sourceId, input.objectName],
  );
  return rowCount ?? 0;
}

/** §9 — bytes held in the stand-in, whole rows. */
export async function bytesOfRows(db: Executor, siloId: string): Promise<number> {
  const { rows } = await db.query<{ bytes: string }>(
    `SELECT COALESCE(sum(pg_column_size(r.*)), 0)::text AS bytes FROM silo_rows r WHERE r.silo_id = $1`,
    [siloId],
  );
  return Number(rows[0]?.bytes ?? 0);
}
