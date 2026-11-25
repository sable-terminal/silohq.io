import type { Executor } from '../infra/db.infra';
import { generateId } from '../utils/tokens.util';
import type { FieldAuthority } from '../models/authority.model';

/**
 * §2.8 — field authorities.
 *
 * SQL, and the mapping between a row and a model. The decision about whether a
 * person may declare one, and whether the concept exists, is the service's.
 */

const COLUMNS = `
  id, organisation_id, concept_id, field_path, connection_id,
  because, declared_by, declared_at, retired_at
`;

interface Row {
  id: string;
  organisation_id: string;
  concept_id: string;
  field_path: string;
  connection_id: string;
  because: string | null;
  declared_by: string;
  declared_at: Date;
  retired_at: Date | null;
}

const map = (row: Row): FieldAuthority => ({
  id: row.id,
  organisationId: row.organisation_id,
  conceptId: row.concept_id,
  fieldPath: row.field_path,
  connectionId: row.connection_id,
  because: row.because,
  declaredBy: row.declared_by,
  declaredAt: row.declared_at,
  retiredAt: row.retired_at,
});

/**
 * The authority standing against one field, retired or not.
 *
 * RETIRED ROWS COME BACK TOO, and they have to: `field_authorities_unique`
 * covers them, so a retired row is still the row an insert collides with. A
 * lookup that hid it would report "nothing declared" right up until the write
 * failed.
 */
export async function read(
  db: Executor,
  input: { conceptId: string; fieldPath: string },
): Promise<FieldAuthority | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM field_authorities
      WHERE concept_id = $1 AND field_path = $2`,
    [input.conceptId, input.fieldPath],
  );

  const row = rows[0];
  return row ? map(row) : null;
}

/**
 * Every authority that still stands, for one concept or for all of them.
 *
 * `retired_at IS NULL` IS NOT AN ACCESS RULE. A retired authority is not one
 * somebody is being kept away from — it is one the organisation has withdrawn,
 * and merging by it would apply a decision they have taken back.
 */
export async function live(
  db: Executor,
  conceptId?: string,
): Promise<FieldAuthority[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM field_authorities
      WHERE retired_at IS NULL
        AND ($1::uuid IS NULL OR concept_id = $1)
      ORDER BY concept_id, field_path`,
    [conceptId ?? null],
  );

  return rows.map(map);
}

/**
 * Declare one, replacing whatever stood before.
 *
 * ONE ROW PER FIELD, EVER — the unique constraint covers retired rows, so this
 * is an upsert rather than an insert beside the old one. Re-declaring revives a
 * retired row and clears `retired_at`, which is right: the organisation has
 * changed its mind back, and a second row would leave two answers to a question
 * that has one.
 */
export async function declare(
  db: Executor,
  input: {
    organisationId: string;
    conceptId: string;
    fieldPath: string;
    connectionId: string;
    because: string | null;
    declaredBy: string;
  },
): Promise<FieldAuthority> {
  const { rows } = await db.query<Row>(
    `INSERT INTO field_authorities
       (id, organisation_id, concept_id, field_path, connection_id, because, declared_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (organisation_id, concept_id, field_path)
     DO UPDATE SET connection_id = EXCLUDED.connection_id,
                   because = EXCLUDED.because,
                   declared_by = EXCLUDED.declared_by,
                   declared_at = now(),
                   retired_at = NULL
     RETURNING ${COLUMNS}`,
    [
      generateId(),
      input.organisationId,
      input.conceptId,
      input.fieldPath,
      input.connectionId,
      input.because,
      input.declaredBy,
    ],
  );

  return map(rows[0]!);
}

/** Withdraw one. Returns false where nothing live was standing. */
export async function retire(db: Executor, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE field_authorities SET retired_at = now()
      WHERE id = $1 AND retired_at IS NULL`,
    [id],
  );

  return (rowCount ?? 0) > 0;
}
