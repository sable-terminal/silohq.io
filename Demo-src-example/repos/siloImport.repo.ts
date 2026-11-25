import type { Executor } from '../infra/db.infra';
import type { Sealed } from '../utils/envelope.util';

/**
 * Import — sources, structuring definitions and the files that arrive.
 *
 * SQL, AND THE MAPPING BETWEEN A ROW AND A MODEL. Whether a person may import,
 * whether a definition is fit to publish and what a file's contents mean are
 * the service's decisions.
 */

export type SourceKind = 'upload' | 'watched';
export type DefinitionRoute = 'ai' | 'builder' | 'prebuilt';
export type FileStatus = 'awaiting_upload' | 'received' | 'processing' | 'processed' | 'failed';

export interface SiloSource {
  id: string;
  organisationId: string;
  siloId: string;
  kind: SourceKind;
  name: string;
  location: string | null;
  definitionId: string | null;
  connectionId: string | null;
  createdBy: string;
  createdAt: Date;
  retiredAt: Date | null;
  /* Watched locations only. */
  watchPattern: string | null;
  hostFingerprint: string | null;
  watchCursor: Date | null;
  watchCursorNames: string[];
  lastPolledAt: Date | null;
  pollFailureCode: string | null;
}

export interface SiloDefinitionRecord {
  id: string;
  organisationId: string | null;
  definitionKey: string;
  version: number | null;
  name: string;
  sourceRoute: DefinitionRoute;
  document: Record<string, unknown>;
  status: 'draft' | 'published';
  probedFileId: string | null;
  probedDocumentHash: string | null;
  probePassed: boolean;
  manifestId: string | null;
  createdBy: string | null;
  createdAt: Date;
  publishedAt: Date | null;
}

export interface SiloFile {
  id: string;
  organisationId: string;
  siloId: string;
  sourceId: string;
  objectKey: string;
  filename: string;
  declaredBytes: number;
  sizeBytes: number | null;
  contentType: string | null;
  status: FileStatus;
  failureCode: string | null;
  rowsExtracted: number | null;
  rowsRejected: number | null;
  uploadExpiresAt: Date;
  uploadedBy: string | null;
  createdAt: Date;
  receivedAt: Date | null;
  processedAt: Date | null;
}

/* ── Sources ─────────────────────────────────────────────────────────────── */

const SOURCE_COLUMNS = `
  id, organisation_id, silo_id, kind, name, location, definition_id, connection_id,
  created_by, created_at, retired_at, watch_pattern, host_fingerprint, watch_cursor,
  watch_cursor_names, last_polled_at, poll_failure_code
`;

type SourceRow = {
  id: string;
  organisation_id: string;
  silo_id: string;
  kind: SourceKind;
  name: string;
  location: string | null;
  definition_id: string | null;
  connection_id: string | null;
  created_by: string;
  created_at: Date;
  retired_at: Date | null;
  watch_pattern: string | null;
  host_fingerprint: string | null;
  watch_cursor: Date | null;
  watch_cursor_names: string[];
  last_polled_at: Date | null;
  poll_failure_code: string | null;
};

const mapSource = (row: SourceRow): SiloSource => ({
  id: row.id,
  organisationId: row.organisation_id,
  siloId: row.silo_id,
  kind: row.kind,
  name: row.name,
  location: row.location,
  definitionId: row.definition_id,
  connectionId: row.connection_id,
  createdBy: row.created_by,
  createdAt: row.created_at,
  retiredAt: row.retired_at,
  watchPattern: row.watch_pattern,
  hostFingerprint: row.host_fingerprint,
  watchCursor: row.watch_cursor,
  watchCursorNames: row.watch_cursor_names,
  lastPolledAt: row.last_polled_at,
  pollFailureCode: row.poll_failure_code,
});

export async function insertSource(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    siloId: string;
    kind: SourceKind;
    name: string;
    location: string | null;
    createdBy: string;
    watchPattern?: string | null;
    hostFingerprint?: string | null;
    watchCursor?: Date | null;
  },
): Promise<SiloSource> {
  const { rows } = await db.query<SourceRow>(
    `INSERT INTO silo_sources
       (id, organisation_id, silo_id, kind, name, location, created_by, watch_pattern, host_fingerprint, watch_cursor)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${SOURCE_COLUMNS}`,
    [
      input.id, input.organisationId, input.siloId, input.kind, input.name, input.location, input.createdBy,
      input.watchPattern ?? null, input.hostFingerprint ?? null, input.watchCursor ?? null,
    ],
  );
  return mapSource(rows[0]!);
}

export async function findSource(db: Executor, id: string): Promise<SiloSource | null> {
  const { rows } = await db.query<SourceRow>(`SELECT ${SOURCE_COLUMNS} FROM silo_sources WHERE id = $1`, [id]);
  return rows[0] ? mapSource(rows[0]) : null;
}

export async function sourcesIn(db: Executor, siloId: string): Promise<SiloSource[]> {
  const { rows } = await db.query<SourceRow>(
    `SELECT ${SOURCE_COLUMNS} FROM silo_sources WHERE silo_id = $1 ORDER BY created_at`,
    [siloId],
  );
  return rows.map(mapSource);
}

export async function attachDefinition(
  db: Executor,
  input: { sourceId: string; definitionId: string; connectionId: string },
): Promise<void> {
  await db.query(
    `UPDATE silo_sources SET definition_id = $2, connection_id = $3 WHERE id = $1`,
    [input.sourceId, input.definitionId, input.connectionId],
  );
}

/** Retire every live source of a Silo, returning the connections they answered through. */
export async function retireSourcesOf(db: Executor, siloId: string): Promise<string[]> {
  const { rows } = await db.query<{ connection_id: string | null }>(
    `UPDATE silo_sources SET retired_at = now()
      WHERE silo_id = $1 AND retired_at IS NULL
  RETURNING connection_id`,
    [siloId],
  );
  return rows.map((row) => row.connection_id).filter((id): id is string => id !== null);
}

/* ── Definitions ─────────────────────────────────────────────────────────── */

const DEFINITION_COLUMNS = `
  id, organisation_id, definition_key, version, name, source_route, document, status,
  probed_file_id, probed_document_hash, probe_passed, manifest_id, created_by, created_at,
  published_at
`;

type DefinitionRow = {
  id: string;
  organisation_id: string | null;
  definition_key: string;
  version: number | null;
  name: string;
  source_route: DefinitionRoute;
  document: Record<string, unknown>;
  status: 'draft' | 'published';
  probed_file_id: string | null;
  probed_document_hash: string | null;
  probe_passed: boolean;
  manifest_id: string | null;
  created_by: string | null;
  created_at: Date;
  published_at: Date | null;
};

const mapDefinition = (row: DefinitionRow): SiloDefinitionRecord => ({
  id: row.id,
  organisationId: row.organisation_id,
  definitionKey: row.definition_key,
  version: row.version,
  name: row.name,
  sourceRoute: row.source_route,
  document: row.document,
  status: row.status,
  probedFileId: row.probed_file_id,
  probedDocumentHash: row.probed_document_hash,
  probePassed: row.probe_passed,
  manifestId: row.manifest_id,
  createdBy: row.created_by,
  createdAt: row.created_at,
  publishedAt: row.published_at,
});

export async function insertDefinition(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    definitionKey: string;
    name: string;
    sourceRoute: DefinitionRoute;
    document: Record<string, unknown>;
    createdBy: string;
  },
): Promise<SiloDefinitionRecord> {
  const { rows } = await db.query<DefinitionRow>(
    `INSERT INTO silo_definitions (id, organisation_id, definition_key, name, source_route, document, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${DEFINITION_COLUMNS}`,
    [
      input.id, input.organisationId, input.definitionKey, input.name, input.sourceRoute,
      JSON.stringify(input.document), input.createdBy,
    ],
  );
  return mapDefinition(rows[0]!);
}

/** The organisation's own definition, or a prebuilt one. Row level security decides which exist. */
export async function findDefinition(db: Executor, id: string): Promise<SiloDefinitionRecord | null> {
  const { rows } = await db.query<DefinitionRow>(`SELECT ${DEFINITION_COLUMNS} FROM silo_definitions WHERE id = $1`, [id]);
  return rows[0] ? mapDefinition(rows[0]) : null;
}

export async function definitionsFor(db: Executor, definitionKey: string): Promise<SiloDefinitionRecord[]> {
  const { rows } = await db.query<DefinitionRow>(
    `SELECT ${DEFINITION_COLUMNS} FROM silo_definitions
      WHERE definition_key = $1 AND organisation_id IS NOT NULL
      ORDER BY created_at DESC`,
    [definitionKey],
  );
  return rows.map(mapDefinition);
}

export async function prebuiltDefinitions(db: Executor): Promise<SiloDefinitionRecord[]> {
  const { rows } = await db.query<DefinitionRow>(
    `SELECT ${DEFINITION_COLUMNS} FROM silo_definitions
      WHERE organisation_id IS NULL AND status = 'published'
      ORDER BY name`,
  );
  return rows.map(mapDefinition);
}

/**
 * Save a draft, and forget its probe.
 *
 * AN EDIT INVALIDATES THE PROBE, in the same statement. A probe is evidence that
 * THIS document extracts from THIS file; the hash guards publish as well, but a
 * draft that still said "probe passed" after its columns were renamed would be
 * telling the person looking at it something false.
 */
export async function updateDraft(
  db: Executor,
  input: { id: string; name: string; document: Record<string, unknown> },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE silo_definitions
        SET name = $2, document = $3, probe_passed = false,
            probed_file_id = NULL, probed_document_hash = NULL
      WHERE id = $1 AND status = 'draft'`,
    [input.id, input.name, JSON.stringify(input.document)],
  );
  return (rowCount ?? 0) > 0;
}

export async function recordProbe(
  db: Executor,
  input: { id: string; fileId: string; documentHash: string; passed: boolean },
): Promise<void> {
  await db.query(
    `UPDATE silo_definitions
        SET probed_file_id = $2, probed_document_hash = $3, probe_passed = $4
      WHERE id = $1 AND status = 'draft'`,
    [input.id, input.fileId, input.documentHash, input.passed],
  );
}

export async function nextDefinitionVersion(
  db: Executor,
  input: { organisationId: string; definitionKey: string },
): Promise<number> {
  const { rows } = await db.query<{ next: number }>(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM silo_definitions
      WHERE organisation_id = $1 AND definition_key = $2`,
    [input.organisationId, input.definitionKey],
  );
  return rows[0]?.next ?? 1;
}

export async function latestPublished(
  db: Executor,
  definitionKey: string,
): Promise<SiloDefinitionRecord | null> {
  const { rows } = await db.query<DefinitionRow>(
    `SELECT ${DEFINITION_COLUMNS} FROM silo_definitions
      WHERE definition_key = $1 AND organisation_id IS NOT NULL AND status = 'published'
      ORDER BY version DESC LIMIT 1`,
    [definitionKey],
  );
  return rows[0] ? mapDefinition(rows[0]) : null;
}

export async function markPublished(
  db: Executor,
  input: { id: string; version: number; manifestId: string },
): Promise<void> {
  await db.query(
    `UPDATE silo_definitions
        SET status = 'published', version = $2, manifest_id = $3, published_at = now()
      WHERE id = $1 AND status = 'draft'`,
    [input.id, input.version, input.manifestId],
  );
}

/* ── Files ───────────────────────────────────────────────────────────────── */

const FILE_COLUMNS = `
  id, organisation_id, silo_id, source_id, object_key, filename, declared_bytes, size_bytes,
  content_type, status, failure_code, rows_extracted, rows_rejected, upload_expires_at,
  uploaded_by, created_at, received_at, processed_at
`;

type FileRow = {
  id: string;
  organisation_id: string;
  silo_id: string;
  source_id: string;
  object_key: string;
  filename: string;
  declared_bytes: string;
  size_bytes: string | null;
  content_type: string | null;
  status: FileStatus;
  failure_code: string | null;
  rows_extracted: number | null;
  rows_rejected: number | null;
  upload_expires_at: Date;
  uploaded_by: string | null;
  created_at: Date;
  received_at: Date | null;
  processed_at: Date | null;
};

const mapFile = (row: FileRow): SiloFile => ({
  id: row.id,
  organisationId: row.organisation_id,
  siloId: row.silo_id,
  sourceId: row.source_id,
  objectKey: row.object_key,
  filename: row.filename,
  declaredBytes: Number(row.declared_bytes),
  sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
  contentType: row.content_type,
  status: row.status,
  failureCode: row.failure_code,
  rowsExtracted: row.rows_extracted,
  rowsRejected: row.rows_rejected,
  uploadExpiresAt: row.upload_expires_at,
  uploadedBy: row.uploaded_by,
  createdAt: row.created_at,
  receivedAt: row.received_at,
  processedAt: row.processed_at,
});

export async function insertFile(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    siloId: string;
    sourceId: string;
    objectKey: string;
    filename: string;
    declaredBytes: number;
    uploadExpiresAt: Date;
    uploadedBy: string | null;
  },
): Promise<SiloFile> {
  const { rows } = await db.query<FileRow>(
    `INSERT INTO silo_files
       (id, organisation_id, silo_id, source_id, object_key, filename, declared_bytes,
        upload_expires_at, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${FILE_COLUMNS}`,
    [
      input.id, input.organisationId, input.siloId, input.sourceId, input.objectKey,
      input.filename, input.declaredBytes, input.uploadExpiresAt, input.uploadedBy,
    ],
  );
  return mapFile(rows[0]!);
}

export async function findFile(db: Executor, id: string): Promise<SiloFile | null> {
  const { rows } = await db.query<FileRow>(`SELECT ${FILE_COLUMNS} FROM silo_files WHERE id = $1`, [id]);
  return rows[0] ? mapFile(rows[0]) : null;
}

export async function filesOf(db: Executor, sourceId: string): Promise<SiloFile[]> {
  const { rows } = await db.query<FileRow>(
    `SELECT ${FILE_COLUMNS} FROM silo_files WHERE source_id = $1 ORDER BY created_at DESC`,
    [sourceId],
  );
  return rows.map(mapFile);
}

export async function filesOfSilo(db: Executor, siloId: string): Promise<SiloFile[]> {
  const { rows } = await db.query<FileRow>(
    `SELECT ${FILE_COLUMNS} FROM silo_files WHERE silo_id = $1 ORDER BY created_at`,
    [siloId],
  );
  return rows.map(mapFile);
}

/** Only an upload still waiting may be received, and only once. */
export async function markReceived(
  db: Executor,
  input: { id: string; sizeBytes: number; contentType: string },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE silo_files
        SET status = 'received', size_bytes = $2, content_type = $3, received_at = now()
      WHERE id = $1 AND status = 'awaiting_upload'`,
    [input.id, input.sizeBytes, input.contentType],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Take a received file for processing, so two workers cannot both read it.
 *
 * THE UPDATE IS THE LOCK. Whichever worker's statement changes the row owns the
 * file; the other gets nothing back and moves on.
 */
export async function claimForProcessing(db: Executor, id: string): Promise<SiloFile | null> {
  const { rows } = await db.query<FileRow>(
    `UPDATE silo_files SET status = 'processing'
      WHERE id = $1 AND status = 'received'
  RETURNING ${FILE_COLUMNS}`,
    [id],
  );
  return rows[0] ? mapFile(rows[0]) : null;
}

/** Hand a claimed file back, unchanged, to wait for what it needs. */
export async function releaseClaim(db: Executor, id: string): Promise<void> {
  await db.query(`UPDATE silo_files SET status = 'received' WHERE id = $1 AND status = 'processing'`, [id]);
}

/** False when the file is gone — purged while its rows were being written. */
export async function markProcessed(
  db: Executor,
  input: { id: string; rowsExtracted: number; rowsRejected: number },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE silo_files
        SET status = 'processed', rows_extracted = $2, rows_rejected = $3,
            failure_code = NULL, processed_at = now()
      WHERE id = $1`,
    [input.id, input.rowsExtracted, input.rowsRejected],
  );
  return (rowCount ?? 0) > 0;
}

export async function markFailed(db: Executor, input: { id: string; failureCode: string }): Promise<void> {
  await db.query(
    `UPDATE silo_files SET status = 'failed', failure_code = $2, processed_at = now()
      WHERE id = $1 AND received_at IS NOT NULL`,
    [input.id, input.failureCode],
  );
}

/** Files that arrived and are waiting — for a definition to be published, or storage to come back on. */
export async function waitingFiles(db: Executor, sourceId: string): Promise<SiloFile[]> {
  const { rows } = await db.query<FileRow>(
    `SELECT ${FILE_COLUMNS} FROM silo_files WHERE source_id = $1 AND status = 'received' ORDER BY received_at`,
    [sourceId],
  );
  return rows.map(mapFile);
}

/**
 * Received files left unprocessed: a claim abandoned by an instance that died,
 * or a file that arrived while nothing was draining. For the recovery sweep.
 */
export async function strandedFiles(db: Executor, olderThanMinutes: number): Promise<SiloFile[]> {
  const { rows } = await db.query<FileRow>(
    `SELECT ${FILE_COLUMNS} FROM silo_files
      WHERE status IN ('received', 'processing')
        AND received_at < now() - make_interval(mins => $1)
      ORDER BY received_at
      LIMIT 500`,
    [olderThanMinutes],
  );
  return rows.map(mapFile);
}

export async function deleteFile(db: Executor, id: string): Promise<boolean> {
  const { rowCount } = await db.query(`DELETE FROM silo_files WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

/**
 * §9 — bytes held in object storage, for a Silo. A file refused at receipt
 * (`file.*`) had its object deleted then; one that failed later still has it.
 */
export async function bytesOfFiles(db: Executor, siloId: string): Promise<number> {
  const { rows } = await db.query<{ bytes: string }>(
    `SELECT COALESCE(sum(size_bytes), 0)::text AS bytes FROM silo_files
      WHERE silo_id = $1 AND NOT (status = 'failed' AND failure_code LIKE 'file.%')`,
    [siloId],
  );
  return Number(rows[0]?.bytes ?? 0);
}

/**
 * §8 retention — files received longer ago than their Silo's window, across the
 * cell. The sweep runs as the migrator; this is its view.
 */
export async function expiredFiles(
  db: Executor,
): Promise<Array<{ organisationId: string; siloId: string; sourceId: string; fileId: string; objectKey: string }>> {
  const { rows } = await db.query<{
    organisation_id: string;
    silo_id: string;
    source_id: string;
    id: string;
    object_key: string;
  }>(
    `SELECT f.organisation_id, f.silo_id, f.source_id, f.id, f.object_key
       FROM silo_files f
       JOIN siloes s ON s.id = f.silo_id
      WHERE f.received_at < now() - make_interval(days => s.retention_days)
      ORDER BY f.received_at
      LIMIT 5000`,
  );
  return rows.map((row) => ({
    organisationId: row.organisation_id,
    siloId: row.silo_id,
    sourceId: row.source_id,
    fileId: row.id,
    objectKey: row.object_key,
  }));
}

/** The published definition behind a source, as its document. For row-store housekeeping. */
export async function publishedDocumentOf(
  db: Executor,
  sourceId: string,
): Promise<Record<string, unknown> | null> {
  const { rows } = await db.query<{ document: Record<string, unknown> }>(
    `SELECT d.document
       FROM silo_sources s
       JOIN silo_definitions d ON d.id = s.definition_id
      WHERE s.id = $1`,
    [sourceId],
  );
  return rows[0]?.document ?? null;
}

/** §9 — count document extractions run against a Silo. */
export async function recordExtractionOperations(db: Executor, siloId: string, count: number): Promise<void> {
  if (count <= 0) return;
  await db.query(
    `UPDATE siloes SET extraction_operations = extraction_operations + $2 WHERE id = $1`,
    [siloId, count],
  );
}

/* ── Watched locations ───────────────────────────────────────────────────── */

export interface SourceCredential {
  sourceId: string;
  username: string;
  sealed: Sealed;
}

export async function insertCredential(
  db: Executor,
  input: { id: string; organisationId: string; sourceId: string; username: string; sealed: Sealed; createdBy: string },
): Promise<void> {
  await db.query(
    `INSERT INTO silo_source_credentials
       (id, organisation_id, source_id, username, sealed, wrapped_key, key_reference, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.id, input.organisationId, input.sourceId, input.username, input.sealed.ciphertext,
      input.sealed.wrappedKey, input.sealed.keyReference, input.createdBy,
    ],
  );
}

/** Sealed, never opened here. */
export async function credentialOf(db: Executor, sourceId: string): Promise<SourceCredential | null> {
  const { rows } = await db.query<{ source_id: string; username: string; sealed: Buffer; wrapped_key: Buffer; key_reference: string }>(
    `SELECT source_id, username, sealed, wrapped_key, key_reference
       FROM silo_source_credentials WHERE source_id = $1`,
    [sourceId],
  );
  const row = rows[0];
  return row
    ? {
        sourceId: row.source_id,
        username: row.username,
        sealed: { ciphertext: row.sealed, wrappedKey: row.wrapped_key, keyReference: row.key_reference },
      }
    : null;
}

export async function deleteCredential(db: Executor, sourceId: string): Promise<void> {
  await db.query(`DELETE FROM silo_source_credentials WHERE source_id = $1`, [sourceId]);
}

export async function deleteCredentialsOf(db: Executor, siloId: string): Promise<void> {
  await db.query(
    `DELETE FROM silo_source_credentials
      WHERE source_id IN (SELECT id FROM silo_sources WHERE silo_id = $1)`,
    [siloId],
  );
}

export async function retireSource(db: Executor, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE silo_sources SET retired_at = now() WHERE id = $1 AND retired_at IS NULL`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

/** When a location was last looked at, and why it could not be, if it could not. */
export async function recordPoll(db: Executor, input: { id: string; failureCode: string | null }): Promise<void> {
  await db.query(
    `UPDATE silo_sources SET last_polled_at = now(), poll_failure_code = $2 WHERE id = $1`,
    [input.id, input.failureCode],
  );
}

/**
 * Move the cursor past one file.
 *
 * FILES ARE TAKEN OLDEST FIRST, so the cursor only moves forward. A file at the
 * cursor's own instant joins the names held there; a later one replaces them.
 */
export async function advanceCursor(
  db: Executor,
  input: { id: string; modifiedAt: Date; name: string },
): Promise<void> {
  await db.query(
    `UPDATE silo_sources
        SET watch_cursor_names = CASE
              WHEN watch_cursor IS NOT DISTINCT FROM $2::timestamptz THEN array_append(watch_cursor_names, $3)
              ELSE ARRAY[$3]::text[]
            END,
            watch_cursor = $2::timestamptz
      WHERE id = $1`,
    [input.id, input.modifiedAt, input.name],
  );
}

/** Watched locations due a pickup, across the cell. The pickup job runs as the migrator; this is its view. */
export async function dueWatchedSources(
  db: Executor,
  olderThanMinutes: number,
): Promise<Array<{ id: string; organisationId: string }>> {
  const { rows } = await db.query<{ id: string; organisation_id: string }>(
    `SELECT id, organisation_id FROM silo_sources
      WHERE kind = 'watched' AND retired_at IS NULL
        AND (last_polled_at IS NULL OR last_polled_at < now() - make_interval(mins => $1))
      ORDER BY last_polled_at NULLS FIRST
      LIMIT 500`,
    [olderThanMinutes],
  );
  return rows.map((row) => ({ id: row.id, organisationId: row.organisation_id }));
}


/**
 * §7 — uploads that never arrived, past the window they were given.
 *
 * ── THE ONE HOLE THE RETENTION SWEEP DID NOT REACH ────────────────────────
 *
 * The browser writes the object straight to the bucket with a signed URL, and
 * the row's `received_at` is set afterwards by `markReceived`. Where that
 * second call never happens — a closed tab, a dropped connection, a client
 * error — the bytes are in object storage and `received_at` stays NULL.
 *
 * `expiredFiles` selects on `received_at < now() - window`, and NULL compared
 * to anything is NULL, so those rows matched nothing and the objects were
 * never deleted by anything. §7 says files are "retained per the Silo's
 * retention window"; these were retained for ever.
 *
 * `upload_expires_at` is the column that bounds them. It has been NOT NULL and
 * written on every insert since 067 and read by nothing at all, which is why
 * the gap was invisible: the fix was already in the schema.
 */
export async function abandonedUploads(
  db: Executor,
): Promise<Array<{ organisationId: string; siloId: string; fileId: string; objectKey: string }>> {
  const { rows } = await db.query<{
    organisation_id: string;
    silo_id: string;
    id: string;
    object_key: string;
  }>(
    `SELECT organisation_id, silo_id, id, object_key
       FROM silo_files
      WHERE status = 'awaiting_upload'
        AND received_at IS NULL
        AND upload_expires_at < now()
      ORDER BY upload_expires_at
      LIMIT 5000`,
  );
  return rows.map((row) => ({
    organisationId: row.organisation_id,
    siloId: row.silo_id,
    fileId: row.id,
    objectKey: row.object_key,
  }));
}
