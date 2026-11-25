// Silo's own BigQuery (catalogue: "bigquery-adapter", the one client every BigQuery
// service uses; spec 66.8, 69): the Warehouse, the Import row store, the Object Index and
// the metering read. A platform adapter, like KMS and object storage: it may name the
// provider, and it is the only file that holds the BigQuery client
// (tests/architecture/sql.test.ts, decision 2026-11-02).
//
// It writes no SQL. Statements reach it rendered by the warehouse generator
// (services/warehouse-schema/generator/, through utils/sqlBuilder.util.ts): constant text
// with @p<n> placeholders and every value bound, so Cloud Audit Logs, which record query
// text, never hold a record value (design: BigQuery and object storage, Access).
//
// What it enforces for every caller:
// - Location pinning: the adapter is built for one location, the cell's region; every
//   dataset is created there, and a dataset found elsewhere is refused (spec 66.8).
// - Labels: every job carries the organisation and the service, for metering (69.19).
// - Cost: a query may name maximumBytesBilled; it is dry-run first and refused, with the
//   bound named, when it would bill more.
// - Retries on quota and transient errors; a provider message never leaves this file
//   (it can quote a bound value), only a code.
//
// Creation of projects and keys is the provisioning account's work (design: Access); the
// day-to-day accounts reach datasets and jobs only.

import { BigQuery, type Job, type Query } from '@google-cloud/bigquery';
import type { RESIDENCIES } from '../config/cell.config.ts';
import { AppError, isAppError } from '../utils/errors.util.ts';
import { retry } from '../utils/retry.util.ts';

type Residency = (typeof RESIDENCIES)[number];

// ----------------------------------------------------------------------------- interface

/** A statement as the generator renders it: @p1..@pn in text, values in order. */
export interface WarehouseStatement {
  text: string;
  values: unknown[];
  /**
   * The BigQuery type of each value, where it cannot be inferred: always for a null, and
   * for an array of structs whose fields may be null. Index i types @p<i+1>.
   */
  types?: (WarehouseParameterType | undefined)[];
}

/** BigQuery parameter types: 'STRING', 'INT64', ['STRING'] (an array), { field: type } (a struct). */
export type WarehouseParameterType = string | WarehouseParameterType[] | { [field: string]: WarehouseParameterType };

export interface DatasetRef {
  projectId: string;
  dataset: string;
}

export interface TableRef extends DatasetRef {
  table: string;
}

/**
 * Labels on every job: the organisation, the service, what the job is for, and the Silo it
 * serves where one shared project holds many (the cell's siloes project: Import rows and
 * Object Index documents), so metering attributes bytes per Silo (spec 69.7, 74.1).
 */
export interface JobLabels {
  organisation: string;
  service: string;
  purpose: 'warehouse_schema' | 'warehouse_sync' | 'warehouse_reconcile' | 'import_load' | 'index_refresh' | 'index_search' | 'index_read' | 'warehouse_read' | 'metering'
    | 'export' | 'question' | 'silo_query';
  silo?: string;
}

export interface QueryOptions {
  labels: JobLabels;
  /** Dry-run first; refuse (bounds) when the query would bill more than this. */
  maximumBytesBilled?: number;
  /** The project the job runs and bills in; the dataset's project by default. */
  jobProjectId?: string;
}

export interface QueryOutcome {
  jobId: string;
  rows: Record<string, unknown>[];
  /** Rows changed by a DML statement; null for a query. */
  affectedRows: number | null;
  bytesProcessed: number;
  bytesBilled: number;
  cacheHit: boolean;
}

export interface TableInfo {
  columns: { name: string; type: string; mode: 'NULLABLE' | 'REQUIRED' | 'REPEATED' }[];
  rows: number;
  bytes: number;
}

export interface DatasetInfo {
  location: string;
  kmsKeyRef: string | null;
  maxTimeTravelHours: number | null;
}

export type DatasetRole = 'reader' | 'writer';

export interface JobStatistic {
  jobId: string;
  projectId: string;
  kind: 'query' | 'load' | 'extract' | 'copy';
  labels: Record<string, string>;
  bytesProcessed: number;
  bytesBilled: number;
  slotMs: number;
  state: 'pending' | 'running' | 'done';
  failed: boolean;
  createdAt: string;
  endedAt: string | null;
}

export interface StorageMeasurement {
  logicalBytes: number;
  physicalBytes: number;
  tables: number;
}

export interface BigQueryAdapter {
  /** The single-region location every dataset of this cell is pinned to. */
  readonly location: string;

  // Projects: the Warehouse's dedicated project per organisation (69.13).
  ensureProject(input: { projectId: string; displayName: string; labels: Record<string, string> }): Promise<{ created: boolean }>;
  deleteProject(projectId: string): Promise<{ deleted: boolean }>;
  /** Moves a project under another parent (`organizations/<n>` or `folders/<n>`): the Warehouse hand-over (69.17). */
  moveProject(projectId: string, parent: string): Promise<void>;
  /** roles/bigquery.jobUser on a project for a member (`serviceAccount:` or `user:`). */
  grantJobUser(projectId: string, member: string): Promise<void>;
  revokeJobUser(projectId: string, member: string): Promise<void>;

  // Keys: a customer-managed key in the same region (69.13 step 3). Returns its resource name.
  ensureKey(input: { keyRing: string; key: string; rotationDays: number }): Promise<{ keyRef: string; created: boolean }>;
  /** Schedules destruction of every version of a key (purge). */
  destroyKey(keyRef: string): Promise<void>;

  // Datasets, always in `location`.
  ensureDataset(ref: DatasetRef, input: { kmsKeyRef?: string; maxTimeTravelHours?: number; labels: Record<string, string> })
    : Promise<{ created: boolean }>;
  getDataset(ref: DatasetRef): Promise<DatasetInfo | undefined>;
  setDatasetKey(ref: DatasetRef, kmsKeyRef: string): Promise<void>;
  deleteDataset(ref: DatasetRef): Promise<{ deleted: boolean }>;
  /** Dataset-level access only, never project-level (design: Access). */
  grantDatasetAccess(ref: DatasetRef, member: string, role: DatasetRole): Promise<void>;
  revokeDatasetAccess(ref: DatasetRef, member: string): Promise<void>;
  listDatasetAccess(ref: DatasetRef): Promise<{ member: string; role: DatasetRole | 'owner' }[]>;

  // Tables. Creation and changes are DDL statements from the generator, run with query().
  getTable(ref: TableRef): Promise<TableInfo | undefined>;
  listTables(ref: DatasetRef): Promise<string[]>;

  // Statements rendered by the generator.
  dryRun(ref: DatasetRef, statement: WarehouseStatement, options: QueryOptions): Promise<{ bytesProcessed: number }>;
  /** Runs a statement the generator rendered (DDL, DML or a query). */
  run(ref: DatasetRef, statement: WarehouseStatement, options: QueryOptions): Promise<QueryOutcome>;

  /**
   * Appends rows to a table by a batch load job (a media upload of newline-delimited JSON),
   * never a streaming insert: rows in the streaming buffer cannot be deleted by DML for a
   * while, and a purge must delete at once (design: Import rows). The job id makes it
   * idempotent: a job id that already ran is answered from that job, replayed.
   */
  loadRows(ref: TableRef, input: { jobId: string; rows: Record<string, unknown>[] }): Promise<{ jobId: string; rowsLoaded: number; replayed: boolean }>;

  // Loads and exports, through object storage (gs:// URIs in the cell's region).
  loadFromStorage(ref: TableRef, input: { sourceUris: string[]; format: 'NEWLINE_DELIMITED_JSON' | 'PARQUET' | 'CSV';
    write: 'append' | 'truncate' }, options: QueryOptions): Promise<{ jobId: string }>;
  exportTable(ref: TableRef, input: { destinationUri: string; format: 'PARQUET' | 'NEWLINE_DELIMITED_JSON' | 'CSV' },
    options: QueryOptions): Promise<{ jobId: string }>;
  jobStatus(projectId: string, jobId: string): Promise<{ state: 'pending' | 'running' | 'done'; failed: boolean; errorCode?: string }>;

  // Metering (69.19, 74).
  jobStatistics(input: { projectId: string; since: string; until: string }): Promise<JobStatistic[]>;
  storage(ref: DatasetRef): Promise<StorageMeasurement>;

  close(): Promise<void>;
}

// ----------------------------------------------------------------------------- naming and location

/**
 * The single-region location of each residency (design: Residency). Multi-region
 * locations such as EU or US are never used.
 */
export const LOCATION_BY_CELL: Readonly<Record<string, string>> = {
  'uk-lon-1': 'europe-west2',
  'eu-fra-1': 'europe-west3',
  'us-va-1': 'us-east4',
};

const LOCATION_BY_RESIDENCY: Readonly<Record<Residency, string>> = { uk: 'europe-west2', eu: 'europe-west3', us: 'us-east4' };

/** The location a cell's datasets are pinned to: its own, or its residency's region. */
export function cellLocation(cellId: string, residency: Residency): string {
  return LOCATION_BY_CELL[cellId] ?? LOCATION_BY_RESIDENCY[residency]!;
}

/** `uk-lon-1` becomes `uklon1` (design: naming rules). */
export const cellCode = (cellId: string): string => cellId.replaceAll('-', '');

/** The last `n` hex characters of a UUID without hyphens: the random end of a UUIDv7. */
export const idTail = (id: string, n = 12): string => id.replaceAll('-', '').slice(-n);

/** BigQuery label values: lowercase letters, digits, - and _, at most 63 characters. */
export function labelValue(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 63);
  return cleaned.length === 0 ? '_' : cleaned;
}

export function jobLabels(labels: JobLabels): Record<string, string> {
  return {
    silo_organisation: labelValue(labels.organisation),
    silo_service: labelValue(labels.service),
    silo_purpose: labelValue(labels.purpose),
    ...(labels.silo === undefined ? {} : { silo_silo: labelValue(labels.silo) }),
  };
}

// ----------------------------------------------------------------------------- errors

/** A provider error as an AppError: its HTTP status and reason only, never its message. */
export function bigQueryError(error: unknown, operation: string): AppError {
  if (isAppError(error)) return error;
  const e = error as { code?: number | string; errors?: { reason?: string }[]; response?: { status?: number } };
  const status = typeof e.code === 'number' ? e.code : e.response?.status;
  const reason = e.errors?.[0]?.reason ?? (typeof e.code === 'string' ? e.code : undefined);
  const details = { operation, ...(status !== undefined ? { status } : {}), ...(reason !== undefined ? { reason } : {}) };
  if (reason === 'quotaExceeded' || reason === 'rateLimitExceeded' || status === 429) {
    return new AppError('capacity', `BigQuery refused ${operation} for quota`, { code: 'bigquery.quota', details, retryAfterSeconds: 5 });
  }
  if (status === 404 || reason === 'notFound') return new AppError('not_found', `BigQuery has no such resource (${operation})`, { code: 'bigquery.not_found', details });
  if (status === 409 || reason === 'duplicate') return new AppError('conflict', `BigQuery resource exists (${operation})`, { code: 'bigquery.exists', details });
  if (status === 403 || reason === 'accessDenied') return new AppError('forbidden', `BigQuery denied ${operation}`, { code: 'bigquery.access_denied', details });
  if (status === 400 || reason === 'invalidQuery' || reason === 'invalid') {
    return new AppError('validation', `BigQuery refused ${operation} as invalid`, { code: 'bigquery.invalid', details });
  }
  if (status !== undefined && status >= 500) return new AppError('unavailable', `BigQuery is unavailable (${operation})`, { code: 'bigquery.unavailable', details });
  return new AppError('upstream', `BigQuery failed ${operation}`, { code: 'bigquery.failed', details });
}

const RETRY = { attempts: 4, baseDelayMs: 500, maxDelayMs: 8_000 };

/** Named parameters for the client: @p1 is values[0]. */
export function namedParameters(statement: WarehouseStatement): { params: Record<string, unknown>; types?: Record<string, WarehouseParameterType> } {
  const params: Record<string, unknown> = {};
  const types: Record<string, WarehouseParameterType> = {};
  statement.values.forEach((value, i) => {
    params[`p${i + 1}`] = value;
    const type = statement.types?.[i];
    if (type !== undefined) types[`p${i + 1}`] = type;
  });
  return Object.keys(types).length > 0 ? { params, types } : { params };
}

/** Refuses a query that would bill more than its bound, after the dry run. */
export function checkBytes(bytesProcessed: number, maximumBytesBilled: number | undefined): void {
  if (maximumBytesBilled !== undefined && bytesProcessed > maximumBytesBilled) {
    throw new AppError('bounds', 'the query would scan more than its byte bound', {
      code: 'bigquery.bytes_bound', details: { bound: 'maximumBytesBilled', limit: maximumBytesBilled },
    });
  }
}

// ----------------------------------------------------------------------------- the real adapter

export interface BigQueryAdapterOptions {
  /** The cell's siloes project: the default job project and where keys live. */
  projectId: string;
  location: string;
  /** Silo's folder for this cell's Warehouse projects (69.13: a folder per cell). */
  warehouseFolderId?: string | undefined;
  /** The billing account Warehouse projects are linked to. */
  billingAccountId?: string | undefined;
}

const CLOUD_RESOURCE_MANAGER = 'https://cloudresourcemanager.googleapis.com/v3';
const CLOUD_KMS = 'https://cloudkms.googleapis.com/v1';
const CLOUD_BILLING = 'https://cloudbilling.googleapis.com/v1';

export function createBigQueryAdapter(options: BigQueryAdapterOptions): BigQueryAdapter {
  const location = options.location;
  const client = new BigQuery({ projectId: options.projectId, location });
  // A query job runs in the project of the client that makes it (the client takes no project
  // per job), so each project a job bills to has its own client, sharing the same identity.
  const clients = new Map<string, BigQuery>([[options.projectId, client]]);
  const clientFor = (projectId: string): BigQuery => {
    let found = clients.get(projectId);
    if (found === undefined) {
      found = new BigQuery({ projectId, location });
      clients.set(projectId, found);
    }
    return found;
  };

  // Calls the Google REST APIs the BigQuery client does not cover (projects, keys, IAM),
  // with the same workload identity the client uses.
  async function rest(method: string, url: string, operation: string, body?: unknown): Promise<Record<string, unknown> | undefined> {
    return retry(async () => {
      const token = await client.authClient.getAccessToken();
      const response = await fetch(url, {
        method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 404) return undefined;
      if (!response.ok) {
        const parsed = await response.json().catch(() => ({})) as { error?: { status?: string } };
        throw bigQueryError({ code: response.status, errors: [{ reason: parsed.error?.status }] }, operation);
      }
      return await response.json() as Record<string, unknown>;
    }, RETRY);
  }

  async function waitForOperation(name: string, base: string, operation: string): Promise<void> {
    for (let i = 0; i < 60; i += 1) {
      const op = await rest('GET', `${base}/${name}`, operation);
      if (op?.['done'] === true) {
        if (op['error'] !== undefined) throw new AppError('upstream', `the ${operation} operation failed`, { code: 'bigquery.operation_failed', details: { operation } });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(1_000 * (i + 1), 5_000)));
    }
    throw new AppError('timeout', `the ${operation} operation did not finish`, { code: 'bigquery.operation_timeout', details: { operation } });
  }

  async function iamMembers(resource: string, operation: string, change: (bindings: { role: string; members: string[] }[]) => void): Promise<void> {
    const policy = await rest('POST', `${CLOUD_RESOURCE_MANAGER}/${resource}:getIamPolicy`, operation, {}) as
      { bindings?: { role: string; members: string[] }[]; etag?: string } | undefined;
    if (policy === undefined) throw new AppError('not_found', 'no such project', { code: 'bigquery.not_found', details: { operation } });
    const bindings = policy.bindings ?? [];
    change(bindings);
    await rest('POST', `${CLOUD_RESOURCE_MANAGER}/${resource}:setIamPolicy`, operation, { policy: { bindings, etag: policy.etag } });
  }

  const call = <T>(operation: string, work: () => Promise<T>): Promise<T> =>
    retry(async () => {
      try {
        return await work();
      } catch (error) {
        throw bigQueryError(error, operation);
      }
    }, RETRY);

  const datasetOf = (ref: DatasetRef) => client.dataset(ref.dataset, { projectId: ref.projectId, location });

  function queryRequest(ref: DatasetRef, statement: WarehouseStatement, opts: QueryOptions, dryRun: boolean): Query {
    const named = namedParameters(statement);
    return {
      query: statement.text, ...named, location, dryRun, useLegacySql: false, labels: jobLabels(opts.labels),
      defaultDataset: { projectId: ref.projectId, datasetId: ref.dataset },
      ...(opts.maximumBytesBilled !== undefined ? { maximumBytesBilled: String(opts.maximumBytesBilled) } : {}),
    } as Query;
  }

  async function runJob(configuration: Record<string, unknown>, projectId: string, operation: string): Promise<{ jobId: string }> {
    const [job] = await call(operation, () => client.createJob({ configuration, location, projectId } as never));
    return { jobId: job.id! };
  }

  return {
    location,

    async ensureProject(input) {
      const existing = await rest('GET', `${CLOUD_RESOURCE_MANAGER}/projects/${input.projectId}`, 'project.get');
      if (existing !== undefined) {
        if (existing['state'] === 'DELETE_REQUESTED') {
          throw new AppError('conflict', 'the project is being deleted', { code: 'bigquery.project_deleting' });
        }
        return { created: false };
      }
      if (options.warehouseFolderId === undefined) {
        throw new AppError('configuration', 'no folder is configured for Warehouse projects', { code: 'config.bigquery.folder' });
      }
      const op = await rest('POST', `${CLOUD_RESOURCE_MANAGER}/projects`, 'project.create', {
        projectId: input.projectId, displayName: input.displayName, parent: `folders/${options.warehouseFolderId}`, labels: input.labels,
      });
      if (op?.['name'] !== undefined) await waitForOperation(String(op['name']), CLOUD_RESOURCE_MANAGER, 'project.create');
      if (options.billingAccountId !== undefined) {
        await rest('PUT', `${CLOUD_BILLING}/projects/${input.projectId}/billingInfo`, 'project.billing', {
          billingAccountName: `billingAccounts/${options.billingAccountId}`,
        });
      }
      return { created: true };
    },

    async deleteProject(projectId) {
      const existing = await rest('GET', `${CLOUD_RESOURCE_MANAGER}/projects/${projectId}`, 'project.get');
      if (existing === undefined || existing['state'] === 'DELETE_REQUESTED') return { deleted: false };
      await rest('DELETE', `${CLOUD_RESOURCE_MANAGER}/projects/${projectId}`, 'project.delete');
      return { deleted: true };
    },

    async moveProject(projectId, parent) {
      if (!/^(organizations|folders)\/\d{1,30}$/.test(parent)) {
        throw new AppError('validation', 'a project moves under an organisation or a folder', { code: 'bigquery.parent_invalid' });
      }
      const op = await rest('POST', `${CLOUD_RESOURCE_MANAGER}/projects/${projectId}:move`, 'project.move', { destinationParent: parent });
      if (op?.['name'] !== undefined) await waitForOperation(String(op['name']), CLOUD_RESOURCE_MANAGER, 'project.move');
    },

    async grantJobUser(projectId, member) {
      await iamMembers(`projects/${projectId}`, 'project.iam', (bindings) => {
        const role = 'roles/bigquery.jobUser';
        const binding = bindings.find((b) => b.role === role);
        if (binding === undefined) bindings.push({ role, members: [member] });
        else if (!binding.members.includes(member)) binding.members.push(member);
      });
    },

    async revokeJobUser(projectId, member) {
      await iamMembers(`projects/${projectId}`, 'project.iam', (bindings) => {
        const binding = bindings.find((b) => b.role === 'roles/bigquery.jobUser');
        if (binding !== undefined) binding.members = binding.members.filter((m) => m !== member);
      });
    },

    async ensureKey(input) {
      const ring = `projects/${options.projectId}/locations/${location}/keyRings/${input.keyRing}`;
      if (await rest('GET', `${CLOUD_KMS}/${ring}`, 'key_ring.get') === undefined) {
        await rest('POST', `${CLOUD_KMS}/projects/${options.projectId}/locations/${location}/keyRings?keyRingId=${encodeURIComponent(input.keyRing)}`,
          'key_ring.create', {});
      }
      const keyRef = `${ring}/cryptoKeys/${input.key}`;
      if (await rest('GET', `${CLOUD_KMS}/${keyRef}`, 'key.get') !== undefined) return { keyRef, created: false };
      const seconds = input.rotationDays * 86_400;
      await rest('POST', `${CLOUD_KMS}/${ring}/cryptoKeys?cryptoKeyId=${encodeURIComponent(input.key)}`, 'key.create', {
        purpose: 'ENCRYPT_DECRYPT', rotationPeriod: `${seconds}s`,
        nextRotationTime: new Date(Date.now() + seconds * 1_000).toISOString(),
        versionTemplate: { algorithm: 'GOOGLE_SYMMETRIC_ENCRYPTION', protectionLevel: 'SOFTWARE' },
      });
      return { keyRef, created: true };
    },

    async destroyKey(keyRef) {
      const versions = await rest('GET', `${CLOUD_KMS}/${keyRef}/cryptoKeyVersions?filter=state%3DENABLED`, 'key.versions') as
        { cryptoKeyVersions?: { name: string }[] } | undefined;
      for (const v of versions?.cryptoKeyVersions ?? []) await rest('POST', `${CLOUD_KMS}/${v.name}:destroy`, 'key.destroy', {});
    },

    async ensureDataset(ref, input) {
      const existing = await this.getDataset(ref);
      if (existing !== undefined) {
        if (existing.location.toLowerCase() !== location.toLowerCase()) {
          throw new AppError('integrity', 'the dataset is outside the cell\'s region', { code: 'bigquery.location_mismatch' });
        }
        return { created: false };
      }
      await call('dataset.create', () => client.createDataset(ref.dataset, {
        projectId: ref.projectId, location, labels: input.labels,
        ...(input.kmsKeyRef !== undefined ? { defaultEncryptionConfiguration: { kmsKeyName: input.kmsKeyRef } } : {}),
        ...(input.maxTimeTravelHours !== undefined ? { maxTimeTravelHours: String(input.maxTimeTravelHours) } : {}),
      } as never));
      return { created: true };
    },

    async getDataset(ref) {
      try {
        const [metadata] = await call('dataset.get', () => datasetOf(ref).getMetadata());
        const m = metadata as { location?: string; defaultEncryptionConfiguration?: { kmsKeyName?: string }; maxTimeTravelHours?: string };
        return {
          location: m.location ?? '', kmsKeyRef: m.defaultEncryptionConfiguration?.kmsKeyName ?? null,
          maxTimeTravelHours: m.maxTimeTravelHours === undefined ? null : Number(m.maxTimeTravelHours),
        };
      } catch (error) {
        if (isAppError(error) && error.category === 'not_found') return undefined;
        throw error;
      }
    },

    async setDatasetKey(ref, kmsKeyRef) {
      await call('dataset.key', () => datasetOf(ref).setMetadata({ defaultEncryptionConfiguration: { kmsKeyName: kmsKeyRef } } as never));
    },

    async deleteDataset(ref) {
      if (await this.getDataset(ref) === undefined) return { deleted: false };
      await call('dataset.delete', () => datasetOf(ref).delete({ force: true }));
      return { deleted: true };
    },

    async grantDatasetAccess(ref, member, role) {
      const [metadata] = await call('dataset.get', () => datasetOf(ref).getMetadata());
      const access = ((metadata as { access?: Record<string, string>[] }).access ?? []).filter((a) => entryMember(a) !== member);
      access.push(accessEntry(member, role));
      await call('dataset.access', () => datasetOf(ref).setMetadata({ access } as never));
    },

    async revokeDatasetAccess(ref, member) {
      const [metadata] = await call('dataset.get', () => datasetOf(ref).getMetadata());
      const access = ((metadata as { access?: Record<string, string>[] }).access ?? []).filter((a) => entryMember(a) !== member);
      await call('dataset.access', () => datasetOf(ref).setMetadata({ access } as never));
    },

    async listDatasetAccess(ref) {
      const [metadata] = await call('dataset.get', () => datasetOf(ref).getMetadata());
      return ((metadata as { access?: Record<string, string>[] }).access ?? []).flatMap((a) => {
        const member = entryMember(a);
        if (member === undefined) return [];
        const role = a['role'] === 'READER' ? 'reader' as const : a['role'] === 'WRITER' ? 'writer' as const : 'owner' as const;
        return [{ member, role }];
      });
    },

    async getTable(ref) {
      try {
        const [metadata] = await call('table.get', () => datasetOf(ref).table(ref.table).getMetadata());
        const m = metadata as { schema?: { fields?: { name: string; type: string; mode?: string }[] }; numRows?: string; numBytes?: string };
        return {
          columns: (m.schema?.fields ?? []).map((f) => ({ name: f.name, type: f.type, mode: (f.mode ?? 'NULLABLE') as TableInfo['columns'][number]['mode'] })),
          rows: Number(m.numRows ?? 0), bytes: Number(m.numBytes ?? 0),
        };
      } catch (error) {
        if (isAppError(error) && error.category === 'not_found') return undefined;
        throw error;
      }
    },

    async listTables(ref) {
      const [tables] = await call('table.list', () => datasetOf(ref).getTables());
      return tables.map((t) => t.id!).sort();
    },

    async dryRun(ref, statement, opts) {
      const [job] = await call('query.dry_run', () => clientFor(opts.jobProjectId ?? ref.projectId).createQueryJob(queryRequest(ref, statement, opts, true)));
      const stats = job.metadata?.statistics as { totalBytesProcessed?: string } | undefined;
      return { bytesProcessed: Number(stats?.totalBytesProcessed ?? 0) };
    },

    async run(ref, statement, opts) {
      if (opts.maximumBytesBilled !== undefined) checkBytes((await this.dryRun(ref, statement, opts)).bytesProcessed, opts.maximumBytesBilled);
      const request = queryRequest(ref, statement, opts, false);
      // The job runs and bills in the dataset's project unless told otherwise: a Warehouse's
      // questions bill to the Warehouse project (design: Access), Import and Index work to the
      // cell's siloes project.
      const [job] = await call('query.run', () => clientFor(opts.jobProjectId ?? ref.projectId).createQueryJob(request));
      const [rows] = await call('query.results', () => job.getQueryResults());
      const [metadata] = await call('query.metadata', () => job.getMetadata());
      const stats = (metadata as { statistics?: { query?: { totalBytesProcessed?: string; totalBytesBilled?: string; cacheHit?: boolean;
        numDmlAffectedRows?: string } } }).statistics?.query;
      return {
        jobId: job.id!, rows: rows as Record<string, unknown>[],
        affectedRows: stats?.numDmlAffectedRows === undefined ? null : Number(stats.numDmlAffectedRows),
        bytesProcessed: Number(stats?.totalBytesProcessed ?? 0), bytesBilled: Number(stats?.totalBytesBilled ?? 0), cacheHit: stats?.cacheHit === true,
      };
    },

    async loadRows(ref, input) {
      const body = Buffer.from(input.rows.map((r) => JSON.stringify(r)).join('\n'), 'utf8');
      const table = datasetOf(ref).table(ref.table, { location });
      try {
        const job = await new Promise<Job>((resolve, reject) => {
          const stream = table.createWriteStream({ sourceFormat: 'NEWLINE_DELIMITED_JSON', writeDisposition: 'WRITE_APPEND', jobId: input.jobId } as never);
          stream.on('error', reject);
          stream.on('complete', (done: Job) => resolve(done));
          stream.end(body);
        });
        return { jobId: input.jobId, rowsLoaded: loadedRows(job.metadata, input.rows.length), replayed: false };
      } catch (error) {
        const e = bigQueryError(error, 'load.rows');
        if (e.code !== 'bigquery.exists') throw e;
        // The job ran before: this is a retry, answered from that job.
        const [metadata] = await call('job.get', () => client.job(input.jobId, { projectId: ref.projectId, location }).getMetadata());
        if ((metadata as { status?: { errorResult?: unknown } }).status?.errorResult !== undefined) {
          throw new AppError('upstream', 'the load job failed', { code: 'bigquery.load_failed', details: { operation: 'load.rows' } });
        }
        return { jobId: input.jobId, rowsLoaded: loadedRows(metadata, input.rows.length), replayed: true };
      }
    },

    async loadFromStorage(ref, input, opts) {
      return runJob({
        load: {
          sourceUris: input.sourceUris, sourceFormat: input.format,
          destinationTable: { projectId: ref.projectId, datasetId: ref.dataset, tableId: ref.table },
          writeDisposition: input.write === 'truncate' ? 'WRITE_TRUNCATE' : 'WRITE_APPEND',
        },
        labels: jobLabels(opts.labels),
      }, opts.jobProjectId ?? ref.projectId, 'load');
    },

    async exportTable(ref, input, opts) {
      return runJob({
        extract: {
          sourceTable: { projectId: ref.projectId, datasetId: ref.dataset, tableId: ref.table },
          destinationUris: [input.destinationUri], destinationFormat: input.format,
        },
        labels: jobLabels(opts.labels),
      }, opts.jobProjectId ?? ref.projectId, 'export');
    },

    async jobStatus(projectId, jobId) {
      const [metadata] = await call('job.get', () => client.job(jobId, { projectId, location }).getMetadata());
      const status = (metadata as { status?: { state?: string; errorResult?: { reason?: string } } }).status;
      const state = status?.state === 'DONE' ? 'done' as const : status?.state === 'RUNNING' ? 'running' as const : 'pending' as const;
      return { state, failed: status?.errorResult !== undefined, ...(status?.errorResult?.reason ? { errorCode: status.errorResult.reason } : {}) };
    },

    async jobStatistics(input) {
      const [jobs] = await call('job.list', () => client.getJobs({
        projection: 'full', allUsers: true, minCreationTime: String(Date.parse(input.since)), maxCreationTime: String(Date.parse(input.until)),
        projectId: input.projectId,
      } as never));
      return jobs.map((job) => {
        const m = job.metadata as { configuration?: Record<string, unknown> & { labels?: Record<string, string> };
          statistics?: { creationTime?: string; endTime?: string; totalSlotMs?: string; query?: { totalBytesProcessed?: string; totalBytesBilled?: string } };
          status?: { state?: string; errorResult?: unknown } };
        const kind = (['query', 'load', 'extract', 'copy'] as const).find((k) => m.configuration?.[k] !== undefined) ?? 'query';
        return {
          jobId: job.id!, projectId: input.projectId, kind, labels: m.configuration?.labels ?? {},
          bytesProcessed: Number(m.statistics?.query?.totalBytesProcessed ?? 0), bytesBilled: Number(m.statistics?.query?.totalBytesBilled ?? 0),
          slotMs: Number(m.statistics?.totalSlotMs ?? 0),
          state: m.status?.state === 'DONE' ? 'done' as const : m.status?.state === 'RUNNING' ? 'running' as const : 'pending' as const,
          failed: m.status?.errorResult !== undefined,
          createdAt: new Date(Number(m.statistics?.creationTime ?? 0)).toISOString(),
          endedAt: m.statistics?.endTime === undefined ? null : new Date(Number(m.statistics.endTime)).toISOString(),
        };
      });
    },

    async storage(ref) {
      const [tables] = await call('table.list', () => datasetOf(ref).getTables());
      let logicalBytes = 0;
      let physicalBytes = 0;
      for (const table of tables) {
        const [metadata] = await call('table.get', () => table.getMetadata());
        const m = metadata as { numBytes?: string; numTotalPhysicalBytes?: string };
        logicalBytes += Number(m.numBytes ?? 0);
        physicalBytes += Number(m.numTotalPhysicalBytes ?? m.numBytes ?? 0);
      }
      return { logicalBytes, physicalBytes, tables: tables.length };
    },

    async close() {
      // The client holds no connections of its own to close.
    },
  };
}

/** Rows a load job wrote, from its statistics. */
function loadedRows(metadata: unknown, fallback: number): number {
  const rows = (metadata as { statistics?: { load?: { outputRows?: string } } } | undefined)?.statistics?.load?.outputRows;
  return rows === undefined ? fallback : Number(rows);
}

/** The member of a dataset access entry, in IAM form (`user:` or `serviceAccount:`). */
function entryMember(entry: Record<string, string>): string | undefined {
  if (entry['userByEmail'] !== undefined) {
    const email = entry['userByEmail'];
    return email.endsWith('.gserviceaccount.com') ? `serviceAccount:${email}` : `user:${email}`;
  }
  if (entry['groupByEmail'] !== undefined) return `group:${entry['groupByEmail']}`;
  return undefined;
}

function accessEntry(member: string, role: DatasetRole): Record<string, string> {
  const [kind, email] = member.split(':', 2) as [string, string];
  const field = kind === 'group' ? 'groupByEmail' : 'userByEmail';
  return { role: role === 'reader' ? 'READER' : 'WRITER', [field]: email };
}
