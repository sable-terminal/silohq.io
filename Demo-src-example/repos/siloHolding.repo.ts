import type { Executor } from '../infra/db.infra';
import { generateId } from '../utils/tokens.util';
import type { StoredField, StoredFieldType } from '../models/rowStore.model';

/**
 * Siloes (135) — concepts kept in a Silo, and the Postgres stand-in for where
 * their copies live.
 *
 * SQL, and the mapping between a row and a model. Who may keep what, and what
 * a question does with a copy, is the service's.
 */

export type HoldingState = 'waiting' | 'syncing' | 'synced' | 'failed';

export interface Holding {
  id: string;
  siloId: string;
  conceptId: string;
  connectionId: string;
  objectName: string;
  state: HoldingState;
  /** The copy a reader is served: the last one that finished. */
  batchId: string | null;
  syncedAt: Date | null;
  rows: number | null;
  failure: string | null;
  keptBy: string;
  keptAt: Date;
  /** The Silo's window: a copy older than this is not read. */
  retentionDays: number;
  /** Whether each finished copy is kept, rather than replacing the one before (136). */
  history: boolean;
  /** When a copy being made was last heard from. One silent for hours was abandoned by whatever was making it. */
  heardAt: Date | null;
  /**
   * The field this system marks a changed record with (137), worked out from
   * its own records — or null while nothing has shown one. And how many
   * changed records have borne it out.
   */
  changedField: string | null;
  changedEvidence: number;
  /**
   * Whether its Silo is in use and storage is on for the organisation. Where
   * either is not, nothing will copy it again — so it is not read, rather than
   * read for as long as the window lasts while growing a day staler each day.
   */
  live: boolean;
  organisationId: string;
}

/** One finished copy of a holding (136): the batch its rows carry, and the moment it is a picture of. */
export interface Copy {
  id: string;
  holdingId: string;
  copiedAt: Date;
  rows: number;
}

interface Row {
  id: string;
  silo_id: string;
  concept_id: string;
  connection_id: string;
  object_name: string;
  state: HoldingState;
  batch_id: string | null;
  synced_at: Date | null;
  rows: number | null;
  failure: string | null;
  kept_by: string;
  kept_at: Date;
  retention_days: number;
  history: boolean;
  sync_started_at: Date | null;
  changed_field: string | null;
  changed_evidence: number;
  live: boolean;
  organisation_id: string;
}

const SELECT = `
  SELECT h.id, h.silo_id, h.concept_id, h.connection_id, h.object_name, h.state, h.batch_id,
         h.synced_at, h.rows, h.failure, h.kept_by, h.kept_at, h.organisation_id, h.history, h.sync_started_at, h.changed_field, h.changed_evidence, s.retention_days,
         (s.disabled_at IS NULL AND o.storage_enabled) AS live
    FROM silo_holdings h JOIN siloes s ON s.id = h.silo_id JOIN organisations o ON o.id = h.organisation_id`;

const map = (row: Row): Holding => ({
  id: row.id,
  siloId: row.silo_id,
  conceptId: row.concept_id,
  connectionId: row.connection_id,
  objectName: row.object_name,
  state: row.state,
  batchId: row.batch_id,
  syncedAt: row.synced_at,
  rows: row.rows,
  failure: row.failure,
  keptBy: row.kept_by,
  keptAt: row.kept_at,
  retentionDays: row.retention_days,
  history: row.history,
  heardAt: row.sync_started_at,
  changedField: row.changed_field,
  changedEvidence: row.changed_evidence,
  live: row.live,
  organisationId: row.organisation_id,
});

export async function forConcept(db: Executor, conceptId: string): Promise<Holding[]> {
  const { rows } = await db.query<Row>(`${SELECT} WHERE h.concept_id = $1 ORDER BY h.connection_id, h.object_name`, [conceptId]);
  return rows.map(map);
}

/** Everything one Silo keeps whole, by concept. */
export async function inSilo(db: Executor, siloId: string): Promise<Holding[]> {
  const { rows } = await db.query<Row>(`${SELECT} WHERE h.silo_id = $1 ORDER BY h.concept_id, h.connection_id, h.object_name`, [siloId]);
  return rows.map(map);
}

export async function forConcepts(db: Executor, conceptIds: readonly string[]): Promise<Holding[]> {
  if (conceptIds.length === 0) return [];
  const { rows } = await db.query<Row>(`${SELECT} WHERE h.concept_id = ANY($1) ORDER BY h.concept_id, h.connection_id`, [[...conceptIds]]);
  return rows.map(map);
}

/** Keep one system's records of a concept. Returns the row that stands, new or already there. */
export async function keep(
  db: Executor,
  /* `history` null leaves it as it stands: off for a concept newly kept. */
  input: { organisationId: string; siloId: string; conceptId: string; connectionId: string; objectName: string; keptBy: string; history: boolean | null },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO silo_holdings (id, organisation_id, silo_id, concept_id, connection_id, object_name, kept_by, history)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, false))
     ON CONFLICT (concept_id, connection_id, object_name)
       DO UPDATE SET silo_id = EXCLUDED.silo_id, history = COALESCE($8, silo_holdings.history)
     RETURNING id`,
    [generateId(), input.organisationId, input.siloId, input.conceptId, input.connectionId, input.objectName, input.keptBy, input.history],
  );
  return rows[0]!.id;
}

/** Stop keeping a concept. Its copies in the Postgres stand-in go with the rows; BigQuery's are the service's to drop. */
export async function release(db: Executor, conceptId: string): Promise<Holding[]> {
  const held = await forConcept(db, conceptId);
  await db.query(`DELETE FROM silo_holdings WHERE concept_id = $1`, [conceptId]);
  return held;
}

/* How long a copy being made may go unheard from before it is taken to have been abandoned. */
const STRANDED_AFTER_HOURS = 6;

/** Whether a copy of this holding is being made right now, by something still at it. */
export const beingCopied = (holding: Holding, now = new Date()): boolean =>
  holding.state === 'syncing' && holding.heardAt !== null && holding.heardAt.getTime() > now.getTime() - STRANDED_AFTER_HOURS * 60 * 60 * 1000;

/** A copy is being made, and was heard from just now. Called again as it goes, so a long copy is not taken for an abandoned one. */
export async function markSyncing(db: Executor, id: string): Promise<void> {
  await db.query(`UPDATE silo_holdings SET state = 'syncing', failure = NULL, sync_started_at = now() WHERE id = $1`, [id]);
}

/** A copy finished: it is the one readers are served from now on, and it is on the list of copies made. */
export async function markSynced(
  db: Executor,
  id: string,
  input: { organisationId: string; batchId: string; rows: number; at: Date },
): Promise<void> {
  await db.query(
    `UPDATE silo_holdings SET state = 'synced', batch_id = $2, rows = $3, synced_at = $4, failure = NULL WHERE id = $1`,
    [id, input.batchId, input.rows, input.at],
  );
  await db.query(
    `INSERT INTO silo_copies (id, organisation_id, holding_id, copied_at, rows) VALUES ($1, $2, $3, $4, $5)`,
    [input.batchId, input.organisationId, id, input.at, input.rows],
  );
}

/** The field a system marks change with, as the latest copy bears it out — or none, where a changed record did not carry it. */
export async function setMarker(db: Executor, id: string, marker: { field: string; evidence: number } | null): Promise<void> {
  await db.query(`UPDATE silo_holdings SET changed_field = $2, changed_evidence = $3 WHERE id = $1`, [id, marker?.field ?? null, marker?.evidence ?? 0]);
}

/**
 * The copies of these holdings that can still be read, newest first (136).
 *
 * INSIDE THE SILO'S WINDOW, DECIDED HERE. A copy older than that is unreadable
 * from the moment it is, whether or not the sweep has reached it yet.
 */
export async function copiesOf(db: Executor, holdingIds: readonly string[]): Promise<Copy[]> {
  if (holdingIds.length === 0) return [];
  const { rows } = await db.query<{ id: string; holding_id: string; copied_at: Date; rows: number }>(
    `SELECT c.id, c.holding_id, c.copied_at, c.rows
       FROM silo_copies c
       JOIN silo_holdings h ON h.id = c.holding_id
       JOIN siloes s ON s.id = h.silo_id
      WHERE c.holding_id = ANY($1) AND c.copied_at >= now() - make_interval(days => s.retention_days)
      ORDER BY c.copied_at DESC`,
    [[...holdingIds]],
  );
  return rows.map((row) => ({ id: row.id, holdingId: row.holding_id, copiedAt: row.copied_at, rows: row.rows }));
}

/** A copy did not finish. Whatever was being served before still is. */
export async function markFailed(db: Executor, id: string, failure: string): Promise<void> {
  await db.query(`UPDATE silo_holdings SET state = 'failed', failure = $2 WHERE id = $1`, [id, failure.slice(0, 500)]);
}

/**
 * The kept concepts not copied in the last `hours`, across every organisation.
 *
 * FOR THE SCHEDULER, ON ITS OWN CONNECTION. Finding what is due is the one
 * cross-tenant read; each copy then runs through the service under its own
 * organisation, as whoever asked for it to be kept.
 */
export async function dueConcepts(
  db: Executor,
  hours: number,
): Promise<Array<{ organisationId: string; conceptId: string; keptBy: string }>> {
  const { rows } = await db.query<{ organisation_id: string; concept_id: string; kept_by: string }>(
    `SELECT DISTINCT ON (h.concept_id) h.organisation_id, h.concept_id, h.kept_by
       FROM silo_holdings h
       JOIN siloes s ON s.id = h.silo_id AND s.disabled_at IS NULL
       JOIN organisations o ON o.id = h.organisation_id AND o.storage_enabled
      WHERE (h.synced_at IS NULL OR h.synced_at < now() - make_interval(hours => $1))
        /* Not while any system of the concept is being copied by something still at it: two copies at once would race to be the one served. */
        AND NOT EXISTS (
          SELECT 1 FROM silo_holdings b
           WHERE b.concept_id = h.concept_id AND b.state = 'syncing'
             AND b.sync_started_at >= now() - make_interval(hours => $2))
      ORDER BY h.concept_id, h.kept_at`,
    [hours, STRANDED_AFTER_HOURS],
  );
  return rows.map((row) => ({ organisationId: row.organisation_id, conceptId: row.concept_id, keptBy: row.kept_by }));
}

/* ── The Postgres stand-in for the warehouse ─────────────────────────────── */

export async function insertRows(
  db: Executor,
  input: { organisationId: string; holdingId: string; batchId: string; at: Date; rows: ReadonlyArray<Record<string, unknown>> },
): Promise<void> {
  if (input.rows.length === 0) return;
  await db.query(
    `INSERT INTO silo_kept_rows (id, organisation_id, holding_id, batch_id, record, synced_at)
     SELECT gen_random_uuid(), $1, $2, $3, value, $4 FROM jsonb_array_elements($5::jsonb)`,
    [input.organisationId, input.holdingId, input.batchId, input.at, JSON.stringify(input.rows)],
  );
}

/** The rows of a copy that did not finish. It was never served and is on no list; without this they would sit there. */
export async function dropBatch(db: Executor, holdingId: string, batchId: string): Promise<void> {
  await db.query(`DELETE FROM silo_kept_rows WHERE holding_id = $1 AND batch_id = $2`, [holdingId, batchId]);
}

/** Every batch of a holding but the one being served: its rows, and its place on the list of copies. Returns which went. */
export async function dropOtherBatches(db: Executor, holdingId: string, keepBatchId: string): Promise<string[]> {
  await db.query(`DELETE FROM silo_kept_rows WHERE holding_id = $1 AND batch_id <> $2`, [holdingId, keepBatchId]);
  const { rows } = await db.query<{ id: string }>(`DELETE FROM silo_copies WHERE holding_id = $1 AND id <> $2 RETURNING id`, [holdingId, keepBatchId]);
  return rows.map((row) => row.id);
}

/**
 * Copies older than their Silo's window, across every organisation (136).
 *
 * FOR THE RETENTION SWEEP, ON ITS OWN CONNECTION. Already unreadable — `copiesOf`
 * and the query path both stop at the window — and this is what finds them to
 * be deleted.
 */
export async function expiredCopies(
  db: Executor,
): Promise<Array<{ id: string; organisationId: string; siloId: string; holdingId: string; objectName: string; served: boolean }>> {
  const { rows } = await db.query<{ id: string; organisation_id: string; silo_id: string; holding_id: string; object_name: string; served: boolean }>(
    `SELECT c.id, c.organisation_id, h.silo_id, c.holding_id, h.object_name, (h.batch_id = c.id) AS served
       FROM silo_copies c
       JOIN silo_holdings h ON h.id = c.holding_id
       JOIN siloes s ON s.id = h.silo_id
      WHERE c.copied_at < now() - make_interval(days => s.retention_days)`,
  );
  return rows.map((row) => ({
    id: row.id,
    organisationId: row.organisation_id,
    siloId: row.silo_id,
    holdingId: row.holding_id,
    objectName: row.object_name,
    served: row.served,
  }));
}

/** Delete one copy: its rows in the stand-in, and its place on the list. Returns how many rows went. */
export async function deleteCopy(db: Executor, input: { id: string; holdingId: string; served: boolean }): Promise<number> {
  /* A holding whose served copy has lapsed serves nothing until the next one is made. */
  if (input.served) {
    await db.query(`UPDATE silo_holdings SET state = 'waiting', batch_id = NULL, synced_at = NULL, rows = NULL WHERE id = $1`, [input.holdingId]);
  }
  const { rowCount } = await db.query(`DELETE FROM silo_kept_rows WHERE holding_id = $1 AND batch_id = $2`, [input.holdingId, input.id]);
  await db.query(`DELETE FROM silo_copies WHERE id = $1`, [input.id]);
  return rowCount ?? 0;
}

/* `nin` — "not one of these" — is the store's own: what leaves out the records a caught-up answer reads live instead. */
export type Comparison = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'nin' | 'is_null';
export type StoreFilter = { field: string; op: Comparison; value?: unknown };

const CAST: Record<StoredFieldType, string> = {
  string: 'text',
  number: 'numeric',
  boolean: 'boolean',
  date: 'date',
  datetime: 'timestamptz',
  json: 'jsonb',
};

/** The conditions of a read or a summary, as SQL over one batch. */
function conditionsOf(input: { fields: readonly StoredField[]; filters: readonly StoreFilter[] }, args: unknown[]): string[] {
  const types = new Map(input.fields.map((field) => [field.name, field.type]));
  const param = (value: unknown) => {
    args.push(value);
    return `$${args.length}`;
  };

  return input.filters.map((filter) => {
    const type = types.get(filter.field);
    if (!type) throw new Error(`${filter.field} is not a field of the copy.`);
    if (type === 'json') throw new Error(`${filter.field} holds JSON and cannot be filtered.`);

    const expr = `(r.record->>${param(filter.field)})::${CAST[type]}`;

    if (filter.op === 'is_null') return `${expr} IS NULL`;
    if (filter.op === 'in') {
      const values = (Array.isArray(filter.value) ? filter.value : [filter.value]).map((value) => (value === null || value === undefined ? null : String(value)));
      return `${expr} = ANY(${param(values)}::${CAST[type]}[])`;
    }
    if (filter.op === 'nin') {
      const values = (Array.isArray(filter.value) ? filter.value : [filter.value]).map((value) => (value === null || value === undefined ? null : String(value)));
      return `(${expr} IS NULL OR NOT (${expr} = ANY(${param(values)}::${CAST[type]}[])))`;
    }
    if (filter.op === 'neq') return `(${expr} IS NULL OR ${expr} <> ${param(String(filter.value))}::${CAST[type]})`;
    const operator = { eq: '=', gt: '>', gte: '>=', lt: '<', lte: '<=' }[filter.op];
    return `${expr} ${operator} ${param(String(filter.value))}::${CAST[type]}`;
  });
}

export async function readRows(
  db: Executor,
  input: {
    holdingId: string;
    batchId: string;
    fields: readonly StoredField[];
    filters: readonly StoreFilter[];
    /** The order a page is taken in. Without one, a page is whichever rows come first. */
    sort?: ReadonlyArray<{ field: string; direction: 'asc' | 'desc' }>;
    limit: number;
  },
): Promise<Array<Record<string, unknown>>> {
  const args: unknown[] = [input.holdingId, input.batchId];
  const conditions = conditionsOf(input, args);
  const types = new Map(input.fields.map((field) => [field.name, field.type]));

  const order = (input.sort ?? [])
    .filter((one) => types.has(one.field) && types.get(one.field) !== 'json')
    .map((one) => {
      args.push(one.field);
      return `(r.record->>$${args.length})::${CAST[types.get(one.field)!]} ${one.direction === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`;
    });
  args.push(input.limit);

  const { rows } = await db.query<{ record: Record<string, unknown> }>(
    `SELECT r.record FROM silo_kept_rows r
      WHERE r.holding_id = $1 AND r.batch_id = $2
        ${conditions.map((one) => `AND ${one}`).join('\n        ')}
      ${order.length > 0 ? `ORDER BY ${order.join(', ')}` : ''}
      LIMIT $${args.length}`,
    args,
  );
  return rows.map((row) => row.record);
}

/** What a group is keyed by: a field, or the period a date field falls in. */
export type GroupKey = { field: string; every?: 'day' | 'month' | 'quarter' | 'year' };
export type GroupMeasure = { operation: 'count' | 'sum' | 'minimum' | 'maximum'; field?: string };
export type GroupRow = { key: Array<string | null>; records: number; measures: Array<number | null>; counted: Array<number> };

/**
 * Add a copy up, in the store, by group.
 *
 * THE POINT OF KEEPING A COPY. "Invoices by status" over five million rows is
 * a handful of rows back from here, where reading the invoices to add them up
 * would be five million. Each measure also returns how many records had a
 * number to add, so an average can be had and "nothing to measure" is not
 * read as nought.
 */
export async function summarise(
  db: Executor,
  input: {
    holdingId: string;
    batchId: string;
    fields: readonly StoredField[];
    filters: readonly StoreFilter[];
    groupBy: readonly GroupKey[];
    measures: readonly GroupMeasure[];
    limit: number;
  },
): Promise<GroupRow[]> {
  const args: unknown[] = [input.holdingId, input.batchId];
  const conditions = conditionsOf(input, args);
  const param = (value: unknown) => {
    args.push(value);
    return `$${args.length}`;
  };

  const keys = input.groupBy.map((key) => {
    const text = `r.record->>${param(key.field)}`;
    /* The period a date is in, cut from its ISO spelling exactly as `analyse` cuts it. */
    if (key.every === 'year') return `substr(${text}, 1, 4)`;
    if (key.every === 'month') return `substr(${text}, 1, 7)`;
    if (key.every === 'day') return `substr(${text}, 1, 10)`;
    if (key.every === 'quarter') return `substr(${text}, 1, 4) || '-Q' || ceil(substr(${text}, 6, 2)::numeric / 3)::int`;
    return text;
  });

  /* A number, or nothing: text that is not a number adds nothing rather than failing the whole question. */
  const numeric = (field: string) => {
    const text = `r.record->>${param(field)}`;
    return `CASE WHEN ${text} ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (${text})::numeric END`;
  };

  const measures = input.measures.flatMap((measure, at) => {
    if (measure.operation === 'count' || !measure.field) return [`count(*) AS m${at}`, `count(*) AS c${at}`];
    const value = numeric(measure.field);
    const fn = { sum: 'sum', minimum: 'min', maximum: 'max' }[measure.operation];
    return [`${fn}(${value}) AS m${at}`, `count(${value}) AS c${at}`];
  });

  const { rows } = await db.query<Record<string, string | null>>(
    `SELECT ${[...keys.map((key, at) => `${key} AS k${at}`), 'count(*) AS n', ...measures].join(', ')}
       FROM silo_kept_rows r
      WHERE r.holding_id = $1 AND r.batch_id = $2
        ${conditions.map((one) => `AND ${one}`).join('\n        ')}
      ${keys.length > 0 ? `GROUP BY ${keys.map((_key, at) => at + 1).join(', ')}` : ''}
      LIMIT ${param(input.limit)}`,
    args,
  );

  return rows.map((row) => ({
    key: input.groupBy.map((_key, at) => row[`k${at}`] ?? null),
    records: Number(row.n ?? 0),
    measures: input.measures.map((_measure, at) => (row[`m${at}`] === null || row[`m${at}`] === undefined ? null : Number(row[`m${at}`]))),
    counted: input.measures.map((_measure, at) => Number(row[`c${at}`] ?? 0)),
  }));
}

/* ── What differs between two copies (136) ───────────────────────────────── */

/** How two copies of one system's records differ. */
export type Difference = {
  /** Records in the later copy and not the earlier. */
  added: number;
  /** Records in the earlier copy and not the later. */
  removed: number;
  /** Records in both, with a watched field that differs. */
  changed: number;
  /** For each watched field: in how many records held in both it differs. */
  fields: Array<{ field: string; records: number }>;
};

type Between = {
  holdingId: string;
  earlier: string;
  later: string;
  /** The field a record is identified by: what says a record in one copy is the record in the other. */
  identifier: string;
  fields: readonly StoredField[];
  /** The fields whose change makes a record "changed". */
  watch: readonly string[];
  /** The question's own conditions: on a record as it is in the later copy, or as it last was where it is gone. */
  filters: readonly StoreFilter[];
};

/**
 * The two copies side by side, a row per record held in either.
 *
 * `record` IS THE ONE THE QUESTION'S CONDITIONS ARE ABOUT — the record as it is
 * now, or as it last was where it has gone — under the name `conditionsOf`
 * reads, so a condition means here what it means to a plain read.
 */
function sideBySide(input: Between, args: unknown[]): { from: string; differs: string[]; conditions: string[] } {
  args.push(input.holdingId, input.earlier, input.later, input.identifier);
  const conditions = conditionsOf(input, args);

  const differs = input.watch.map((field) => {
    args.push(field);
    return `(r.before->>$${args.length}) IS DISTINCT FROM (r.after->>$${args.length})`;
  });

  return {
    from: `(SELECT a.ref AS was, b.ref AS now, a.record AS before, b.record AS after, COALESCE(b.record, a.record) AS record
              FROM (SELECT k.record->>$4 AS ref, k.record FROM silo_kept_rows k
                     WHERE k.holding_id = $1 AND k.batch_id = $2 AND k.record->>$4 IS NOT NULL) a
              FULL OUTER JOIN
                   (SELECT k.record->>$4 AS ref, k.record FROM silo_kept_rows k
                     WHERE k.holding_id = $1 AND k.batch_id = $3 AND k.record->>$4 IS NOT NULL) b
                ON a.ref = b.ref) r`,
    differs,
    conditions,
  };
}

/* A record held in both copies whose watched fields are not all as they were. */
const changedIn = (differs: readonly string[]) =>
  `r.was IS NOT NULL AND r.now IS NOT NULL AND (${differs.length > 0 ? differs.join(' OR ') : 'r.before IS DISTINCT FROM r.after'})`;

/**
 * Count what differs between two copies, in the store.
 *
 * ONE ROW BACK, HOWEVER MANY RECORDS. The copies are joined on the field a
 * record is identified by and compared where they are; nothing is read out to
 * be compared here.
 */
export async function difference(db: Executor, input: Between): Promise<Difference> {
  const args: unknown[] = [];
  const { from, differs, conditions } = sideBySide(input, args);

  const { rows } = await db.query<Record<string, string>>(
    `SELECT count(*) FILTER (WHERE r.was IS NULL) AS added,
            count(*) FILTER (WHERE r.now IS NULL) AS removed,
            count(*) FILTER (WHERE ${changedIn(differs)}) AS changed
            ${differs.map((one, at) => `, count(*) FILTER (WHERE r.was IS NOT NULL AND r.now IS NOT NULL AND ${one}) AS f${at}`).join('')}
       FROM ${from}
      ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}`,
    args,
  );

  const row = rows[0] ?? {};
  return {
    added: Number(row.added ?? 0),
    removed: Number(row.removed ?? 0),
    changed: Number(row.changed ?? 0),
    fields: input.watch.map((field, at) => ({ field, records: Number(row[`f${at}`] ?? 0) })).filter((one) => one.records > 0),
  };
}

/** Which of the records still held differ (`held`: new or changed; `changed`: changed only), or which have `gone`. */
export type Differing = 'held' | 'changed' | 'gone';

export async function differing(
  db: Executor,
  input: Between & { which: Differing; limit: number },
): Promise<Array<{ ref: string; added: boolean }>> {
  const args: unknown[] = [];
  /* A record that has gone is not compared field by field, and a parameter nothing reads cannot be sent. */
  const { from, differs, conditions } = sideBySide(input.which === 'gone' ? { ...input, watch: [] } : input, args);
  args.push(input.limit);

  const { rows } = await db.query<{ ref: string; added: boolean }>(
    `SELECT COALESCE(r.now, r.was) AS ref, (r.was IS NULL) AS added
       FROM ${from}
      WHERE ${[
        ...conditions,
        input.which === 'gone' ? 'r.now IS NULL' : input.which === 'changed' ? `(${changedIn(differs)})` : `(r.was IS NULL OR (${changedIn(differs)}))`,
      ].join(' AND ')}
      ORDER BY 1
      LIMIT $${args.length}`,
    args,
  );
  return rows;
}

/* ── Which field marks a changed record (137) ────────────────────────────── */

/**
 * What two copies say about one date field as a mark of change.
 *
 * `differ` RECORDS ARE NEW, OR NOT AS THEY WERE in some other field. `marked`
 * is how many of those carry a value in this field later than `since`. Equal,
 * and asking the system for records with this field after `since` would have
 * found every one of them. `recent` is how many records of the whole copy
 * carry such a value: a field every record is recent in marks nothing.
 */
export type MarkerEvidence = { field: string; differ: number; marked: number; recent: number; rows: number };

/**
 * Weigh each date field of a copy as the system's mark of change, in the store.
 *
 * ONE ROW BACK. The two copies are joined on the field a record is identified
 * by, as `difference` joins them, and each candidate is counted against the
 * records that really changed between them.
 */
export async function markerEvidence(
  db: Executor,
  input: { holdingId: string; earlier: string; later: string; identifier: string; candidates: readonly string[]; since: Date },
): Promise<MarkerEvidence[]> {
  if (input.candidates.length === 0) return [];

  const args: unknown[] = [];
  const { from } = sideBySide({ ...input, fields: [], watch: [], filters: [] }, args);
  args.push(input.since);
  const since = `$${args.length}`;

  const counts = input.candidates.map((field, at) => {
    args.push(field);
    const name = `$${args.length}::text`;
    /* A value that is not written as a date marks nothing, rather than failing the whole comparison. */
    const when = `CASE WHEN r.after->>${name} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN (r.after->>${name})::timestamptz END`;
    /* New, or different in something OTHER than the field being weighed: a field cannot vouch for itself. */
    const differs = `r.now IS NOT NULL AND (r.was IS NULL OR (r.before - ${name}) IS DISTINCT FROM (r.after - ${name}))`;
    return (
      `count(*) FILTER (WHERE ${differs}) AS d${at}, ` +
      `count(*) FILTER (WHERE ${differs} AND ${when} >= ${since}) AS m${at}, ` +
      `count(*) FILTER (WHERE r.now IS NOT NULL AND ${when} >= ${since}) AS n${at}`
    );
  });

  const { rows } = await db.query<Record<string, string>>(
    `SELECT count(*) FILTER (WHERE r.now IS NOT NULL) AS total, ${counts.join(', ')} FROM ${from}`,
    args,
  );

  const row = rows[0] ?? {};
  return input.candidates.map((field, at) => ({
    field,
    differ: Number(row[`d${at}`] ?? 0),
    marked: Number(row[`m${at}`] ?? 0),
    recent: Number(row[`n${at}`] ?? 0),
    rows: Number(row.total ?? 0),
  }));
}
