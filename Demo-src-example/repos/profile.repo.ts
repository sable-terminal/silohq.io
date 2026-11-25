import type { Executor } from '../infra/db.infra';

/**
 * §2.2 — what each field looked like when it was last profiled.
 *
 * COUNTS, AND THE SCHEMA HAS NOWHERE TO PUT ANYTHING ELSE. See 052: the only
 * text columns are the names of the object and the field, which are schema and
 * already live in the manifest.
 */

export interface StoredProfile {
  connectionId: string;
  objectName: string;
  fieldName: string;
  rows: number;
  distinctRatio: number;
  absentRatio: number;
}

interface ProfileRow {
  connection_id: string;
  object_name: string;
  field_name: string;
  rows_seen: number;
  distinct_ratio: string;
  absent_ratio: string;
}

/** Every field profile held for a set of connections. */
export async function latest(
  db: Executor,
  connectionIds: readonly string[],
): Promise<StoredProfile[]> {
  if (connectionIds.length === 0) return [];

  const { rows } = await db.query<ProfileRow>(
    `SELECT connection_id, object_name, field_name, rows_seen, distinct_ratio, absent_ratio
       FROM field_profiles
      WHERE connection_id = ANY($1)
      ORDER BY connection_id, object_name, field_name`,
    [[...connectionIds]],
  );

  return rows.map((row) => ({
    connectionId: row.connection_id,
    objectName: row.object_name,
    fieldName: row.field_name,
    rows: Number(row.rows_seen),
    /* numeric arrives as text; parsed here so nothing above compares strings. */
    distinctRatio: Number(row.distinct_ratio),
    absentRatio: Number(row.absent_ratio),
  }));
}

/**
 * Replace what is held for each field observed.
 *
 * ONE ROW PER FIELD, OVERWRITTEN. The comparison is between now and last time,
 * so a history would be unbounded storage answering a question nobody asks.
 */
export async function record(
  db: Executor,
  input: { organisationId: string; profiles: readonly StoredProfile[] },
): Promise<number> {
  if (input.profiles.length === 0) return 0;

  const { rowCount } = await db.query(
    `INSERT INTO field_profiles
       (id, organisation_id, connection_id, object_name, field_name,
        rows_seen, distinct_ratio, absent_ratio)
     SELECT gen_random_uuid(), $1, p.connection_id, p.object_name, p.field_name,
            p.rows_seen, p.distinct_ratio, p.absent_ratio
       FROM jsonb_to_recordset($2::jsonb)
         AS p(connection_id uuid, object_name text, field_name text,
              rows_seen integer, distinct_ratio numeric, absent_ratio numeric)
     ON CONFLICT (connection_id, object_name, field_name)
     DO UPDATE SET rows_seen = EXCLUDED.rows_seen,
                   distinct_ratio = EXCLUDED.distinct_ratio,
                   absent_ratio = EXCLUDED.absent_ratio,
                   observed_at = now()`,
    [
      input.organisationId,
      JSON.stringify(
        input.profiles.map((profile) => ({
          connection_id: profile.connectionId,
          object_name: profile.objectName,
          field_name: profile.fieldName,
          rows_seen: profile.rows,
          distinct_ratio: profile.distinctRatio,
          absent_ratio: profile.absentRatio,
        })),
      ),
    ],
  );

  /* `generateId` is unused here because the insert generates its own; kept out
     of the import list rather than imported and ignored. */

  return rowCount ?? 0;
}
