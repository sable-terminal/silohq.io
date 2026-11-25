import type { Executor } from '../infra/db.infra';
import type { Sealed } from '../utils/envelope.util';

/**
 * A connector being built and tested for somebody (127).
 *
 * AN EXPIRED BUILD IS NOT RETURNED. The schema bounds a build to a day; every
 * read here excludes one past its expiry, so a sweep that has not run yet is a
 * storage question and never a credential that still works.
 */

export type BuildStatus = 'needs_credential' | 'testing' | 'ready' | 'stuck' | 'unsupported' | 'connected';

/** One line of what the build did, in words. Never a record. */
export interface ProgressLine {
  at: string;
  text: string;
  tone: 'info' | 'ok' | 'warn';
}

export interface Build {
  id: string;
  organisationId: string;
  draftId: string;
  createdBy: string;
  status: BuildStatus;
  rounds: number;
  sourceUrl: string | null;
  strategy: string | null;
  sealed: Sealed | null;
  parameters: Record<string, string>;
  progress: ProgressLine[];
  connectionId: string | null;
  createdAt: Date;
  expiresAt: Date;
}

interface Row {
  id: string;
  organisation_id: string;
  draft_id: string;
  created_by: string;
  status: BuildStatus;
  rounds: number;
  source_url: string | null;
  strategy: string | null;
  sealed: Buffer | null;
  wrapped_key: Buffer | null;
  key_reference: string | null;
  parameters: Record<string, string>;
  progress: ProgressLine[];
  connection_id: string | null;
  created_at: Date;
  expires_at: Date;
}

const COLUMNS = `id, organisation_id, draft_id, created_by, status, rounds, source_url, strategy, sealed, wrapped_key,
  key_reference, parameters, progress, connection_id, created_at, expires_at`;

const toBuild = (row: Row): Build => ({
  id: row.id,
  organisationId: row.organisation_id,
  draftId: row.draft_id,
  createdBy: row.created_by,
  status: row.status,
  rounds: row.rounds,
  sourceUrl: row.source_url,
  strategy: row.strategy,
  sealed: row.sealed && row.wrapped_key && row.key_reference ? { ciphertext: row.sealed, wrappedKey: row.wrapped_key, keyReference: row.key_reference } : null,
  parameters: row.parameters ?? {},
  progress: row.progress ?? [],
  connectionId: row.connection_id,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
});

/** Progress is kept short: the latest lines are what a person reads. */
const MAX_LINES = 60;

export async function insert(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    draftId: string;
    createdBy: string;
    status: BuildStatus;
    sourceUrl: string | null;
    progress: ProgressLine[];
    /** For a sign-in that needs a connection first — OAuth, or the agent. */
    connectionId?: string | null;
  },
): Promise<Build> {
  const { rows } = await db.query<Row>(
    `INSERT INTO connector_builds (id, organisation_id, draft_id, created_by, status, source_url, progress, connection_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + interval '24 hours')
     RETURNING ${COLUMNS}`,
    [input.id, input.organisationId, input.draftId, input.createdBy, input.status, input.sourceUrl, JSON.stringify(input.progress.slice(-MAX_LINES)), input.connectionId ?? null],
  );
  return toBuild(rows[0]!);
}

export async function find(db: Executor, id: string): Promise<Build | null> {
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM connector_builds WHERE id = $1 AND expires_at > now()`, [id]);
  return rows[0] ? toBuild(rows[0]) : null;
}

/**
 * Take the build for one round, or return null if a round is already running.
 * The claim lapses on its own, so a round that died mid-way does not hold the
 * build for ever.
 */
export async function claim(db: Executor, id: string, seconds: number): Promise<Build | null> {
  const { rows } = await db.query<Row>(
    `UPDATE connector_builds SET busy_until = now() + make_interval(secs => $2)
      WHERE id = $1 AND expires_at > now() AND (busy_until IS NULL OR busy_until < now())
      RETURNING ${COLUMNS}`,
    [id, seconds],
  );
  return rows[0] ? toBuild(rows[0]) : null;
}

/** Hold the build for a while without a round running: the model service asked Silo to wait. */
export async function pause(db: Executor, id: string, seconds: number): Promise<void> {
  await db.query(`UPDATE connector_builds SET busy_until = now() + make_interval(secs => $2) WHERE id = $1`, [id, seconds]);
}

export async function release(db: Executor, id: string): Promise<void> {
  await db.query(`UPDATE connector_builds SET busy_until = NULL WHERE id = $1`, [id]);
}

export async function update(
  db: Executor,
  id: string,
  patch: { status?: BuildStatus; rounds?: number; progress?: ProgressLine[]; connectionId?: string },
): Promise<Build | null> {
  const { rows } = await db.query<Row>(
    `UPDATE connector_builds
        SET status = COALESCE($2, status),
            rounds = COALESCE($3, rounds),
            progress = COALESCE($4::jsonb, progress),
            connection_id = COALESCE($5, connection_id)
      WHERE id = $1 AND expires_at > now()
      RETURNING ${COLUMNS}`,
    [id, patch.status ?? null, patch.rounds ?? null, patch.progress ? JSON.stringify(patch.progress.slice(-MAX_LINES)) : null, patch.connectionId ?? null],
  );
  return rows[0] ? toBuild(rows[0]) : null;
}

export async function setCredential(
  db: Executor,
  id: string,
  input: { strategy: string; sealed: Sealed; parameters: Record<string, string> },
): Promise<void> {
  await db.query(
    `UPDATE connector_builds
        SET strategy = $2, sealed = $3, wrapped_key = $4, key_reference = $5, parameters = $6
      WHERE id = $1 AND expires_at > now()`,
    [id, input.strategy, input.sealed.ciphertext, input.sealed.wrappedKey, input.sealed.keyReference, JSON.stringify(input.parameters)],
  );
}

/** The credential has moved onto a connection: nothing about it stays here. */
export async function markConnected(db: Executor, id: string, connectionId: string, progress: ProgressLine[]): Promise<void> {
  await db.query(
    `UPDATE connector_builds
        SET status = 'connected', connection_id = $2, sealed = NULL, wrapped_key = NULL, key_reference = NULL,
            strategy = NULL, parameters = '{}'::jsonb, progress = $3, busy_until = NULL
      WHERE id = $1`,
    [id, connectionId, JSON.stringify(progress.slice(-MAX_LINES))],
  );
}

/** Cross-tenant, for the retention sweep: builds past their day, credential and all. */
export async function sweepExpired(db: Executor): Promise<number> {
  const { rowCount } = await db.query(`DELETE FROM connector_builds WHERE expires_at <= now()`);
  return rowCount ?? 0;
}
