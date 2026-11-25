import type { Executor } from '../infra/db.infra';
import { generateId } from '../utils/tokens.util';

/**
 * Siloes (139) — the identities outside Silo that may read a Silo.
 *
 * SQL, and the mapping between a row and a model. Who may add one, and what
 * being on the list gives, is the service's.
 */

export type ReaderKind = 'user' | 'group' | 'service_account';

export interface Reader {
  id: string;
  siloId: string;
  kind: ReaderKind;
  email: string;
  grantedBy: string;
  grantedAt: Date;
}

interface Row {
  id: string;
  silo_id: string;
  kind: ReaderKind;
  email: string;
  granted_by: string;
  granted_at: Date;
}

const map = (row: Row): Reader => ({
  id: row.id,
  siloId: row.silo_id,
  kind: row.kind,
  email: row.email,
  grantedBy: row.granted_by,
  grantedAt: row.granted_at,
});

export async function forSilo(db: Executor, siloId: string): Promise<Reader[]> {
  const { rows } = await db.query<Row>(
    `SELECT id, silo_id, kind, email, granted_by, granted_at FROM silo_readers WHERE silo_id = $1 ORDER BY granted_at, email`,
    [siloId],
  );
  return rows.map(map);
}

/** Add an identity to a Silo's readers. Null where it is already one. */
export async function add(
  db: Executor,
  input: { organisationId: string; siloId: string; kind: ReaderKind; email: string; grantedBy: string },
): Promise<Reader | null> {
  const { rows } = await db.query<Row>(
    `INSERT INTO silo_readers (id, organisation_id, silo_id, kind, email, granted_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (silo_id, email) DO NOTHING
     RETURNING id, silo_id, kind, email, granted_by, granted_at`,
    [generateId(), input.organisationId, input.siloId, input.kind, input.email, input.grantedBy],
  );
  return rows[0] ? map(rows[0]) : null;
}

/** Take an identity off a Silo's readers. Returns it, or null where it was not one. */
export async function remove(db: Executor, siloId: string, id: string): Promise<Reader | null> {
  const { rows } = await db.query<Row>(
    `DELETE FROM silo_readers WHERE silo_id = $1 AND id = $2 RETURNING id, silo_id, kind, email, granted_by, granted_at`,
    [siloId, id],
  );
  return rows[0] ? map(rows[0]) : null;
}
