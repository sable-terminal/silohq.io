import type { Executor } from '../infra/db.infra';
import { generateId } from '../utils/tokens.util';

/**
 * §7.3 — which fields of a concept are times, and which one a question means.
 *
 * SQL, and the mapping between a row and a model. Whether somebody may declare
 * one, and whether the concept exists, is the service's.
 */

export type TimeKind = 'occurred' | 'created' | 'modified' | 'effective';

export interface ConceptTimeField {
  conceptId: string;
  /** The concept's own name for the field, not any system's. */
  fieldPath: string;
  kind: TimeKind;
  /** The one a question means when it does not say. At most one per concept. */
  isDefault: boolean;
}

interface Row {
  concept_id: string;
  field_path: string;
  kind: TimeKind;
  is_default: boolean;
}

const map = (row: Row): ConceptTimeField => ({
  conceptId: row.concept_id,
  fieldPath: row.field_path,
  kind: row.kind,
  isDefault: row.is_default,
});

/**
 * The time fields of a set of concepts.
 *
 * READ FOR THE WHOLE SET, because the compiler builds a vocabulary over every
 * concept a reader can see and asking per concept would be one round trip each
 * for a table with a handful of rows in it.
 */
export async function forConcepts(
  db: Executor,
  conceptIds: readonly string[],
): Promise<ConceptTimeField[]> {
  if (conceptIds.length === 0) return [];

  const { rows } = await db.query<Row>(
    `SELECT concept_id, field_path, kind, is_default
       FROM concept_time_fields
      WHERE concept_id = ANY($1)
      ORDER BY concept_id, is_default DESC, field_path`,
    [[...conceptIds]],
  );

  return rows.map(map);
}

/**
 * Declare one, replacing whatever stood for that field.
 *
 * MAKING ONE THE DEFAULT UNSETS THE OTHERS IN THE SAME STATEMENT. A partial
 * unique index enforces one default per concept, so doing it in two steps would
 * fail between them — and a concept with no default is a question this cannot
 * answer without asking, which is worse than the one it had.
 */
export async function declare(
  db: Executor,
  input: {
    organisationId: string;
    conceptId: string;
    fieldPath: string;
    kind: TimeKind;
    isDefault: boolean;
    declaredBy: string;
  },
): Promise<ConceptTimeField> {
  if (input.isDefault) {
    await db.query(
      `UPDATE concept_time_fields SET is_default = false
        WHERE concept_id = $1 AND field_path <> $2`,
      [input.conceptId, input.fieldPath],
    );
  }

  const { rows } = await db.query<Row>(
    `INSERT INTO concept_time_fields
       (id, organisation_id, concept_id, field_path, kind, is_default, declared_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (concept_id, field_path)
     DO UPDATE SET kind = EXCLUDED.kind,
                   is_default = EXCLUDED.is_default,
                   declared_by = EXCLUDED.declared_by,
                   declared_at = now()
     RETURNING concept_id, field_path, kind, is_default`,
    [
      generateId(),
      input.organisationId,
      input.conceptId,
      input.fieldPath,
      input.kind,
      input.isDefault,
      input.declaredBy,
    ],
  );

  return map(rows[0]!);
}

/** Withdraw one. Returns false where nothing was standing. */
export async function remove(
  db: Executor,
  input: { conceptId: string; fieldPath: string },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `DELETE FROM concept_time_fields WHERE concept_id = $1 AND field_path = $2`,
    [input.conceptId, input.fieldPath],
  );

  return (rowCount ?? 0) > 0;
}
