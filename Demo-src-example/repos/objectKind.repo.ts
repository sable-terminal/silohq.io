import type { Executor } from '../infra/db.infra';
import { generateId } from '../utils/tokens.util';

/**
 * 134 — what a system's records are about, read from its field names alone.
 *
 * SQL, and the mapping between a row and a model. Who is shown what, and what
 * is done with a reading, is the service's.
 */

export type ObjectKind = 'organisation' | 'person' | 'other';

export interface KnownKind {
  connectionId: string;
  objectName: string;
  kind: ObjectKind;
  /** A hash of the field names it was read from. A different one means it is out of date. */
  fieldsHash: string;
}

export async function forConnections(db: Executor, connectionIds: readonly string[]): Promise<KnownKind[]> {
  if (connectionIds.length === 0) return [];

  const { rows } = await db.query<{ connection_id: string; object_name: string; kind: ObjectKind; fields_hash: string }>(
    `SELECT connection_id, object_name, kind, fields_hash
       FROM object_kinds
      WHERE connection_id = ANY($1)`,
    [[...connectionIds]],
  );

  return rows.map((row) => ({
    connectionId: row.connection_id,
    objectName: row.object_name,
    kind: row.kind,
    fieldsHash: row.fields_hash,
  }));
}

/** Keep a reading, replacing the one made from an older set of field names. */
export async function record(
  db: Executor,
  input: { organisationId: string; connectionId: string; objectName: string; kind: ObjectKind; fieldsHash: string },
): Promise<void> {
  await db.query(
    `INSERT INTO object_kinds (id, organisation_id, connection_id, object_name, kind, fields_hash)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (connection_id, object_name)
     DO UPDATE SET kind = EXCLUDED.kind, fields_hash = EXCLUDED.fields_hash, decided_at = now()`,
    [generateId(), input.organisationId, input.connectionId, input.objectName, input.kind, input.fieldsHash],
  );
}
