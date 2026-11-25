import { createHash, randomUUID } from 'node:crypto';
import { env } from '../config/env.config';
import { childLogger } from '../config/logger.config';
import { accessToken } from './googleAuth.infra';
import * as objectStore from './objectStore.infra';
import type { ExtractedRow, ExtractionMethod, StoredField, StoredFieldType } from '../models/rowStore.model';

const log = childLogger('bigquery');

/**
 * Import §7 — BigQuery, where an import's extracted rows are held in production.
 *
 * ── Written against the REST API, like the object store ────────────────────
 *
 * No SDK, for the reason `objectStore.infra` gives: the token comes from the
 * metadata server, requests are plain `fetch`, and there is one less dependency
 * holding a credential. What it sends is covered by tests over a stubbed
 * `fetch`; what BigQuery does with it is verified only against a real dataset.
 *
 * ── Residency is enforced here, at creation, not checked afterwards ─────────
 *
 * A dataset carries a location and cannot be moved. So the location is compared
 * with the cell's residency BEFORE a dataset is created, and an existing dataset
 * whose location differs from configuration is refused on every use — a dataset
 * someone created by hand in the wrong place does not become acceptable by
 * already existing.
 *
 * ── One dataset per organisation, one table per source object ──────────────
 *
 * Separable at the storage layer as well as by query: purging an organisation's
 * import is dropping its dataset, and purging a source object is dropping one
 * table. Names are built from uuids and from object and field names the
 * definition schema restricts to identifiers, so nothing interpolated into SQL
 * here came from a person.
 *
 * ── Loads, not streaming inserts ───────────────────────────────────────────
 *
 * Rows streamed with `insertAll` sit in a buffer that DML cannot touch for up to
 * ninety minutes. §11 says purging a file removes its rows, and a purge that
 * fails for an hour and a half after every upload is not a purge. Load jobs
 * write rows DML can delete immediately.
 */

const API = 'https://bigquery.googleapis.com/bigquery/v2';

/** Locations each residency allows. `uk` is London only; `eu` is EU member states. */
const RESIDENCY: Record<'uk' | 'eu' | 'unrestricted', readonly string[] | null> = {
  uk: ['europe-west2'],
  eu: [
    'EU', 'europe-west1', 'europe-west3', 'europe-west4', 'europe-west8', 'europe-west9',
    'europe-west10', 'europe-west12', 'europe-north1', 'europe-central2', 'europe-southwest1',
  ],
  unrestricted: null,
};

export class ResidencyViolation extends Error {}

export function isConfigured(): boolean {
  return Boolean(env.BIGQUERY_PROJECT_ID && env.BIGQUERY_LOCATION);
}

export function assertLocationAllowed(location: string): void {
  const allowed = RESIDENCY[env.SILO_RESIDENCY];
  if (allowed && !allowed.includes(location)) {
    throw new ResidencyViolation(
      `BigQuery location ${location} is outside this cell's ${env.SILO_RESIDENCY} residency.`,
    );
  }
}

/*
 * ── NOTHING A SYSTEM CALLS ANYTHING IS EVER WRITTEN INTO A STATEMENT ───────
 *
 * An import's object and field names are identifiers by the definition
 * schema's own rule. A CONNECTED SYSTEM'S ARE NOT: a manifest admits any
 * string up to 128 characters as a name, because a system may call a field
 * `Billing City`, `amount (GBP)` or anything else, and a kept concept's copy is
 * made of that system's fields. Written into SQL between backticks, a name
 * holding a backtick would end the identifier and begin a statement of its
 * own — run by an account that can read every organisation's dataset.
 *
 * So every dataset, table and column name in this file is BUILT, by the three
 * functions below, from an id or through `columnFor`, and what `columnFor`
 * returns can hold nothing but letters, digits and underscores whatever it was
 * given. A name that is already an identifier is itself, so every import table
 * is called what it always was.
 */

/* What a column or a table can be called as it stands: the definition schema's rule for a name. */
const PLAIN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
/* Prefixes BigQuery keeps for itself, whatever the case, and the columns this file adds to every table. */
const KEPT_BACK = /^(_table_|_file_|_partition|_row_timestamp|__root__|_colidentifier|_change_|_batch_id$|_row_ref$|_methods$|_received_at$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An id as part of a name. Refused unless it is one: a dataset or table is never named from anything else. */
function hex(id: string): string {
  if (!UUID.test(id)) throw new Error('Not an id.');
  return id.replace(/-/g, '').toLowerCase();
}

/**
 * The column a field is held in — and, for an object, the end of its table's name.
 *
 * ITSELF, WHERE IT IS ALREADY AN IDENTIFIER. Otherwise something readable made
 * from it, with a few characters of its hash so that `Billing City` and
 * `billing-city` are two columns and not one. Always letters, digits and
 * underscores; the same name always gives the same column.
 */
export function columnFor(name: string): string {
  if (PLAIN.test(name) && !KEPT_BACK.test(name)) return name;

  const readable = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return `x_${readable ? `${readable}_` : ''}${createHash('sha256').update(name).digest('hex').slice(0, 10)}`;
}

/* A column as it is written in a statement. */
const col = (name: string) => `\`${columnFor(name)}\``;

export function datasetFor(organisationId: string): string {
  return `silo_${hex(organisationId)}`;
}

export function tableFor(sourceId: string, objectName: string): string {
  return `src_${hex(sourceId)}__${columnFor(objectName)}`;
}

const TYPES: Record<StoredFieldType, string> = {
  string: 'STRING',
  /* BIGNUMERIC, not FLOAT64: a total of money must not be rounded by storage. */
  number: 'BIGNUMERIC',
  boolean: 'BOOL',
  date: 'DATE',
  datetime: 'TIMESTAMP',
  json: 'JSON',
};

const SYSTEM_FIELDS = [
  { name: '_batch_id', type: 'STRING', mode: 'REQUIRED' },
  { name: '_row_ref', type: 'STRING', mode: 'REQUIRED' },
  { name: '_methods', type: 'JSON', mode: 'NULLABLE' },
  { name: '_received_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
];

interface Called<T> {
  status: number;
  body: T | null;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<Called<T>> {
  if (!isConfigured()) throw new Error('BigQuery is not configured.');
  const token = await accessToken();
  if (!token) throw new Error('No Google credentials available for BigQuery.');

  const response = await fetch(`${API}/projects/${env.BIGQUERY_PROJECT_ID}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });

  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as T) : null;

  if (!response.ok && response.status !== 404) {
    /*
     * THE STATUS AND REASON, NEVER THE MESSAGE. A BigQuery error message can
     * quote the offending value, and a value from an imported file does not
     * belong in a log line.
     */
    const reason = (parsed as { error?: { errors?: Array<{ reason?: string }> } } | null)?.error?.errors?.[0]?.reason;
    log.warn({ status: response.status, reason, method, path: path.split('?')[0] }, 'BigQuery call failed');
    throw new Error(`BigQuery ${method} failed with status ${response.status}${reason ? ` (${reason})` : ''}`);
  }

  return { status: response.status, body: parsed };
}

/* ── Datasets and tables ─────────────────────────────────────────────────── */

export async function ensureDataset(organisationId: string, purpose: 'silo-import' | 'silo-verify' = 'silo-import'): Promise<void> {
  await ensureNamed(datasetFor(organisationId), purpose);
}

/** Make sure a dataset exists where this cell keeps its data, labelled with what it is for. */
async function ensureNamed(dataset: string, purpose: 'silo-import' | 'silo-verify' | 'silo-read'): Promise<void> {
  const location = env.BIGQUERY_LOCATION!;

  const found = await call<{ location?: string }>('GET', `/datasets/${dataset}`);

  if (found.status === 404) {
    assertLocationAllowed(location);
    await call('POST', '/datasets', {
      datasetReference: { projectId: env.BIGQUERY_PROJECT_ID, datasetId: dataset },
      location,
      labels: { purpose },
    });
    return;
  }

  const actual = found.body?.location ?? '';
  if (actual !== location) {
    throw new ResidencyViolation(
      `Dataset ${dataset} is in ${actual}, and this cell is configured for ${location}.`,
    );
  }
  assertLocationAllowed(actual);
}

/**
 * Remove a dataset, with everything in it — only one made for the purpose named.
 *
 * THE ONE THING HERE THAT CANNOT BE UNDONE. The dataset is read first and
 * dropped only if it carries the label its maker gave it. An organisation's
 * own dataset, where its records are, carries neither of the labels this is
 * ever called with, and is refused whatever name is passed.
 */
async function dropNamed(dataset: string, purpose: 'silo-verify' | 'silo-read'): Promise<boolean> {
  const found = await call<{ labels?: Record<string, string> }>('GET', `/datasets/${dataset}`);
  if (found.status === 404) return false;
  if (found.body?.labels?.purpose !== purpose) throw new Error(`Dataset ${dataset} was not made for that, and is not removed.`);

  await call('DELETE', `/datasets/${dataset}?deleteContents=true`);
  return true;
}

/**
 * Remove a dataset `silo:verify-store` made for itself, with everything in it.
 * Never an organisation's: see `dropNamed`.
 */
export async function dropVerifyDataset(organisationId: string): Promise<void> {
  await dropNamed(datasetFor(organisationId), 'silo-verify');
}

/* ── A Silo, read by other tools (139) ───────────────────────────────────── */

/*
 * ── A DATASET OF VIEWS, AND ACCESS TO THAT ALONE ──────────────────────────
 *
 * An organisation's dataset holds a table per kept object with every batch in
 * it — the copy being served, the one being written beside it, the past
 * copies — and every other Silo's tables beside those. Access to it is access
 * to all of that, so nobody outside is ever given any.
 *
 * A Silo that somebody has opened to other tools gets a second dataset holding
 * nothing but views: one over the copy of each concept that is being served,
 * and so on. The identities on the Silo's list are readers of THAT dataset.
 * The views can read the tables because the dataset they are in is authorised
 * on the organisation's — BigQuery's own arrangement for exactly this — and a
 * reader of the views gains nothing on the tables by it.
 */

type Access = {
  role?: string;
  userByEmail?: string;
  groupByEmail?: string;
  dataset?: { dataset?: { projectId?: string; datasetId?: string }; targetTypes?: string[] };
  [other: string]: unknown;
};

/** The dataset of views other tools read one Silo through. */
export function readDatasetFor(organisationId: string, siloId: string): string {
  return `silo_${hex(organisationId)}_read_${hex(siloId)}`;
}

/** Where a reader points their tool: the project and the dataset. */
export function readAddress(organisationId: string, siloId: string): string {
  return `${env.BIGQUERY_PROJECT_ID}.${readDatasetFor(organisationId, siloId)}`;
}

/**
 * Make sure a Silo's dataset of views exists, and that views in it may read
 * the organisation's tables.
 *
 * THE AUTHORISATION IS ADDED TO THE LIST, NEVER PUT IN ITS PLACE. A dataset's
 * access is one list, replaced whole by a write; it is read, this one entry is
 * added if it is not there, and everything already on it goes back as it was.
 */
export async function ensureReadDataset(organisationId: string, siloId: string): Promise<void> {
  const source = datasetFor(organisationId);
  const reading = readDatasetFor(organisationId, siloId);

  await ensureNamed(source, 'silo-import');
  await ensureNamed(reading, 'silo-read');

  const found = await call<{ access?: Access[] }>('GET', `/datasets/${source}`);
  const access = found.body?.access ?? [];
  if (access.some((entry) => entry.dataset?.dataset?.datasetId === reading)) return;

  await call('PATCH', `/datasets/${source}`, {
    access: [...access, { dataset: { dataset: { projectId: env.BIGQUERY_PROJECT_ID, datasetId: reading }, targetTypes: ['VIEWS'] } }],
  });
}

/* A reader this file put on the list: read access, to a person, a service account or a group. */
const aReader = (entry: Access) => entry.role === 'READER' && (entry.userByEmail !== undefined || entry.groupByEmail !== undefined);

/**
 * Make the readers of a Silo's views exactly these identities.
 *
 * EVERYTHING ELSE ON THE LIST STAYS. The project's own owners and the account
 * that made the dataset are on it too, and are put back untouched; only the
 * entries that give an identity read access are replaced, by the list as it
 * now stands. So taking somebody off the Silo's list takes their access away,
 * and nothing this did not grant is ever removed by it.
 */
export async function setReaders(
  organisationId: string,
  siloId: string,
  readers: ReadonlyArray<{ kind: 'user' | 'group' | 'service_account'; email: string }>,
): Promise<void> {
  const reading = readDatasetFor(organisationId, siloId);
  const found = await call<{ access?: Access[] }>('GET', `/datasets/${reading}`);
  if (found.status === 404) throw new Error('The dataset to give access to does not exist.');

  await call('PATCH', `/datasets/${reading}`, {
    access: [
      ...(found.body?.access ?? []).filter((entry) => !aReader(entry)),
      ...readers.map((reader) => (reader.kind === 'group' ? { role: 'READER', groupByEmail: reader.email } : { role: 'READER', userByEmail: reader.email })),
    ],
  });
}

const VIEW_NAME = /^[a-z][a-z0-9_]{0,199}$/;

/**
 * The statement that makes one view: some copies of one table, by their batches.
 *
 * ── WHICH COPIES IS WRITTEN INTO THE VIEW, SO IT IS REMADE AT EVERY COPY ──
 *
 * A view cannot take a parameter, and "the newest batch" would show a copy
 * half written. So the batches a view shows are named in it: the one being
 * served, or every finished one for a view of past copies. Each is an id this
 * product made and a time it recorded; both are checked to be exactly that
 * before they are written, and nothing a person or a system named is written
 * at all — the view's own name is letters, digits and underscores or refused,
 * and every column goes through `columnFor`.
 *
 * `silo_copied_at` says which copy a row is from, which a view of past copies
 * is no use without.
 */
export function viewStatement(input: {
  organisationId: string;
  siloId: string;
  name: string;
  sourceId: string;
  objectName: string;
  fields: readonly string[];
  batches: ReadonlyArray<{ id: string; at: Date }>;
}): string {
  if (!VIEW_NAME.test(input.name)) throw new Error('Not a name for a view.');
  if (input.batches.length === 0) throw new Error('A view shows at least one copy.');

  const columns = [...new Set(input.fields.map(columnFor))].filter((column) => column !== 'silo_copied_at').map((column) => `\`${column}\``);

  const copies = input.batches.map((batch) => {
    if (!UUID.test(batch.id) || Number.isNaN(batch.at.getTime())) throw new Error('Not a copy.');
    const from = batch.at.toISOString();
    const until = new Date(batch.at.getTime() + 1_000).toISOString();
    return `(\`_batch_id\` = '${batch.id.toLowerCase()}' AND \`_received_at\` >= TIMESTAMP '${from}' AND \`_received_at\` < TIMESTAMP '${until}')`;
  });

  return (
    `CREATE OR REPLACE VIEW \`${env.BIGQUERY_PROJECT_ID}.${readDatasetFor(input.organisationId, input.siloId)}.${input.name}\` AS ` +
    `SELECT ${[...columns, '`_received_at` AS `silo_copied_at`'].join(', ')} ` +
    `FROM \`${env.BIGQUERY_PROJECT_ID}.${datasetFor(input.organisationId)}.${tableFor(input.sourceId, input.objectName)}\` ` +
    `WHERE ${copies.join(' OR ')}`
  );
}

/** Make a view, or remake it over the copies it should now show. */
export async function replaceView(input: Parameters<typeof viewStatement>[0]): Promise<void> {
  await runQuery(viewStatement(input), []);
}

/** How many rows a view shows. For `silo:verify-store`, which has to see a view answer. */
export async function viewRows(organisationId: string, siloId: string, name: string): Promise<number> {
  if (!VIEW_NAME.test(name)) throw new Error('Not a name for a view.');
  const result = await runQuery(`SELECT COUNT(*) AS n FROM \`${readAddress(organisationId, siloId)}.${name}\``, []);
  return Number(result.rows[0]?.[0] ?? 0);
}

/** Remove every view in a Silo's dataset but these: a concept no longer kept is no longer shown. Returns what went. */
export async function dropViewsExcept(organisationId: string, siloId: string, keep: readonly string[]): Promise<string[]> {
  const reading = readDatasetFor(organisationId, siloId);
  const kept = new Set(keep);
  const gone: string[] = [];
  let token: string | undefined;

  do {
    const page = await call<{ tables?: Array<{ tableReference?: { tableId?: string } }>; nextPageToken?: string }>(
      'GET',
      `/datasets/${reading}/tables?maxResults=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`,
    );
    if (page.status === 404) return gone;

    for (const table of page.body?.tables ?? []) {
      const name = table.tableReference?.tableId;
      /* Only what this file could have made: anything else in there is not its to remove. */
      if (!name || kept.has(name) || !VIEW_NAME.test(name)) continue;
      await call('DELETE', `/datasets/${reading}/tables/${name}`);
      gone.push(name);
    }
    token = page.body?.nextPageToken;
  } while (token);

  return gone;
}

/**
 * Remove a Silo's dataset of views, and its authorisation on the organisation's.
 *
 * WHEN NOBODY IS LEFT ON THE LIST. The dataset holds views and nothing else;
 * the tables they read are untouched. Never an organisation's own dataset: see
 * `dropNamed`.
 */
export async function dropReadDataset(organisationId: string, siloId: string): Promise<void> {
  const source = datasetFor(organisationId);
  const reading = readDatasetFor(organisationId, siloId);

  if (!(await dropNamed(reading, 'silo-read'))) return;

  const found = await call<{ access?: Access[] }>('GET', `/datasets/${source}`);
  const access = found.body?.access ?? [];
  const left = access.filter((entry) => entry.dataset?.dataset?.datasetId !== reading);
  if (found.status !== 404 && left.length !== access.length) await call('PATCH', `/datasets/${source}`, { access: left });
}

/**
 * Create the table for a source object, or add the columns a newer definition
 * declares.
 *
 * A COLUMN'S TYPE NEVER CHANGES. Rows already loaded were read under the old
 * type, and BigQuery cannot convert them in place; a definition that changes a
 * type is refused at publish rather than half-applied here.
 *
 * PARTITION EXPIRY IS A BACKSTOP, SET ONE DAY PAST THE WINDOW. The retention
 * sweep deletes on the day and audits it; expiry is what still holds if the
 * sweep has not run, so a row cannot outlive its window by more than a day
 * whatever else fails.
 */
export async function ensureTable(input: {
  organisationId: string;
  sourceId: string;
  objectName: string;
  fields: StoredField[];
  retentionDays: number;
}): Promise<void> {
  const dataset = datasetFor(input.organisationId);
  const table = tableFor(input.sourceId, input.objectName);
  const declared = input.fields.map((f) => ({ name: columnFor(f.name), type: TYPES[f.type], mode: 'NULLABLE' }));
  const expirationMs = String((input.retentionDays + 1) * 24 * 60 * 60 * 1000);

  const found = await call<{
    schema?: { fields?: Array<{ name: string; type: string; mode?: string }> };
    timePartitioning?: { expirationMs?: string };
  }>('GET', `/datasets/${dataset}/tables/${table}`);

  if (found.status === 404) {
    await call('POST', `/datasets/${dataset}/tables`, {
      tableReference: { projectId: env.BIGQUERY_PROJECT_ID, datasetId: dataset, tableId: table },
      schema: { fields: [...SYSTEM_FIELDS, ...declared] },
      timePartitioning: { type: 'DAY', field: '_received_at', expirationMs },
    });
    return;
  }

  const existing = found.body?.schema?.fields ?? [];
  const byName = new Map(existing.map((f) => [f.name, f]));

  for (const f of declared) {
    const held = byName.get(f.name);
    if (held && held.type !== f.type) {
      throw new Error(`Column ${f.name} is ${held.type} and cannot become ${f.type}.`);
    }
  }

  const added = declared.filter((f) => !byName.has(f.name));
  const expiryChanged = found.body?.timePartitioning?.expirationMs !== expirationMs;

  if (added.length > 0 || expiryChanged) {
    await call('PATCH', `/datasets/${dataset}/tables/${table}`, {
      schema: { fields: [...existing, ...added] },
      timePartitioning: { type: 'DAY', field: '_received_at', expirationMs },
    });
  }
}

/* ── Loading rows ────────────────────────────────────────────────────────── */

/**
 * Load one file's extracted rows into its object's table.
 *
 * STAGED AS NEWLINE-DELIMITED JSON IN THE BUCKET, loaded, then deleted. The
 * staged object is a copy of extracted values, so it is removed whether or not
 * the load succeeded. The bucket and the dataset must be in compatible
 * locations for BigQuery to read it.
 */
export async function load(input: {
  organisationId: string;
  sourceId: string;
  objectName: string;
  fileId: string;
  receivedAt: Date;
  fields: StoredField[];
  rows: ExtractedRow[];
}): Promise<{ rows: number }> {
  if (input.rows.length === 0) return { rows: 0 };

  const types = new Map(input.fields.map((f) => [f.name, f.type]));
  const ndjson = input.rows
    .map((row) =>
      JSON.stringify({
        /*
         * ONLY THE FIELDS THE TABLE HAS, UNDER THE COLUMNS IT HAS THEM IN. A
         * system can return a key its description does not declare; there is no
         * column for it, and a row carrying one would fail the whole load.
         */
        ...Object.fromEntries(
          Object.entries(row.values)
            .filter(([name]) => types.has(name))
            .map(([name, value]) => [columnFor(name), toLoadValue(value, types.get(name))]),
        ),
        _batch_id: input.fileId,
        _row_ref: row.rowRef,
        _methods: Object.keys(row.methods).length ? row.methods : null,
        _received_at: input.receivedAt.toISOString(),
      }),
    )
    .join('\n');

  const key = `org/${input.organisationId}/silo-load/${input.fileId}-${randomUUID()}.ndjson`;
  await objectStore.putAt({ key, body: Buffer.from(ndjson, 'utf8'), sniffedContentType: 'application/x-ndjson' });

  try {
    const job = await runJob({
      load: {
        sourceUris: [`gs://${env.STORAGE_BUCKET}/${key}`],
        destinationTable: {
          projectId: env.BIGQUERY_PROJECT_ID,
          datasetId: datasetFor(input.organisationId),
          tableId: tableFor(input.sourceId, input.objectName),
        },
        sourceFormat: 'NEWLINE_DELIMITED_JSON',
        writeDisposition: 'WRITE_APPEND',
        createDisposition: 'CREATE_NEVER',
      },
    });

    return { rows: Number(job.statistics?.load?.outputRows ?? input.rows.length) };
  } finally {
    await objectStore.remove(key);
  }
}

function toLoadValue(value: unknown, type: StoredFieldType | undefined): unknown {
  if (value === null || value === undefined) return null;
  /* Numbers as strings, so BIGNUMERIC receives the digits rather than a float. */
  if (type === 'number') return String(value);
  /* A system that returns an object where its description says text: held as it is written, not refused. */
  if (type === 'string' && typeof value === 'object') return JSON.stringify(value);
  return value;
}

interface Job {
  jobReference?: { jobId: string; location?: string };
  status?: { state?: string; errorResult?: { reason?: string } };
  statistics?: { load?: { outputRows?: string } };
}

async function runJob(configuration: Record<string, unknown>): Promise<Job> {
  const jobId = `silo_${randomUUID().replace(/-/g, '')}`;
  const location = env.BIGQUERY_LOCATION;

  await call<Job>('POST', '/jobs', {
    jobReference: { projectId: env.BIGQUERY_PROJECT_ID, jobId, location },
    configuration,
  });

  const deadline = Date.now() + 10 * 60 * 1000;
  for (;;) {
    const polled = await call<Job>('GET', `/jobs/${jobId}?location=${encodeURIComponent(location!)}`);
    const state = polled.body?.status?.state;

    if (state === 'DONE') {
      const failed = polled.body?.status?.errorResult;
      if (failed) throw new Error(`BigQuery job failed (${failed.reason ?? 'unknown'})`);
      return polled.body!;
    }

    if (Date.now() > deadline) throw new Error('BigQuery job did not finish in ten minutes.');
    await new Promise((settle) => setTimeout(settle, 1_000));
  }
}

/* ── Reading rows ────────────────────────────────────────────────────────── */

/* `nin` — "not one of these" — is the store's own: what leaves out the records a caught-up answer reads live instead. */
export type Comparison = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'nin' | 'is_null';

export interface ReadRow {
  values: Record<string, unknown>;
  fileId: string;
  rowRef: string;
  methods: Record<string, Exclude<ExtractionMethod, 'certain'>>;
}

const OPERATORS: Record<Exclude<Comparison, 'in' | 'nin' | 'is_null' | 'neq'>, string> = {
  eq: '=',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};

/**
 * Build the parameterised statement for a read. Exported so the statement can
 * be checked without a network.
 *
 * VALUES ARE PARAMETERS, NEVER TEXT. Column names are identifiers the
 * definition schema admits, backtick-quoted; everything a person typed into a
 * question is a named parameter.
 *
 * `neq` INCLUDES NULL, because the engine's own `matches` does: a missing value
 * is not equal to anything, and SQL's `!=` would silently drop it.
 */
export function readStatement(input: {
  organisationId: string;
  sourceId: string;
  object: { name: string; fields: StoredField[] };
  filters: Array<{ field: string; op: Comparison; value?: unknown }>;
  sort: Array<{ field: string; direction: 'asc' | 'desc' }>;
  fields: string[];
  limit: number;
  sinceReceived: Date;
  /**
   * Siloes (136) — exactly one copy of a kept concept: its batch, and the
   * moment every row of it carries. Then nothing written beside it is read,
   * and only its own day's partition is scanned.
   */
  batch?: { id: string; at: Date };
}): { query: string; parameters: Array<Record<string, unknown>> } {
  const types = new Map(input.object.fields.map((f) => [f.name, f.type]));
  const known = (name: string): StoredFieldType => {
    const type = types.get(name);
    if (!type) throw new Error(`${name} is not a field of ${input.object.name}.`);
    return type;
  };

  const parameters: Array<Record<string, unknown>> = [
    { name: 'since', parameterType: { type: 'TIMESTAMP' }, parameterValue: { value: (input.batch?.at ?? input.sinceReceived).toISOString() } },
    { name: 'limit', parameterType: { type: 'INT64' }, parameterValue: { value: String(input.limit) } },
  ];

  const conditions = ['`_received_at` >= @since'];

  if (input.batch) {
    parameters.push(...batchParameters('', input.batch).slice(1));
    conditions.push('`_received_at` < @until', '`_batch_id` = @batch');
  }

  const filtered = whereOf(input.object, input.filters, col);
  conditions.push(...filtered.conditions);
  parameters.push(...filtered.parameters);

  const wanted = input.fields.length > 0 ? input.fields : input.object.fields.map((f) => f.name);
  wanted.forEach(known);
  const select = [...wanted.map(col), '`_batch_id`', '`_row_ref`', 'TO_JSON_STRING(`_methods`) AS `_methods`'];

  const order = input.sort.length
    ? input.sort.map((one) => `${known(one.field) && col(one.field)} ${one.direction === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`).join(', ')
    : '`_received_at` DESC, `_row_ref`';

  const table = `\`${env.BIGQUERY_PROJECT_ID}.${datasetFor(input.organisationId)}.${tableFor(input.sourceId, input.object.name)}\``;

  return {
    query: `SELECT ${select.join(', ')} FROM ${table} WHERE ${conditions.join(' AND ')} ORDER BY ${order} LIMIT @limit`,
    parameters,
  };
}

/**
 * The parameters that pick out one copy: where its rows start, where they end,
 * and its batch. A copy's rows all carry the moment it was begun, so a second
 * either side is the whole of it — and the bound BigQuery prunes partitions by.
 */
function batchParameters(prefix: string, batch: { id: string; at: Date }): Array<Record<string, unknown>> {
  return [
    { name: `${prefix}since`, parameterType: { type: 'TIMESTAMP' }, parameterValue: { value: batch.at.toISOString() } },
    { name: `${prefix}until`, parameterType: { type: 'TIMESTAMP' }, parameterValue: { value: new Date(batch.at.getTime() + 1_000).toISOString() } },
    { name: `${prefix}batch`, parameterType: { type: 'STRING' }, parameterValue: { value: batch.id } },
  ];
}

/**
 * A question's conditions as SQL, over whatever a caller says a column is.
 *
 * ONE PLACE, so a filter means the same thing to a read, a total and a
 * comparison of two copies. `column` is how the field is spelled where it is
 * being applied: a bare column for a read, one side of a join for a comparison.
 */
function whereOf(
  object: { name: string; fields: StoredField[] },
  filters: Array<{ field: string; op: Comparison; value?: unknown }>,
  column: (name: string) => string,
): { conditions: string[]; parameters: Array<Record<string, unknown>> } {
  const types = new Map(object.fields.map((f) => [f.name, f.type]));
  const conditions: string[] = [];
  const parameters: Array<Record<string, unknown>> = [];

  filters.forEach((filter, at) => {
    const type = types.get(filter.field);
    if (!type) throw new Error(`${filter.field} is not a field of ${object.name}.`);
    if (type === 'json') throw new Error(`${filter.field} holds JSON and cannot be filtered.`);

    const expression = column(filter.field);
    const param = `p${at}`;

    if (filter.op === 'is_null') {
      conditions.push(`${expression} IS NULL`);
      return;
    }

    if (filter.op === 'in' || filter.op === 'nin') {
      const values = Array.isArray(filter.value) ? filter.value : [filter.value];
      parameters.push({
        name: param,
        parameterType: { type: 'ARRAY', arrayType: { type: TYPES[type] } },
        parameterValue: { arrayValues: values.map((value) => ({ value: paramValue(value) })) },
      });
      /* A record with nothing there is not one of them: SQL's own NOT IN would drop it. */
      conditions.push(filter.op === 'in' ? `${expression} IN UNNEST(@${param})` : `(${expression} IS NULL OR ${expression} NOT IN UNNEST(@${param}))`);
      return;
    }

    parameters.push({
      name: param,
      parameterType: { type: TYPES[type] },
      parameterValue: { value: paramValue(filter.value) },
    });

    conditions.push(
      filter.op === 'neq'
        ? `(${expression} IS NULL OR ${expression} != @${param})`
        : `${expression} ${OPERATORS[filter.op]} @${param}`,
    );
  });

  return { conditions, parameters };
}

/**
 * Siloes (135) — add a kept copy up, in BigQuery, by group.
 *
 * THE POINT OF KEEPING A COPY IN A WAREHOUSE. "Invoices by status" over five
 * million rows is a handful of rows back from here; reading the invoices to
 * add them up would be five million. The same conditions as `readStatement`,
 * the same table, one batch of it.
 *
 * NOT YET RUN AGAINST A REAL DATASET, like the rest of this file was not when
 * it was written: the statement is built here and tested as text, and what
 * BigQuery makes of it is verified only against one.
 */
export function summariseStatement(input: {
  organisationId: string;
  sourceId: string;
  /** The copy being read: its batch, and the moment every row of it carries. */
  batch: { id: string; at: Date };
  object: { name: string; fields: StoredField[] };
  filters: Array<{ field: string; op: Comparison; value?: unknown }>;
  groupBy: Array<{ field: string; every?: 'day' | 'month' | 'quarter' | 'year' }>;
  measures: Array<{ operation: 'count' | 'sum' | 'minimum' | 'maximum'; field?: string }>;
  limit: number;
}): { query: string; parameters: Array<Record<string, unknown>> } {
  /* The conditions are `readStatement`'s own, so a filter means the same thing whether rows or totals come back. */
  const base = readStatement({
    organisationId: input.organisationId,
    sourceId: input.sourceId,
    object: input.object,
    filters: input.filters,
    sort: [],
    fields: [],
    limit: input.limit,
    sinceReceived: input.batch.at,
    batch: input.batch,
  });
  const where = base.query.slice(base.query.indexOf(' WHERE ') + 7, base.query.indexOf(' ORDER BY '));

  const types = new Map(input.object.fields.map((f) => [f.name, f.type]));
  const known = (name: string) => {
    if (!types.has(name)) throw new Error(`${name} is not a field of ${input.object.name}.`);
    return col(name);
  };

  const keys = input.groupBy.map((key) => {
    const text = `CAST(${known(key.field)} AS STRING)`;
    /* The period a date is in, cut from its ISO spelling exactly as `analyse` cuts it. */
    if (key.every === 'year') return `SUBSTR(${text}, 1, 4)`;
    if (key.every === 'month') return `SUBSTR(${text}, 1, 7)`;
    if (key.every === 'day') return `SUBSTR(${text}, 1, 10)`;
    if (key.every === 'quarter') return `CONCAT(SUBSTR(${text}, 1, 4), '-Q', CAST(CAST(CEIL(SAFE_CAST(SUBSTR(${text}, 6, 2) AS INT64) / 3) AS INT64) AS STRING))`;
    return text;
  });

  const measures = input.measures.flatMap((measure, at) => {
    if (measure.operation === 'count' || !measure.field) return [`COUNT(*) AS m${at}`, `COUNT(*) AS c${at}`];
    const value = `SAFE_CAST(${known(measure.field)} AS NUMERIC)`;
    const fn = { sum: 'SUM', minimum: 'MIN', maximum: 'MAX' }[measure.operation];
    return [`${fn}(${value}) AS m${at}`, `COUNT(${value}) AS c${at}`];
  });

  const table = `\`${env.BIGQUERY_PROJECT_ID}.${datasetFor(input.organisationId)}.${tableFor(input.sourceId, input.object.name)}\``;

  return {
    query:
      `SELECT ${[...keys.map((key, at) => `${key} AS k${at}`), 'COUNT(*) AS n', ...measures].join(', ')} ` +
      `FROM ${table} WHERE ${where}` +
      `${keys.length > 0 ? ` GROUP BY ${keys.map((_key, at) => at + 1).join(', ')}` : ''} LIMIT @limit`,
    parameters: base.parameters,
  };
}

export async function summarise(
  input: Parameters<typeof summariseStatement>[0],
): Promise<{ rows: Array<{ key: Array<string | null>; records: number; measures: Array<number | null>; counted: number[] }>; bytesScanned: number }> {
  const statement = summariseStatement(input);
  const result = await runQuery(statement.query, statement.parameters);
  const at = (name: string) => result.fields.indexOf(name);

  return {
    rows: result.rows.map((cells) => ({
      key: input.groupBy.map((_key, index) => (cells[at(`k${index}`)] === null || cells[at(`k${index}`)] === undefined ? null : String(cells[at(`k${index}`)]))),
      records: Number(cells[at('n')] ?? 0),
      measures: input.measures.map((_measure, index) => {
        const cell = cells[at(`m${index}`)];
        return cell === null || cell === undefined ? null : Number(cell);
      }),
      counted: input.measures.map((_measure, index) => Number(cells[at(`c${index}`)] ?? 0)),
    })),
    bytesScanned: result.bytesProcessed,
  };
}

/**
 * Siloes (136) — two copies of one table, side by side, and what differs.
 *
 * THE SAME COMPARISON THE POSTGRES STAND-IN MAKES (`siloHolding.repo`): the
 * copies joined on the field a record is identified by, a record "changed"
 * where a watched field is not as it was, and the question's conditions applied
 * to the record as it is now — or as it last was, where it has gone.
 *
 * `which` ASKS FOR THE RECORDS RATHER THAN THE COUNT: the ones still held (new
 * or changed), or the ones gone.
 *
 * NOT YET RUN AGAINST A REAL DATASET. Built here and tested as text, like
 * `summariseStatement`.
 */
export function differenceStatement(input: {
  organisationId: string;
  sourceId: string;
  object: { name: string; fields: StoredField[] };
  earlier: { id: string; at: Date };
  later: { id: string; at: Date };
  identifier: string;
  watch: string[];
  filters: Array<{ field: string; op: Comparison; value?: unknown }>;
  which?: { records: 'held' | 'changed' | 'gone'; limit: number };
}): { query: string; parameters: Array<Record<string, unknown>> } {
  const types = new Map(input.object.fields.map((f) => [f.name, f.type]));
  const known = (name: string) => {
    if (!types.has(name)) throw new Error(`${name} is not a field of ${input.object.name}.`);
    return col(name);
  };

  const id = known(input.identifier);
  const table = `\`${env.BIGQUERY_PROJECT_ID}.${datasetFor(input.organisationId)}.${tableFor(input.sourceId, input.object.name)}\``;
  const copy = (prefix: string) =>
    `(SELECT * FROM ${table} WHERE \`_received_at\` >= @${prefix}since AND \`_received_at\` < @${prefix}until ` +
    `AND \`_batch_id\` = @${prefix}batch AND ${id} IS NOT NULL)`;

  /* JSON has no equality of its own in BigQuery, so it is compared as it is written. */
  const differs = input.watch.map((field) => {
    const column = known(field);
    return types.get(field) === 'json'
      ? `TO_JSON_STRING(a.${column}) IS DISTINCT FROM TO_JSON_STRING(b.${column})`
      : `a.${column} IS DISTINCT FROM b.${column}`;
  });
  const inBoth = `a.${id} IS NOT NULL AND b.${id} IS NOT NULL`;
  const changed = `${inBoth} AND (${differs.length > 0 ? differs.join(' OR ') : 'TO_JSON_STRING(a) != TO_JSON_STRING(b)'})`;

  /* The record a condition is about: as it is now, or as it last was where it has gone. */
  const filtered = whereOf(input.object, input.filters, (name) => `IF(b.${id} IS NULL, a.${col(name)}, b.${col(name)})`);
  const from = `${copy('a_')} a FULL OUTER JOIN ${copy('b_')} b ON a.${id} = b.${id}`;
  const parameters = [...batchParameters('a_', input.earlier), ...batchParameters('b_', input.later), ...filtered.parameters];

  if (input.which) {
    const wanted =
      input.which.records === 'gone' ? `b.${id} IS NULL` : input.which.records === 'changed' ? `(${changed})` : `(a.${id} IS NULL OR (${changed}))`;
    return {
      query:
        `SELECT CAST(COALESCE(b.${id}, a.${id}) AS STRING) AS ref, a.${id} IS NULL AS added FROM ${from} ` +
        `WHERE ${[...filtered.conditions, wanted].join(' AND ')} ORDER BY 1 LIMIT @limit`,
      parameters: [...parameters, { name: 'limit', parameterType: { type: 'INT64' }, parameterValue: { value: String(input.which.limit) } }],
    };
  }

  return {
    query:
      `SELECT COUNTIF(a.${id} IS NULL) AS added, COUNTIF(b.${id} IS NULL) AS removed, COUNTIF(${changed}) AS changed` +
      differs.map((one, at) => `, COUNTIF(${inBoth} AND ${one}) AS f${at}`).join('') +
      ` FROM ${from}${filtered.conditions.length > 0 ? ` WHERE ${filtered.conditions.join(' AND ')}` : ''}`,
    parameters,
  };
}

export async function difference(
  input: Omit<Parameters<typeof differenceStatement>[0], 'which'>,
): Promise<{ added: number; removed: number; changed: number; fields: Array<{ field: string; records: number }> }> {
  const statement = differenceStatement(input);
  const result = await runQuery(statement.query, statement.parameters);
  const cell = (name: string) => Number(result.rows[0]?.[result.fields.indexOf(name)] ?? 0);

  return {
    added: cell('added'),
    removed: cell('removed'),
    changed: cell('changed'),
    fields: input.watch.map((field, at) => ({ field, records: cell(`f${at}`) })).filter((one) => one.records > 0),
  };
}

export async function differing(
  input: Omit<Parameters<typeof differenceStatement>[0], 'which'> & { which: 'held' | 'changed' | 'gone'; limit: number },
): Promise<Array<{ ref: string; added: boolean }>> {
  const statement = differenceStatement({ ...input, which: { records: input.which, limit: input.limit } });
  const result = await runQuery(statement.query, statement.parameters);
  const at = (name: string) => result.fields.indexOf(name);

  return result.rows.map((cells) => ({ ref: String(cells[at('ref')] ?? ''), added: cells[at('added')] === true || cells[at('added')] === 'true' }));
}

/**
 * Siloes (137) — weigh each date field of a copy as the system's mark of change.
 *
 * THE SAME COUNT THE POSTGRES STAND-IN MAKES (`siloHolding.repo`): of the
 * records new or different between two copies in some OTHER field, how many
 * carry a value in this one later than `since`; and how many records of the
 * whole copy do.
 *
 * NOT YET RUN AGAINST A REAL DATASET. Built here and tested as text.
 */
export function markerStatement(input: {
  organisationId: string;
  sourceId: string;
  object: { name: string; fields: StoredField[] };
  earlier: { id: string; at: Date };
  later: { id: string; at: Date };
  identifier: string;
  candidates: string[];
  since: Date;
}): { query: string; parameters: Array<Record<string, unknown>> } {
  const types = new Map(input.object.fields.map((f) => [f.name, f.type]));
  const known = (name: string) => {
    if (!types.has(name)) throw new Error(`${name} is not a field of ${input.object.name}.`);
    return col(name);
  };

  const id = known(input.identifier);
  const table = `\`${env.BIGQUERY_PROJECT_ID}.${datasetFor(input.organisationId)}.${tableFor(input.sourceId, input.object.name)}\``;
  const copy = (prefix: string) =>
    `(SELECT * FROM ${table} WHERE \`_received_at\` >= @${prefix}since AND \`_received_at\` < @${prefix}until ` +
    `AND \`_batch_id\` = @${prefix}batch AND ${id} IS NOT NULL)`;

  const differsIn = (field: string) =>
    types.get(field) === 'json'
      ? `TO_JSON_STRING(a.${col(field)}) IS DISTINCT FROM TO_JSON_STRING(b.${col(field)})`
      : `a.${col(field)} IS DISTINCT FROM b.${col(field)}`;

  const counts = input.candidates.map((field, at) => {
    const column = known(field);
    /* New, or different in something OTHER than the field being weighed: a field cannot vouch for itself. */
    const others = input.object.fields.filter((one) => one.name !== field).map((one) => differsIn(one.name));
    const differs = `b.${id} IS NOT NULL AND (a.${id} IS NULL${others.length > 0 ? ` OR ${others.join(' OR ')}` : ''})`;
    const when = `TIMESTAMP(b.${column})`;
    return (
      `COUNTIF(${differs}) AS d${at}, COUNTIF(${differs} AND ${when} >= @marked) AS m${at}, ` +
      `COUNTIF(b.${id} IS NOT NULL AND ${when} >= @marked) AS n${at}`
    );
  });

  return {
    query:
      `SELECT COUNTIF(b.${id} IS NOT NULL) AS total, ${counts.join(', ')} ` +
      `FROM ${copy('a_')} a FULL OUTER JOIN ${copy('b_')} b ON a.${id} = b.${id}`,
    parameters: [
      ...batchParameters('a_', input.earlier),
      ...batchParameters('b_', input.later),
      { name: 'marked', parameterType: { type: 'TIMESTAMP' }, parameterValue: { value: input.since.toISOString() } },
    ],
  };
}

export async function markerEvidence(
  input: Parameters<typeof markerStatement>[0],
): Promise<Array<{ field: string; differ: number; marked: number; recent: number; rows: number }>> {
  if (input.candidates.length === 0) return [];

  const statement = markerStatement(input);
  const result = await runQuery(statement.query, statement.parameters);
  const cell = (name: string) => Number(result.rows[0]?.[result.fields.indexOf(name)] ?? 0);

  return input.candidates.map((field, at) => ({ field, differ: cell(`d${at}`), marked: cell(`m${at}`), recent: cell(`n${at}`), rows: cell('total') }));
}

function paramValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

export async function read(input: Parameters<typeof readStatement>[0]): Promise<{ rows: ReadRow[]; bytesScanned: number }> {
  const statement = readStatement(input);
  const result = await runQuery(statement.query, statement.parameters);
  const types = new Map(input.object.fields.map((f) => [f.name, f.type]));
  /* A row comes back by column; a caller knows a field by the name its system gives it. */
  const fieldOf = new Map(input.object.fields.map((f) => [columnFor(f.name), f.name]));

  const rows = result.rows.map((cells) => {
    const names = result.fields;
    const values: Record<string, unknown> = {};
    let fileId = '';
    let rowRef = '';
    let methods: ReadRow['methods'] = {};

    names.forEach((name, at) => {
      const raw = cells[at] ?? null;
      if (name === '_batch_id') fileId = String(raw);
      else if (name === '_row_ref') rowRef = String(raw);
      else if (name === '_methods') methods = raw ? (JSON.parse(String(raw)) as ReadRow['methods']) : {};
      else {
        const field = fieldOf.get(name) ?? name;
        values[field] = fromCell(raw, types.get(field));
      }
    });

    return { values, fileId, rowRef, methods };
  });

  return { rows, bytesScanned: result.bytesProcessed };
}

function fromCell(raw: unknown, type: StoredFieldType | undefined): unknown {
  if (raw === null || raw === undefined) return null;
  switch (type) {
    case 'number':
      return Number(raw);
    case 'boolean':
      return raw === 'true' || raw === true;
    case 'datetime':
      /* The REST API returns TIMESTAMP as seconds since the epoch, as a string. */
      return new Date(Number(raw) * 1000).toISOString();
    case 'json':
      return JSON.parse(String(raw));
    default:
      return raw;
  }
}

interface QueryResponse {
  jobComplete?: boolean;
  jobReference?: { jobId: string; location?: string };
  schema?: { fields?: Array<{ name: string }> };
  rows?: Array<{ f: Array<{ v: unknown }> }>;
  pageToken?: string;
  totalBytesProcessed?: string;
  numDmlAffectedRows?: string;
}

async function runQuery(
  query: string,
  parameters: Array<Record<string, unknown>>,
): Promise<{ fields: string[]; rows: unknown[][]; bytesProcessed: number; affected: number }> {
  const location = env.BIGQUERY_LOCATION!;
  let response = (
    await call<QueryResponse>('POST', '/queries', {
      query,
      useLegacySql: false,
      parameterMode: 'NAMED',
      queryParameters: parameters,
      location,
      timeoutMs: 60_000,
    })
  ).body!;

  const jobId = response.jobReference?.jobId;
  const deadline = Date.now() + 10 * 60 * 1000;

  while (!response.jobComplete) {
    if (!jobId || Date.now() > deadline) throw new Error('BigQuery query did not finish.');
    response = (
      await call<QueryResponse>('GET', `/queries/${jobId}?location=${encodeURIComponent(location)}&timeoutMs=60000`)
    ).body!;
  }

  const fields = (response.schema?.fields ?? []).map((f) => f.name);
  const rows = (response.rows ?? []).map((row) => row.f.map((cell) => cell.v));
  let token = response.pageToken;

  while (token && jobId) {
    const page = (
      await call<QueryResponse>(
        'GET',
        `/queries/${jobId}?location=${encodeURIComponent(location)}&pageToken=${encodeURIComponent(token)}`,
      )
    ).body!;
    rows.push(...(page.rows ?? []).map((row) => row.f.map((cell) => cell.v)));
    token = page.pageToken;
  }

  return {
    fields,
    rows,
    bytesProcessed: Number(response.totalBytesProcessed ?? 0),
    affected: Number(response.numDmlAffectedRows ?? 0),
  };
}

/* ── Removing rows ───────────────────────────────────────────────────────── */

/**
 * Delete rows from one source object's table: one file's, those older than a
 * moment, or all of them. Returns how many went.
 */
export async function deleteRows(input: {
  organisationId: string;
  sourceId: string;
  objectName: string;
  where: { fileId: string } | { receivedBefore: Date } | 'all';
}): Promise<number> {
  const table = `\`${env.BIGQUERY_PROJECT_ID}.${datasetFor(input.organisationId)}.${tableFor(input.sourceId, input.objectName)}\``;

  const found = await call('GET', `/datasets/${datasetFor(input.organisationId)}/tables/${tableFor(input.sourceId, input.objectName)}`);
  if (found.status === 404) return 0;

  const [condition, parameters] =
    input.where === 'all'
      ? ['TRUE', []]
      : 'fileId' in input.where
        ? ['`_batch_id` = @file', [{ name: 'file', parameterType: { type: 'STRING' }, parameterValue: { value: input.where.fileId } }]]
        : ['`_received_at` < @before', [{ name: 'before', parameterType: { type: 'TIMESTAMP' }, parameterValue: { value: input.where.receivedBefore.toISOString() } }]];

  const result = await runQuery(`DELETE FROM ${table} WHERE ${condition as string}`, parameters as Array<Record<string, unknown>>);
  return result.affected;
}

/**
 * §5 — a confirmed value stops being marked in BigQuery.
 *
 * THE FIELD NAME IS PART OF A JSON PATH, which BigQuery takes as a literal. It is
 * an identifier the definition schema admits, and checked again here before it
 * is written into the statement; the file and row are parameters.
 */
export async function certifyField(input: {
  organisationId: string;
  sourceId: string;
  objectName: string;
  fileId: string;
  rowRef: string;
  field: string;
}): Promise<void> {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(input.field)) throw new Error('Not a field name.');

  const dataset = datasetFor(input.organisationId);
  const tableId = tableFor(input.sourceId, input.objectName);
  const found = await call('GET', `/datasets/${dataset}/tables/${tableId}`);
  if (found.status === 404) return;

  await runQuery(
    `UPDATE \`${env.BIGQUERY_PROJECT_ID}.${dataset}.${tableId}\`
        SET \`_methods\` = JSON_REMOVE(\`_methods\`, '$.${input.field}')
      WHERE \`_batch_id\` = @file AND \`_row_ref\` = @row`,
    [
      { name: 'file', parameterType: { type: 'STRING' }, parameterValue: { value: input.fileId } },
      { name: 'row', parameterType: { type: 'STRING' }, parameterValue: { value: input.rowRef } },
    ],
  );
}

/** What one source object's table holds, as BigQuery bills it. */
export async function tableBytes(input: { organisationId: string; sourceId: string; objectName: string }): Promise<number> {
  const found = await call<{ numBytes?: string }>(
    'GET',
    `/datasets/${datasetFor(input.organisationId)}/tables/${tableFor(input.sourceId, input.objectName)}`,
  );
  return found.status === 404 ? 0 : Number(found.body?.numBytes ?? 0);
}
