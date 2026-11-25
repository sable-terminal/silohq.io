import type { Executor } from '../infra/db.infra';

/**
 * §10 — Siloes: what is captured, what it is compared against, and what was
 * deleted.
 *
 * SQL, AND THE MAPPING BETWEEN A ROW AND A MODEL. Whether somebody may enable
 * storage, whether they hold clearance on a concept they are adding, and which
 * detectors stop working when something is purged are all the service's
 * decisions.
 */

export interface Silo {
  id: string;
  organisationId: string;
  name: string;
  purpose: string;
  retentionDays: number;
  /** §10 — metered from day one. */
  bytesScanned: number;
  /** Import §9 — document extractions run against this Silo. */
  extractionOperations: number;
  createdBy: string;
  createdAt: Date;
  disabledAt: Date | null;
}

export interface SiloConcept {
  id: string;
  siloId: string;
  conceptId: string;
  nominatedFields: string[];
  addedBy: string;
  addedAt: Date;
}

/* ── The Silo ────────────────────────────────────────────────────────────── */

const SILO_COLUMNS = `
  id, organisation_id, name, purpose, retention_days, bytes_scanned, extraction_operations,
  created_by, created_at, disabled_at
`;

interface SiloRow {
  id: string;
  organisation_id: string;
  name: string;
  purpose: string;
  retention_days: number;
  bytes_scanned: string;
  extraction_operations: string;
  created_by: string;
  created_at: Date;
  disabled_at: Date | null;
}

const mapSilo = (row: SiloRow): Silo => ({
  id: row.id,
  organisationId: row.organisation_id,
  name: row.name,
  purpose: row.purpose,
  retentionDays: row.retention_days,
  bytesScanned: Number(row.bytes_scanned),
  extractionOperations: Number(row.extraction_operations),
  createdBy: row.created_by,
  createdAt: row.created_at,
  disabledAt: row.disabled_at,
});

export async function create(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    name: string;
    purpose: string;
    retentionDays: number;
    createdBy: string;
  },
): Promise<Silo> {
  const { rows } = await db.query<SiloRow>(
    `INSERT INTO siloes (id, organisation_id, name, purpose, retention_days, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${SILO_COLUMNS}`,
    [input.id, input.organisationId, input.name, input.purpose, input.retentionDays, input.createdBy],
  );
  return mapSilo(rows[0]!);
}

export async function find(db: Executor, id: string): Promise<Silo | null> {
  const { rows } = await db.query<SiloRow>(`SELECT ${SILO_COLUMNS} FROM siloes WHERE id = $1`, [id]);
  return rows[0] ? mapSilo(rows[0]) : null;
}

export async function list(db: Executor): Promise<Silo[]> {
  const { rows } = await db.query<SiloRow>(
    `SELECT ${SILO_COLUMNS} FROM siloes ORDER BY created_at DESC`,
  );
  return rows.map(mapSilo);
}

/** Returns the previous window, because shortening one destroys data. */
export async function setRetention(
  db: Executor,
  id: string,
  days: number,
): Promise<number | null> {
  const { rows } = await db.query<{ previous: number }>(
    `UPDATE siloes SET retention_days = $2 WHERE id = $1
  RETURNING (SELECT retention_days FROM siloes WHERE id = $1) AS previous`,
    [id, days],
  );
  return rows[0]?.previous ?? null;
}

/**
 * §9 — the "disable" half of "disable and purge".
 *
 * IT RELEASES WHAT THE SILO NOMINATED. A concept may be live in one Silo only,
 * so a disabled Silo still holding its nominations would make those concepts
 * impossible to capture anywhere again. Released rows keep `removed_at`, so the
 * history of what was captured and when stays readable.
 */
export async function disable(db: Executor, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE siloes SET disabled_at = now() WHERE id = $1 AND disabled_at IS NULL`,
    [id],
  );
  if ((rowCount ?? 0) === 0) return false;

  await db.query(
    `UPDATE silo_concepts SET removed_at = now() WHERE silo_id = $1 AND removed_at IS NULL`,
    [id],
  );
  return true;
}

/** §10 — what the detectors read out of a Silo, accumulated. */
export async function recordScan(db: Executor, siloId: string, bytes: number): Promise<void> {
  if (bytes <= 0) return;
  await db.query(`UPDATE siloes SET bytes_scanned = bytes_scanned + $2 WHERE id = $1`, [
    siloId,
    bytes,
  ]);
}

/* ── What it captures ────────────────────────────────────────────────────── */

type SiloConceptRow = {
  id: string;
  silo_id: string;
  concept_id: string;
  nominated_fields: string[];
  added_by: string;
  added_at: Date;
};

const mapSiloConcept = (row: SiloConceptRow): SiloConcept => ({
  id: row.id,
  siloId: row.silo_id,
  conceptId: row.concept_id,
  nominatedFields: row.nominated_fields,
  addedBy: row.added_by,
  addedAt: row.added_at,
});

export async function addConcept(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    siloId: string;
    conceptId: string;
    nominatedFields: string[];
    addedBy: string;
  },
): Promise<SiloConcept> {
  const { rows } = await db.query<SiloConceptRow>(
    `INSERT INTO silo_concepts
       (id, organisation_id, silo_id, concept_id, nominated_fields, added_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, silo_id, concept_id, nominated_fields, added_by, added_at`,
    [input.id, input.organisationId, input.siloId, input.conceptId, input.nominatedFields, input.addedBy],
  );
  return mapSiloConcept(rows[0]!);
}

export async function removeConcept(db: Executor, siloId: string, conceptId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE silo_concepts SET removed_at = now()
      WHERE silo_id = $1 AND concept_id = $2 AND removed_at IS NULL`,
    [siloId, conceptId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Replace the nominated fields, returning the ones that were nominated before.
 *
 * NARROWING DELETES NOTHING. A field that stops being nominated stops being
 * captured; what was already captured for it stays under the window until the
 * sweep or a purge takes it, exactly as removing a whole concept does.
 */
export async function setNominatedFields(
  db: Executor,
  siloId: string,
  conceptId: string,
  fields: string[],
): Promise<string[] | null> {
  const { rows } = await db.query<{ previous: string[] }>(
    `UPDATE silo_concepts
        SET nominated_fields = $3
      WHERE silo_id = $1 AND concept_id = $2 AND removed_at IS NULL
  RETURNING (SELECT nominated_fields FROM silo_concepts
              WHERE silo_id = $1 AND concept_id = $2 AND removed_at IS NULL) AS previous`,
    [siloId, conceptId, fields],
  );
  return rows[0]?.previous ?? null;
}

/**
 * Which Silo, if any, already nominates this concept — whatever the switches.
 *
 * ONE LIVE SILO PER CONCEPT, and this is the question asked before a second
 * nomination, so it deliberately ignores whether storage is on: a concept held
 * by a Silo in a switched-off organisation is still held.
 */
export async function nominatedBy(
  db: Executor,
  conceptId: string,
): Promise<{ siloId: string; name: string } | null> {
  const { rows } = await db.query<{ id: string; name: string }>(
    `SELECT s.id, s.name
       FROM silo_concepts sc
       JOIN siloes s ON s.id = sc.silo_id
      WHERE sc.concept_id = $1 AND sc.removed_at IS NULL`,
    [conceptId],
  );
  return rows[0] ? { siloId: rows[0].id, name: rows[0].name } : null;
}

/**
 * What is being captured for this concept right now.
 *
 * THE QUESTION THE QUERY PATH ASKS, on every answer, so it has to be one
 * statement and it has to be cheap.
 */
export async function capturedFields(
  db: Executor,
  conceptId: string,
): Promise<{ siloId: string; fields: string[]; retentionDays: number } | null> {
  /*
   * -- THREE SWITCHES, AND THE ORGANISATION'S IS THE ONE THAT GETS FORGOTTEN --
   *
   * A concept is captured only while the concept is nominated, the Silo is
   * live, AND the organisation's master switch is on. `captureBatch` asks the
   * same three again at write time, because a reading queued before a switch
   * was thrown is written after it.
   *
   * No LIMIT is needed: `silo_concepts_one_silo_per_concept` allows one live
   * nomination per concept, so which Silo a concept belongs to is not a choice
   * this statement makes.
   */
  const { rows } = await db.query<{
    silo_id: string;
    nominated_fields: string[];
    retention_days: number;
  }>(
    `SELECT sc.silo_id, sc.nominated_fields, s.retention_days
       FROM silo_concepts sc
       JOIN siloes s        ON s.id = sc.silo_id
       JOIN organisations o ON o.id = s.organisation_id
      WHERE sc.concept_id = $1
        AND sc.removed_at IS NULL
        AND s.disabled_at IS NULL
        AND o.storage_enabled`,
    [conceptId],
  );

  const row = rows[0];
  return row
    ? { siloId: row.silo_id, fields: row.nominated_fields, retentionDays: row.retention_days }
    : null;
}

export async function conceptsIn(db: Executor, siloId: string): Promise<SiloConcept[]> {
  const { rows } = await db.query<SiloConceptRow>(
    `SELECT id, silo_id, concept_id, nominated_fields, added_by, added_at
       FROM silo_concepts WHERE silo_id = $1 AND removed_at IS NULL`,
    [siloId],
  );
  return rows.map(mapSiloConcept);
}

/* ── Capture ─────────────────────────────────────────────────────────────── */

/** One field of one entity from one system, as an answer contained it. */
export interface Reading {
  conceptId: string;
  connectionId: string;
  entityRef: string;
  fieldPath: string;
  value: string | null;
  /** When the answer was assembled, not when the queue got round to it. */
  observedAt: string;
}

/**
 * Compare a batch of readings against what was last seen, and write what moved.
 *
 * ── Five things this statement decides, each of which was wrong once ───────
 *
 * 1. WHICH READINGS ARE STILL WANTED. The concept nominated, the field one of
 *    its nominated fields, the Silo live, the organisation switched on — asked
 *    again here, at write time, because a reading queued before any of those
 *    changed is written after it. And not observed before a purge that covers
 *    it: a receipt is a fence, so a reading still in flight when the wipe
 *    arrived, in this process or any other instance's queue, is refused rather
 *    than written back behind a receipt that says it is gone.
 *
 * 2. ONE READING PER KEY. Two readings for the same entity and field in one
 *    batch made `ON CONFLICT DO UPDATE` refuse the whole statement ("cannot
 *    affect row a second time"), and the drain then threw away every reading for
 *    every concept in the Silo. It happened whenever one question was asked twice
 *    in five seconds. The latest observation wins; a value that moved and moved
 *    back inside one batch records nothing, which is the sampling §5 states.
 *
 * 3. A BASELINE PER CONNECTION. Two systems that use the same identifier share
 *    no baseline, so their disagreeing is not recorded as a change on every
 *    answer.
 *
 * 4. NOTHING BACKWARDS. A reading observed before the baseline was last
 *    updated — a slow instance's queue — neither writes a transition nor rolls
 *    the baseline back.
 *
 * 5. NO TRANSITION ON FIRST SIGHTING. `JOIN` rather than `LEFT JOIN`: with no
 *    baseline there is nothing to compare against.
 *
 * ── And one thing it does before the statement ─────────────────────────────
 *
 * THE EXISTING BASELINES ARE LOCKED FIRST, in a statement of their own. Every
 * CTE in one statement sees the same snapshot, so two instances writing the
 * same entity could both read the old value and both record the change. Taking
 * the row locks first makes the second wait, and under READ COMMITTED its next
 * statement sees what the first committed.
 */
export async function captureBatch(
  db: Executor,
  input: { organisationId: string; siloId: string; readings: ReadonlyArray<Reading> },
): Promise<{ written: number; admitted: number }> {
  if (input.readings.length === 0) return { written: 0, admitted: 0 };

  const payload = JSON.stringify(input.readings);

  await db.query(
    `SELECT 1
       FROM silo_baselines b
       JOIN (SELECT DISTINCT (r->>'conceptId')::uuid    AS concept_id,
                             (r->>'connectionId')::uuid AS connection_id,
                              r->>'entityRef'           AS entity_ref,
                              r->>'fieldPath'           AS field_path
               FROM jsonb_array_elements($2::jsonb) AS r) k
         ON b.silo_id = $1
        AND b.concept_id = k.concept_id AND b.connection_id = k.connection_id
        AND b.entity_ref = k.entity_ref AND b.field_path = k.field_path
      ORDER BY b.id
        FOR UPDATE OF b`,
    [input.siloId, payload],
  );

  const { rows } = await db.query<{ written: string; admitted: string }>(
    `WITH incoming AS (
       SELECT (e.r->>'conceptId')::uuid          AS concept_id,
              (e.r->>'connectionId')::uuid       AS connection_id,
               e.r->>'entityRef'                 AS entity_ref,
               e.r->>'fieldPath'                 AS field_path,
               e.r->>'value'                     AS value,
              (e.r->>'observedAt')::timestamptz  AS observed_at,
               e.ord
         FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS e(r, ord)
     ),
     admitted AS (
       SELECT i.*, s.retention_days
         FROM incoming i
         JOIN siloes s        ON s.id = $2 AND s.organisation_id = $1 AND s.disabled_at IS NULL
         JOIN organisations o ON o.id = s.organisation_id AND o.storage_enabled
         JOIN silo_concepts sc
           ON sc.silo_id = s.id AND sc.concept_id = i.concept_id
          AND sc.removed_at IS NULL AND i.field_path = ANY (sc.nominated_fields)
        WHERE NOT EXISTS (
                SELECT 1 FROM purge_receipts p
                 WHERE p.silo_id = $2
                   AND p.completed_at >= i.observed_at
                   AND (    p.scope = 'silo'
                        OR (p.scope = 'concept' AND p.concept_id = i.concept_id)
                        OR (p.scope = 'entity'  AND p.concept_id = i.concept_id
                                                AND p.entity_ref = i.entity_ref))
              )
     ),
     latest AS (
       SELECT DISTINCT ON (concept_id, connection_id, entity_ref, field_path) *
         FROM admitted
        ORDER BY concept_id, connection_id, entity_ref, field_path, observed_at DESC, ord DESC
     ),
     changed AS (
       INSERT INTO transitions
         (id, organisation_id, silo_id, concept_id, connection_id,
          entity_ref, field_path, previous_value, new_value, observed_at)
       SELECT gen_random_uuid(), $1, $2, l.concept_id, l.connection_id,
              l.entity_ref, l.field_path, b.last_value, l.value, l.observed_at
         FROM latest l
         JOIN silo_baselines b
           ON b.silo_id = $2
          AND b.concept_id = l.concept_id AND b.connection_id = l.connection_id
          AND b.entity_ref = l.entity_ref AND b.field_path = l.field_path
        WHERE b.last_value IS DISTINCT FROM l.value
          AND b.last_seen_at <= l.observed_at
          /* A baseline past the window is unreadable, and so not a thing a
             change can be measured from: the next sighting is a first one. */
          AND b.last_seen_at >= now() - make_interval(days => l.retention_days)
       RETURNING 1
     ),
     baseline AS (
       INSERT INTO silo_baselines
         (id, organisation_id, silo_id, concept_id, connection_id,
          entity_ref, field_path, last_value, last_seen_at)
       SELECT gen_random_uuid(), $1, $2, l.concept_id, l.connection_id,
              l.entity_ref, l.field_path, l.value, l.observed_at
         FROM latest l
       ON CONFLICT (silo_id, concept_id, connection_id, entity_ref, field_path) DO UPDATE
          SET last_value = EXCLUDED.last_value, last_seen_at = EXCLUDED.last_seen_at
        WHERE silo_baselines.last_seen_at <= EXCLUDED.last_seen_at
       RETURNING 1
     )
     SELECT (SELECT count(*) FROM changed)::text  AS written,
            (SELECT count(*) FROM admitted)::text AS admitted`,
    [input.organisationId, input.siloId, payload],
  );

  return {
    written: Number(rows[0]?.written ?? 0),
    admitted: Number(rows[0]?.admitted ?? 0),
  };
}

/** §12 — whether a Silo holds anything for this concept, and since when. */
export async function coverageOf(
  db: Executor,
  siloId: string,
  conceptId: string,
): Promise<{ transitions: number; since: Date | null }> {
  /* Within the window only: a change past it is unreadable, whether or not the
     sweep has deleted it yet. */
  const { rows } = await db.query<{ n: string; since: Date | null }>(
    `SELECT count(*)::text AS n, min(t.observed_at) AS since
       FROM transitions t
       JOIN siloes s ON s.id = t.silo_id
      WHERE t.silo_id = $1 AND t.concept_id = $2
        AND t.observed_at >= now() - make_interval(days => s.retention_days)`,
    [siloId, conceptId],
  );

  const row = rows[0];
  return { transitions: Number(row?.n ?? 0), since: row?.since ?? null };
}

/**
 * §12 — when each change happened, so a detector can run against it.
 *
 * NO VALUES COME BACK. A detector over a Silo counts changes: how often a field
 * moves, which entities keep moving. Neither needs what the field said, so this
 * read does not return it, and the one table in the product holding customer
 * values has no read path that hands them to anything.
 *
 * THE NEWEST, NOT THE OLDEST. Ordered ascending with a limit, a busy Silo fed
 * the detectors its oldest rows and presented a finding about months ago as a
 * finding about now. Newest first, then reversed.
 *
 * PAST THE WINDOW IS UNREADABLE, NOT MERELY UNSWEPT. A retention bound that
 * holds only once the sweep has run is a promise; filtering here makes it hold
 * the moment the window passes, which is what the disclosure says.
 *
 * ONE MORE THAN ASKED FOR, so the caller can tell a range that fitted from a
 * range that did not — bounds refuse rather than truncate, and refusing needs
 * to know.
 *
 * `bytes` IS WHAT POSTGRES READ, for §10's metering: the whole row, not the
 * columns returned.
 */
export type ChangeInstant = {
  entityRef: string;
  fieldPath: string;
  connectionId: string;
  observedAt: Date;
};

export async function changesFor(
  db: Executor,
  input: { siloId: string; conceptId: string; fieldPath?: string; since: Date; limit: number },
): Promise<{ changes: ChangeInstant[]; truncated: boolean; bytes: number }> {
  const args: unknown[] = [input.siloId, input.conceptId, input.since];
  let fieldClause = '';
  if (input.fieldPath) {
    args.push(input.fieldPath);
    fieldClause = ` AND t.field_path = $${args.length}`;
  }
  args.push(input.limit + 1);

  const { rows } = await db.query<{
    entity_ref: string;
    field_path: string;
    connection_id: string;
    observed_at: Date;
    bytes: number;
  }>(
    `SELECT t.entity_ref, t.field_path, t.connection_id, t.observed_at,
            pg_column_size(t.*) AS bytes
       FROM transitions t
       JOIN siloes s ON s.id = t.silo_id
      WHERE t.silo_id = $1 AND t.concept_id = $2 AND t.observed_at >= $3
        AND t.observed_at >= now() - make_interval(days => s.retention_days)${fieldClause}
      ORDER BY t.observed_at DESC
      LIMIT $${args.length}`,
    args,
  );

  const truncated = rows.length > input.limit;
  const kept = rows.slice(0, input.limit).reverse();

  return {
    changes: kept.map((row) => ({
      entityRef: row.entity_ref,
      fieldPath: row.field_path,
      connectionId: row.connection_id,
      observedAt: row.observed_at,
    })),
    truncated,
    bytes: rows.reduce((sum, row) => sum + Number(row.bytes), 0),
  };
}

/* ── Wipe ────────────────────────────────────────────────────────────────── */

/**
 * §9 — exactly one of three scopes, and the scope IS the delete.
 *
 * AN ENTITY IS NAMED WITHIN A CONCEPT. `entity_ref` is a source identifier, and
 * the same identifier in two concepts is two different records.
 */
export type PurgeTarget =
  | { scope: 'silo' }
  | { scope: 'concept'; conceptId: string }
  | { scope: 'entity'; conceptId: string; entityRef: string }
  /* Import §11 — one file with everything read out of it, and one imported object. */
  | { scope: 'file'; fileId: string }
  | { scope: 'object'; sourceId: string; objectName: string };

/** The captured rows a scope reaches. Null for the import-only scopes, which reach none. */
function whereFor(siloId: string, target: PurgeTarget): { clause: string; args: unknown[] } | null {
  switch (target.scope) {
    case 'file':
    case 'object':
      return null;
    case 'silo':
      return { clause: 'silo_id = $1', args: [siloId] };
    case 'concept':
      return { clause: 'silo_id = $1 AND concept_id = $2', args: [siloId, target.conceptId] };
    case 'entity':
      return {
        clause: 'silo_id = $1 AND concept_id = $2 AND entity_ref = $3',
        args: [siloId, target.conceptId, target.entityRef],
      };
  }
}

export async function purge(
  db: Executor,
  siloId: string,
  target: PurgeTarget,
): Promise<{ transitions: number; baselines: number }> {
  const where = whereFor(siloId, target);
  if (!where) return { transitions: 0, baselines: 0 };
  const { clause, args } = where;

  const gone = await db.query(`DELETE FROM transitions WHERE ${clause}`, args);
  /* THE BASELINE GOES TOO. It holds the last value seen, which is a customer
     value, and a purge that left it would leave the thing purged. */
  const baselines = await db.query(`DELETE FROM silo_baselines WHERE ${clause}`, args);

  return { transitions: gone.rowCount ?? 0, baselines: baselines.rowCount ?? 0 };
}

export interface PurgeReceipt {
  id: string;
  siloId: string;
  scope: PurgeTarget['scope'];
  conceptId: string | null;
  entityRef: string | null;
  fileId: string | null;
  sourceId: string | null;
  objectName: string | null;
  filesRemoved: number;
  rowsRemoved: number;
  transitionsRemoved: number;
  baselinesRemoved: number;
  detectorsAffected: string[];
  siloDisabled: boolean;
  requestedBy: string;
  /** §4 — the second person, where the organisation requires one. Null where it does not. */
  approvedBy: string | null;
  completedAt: Date;
}

/**
 * Write the receipt.
 *
 * `completed_at` IS THE CLOCK AT INSERT, NOT THE TRANSACTION'S START. It is the
 * fence `captureBatch` checks readings against, and a reading observed while
 * the delete above was running is a reading the delete did not see.
 */
export async function recordReceipt(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    siloId: string;
    target: PurgeTarget;
    transitionsRemoved: number;
    baselinesRemoved: number;
    detectorsAffected: string[];
    siloDisabled: boolean;
    requestedBy: string;
    /** §4 — the second person, where the organisation's approval chain required one. */
    approvedBy: string | null;
    /** Import §11 — imported files and extracted rows the purge removed. */
    filesRemoved: number;
    rowsRemoved: number;
  },
): Promise<void> {
  const { target } = input;
  const conceptId = target.scope === 'concept' || target.scope === 'entity' ? target.conceptId : null;
  const entityRef = target.scope === 'entity' ? target.entityRef : null;
  const fileId = target.scope === 'file' ? target.fileId : null;
  const sourceId = target.scope === 'object' ? target.sourceId : null;
  const objectName = target.scope === 'object' ? target.objectName : null;

  await db.query(
    `INSERT INTO purge_receipts
       (id, organisation_id, silo_id, scope, concept_id, entity_ref, file_id, source_id, object_name,
        transitions_removed, baselines_removed, files_removed, rows_removed, detectors_affected,
        silo_disabled, requested_by, approved_by, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, clock_timestamp())`,
    [
      input.id, input.organisationId, input.siloId, target.scope, conceptId, entityRef, fileId,
      sourceId, objectName, input.transitionsRemoved, input.baselinesRemoved, input.filesRemoved,
      input.rowsRemoved, input.detectorsAffected, input.siloDisabled, input.requestedBy,
      input.approvedBy,
    ],
  );
}

export async function receiptsFor(db: Executor, siloId: string): Promise<PurgeReceipt[]> {
  const { rows } = await db.query<{
    id: string;
    silo_id: string;
    scope: PurgeTarget['scope'];
    concept_id: string | null;
    entity_ref: string | null;
    file_id: string | null;
    source_id: string | null;
    object_name: string | null;
    files_removed: number;
    rows_removed: number;
    transitions_removed: number;
    baselines_removed: number;
    detectors_affected: string[];
    silo_disabled: boolean;
    requested_by: string;
    approved_by: string | null;
    completed_at: Date;
  }>(
    `SELECT id, silo_id, scope, concept_id, entity_ref, file_id, source_id, object_name,
            files_removed, rows_removed, transitions_removed, baselines_removed,
            detectors_affected, silo_disabled, requested_by, approved_by, completed_at
       FROM purge_receipts WHERE silo_id = $1 ORDER BY completed_at DESC`,
    [siloId],
  );

  return rows.map((row) => ({
    id: row.id,
    siloId: row.silo_id,
    scope: row.scope,
    conceptId: row.concept_id,
    entityRef: row.entity_ref,
    fileId: row.file_id,
    sourceId: row.source_id,
    objectName: row.object_name,
    filesRemoved: row.files_removed,
    rowsRemoved: row.rows_removed,
    transitionsRemoved: row.transitions_removed,
    baselinesRemoved: row.baselines_removed,
    detectorsAffected: row.detectors_affected,
    siloDisabled: row.silo_disabled,
    requestedBy: row.requested_by,
    approvedBy: row.approved_by,
    completedAt: row.completed_at,
  }));
}

/* ── §8 Retention ────────────────────────────────────────────────────────── */

/**
 * Delete everything past its Silo's own window — transitions AND baselines.
 *
 * A RETENTION WINDOW THAT IS NOT ENFORCED IS WORSE THAN NONE. The baseline was
 * the part it did not reach: the last value seen for every entity ever queried,
 * kept for ever beside a window that said otherwise. A baseline not seen within
 * the window goes; one seen yesterday stays, because it is inside it.
 *
 * GROUPED PER SILO so one audit entry per organisation can say what went. A bare
 * row count is enough for an operator and useless to a customer.
 */
export async function sweepRetention(
  db: Executor,
): Promise<Array<{ organisationId: string; siloId: string; transitions: number; baselines: number }>> {
  const { rows } = await db.query<{
    organisation_id: string;
    silo_id: string;
    transitions: string;
    baselines: string;
  }>(
    `WITH swept_transitions AS (
       DELETE FROM transitions t
        USING siloes s
        WHERE s.id = t.silo_id
          AND t.observed_at < now() - make_interval(days => s.retention_days)
       RETURNING t.organisation_id, t.silo_id
     ),
     swept_baselines AS (
       DELETE FROM silo_baselines b
        USING siloes s
        WHERE s.id = b.silo_id
          AND b.last_seen_at < now() - make_interval(days => s.retention_days)
       RETURNING b.organisation_id, b.silo_id
     ),
     counted AS (
       SELECT organisation_id, silo_id, 1 AS transitions, 0 AS baselines FROM swept_transitions
       UNION ALL
       SELECT organisation_id, silo_id, 0, 1 FROM swept_baselines
     )
     SELECT organisation_id, silo_id,
            sum(transitions)::text AS transitions, sum(baselines)::text AS baselines
       FROM counted
      GROUP BY organisation_id, silo_id`,
  );

  return rows.map((row) => ({
    organisationId: row.organisation_id,
    siloId: row.silo_id,
    transitions: Number(row.transitions),
    baselines: Number(row.baselines),
  }));
}

/**
 * Keep dated partitions ahead of the data, rescuing anything in the default.
 * Returns how many were created. The function is 065's; this is the call.
 */
export async function ensurePartitions(db: Executor, monthsAhead: number): Promise<number> {
  const { rows } = await db.query<{ created: number }>(
    'SELECT silo_ensure_transition_partitions($1) AS created',
    [monthsAhead],
  );
  return rows[0]?.created ?? 0;
}

/** Drop past months the sweep has emptied. Never a month still holding a row. */
export async function dropEmptyPartitions(db: Executor): Promise<number> {
  const { rows } = await db.query<{ dropped: number }>(
    'SELECT silo_drop_empty_transition_partitions() AS dropped',
  );
  return rows[0]?.dropped ?? 0;
}

/* ── §10 Metering and §11 disclosure ─────────────────────────────────────── */

/**
 * Bytes held, per Silo: whole rows, for both tables that hold values.
 *
 * THE BASELINE IS COUNTED. It holds a customer value per entity per field, and a
 * figure that left it out described a Silo smaller than the one being stored.
 */
export async function bytesStored(
  db: Executor,
  siloId: string,
): Promise<{ transitions: number; baselines: number }> {
  const { rows } = await db.query<{ transitions: string; baselines: string }>(
    `SELECT (SELECT COALESCE(sum(pg_column_size(t.*)), 0) FROM transitions t    WHERE t.silo_id = $1)::text AS transitions,
            (SELECT COALESCE(sum(pg_column_size(b.*)), 0) FROM silo_baselines b WHERE b.silo_id = $1)::text AS baselines`,
    [siloId],
  );
  return {
    transitions: Number(rows[0]?.transitions ?? 0),
    baselines: Number(rows[0]?.baselines ?? 0),
  };
}

/**
 * Everything a Silo holds, per concept — including concepts no longer nominated.
 *
 * A REMOVED CONCEPT STILL HOLDS WHAT IT CAPTURED. Removing a nomination stops
 * capture and deletes nothing, so a disclosure built from the live nominations
 * alone could say a Silo stores nothing while it holds a year of changes.
 */
export async function holdings(
  db: Executor,
  siloId: string,
): Promise<
  Array<{
    conceptId: string;
    conceptName: string | null;
    /** Null where the concept is no longer nominated. */
    nominatedFields: string[] | null;
    transitions: number;
    baselines: number;
    earliest: Date | null;
  }>
> {
  const { rows } = await db.query<{
    concept_id: string;
    name: string | null;
    nominated_fields: string[] | null;
    transitions: string;
    baselines: string;
    earliest: Date | null;
  }>(
    `WITH held_transitions AS (
       SELECT concept_id, count(*) AS n, min(observed_at) AS earliest
         FROM transitions WHERE silo_id = $1 GROUP BY concept_id
     ),
     held_baselines AS (
       SELECT concept_id, count(*) AS n, min(last_seen_at) AS earliest
         FROM silo_baselines WHERE silo_id = $1 GROUP BY concept_id
     ),
     live AS (
       SELECT concept_id, nominated_fields
         FROM silo_concepts WHERE silo_id = $1 AND removed_at IS NULL
     ),
     ids AS (
       SELECT concept_id FROM held_transitions
       UNION SELECT concept_id FROM held_baselines
       UNION SELECT concept_id FROM live
     )
     SELECT ids.concept_id, c.name, live.nominated_fields,
            COALESCE(ht.n, 0)::text AS transitions,
            COALESCE(hb.n, 0)::text AS baselines,
            LEAST(ht.earliest, hb.earliest) AS earliest
       FROM ids
       LEFT JOIN concepts c           ON c.id = ids.concept_id
       LEFT JOIN live                 ON live.concept_id = ids.concept_id
       LEFT JOIN held_transitions ht  ON ht.concept_id = ids.concept_id
       LEFT JOIN held_baselines hb    ON hb.concept_id = ids.concept_id
      ORDER BY c.name NULLS LAST, ids.concept_id`,
    [siloId],
  );

  return rows.map((row) => ({
    conceptId: row.concept_id,
    conceptName: row.name,
    nominatedFields: row.nominated_fields,
    transitions: Number(row.transitions),
    baselines: Number(row.baselines),
    earliest: row.earliest,
  }));
}

/**
 * Simulation §2.2 — WHEN things changed, for one concept in one Silo.
 *
 * ── NO VALUE COLUMN, AND THAT IS THE WHOLE POINT ──────────────────────────
 *
 * `previous_value` and `new_value` are the one place this architecture holds
 * customer values and the entire subject of the storage disclosure. Deriving a
 * lead time needs when a thing changed and never what it said, so this selects
 * a reference and a timestamp. A `SELECT *` here would quietly make the
 * simulation subsystem a second reader of customer values.
 *
 * ── ONE ROW PER ENTITY PER MOMENT ─────────────────────────────────────────
 *
 * A single update touching six nominated fields writes six transition rows at
 * the same instant. That is one event for this purpose, so the field path is
 * dropped and the moments are made distinct — otherwise an edge's sample size
 * would count how many fields a Silo happens to watch.
 *
 * ── WITHIN THE WINDOW, LIKE EVERY OTHER READ OF THIS TABLE ────────────────
 *
 * The published disclosure says "Past its window it can no longer be read, even
 * before it is deleted", and the model that holds that sentence names the
 * window filter on every read in this file as the thing that makes it true.
 * This function shipped without one: the sweep runs nightly, so between a
 * change passing its window and the sweep reaching it there is a period in
 * which a simulation could measure a lead time from events the customer has
 * been told are unreadable.
 *
 * It read no values — times and references only — which is why nothing else
 * caught it. That is not the claim the disclosure makes.
 */
export async function eventTimes(
  db: Executor,
  input: { siloId: string; conceptId: string; limit: number },
): Promise<Array<{ entityRef: string; at: Date }>> {
  const { rows } = await db.query<{ entity_ref: string; observed_at: Date; bytes: string }>(
    `SELECT DISTINCT t.entity_ref, t.observed_at,
            /* §10 — "bytes held and bytes scanned, per Silo". A read that did
               not meter itself would make a Silo look cheaper than it is. */
            sum(pg_column_size(t.*)) OVER ()::text AS bytes
       FROM transitions t
       JOIN siloes s ON s.id = t.silo_id
      WHERE t.silo_id = $1 AND t.concept_id = $2
        AND t.observed_at >= now() - make_interval(days => s.retention_days)
      ORDER BY t.observed_at
      LIMIT $3`,
    [input.siloId, input.conceptId, input.limit],
  );

  if (rows[0]) await recordScan(db, input.siloId, Number(rows[0].bytes));

  return rows.map((row) => ({ entityRef: row.entity_ref, at: row.observed_at }));
}
