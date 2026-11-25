import type { Executor } from '../infra/db.infra';

/**
 * Files §8 — a document, the permissions that shaped it, and where it came
 * from.
 *
 * THREE TABLES WRITTEN TOGETHER AND READ TOGETHER. A file without its frozen
 * permissions is a document nobody can say anything about, and one without its
 * provenance cannot answer "where did this figure come from" — which §3 says is
 * the point of recording it.
 */

export type FileKind = 'export' | 'upload';
export type SourceKind = 'view' | 'finding' | 'ranking' | 'receipt';

export interface StoredFile {
  id: string;
  kind: FileKind;
  /** §5 — null on an export; 'stored' or 'ingested' on an upload. */
  outcome: 'stored' | 'ingested' | null;
  /** Null while the bytes have not turned up. Such a row is not a file. */
  receivedAt: Date | null;
  /** §5 — the importer's working record for the same bytes, once ingested. */
  siloFileId: string | null;
  name: string;
  objectKey: string;
  contentType: string;
  bytes: number;
  siloId: string | null;
  folderId: string | null;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date | null;
}

export interface FrozenPermissions {
  clearances: string[];
  omittedFields: string[];
  connections: string[];
  frozenAt: Date;
}

export interface Provenance {
  sourceKind: SourceKind;
  sourceId: string;
  sourceName: string | null;
  runReference: string | null;
  producedAt: Date;
}

type Row = {
  id: string;
  kind: FileKind;
  outcome: 'stored' | 'ingested' | null;
  received_at: Date | null;
  silo_file_id: string | null;
  name: string;
  object_key: string;
  content_type: string;
  bytes: string;
  silo_id: string | null;
  folder_id: string | null;
  created_by: string;
  created_at: Date;
  expires_at: Date | null;
};

const COLUMNS = `id, kind, outcome, received_at, silo_file_id, name, object_key, content_type, bytes,
                 silo_id, folder_id, created_by, created_at, expires_at`;

const map = (row: Row): StoredFile => ({
  id: row.id,
  kind: row.kind,
  outcome: row.outcome,
  receivedAt: row.received_at,
  siloFileId: row.silo_file_id,
  name: row.name,
  objectKey: row.object_key,
  contentType: row.content_type,
  bytes: Number(row.bytes),
  siloId: row.silo_id,
  folderId: row.folder_id,
  createdBy: row.created_by,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
});

export async function create(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    kind: FileKind;
    outcome: 'stored' | 'ingested' | null;
    /** Exports are complete when written; an upload waits for its bytes. */
    receivedAt: Date | null;
    name: string;
    objectKey: string;
    contentType: string;
    bytes: number;
    siloId: string | null;
    createdBy: string;
    expiresAt: Date | null;
    permissions: { clearances: string[]; omittedFields: string[]; connections: string[] };
    /*
     * §3 — provenance describes what an export was PRODUCED FROM: a view, a
     * finding, a ranking or a receipt. An upload was produced from a person,
     * which `created_by` already records, so it has none. Null rather than a
     * fifth source kind, because "uploaded" is not a lineage.
     */
    provenance: {
      sourceKind: SourceKind;
      sourceId: string;
      sourceName: string | null;
      runReference: string | null;
    } | null;
  },
): Promise<StoredFile> {
  const { rows } = await db.query<Row>(
    `INSERT INTO files (id, organisation_id, kind, outcome, received_at, name, object_key,
                        content_type, bytes, silo_id, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING ${COLUMNS}`,
    [
      input.id,
      input.organisationId,
      input.kind,
      input.outcome,
      input.receivedAt,
      input.name,
      input.objectKey,
      input.contentType,
      input.bytes,
      input.siloId,
      input.createdBy,
      input.expiresAt,
    ],
  );

  await db.query(
    `INSERT INTO file_permissions (file_id, organisation_id, clearances, omitted_fields, connections)
     VALUES ($1, $2, $3::uuid[], $4::text[], $5::uuid[])`,
    [
      input.id,
      input.organisationId,
      input.permissions.clearances,
      input.permissions.omittedFields,
      input.permissions.connections,
    ],
  );

  if (input.provenance) {
    await db.query(
      `INSERT INTO file_provenance
         (file_id, organisation_id, source_kind, source_id, source_name, run_reference)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.id,
        input.organisationId,
        input.provenance.sourceKind,
        input.provenance.sourceId,
        input.provenance.sourceName,
        input.provenance.runReference,
      ],
    );
  }

  return map(rows[0]!);
}

/**
 * A file. `pending` reaches the rows whose bytes have not turned up, which only
 * the upload path has any business seeing.
 */
export async function read(
  db: Executor,
  id: string,
  options: { pending?: boolean } = {},
): Promise<StoredFile | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM files
      WHERE id = $1 AND deleted_at IS NULL AND ($2 OR received_at IS NOT NULL)`,
    [id, options.pending ?? false],
  );
  return rows[0] ? map(rows[0]) : null;
}

/** §5 — the bytes turned up, and what they turned out to be. */
export async function markReceived(
  db: Executor,
  input: { id: string; contentType: string; bytes: number },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE files SET received_at = now(), content_type = $2, bytes = $3
      WHERE id = $1 AND received_at IS NULL AND deleted_at IS NULL`,
    [input.id, input.contentType, input.bytes],
  );
  return (rowCount ?? 0) > 0;
}

/** An upload that failed validation. The row goes; the object is removed too. */
export async function discard(db: Executor, id: string): Promise<void> {
  await db.query(`UPDATE files SET deleted_at = now() WHERE id = $1`, [id]);
}

/**
 * What this person made, newest first.
 *
 * THE KIND IS A FILTER RATHER THAN TWO FUNCTIONS. §1's two things — a document
 * Silo produced and a document a customer uploaded — now live in two rooms:
 * exports in Exports, uploads inside the Silo that holds them. The rows are
 * still one table, because an upload and an export are the same object with
 * different provenance, and sharing, folders and deletion are written once.
 */
export async function listOwnedBy(
  db: Executor,
  membershipId: string,
  kind?: FileKind,
): Promise<StoredFile[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM files
      WHERE created_by = $1 AND deleted_at IS NULL AND received_at IS NOT NULL
        AND ($2::text IS NULL OR kind = $2)
      ORDER BY created_at DESC
      LIMIT 200`,
    [membershipId, kind ?? null],
  );
  return rows.map(map);
}

/**
 * The documents uploaded into one Silo, for whoever may see each of them.
 *
 * THE SAME REACH TEST AS EVERY OTHER LISTING: theirs, or shared with them by
 * name, by scope or across the organisation. Being able to open the Silo is not
 * the question — §2's rule is that access is decided on the file.
 */
export async function filesOfSilo(
  db: Executor,
  input: { siloId: string; membershipId: string },
): Promise<StoredFile[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM files f
      WHERE f.silo_id = $1
        AND f.deleted_at IS NULL
        AND f.received_at IS NOT NULL
        AND (
          f.created_by = $2
          OR EXISTS (
               SELECT 1 FROM file_shares s
                WHERE s.file_id = f.id
                  AND s.revoked_at IS NULL
                  AND (s.expires_at IS NULL OR s.expires_at > now())
                  AND (
                    s.membership_id = $2
                    OR s.organisation_wide
                    OR s.scope_id IN (SELECT scope_id FROM scope_memberships WHERE membership_id = $2)
                  )
             )
        )
      ORDER BY f.created_at DESC
      LIMIT 200`,
    [input.siloId, input.membershipId],
  );
  return rows.map(map);
}

export async function permissionsFor(db: Executor, fileId: string): Promise<FrozenPermissions | null> {
  const { rows } = await db.query<{
    clearances: string[];
    omitted_fields: string[];
    connections: string[];
    frozen_at: Date;
  }>(
    `SELECT clearances, omitted_fields, connections, frozen_at
       FROM file_permissions WHERE file_id = $1`,
    [fileId],
  );
  const row = rows[0];
  if (!row) return null;

  return {
    clearances: row.clearances,
    omittedFields: row.omitted_fields,
    connections: row.connections,
    frozenAt: row.frozen_at,
  };
}

export async function provenanceFor(db: Executor, fileId: string): Promise<Provenance | null> {
  const { rows } = await db.query<{
    source_kind: SourceKind;
    source_id: string;
    source_name: string | null;
    run_reference: string | null;
    produced_at: Date;
  }>(
    `SELECT source_kind, source_id, source_name, run_reference, produced_at
       FROM file_provenance WHERE file_id = $1`,
    [fileId],
  );
  const row = rows[0];
  if (!row) return null;

  return {
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    sourceName: row.source_name,
    runReference: row.run_reference,
    producedAt: row.produced_at,
  };
}

/* ── §2: folders, which are an arrangement and not a boundary ────────────── */

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  createdBy: string;
  createdAt: Date;
}

export async function createFolder(
  db: Executor,
  input: { id: string; organisationId: string; name: string; parentId: string | null; createdBy: string },
): Promise<Folder> {
  const { rows } = await db.query<{
    id: string; name: string; parent_id: string | null; created_by: string; created_at: Date;
  }>(
    `INSERT INTO folders (id, organisation_id, name, parent_id, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, parent_id, created_by, created_at`,
    [input.id, input.organisationId, input.name, input.parentId, input.createdBy],
  );
  const row = rows[0]!;
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export async function foldersUnder(db: Executor, parentId: string | null): Promise<Folder[]> {
  const { rows } = await db.query<{
    id: string; name: string; parent_id: string | null; created_by: string; created_at: Date;
  }>(
    `SELECT id, name, parent_id, created_by, created_at FROM folders
      WHERE parent_id IS NOT DISTINCT FROM $1 ORDER BY name`,
    [parentId],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }));
}

export async function readFolder(db: Executor, id: string): Promise<Folder | null> {
  const { rows } = await db.query<{
    id: string; name: string; parent_id: string | null; created_by: string; created_at: Date;
  }>(
    `SELECT id, name, parent_id, created_by, created_at FROM folders WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export async function moveFile(db: Executor, input: { id: string; folderId: string | null }): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE files SET folder_id = $2 WHERE id = $1 AND deleted_at IS NULL`,
    [input.id, input.folderId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * §2 — the files in a folder THIS PERSON may see.
 *
 * THE FILTER IS IN THE QUERY, NOT AFTER IT. "Two people opening the same folder
 * see different contents" — and a listing that fetched everything and filtered
 * in TypeScript would have the whole folder in memory, one careless `return`
 * away from being the response. It is also why there is no count: a total
 * computed before the filter is a disclosure of what was filtered out.
 */
export async function filesIn(
  db: Executor,
  input: { folderId: string | null; membershipId: string; kind?: FileKind },
): Promise<StoredFile[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM files f
      WHERE f.folder_id IS NOT DISTINCT FROM $1
        AND f.deleted_at IS NULL
        AND f.received_at IS NOT NULL
        AND ($3::text IS NULL OR f.kind = $3)
        AND (
          f.created_by = $2
          OR EXISTS (
               SELECT 1 FROM file_shares s
                WHERE s.file_id = f.id
                  AND s.revoked_at IS NULL
                  AND (s.expires_at IS NULL OR s.expires_at > now())
                  AND (
                    s.membership_id = $2
                    OR s.organisation_wide
                    OR s.scope_id IN (SELECT scope_id FROM scope_memberships WHERE membership_id = $2)
                  )
             )
        )
      ORDER BY f.created_at DESC
      LIMIT 500`,
    [input.folderId, input.membershipId, input.kind ?? null],
  );
  return rows.map(map);
}

/* ── §4: shares ──────────────────────────────────────────────────────────── */

export interface FileShare {
  id: string;
  fileId: string;
  membershipId: string | null;
  scopeId: string | null;
  organisationWide: boolean;
  access: 'view' | 'download';
  expiresAt: Date | null;
}

export async function share(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    fileId: string;
    membershipId: string | null;
    scopeId: string | null;
    organisationWide: boolean;
    access: 'view' | 'download';
    sharedBy: string;
    expiresAt: Date | null;
  },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO file_shares
       (id, organisation_id, file_id, membership_id, scope_id, organisation_wide, access, shared_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (file_id, membership_id, scope_id, organisation_wide) DO UPDATE
        SET access = EXCLUDED.access, expires_at = EXCLUDED.expires_at,
            shared_by = EXCLUDED.shared_by, shared_at = now(), revoked_at = NULL
     RETURNING id`,
    [
      input.id,
      input.organisationId,
      input.fileId,
      input.membershipId,
      input.scopeId,
      input.organisationWide,
      input.access,
      input.sharedBy,
      input.expiresAt,
    ],
  );
  return rows[0]!.id;
}

export async function revokeShare(db: Executor, input: { fileId: string; shareId: string }): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE file_shares SET revoked_at = now()
      WHERE id = $1 AND file_id = $2 AND revoked_at IS NULL`,
    [input.shareId, input.fileId],
  );
  return (rowCount ?? 0) > 0;
}

/** The live share reaching this membership, if any. */
export async function shareFor(
  db: Executor,
  input: { fileId: string; membershipId: string },
): Promise<FileShare | null> {
  const { rows } = await db.query<{
    id: string;
    file_id: string;
    membership_id: string | null;
    scope_id: string | null;
    organisation_wide: boolean;
    access: 'view' | 'download';
    expires_at: Date | null;
  }>(
    `SELECT id, file_id, membership_id, scope_id, organisation_wide, access, expires_at
       FROM file_shares
      WHERE file_id = $1
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
        AND (
          membership_id = $2
          OR organisation_wide
          OR scope_id IN (SELECT scope_id FROM scope_memberships WHERE membership_id = $2)
        )
      /* A named share beats a scope beats the whole organisation: the most
         specific grant is the one somebody meant. */
      ORDER BY (membership_id IS NOT NULL) DESC, (scope_id IS NOT NULL) DESC
      LIMIT 1`,
    [input.fileId, input.membershipId],
  );

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    fileId: row.file_id,
    membershipId: row.membership_id,
    scopeId: row.scope_id,
    organisationWide: row.organisation_wide,
    access: row.access,
    expiresAt: row.expires_at,
  };
}


/* ── §5: ingestion, and §6: taking it away ───────────────────────────────── */

/** §5 — the document is now also the importer's working record. */
export async function markIngested(
  db: Executor,
  input: { id: string; siloFileId: string },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE files SET outcome = 'ingested', silo_file_id = $2
      WHERE id = $1 AND kind = 'upload' AND outcome = 'stored' AND deleted_at IS NULL`,
    [input.id, input.siloFileId],
  );
  return (rowCount ?? 0) > 0;
}

export async function markDeleted(db: Executor, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE files SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

export interface DeletionReceipt {
  id: string;
  fileId: string;
  fileName: string;
  scope: 'document' | 'document_and_data';
  purgeReceiptId: string | null;
  detectorsAffected: string[];
  rowsRemoved: number;
  extractionsRemoved: number;
  completedAt: Date;
}

/**
 * §6 — "Deletion produces a receipt: what was removed, by whom, and what
 * stopped working as a result."
 */
export async function recordDeletion(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    fileId: string;
    fileName: string;
    fileKind: FileKind;
    scope: 'document' | 'document_and_data';
    purgeReceiptId: string | null;
    detectorsAffected: string[];
    rowsRemoved: number;
    extractionsRemoved: number;
    requestedBy: string;
  },
): Promise<DeletionReceipt> {
  const { rows } = await db.query<{
    id: string;
    file_id: string;
    file_name: string;
    scope: 'document' | 'document_and_data';
    purge_receipt_id: string | null;
    detectors_affected: string[];
    rows_removed: number;
    extractions_removed: number;
    completed_at: Date;
  }>(
    `INSERT INTO file_deletions
       (id, organisation_id, file_id, file_name, file_kind, scope, purge_receipt_id,
        detectors_affected, rows_removed, extractions_removed, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10, $11)
     RETURNING id, file_id, file_name, scope, purge_receipt_id, detectors_affected,
               rows_removed, extractions_removed, completed_at`,
    [
      input.id,
      input.organisationId,
      input.fileId,
      input.fileName,
      input.fileKind,
      input.scope,
      input.purgeReceiptId,
      input.detectorsAffected,
      input.rowsRemoved,
      input.extractionsRemoved,
      input.requestedBy,
    ],
  );

  const row = rows[0]!;
  return {
    id: row.id,
    fileId: row.file_id,
    fileName: row.file_name,
    scope: row.scope,
    purgeReceiptId: row.purge_receipt_id,
    detectorsAffected: row.detectors_affected,
    rowsRemoved: row.rows_removed,
    extractionsRemoved: row.extractions_removed,
    completedAt: row.completed_at,
  };
}


/**
 * §6 — the receipts for what this person deleted.
 *
 * A RECEIPT NOBODY CAN READ IS NOT A RECEIPT. "Deletion produces a receipt:
 * what was removed, by whom, and what stopped working as a result" — and the
 * reviewer §6 is written for reads it after the fact, which is the only time it
 * matters. Kept after the file is gone, so it is queried by `requested_by`
 * rather than by joining to a row that no longer exists.
 */
export async function deletionsBy(db: Executor, membershipId: string): Promise<DeletionReceipt[]> {
  const { rows } = await db.query<{
    id: string;
    file_id: string;
    file_name: string;
    scope: 'document' | 'document_and_data';
    purge_receipt_id: string | null;
    detectors_affected: string[];
    rows_removed: number;
    extractions_removed: number;
    completed_at: Date;
  }>(
    `SELECT id, file_id, file_name, scope, purge_receipt_id, detectors_affected,
            rows_removed, extractions_removed, completed_at
       FROM file_deletions
      WHERE requested_by = $1
      ORDER BY completed_at DESC
      LIMIT 200`,
    [membershipId],
  );

  return rows.map((row) => ({
    id: row.id,
    fileId: row.file_id,
    fileName: row.file_name,
    scope: row.scope,
    purgeReceiptId: row.purge_receipt_id,
    detectorsAffected: row.detectors_affected,
    rowsRemoved: row.rows_removed,
    extractionsRemoved: row.extractions_removed,
    completedAt: row.completed_at,
  }));
}

/**
 * Files §6 — uploads past the retention window of the Silo they belong to.
 *
 * ── NOTHING SWEPT THIS TABLE AT ALL ───────────────────────────────────────
 *
 * §6 — "Uploads carry the retention of the Silo they belong to." `requestUpload`
 * computes `expires_at` from the Silo's window and writes it; every query in
 * this file then ignores it, the `files_expiring` index 092 built had no
 * reader, and the retention sweep never named this table. So a stored upload
 * was never deleted by anything, and `file_retention_swept` was declared and
 * emitted nowhere.
 *
 * EXPORTS ARE NOT SWEPT HERE and that is not an omission: §6 gives them their
 * own retention "set per organisation, defaulting to indefinite", and
 * `expires_at` is null on every export because no organisation setting exists
 * yet. A null never matches, so exports are untouched by construction rather
 * than by a filter somebody could remove.
 */
export async function expired(
  db: Executor,
  now: Date,
): Promise<Array<{ id: string; organisationId: string; siloId: string | null; objectKey: string }>> {
  const { rows } = await db.query<{
    id: string;
    organisation_id: string;
    silo_id: string | null;
    object_key: string;
  }>(
    `SELECT id, organisation_id, silo_id, object_key
       FROM files
      WHERE deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at <= $1
      ORDER BY expires_at
      LIMIT 5000`,
    [now],
  );
  return rows.map((row) => ({
    id: row.id,
    organisationId: row.organisation_id,
    siloId: row.silo_id,
    objectKey: row.object_key,
  }));
}
