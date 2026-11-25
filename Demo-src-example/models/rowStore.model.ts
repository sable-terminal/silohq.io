/**
 * The row store: where an import's extracted rows are held.
 *
 * §7 — BigQuery in production, where the volume justifies it; a Postgres table
 * wherever BigQuery is not configured. One shape, so the query path cannot tell.
 */

/** §5 — how a value was got. `certain` is the default and is never stored. */
export type ExtractionMethod = 'certain' | 'near' | 'inferred';

export type StoredFieldType = 'string' | 'number' | 'boolean' | 'date' | 'datetime' | 'json';

export interface StoredField {
  name: string;
  type: StoredFieldType;
}

/** One extracted record, before it is stored. */
export interface ExtractedRow {
  /** Where in the file it came from: "line 12", "Sheet1 row 40". */
  rowRef: string;
  values: Record<string, unknown>;
  /** Only the fields whose method is not `certain`. Empty for a spreadsheet. */
  methods: Record<string, Exclude<ExtractionMethod, 'certain'>>;
}

export type RowStoreKind = 'postgres' | 'bigquery';
