import type { Executor } from '../infra/db.infra';
import { generateId } from '../utils/tokens.util';

/**
 * §2.3 — corrections to what a system calls its fields.
 *
 * SQL, and the mapping between a row and a model. Whether somebody may declare
 * one, and whether the connection exists, is the service's.
 */

export interface FieldAlias {
  id: string;
  connectionId: string;
  objectName: string;
  /** What the source calls it. */
  sourceField: string;
  /** What the organisation calls it, in a concept's terms. */
  canonicalField: string;
  declaredBy: string;
  declaredAt: Date;
  /** Who said it: a person, or an answer (131). */
  origin: 'declared' | 'learned';
  /** For a learned one: how many records held both fields, and how many agreed. Counts, never values. */
  compared: number | null;
  agreed: number | null;
}

interface Row {
  id: string;
  connection_id: string;
  object_name: string;
  source_field: string;
  canonical_field: string;
  declared_by: string;
  declared_at: Date;
  origin: 'declared' | 'learned';
  compared: number | null;
  agreed: number | null;
}

const COLUMNS = `id, connection_id, object_name, source_field, canonical_field,
            declared_by, declared_at, origin, compared, agreed`;

const map = (row: Row): FieldAlias => ({
  id: row.id,
  connectionId: row.connection_id,
  objectName: row.object_name,
  sourceField: row.source_field,
  canonicalField: row.canonical_field,
  declaredBy: row.declared_by,
  declaredAt: row.declared_at,
  origin: row.origin,
  compared: row.compared,
  agreed: row.agreed,
});

/**
 * Every correction held for a set of connections.
 *
 * READ FOR THE WHOLE SET AT ONCE, because confirmation applies them across
 * every system a concept spans and asking per connection would be one round
 * trip per contributing object for a table with a handful of rows in it.
 */
export async function forConnections(
  db: Executor,
  connectionIds: readonly string[],
): Promise<FieldAlias[]> {
  if (connectionIds.length === 0) return [];

  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS}
       FROM field_aliases
      WHERE connection_id = ANY($1)
      ORDER BY connection_id, object_name, source_field`,
    [[...connectionIds]],
  );

  return rows.map(map);
}

/**
 * The matches an answer taught, for a set of connections.
 *
 * READ ON EVERY QUESTION, which is why it is its own statement: a question
 * wants these and never the declared ones, which reached their concepts when
 * those were confirmed.
 */
export async function learnedFor(
  db: Executor,
  connectionIds: readonly string[],
): Promise<FieldAlias[]> {
  if (connectionIds.length === 0) return [];

  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS}
       FROM field_aliases
      WHERE connection_id = ANY($1) AND origin = 'learned'
      ORDER BY connection_id, object_name, source_field`,
    [[...connectionIds]],
  );

  return rows.map(map);
}

/**
 * Record one, replacing any correction already standing for that column.
 *
 * THE SOURCE FIELD IS THE KEY, because that is the thing being renamed. Two
 * canonical names for one column is a contradiction; two columns mapping to one
 * canonical name is ordinary and the constraint permits it.
 */
export async function declare(
  db: Executor,
  input: {
    organisationId: string;
    connectionId: string;
    objectName: string;
    sourceField: string;
    canonicalField: string;
    declaredBy: string;
  },
): Promise<FieldAlias> {
  const { rows } = await db.query<Row>(
    `INSERT INTO field_aliases
       (id, organisation_id, connection_id, object_name, source_field,
        canonical_field, declared_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (connection_id, object_name, source_field)
     DO UPDATE SET canonical_field = EXCLUDED.canonical_field,
                   declared_by = EXCLUDED.declared_by,
                   declared_at = now(),
                   /* A person saying it replaces whatever an answer had learned. */
                   origin = 'declared',
                   compared = NULL,
                   agreed = NULL
     RETURNING ${COLUMNS}`,
    [
      generateId(),
      input.organisationId,
      input.connectionId,
      input.objectName,
      input.sourceField,
      input.canonicalField,
      input.declaredBy,
    ],
  );

  return map(rows[0]!);
}

/**
 * Keep a match an answer taught.
 *
 * NEVER OVER A PERSON'S. Where somebody has already said what that column is
 * called, the answer's reading of it is not recorded and null comes back — a
 * model noticing a resemblance does not outrank a person who named the field.
 * A learned row is replaced by a later one, which carries fresher evidence.
 */
export async function learn(
  db: Executor,
  input: {
    organisationId: string;
    connectionId: string;
    objectName: string;
    sourceField: string;
    canonicalField: string;
    /** Whose question taught it. */
    learnedFrom: string;
    compared: number;
    agreed: number;
  },
): Promise<FieldAlias | null> {
  const { rows } = await db.query<Row>(
    `INSERT INTO field_aliases
       (id, organisation_id, connection_id, object_name, source_field,
        canonical_field, declared_by, origin, compared, agreed)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'learned', $8, $9)
     ON CONFLICT (connection_id, object_name, source_field)
     DO UPDATE SET canonical_field = EXCLUDED.canonical_field,
                   declared_by = EXCLUDED.declared_by,
                   declared_at = now(),
                   compared = EXCLUDED.compared,
                   agreed = EXCLUDED.agreed
       WHERE field_aliases.origin = 'learned'
     RETURNING ${COLUMNS}`,
    [
      generateId(),
      input.organisationId,
      input.connectionId,
      input.objectName,
      input.sourceField,
      input.canonicalField,
      input.learnedFrom,
      input.compared,
      input.agreed,
    ],
  );

  return rows[0] ? map(rows[0]) : null;
}

/**
 * Replace the evidence kept beside a learned match with what an answer just saw.
 *
 * ONLY A LEARNED ONE. A declared alias is a person's word and carries no
 * counts; the constraint would refuse them, and this does not try.
 */
export async function observe(db: Executor, id: string, seen: { compared: number; agreed: number }): Promise<void> {
  await db.query(
    `UPDATE field_aliases SET compared = $2, agreed = $3 WHERE id = $1 AND origin = 'learned'`,
    [id, seen.compared, seen.agreed],
  );
}

/** Withdraw one a later answer no longer bears out. Returns false where it was already gone, or a person's. */
export async function unlearn(db: Executor, id: string): Promise<boolean> {
  const { rowCount } = await db.query(`DELETE FROM field_aliases WHERE id = $1 AND origin = 'learned'`, [id]);
  return (rowCount ?? 0) > 0;
}

/** Withdraw one. Returns false where nothing was standing. */
export async function remove(db: Executor, id: string): Promise<boolean> {
  const { rowCount } = await db.query(`DELETE FROM field_aliases WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}
