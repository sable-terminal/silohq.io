import type { Executor } from '../infra/db.infra';
import type { FieldPolicy } from '../utils/effectivePermissions.util';

/**
 * Field policies: which fields of a connection are hidden from whom.
 *
 * SQL, AND THE MAPPING BETWEEN A ROW AND A MODEL. Whether a policy applies to a
 * membership is `effectivePermissions.util`'s; who may set one is the service's.
 */

export type StoredFieldPolicy = FieldPolicy & {
  id: string;
  appliesToScopeId: string | null;
  createdBy: string;
  createdAt: Date;
};

type Row = {
  id: string;
  connection_id: string;
  field_path: string;
  effect: FieldPolicy['effect'];
  applies_to_role: string | null;
  applies_to_marking: string | null;
  applies_to_scope: string | null;
  scope_path: string | null;
  include_descendants: boolean;
  created_by: string;
  created_at: Date;
};

const map = (row: Row): StoredFieldPolicy => ({
  id: row.id,
  connectionId: row.connection_id,
  fieldPath: row.field_path,
  effect: row.effect,
  appliesToRole: row.applies_to_role,
  appliesToMarking: row.applies_to_marking,
  appliesToScopeId: row.applies_to_scope,
  appliesToScopePath: row.scope_path,
  includeDescendants: row.include_descendants,
  createdBy: row.created_by,
  createdAt: row.created_at,
});

/** Every policy in force, or only those on these connections. */
export async function live(db: Executor, connectionIds?: readonly string[]): Promise<StoredFieldPolicy[]> {
  const { rows } = await db.query<Row>(
    `SELECT p.id, p.connection_id, p.field_path, p.effect, p.applies_to_role, p.applies_to_marking,
            p.applies_to_scope, s.path::text AS scope_path, p.include_descendants, p.created_by, p.created_at
       FROM field_policies p
       LEFT JOIN scopes s ON s.id = p.applies_to_scope
      WHERE p.revoked_at IS NULL
        AND ($1::uuid[] IS NULL OR p.connection_id = ANY($1::uuid[]))
      ORDER BY p.connection_id, p.field_path, p.created_at`,
    [connectionIds ? [...connectionIds] : null],
  );
  return rows.map(map);
}

export async function create(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    connectionId: string;
    fieldPath: string;
    effect: FieldPolicy['effect'];
    appliesToRole: string | null;
    appliesToMarking: string | null;
    appliesToScope: string | null;
    includeDescendants: boolean;
    createdBy: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO field_policies
       (id, organisation_id, connection_id, field_path, effect, applies_to_role, applies_to_marking,
        applies_to_scope, include_descendants, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      input.id,
      input.organisationId,
      input.connectionId,
      input.fieldPath,
      input.effect,
      input.appliesToRole,
      input.appliesToMarking,
      input.appliesToScope,
      input.includeDescendants,
      input.createdBy,
    ],
  );
}

export async function revoke(
  db: Executor,
  input: { id: string; revokedBy: string },
): Promise<{ connectionId: string; fieldPath: string } | null> {
  const { rows } = await db.query<{ connection_id: string; field_path: string }>(
    `UPDATE field_policies SET revoked_at = now(), revoked_by = $2
      WHERE id = $1 AND revoked_at IS NULL
      RETURNING connection_id, field_path`,
    [input.id, input.revokedBy],
  );
  return rows[0] ? { connectionId: rows[0].connection_id, fieldPath: rows[0].field_path } : null;
}
