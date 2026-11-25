// bigquery-metering (spec 69.7, 69.19, 74.1): what each Silo held in Silo's BigQuery costs at
// the provider, measured per window and recorded as storage_measured through the outbox.
//
// - Bytes held: the dataset's logical bytes, now. Storage cost is that many GiB for the part
//   of the window the Silo existed, at the region's GiB-month rate (a month of 30 days).
// - Bytes scanned: bytes billed by the jobs created in the window. An Import or Object Index
//   Silo shares the cell's siloes project, so its jobs are the ones labelled with it; a
//   Warehouse has its own project, so every job there is its own, the customer's direct SQL
//   included (design: Access). Compute cost is those TiB at the region's on-demand rate.
// - Costs are exact decimals (micro-pounds), never floating point, and add up per line.
// - Prices come from the cell's configuration; this service does not start without them,
//   so a price nobody set is never billed as zero.
// Backfill, sync, reconciliation and refresh bytes are billed here, never as tokens (69.19).

import { storageMeasuredMessage } from '../../contracts/metering/usage.contract.ts';
import type { MeasurementView } from '../../contracts/bigquery-metering/metering.contract.ts';
import { labelValue, type BigQueryAdapter, type DatasetRef, type JobStatistic } from '../../infra/bigquery.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases, type Queryable } from '../../infra/postgres.infra.ts';
import type { Silo } from '../../models/siloes/index.model.ts';
import { storageMeasurementRepo } from '../../repos/billing/index.repo.ts';
import { outboxRepo } from '../../repos/platform/index.repo.ts';
import { siloRepo, warehouseProjectRepo } from '../../repos/siloes/index.repo.ts';
import { isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';

export interface MeteringDeps {
  databases: Databases;
  logger: Logger;
  bigQuery: BigQueryAdapter;
  /** The cell's siloes project: Import and Object Index datasets, and their jobs. */
  projectId: string;
  intervalSeconds: number;
  /** Pounds, as configured: per TiB billed, per GiB-month held. */
  pricePerTibScanned: string;
  pricePerGibMonthStored: string;
  now: () => number;
}

const MAX_WINDOWS = 31;
const GIB = 1n << 30n;
const TIB = 1n << 40n;
const MONTH_SECONDS = 30n * 86_400n;

/** Pounds as micro-pounds: '4.80' is 4_800_000n. */
export function micros(pounds: string): bigint {
  const [whole, fraction = ''] = pounds.split('.');
  return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0').slice(0, 6));
}

/** Micro-pounds as pounds with six decimals. */
export function pounds(value: bigint): string {
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, '0');
  return `${whole}.${fraction}`;
}

/** a / b, rounded half up, for non-negative integers. */
const divide = (a: bigint, b: bigint): bigint => (a + b / 2n) / b;

export const storageCost = (bytesHeld: bigint, seconds: bigint, perGibMonth: bigint): bigint =>
  divide(bytesHeld * perGibMonth * seconds, GIB * MONTH_SECONDS);

export const computeCost = (bytesBilled: bigint, perTib: bigint): bigint => divide(bytesBilled * perTib, TIB);

/** The completed windows after `from` (exclusive), oldest first, at most MAX_WINDOWS (the latest kept). */
export function windowsAfter(from: number, now: number, intervalMs: number): { start: number; end: number }[] {
  const lastEnd = Math.floor(now / intervalMs) * intervalMs;
  const firstEnd = (Math.floor(from / intervalMs) + 1) * intervalMs;
  const out: { start: number; end: number }[] = [];
  for (let end = Math.max(firstEnd, lastEnd - (MAX_WINDOWS - 1) * intervalMs); end <= lastEnd; end += intervalMs) {
    out.push({ start: end - intervalMs, end });
  }
  return out;
}

interface Target {
  silo: Silo;
  store: 'bigquery' | 'index';
  dataset: DatasetRef;
  /** The project whose jobs are read, and which of them are this Silo's. */
  jobProject: string;
  isMine: (job: JobStatistic) => boolean;
}

async function targetOf(deps: MeteringDeps, db: Queryable, silo: Silo): Promise<Target | undefined> {
  if (silo.kind === 'warehouse') {
    const project = await warehouseProjectRepo.findByOrganisationId(db, silo.organisationId);
    if (project === undefined || project.siloId !== silo.id || project.status === 'purged' || project.status === 'handed_over') return undefined;
    return {
      silo, store: 'bigquery', dataset: { projectId: project.gcpProjectId, dataset: project.dataset }, jobProject: project.gcpProjectId,
      isMine: () => true,
    };
  }
  const label = labelValue(silo.id);
  return {
    silo, store: silo.kind === 'object_index' ? 'index' : 'bigquery', dataset: { projectId: deps.projectId, dataset: silo.storeRef! },
    jobProject: deps.projectId, isMine: (job) => job.labels['silo_silo'] === label,
  };
}

async function bytesHeld(deps: MeteringDeps, ref: DatasetRef): Promise<bigint> {
  try {
    if (await deps.bigQuery.getDataset(ref) === undefined) return 0n;
    return BigInt((await deps.bigQuery.storage(ref)).logicalBytes);
  } catch (error) {
    if (isAppError(error) && error.category === 'not_found') return 0n;
    throw error;
  }
}

/** Measures every completed window of one Silo since its last measurement, recording each. */
/**
 * Any Silo store, measured in completed windows since its last measurement and recorded as
 * storage_measured (spec 67.6, 68.8, 69.7, 74.1). Capture (Postgres) and Import files use it
 * too, from their own services. bytesScanned answers per window.
 */
export interface StoreToMeasure {
  silo: Pick<Silo, 'id' | 'kind' | 'createdAt'>;
  store: 'postgres' | 'gcs' | 'bigquery' | 'index';
  pricePerGibMonth: string;
  pricePerTib: string;
  bytesHeld(): Promise<bigint>;
  bytesScanned(windows: { start: number; end: number }[]): Promise<bigint[]>;
}

export interface StoreMeteringDeps {
  databases: Databases;
  intervalSeconds: number;
  now: () => number;
}

export async function measureStore(deps: StoreMeteringDeps, organisationId: string, target: StoreToMeasure, correlationId: string): Promise<MeasurementView[]> {
  const pool = deps.databases.pool('control');
  const scope = { organisationId };
  const intervalMs = deps.intervalSeconds * 1_000;
  const latest = await inTransaction(pool, scope, (db) => storageMeasurementRepo.latestFor(db, target.silo.id, target.store), { readOnly: true });
  const createdAt = Date.parse(target.silo.createdAt);
  const windows = windowsAfter(latest === undefined ? createdAt : Date.parse(latest.measuredAt), deps.now(), intervalMs);
  if (windows.length === 0) return [];
  const held = await target.bytesHeld();
  const scannedPerWindow = await target.bytesScanned(windows);
  const perTib = micros(target.pricePerTib);
  const perGibMonth = micros(target.pricePerGibMonth);

  const out: MeasurementView[] = [];
  for (const [i, w] of windows.entries()) {
    const from = Math.max(w.start, createdAt);
    const seconds = BigInt(Math.max(0, Math.floor((w.end - from) / 1_000)));
    const scanned = scannedPerWindow[i] ?? 0n;
    const storage = storageCost(held, seconds, perGibMonth);
    const compute = computeCost(scanned, perTib);
    const measuredAt = new Date(w.end).toISOString();
    const view: MeasurementView = {
      measurementId: uuidv7(), siloId: target.silo.id, kind: target.silo.kind, store: target.store,
      windowStart: new Date(w.start).toISOString(), measuredAt, bytesHeld: held.toString(), bytesScanned: scanned.toString(),
      costStorage: pounds(storage), costCompute: pounds(compute), providerCost: pounds(storage + compute),
    };
    const payload = storageMeasuredMessage.schema.parse({
      organisationId, measurementId: view.measurementId, siloId: view.siloId, store: view.store, bytesHeld: view.bytesHeld,
      bytesScanned: view.bytesScanned, bytesEgressed: '0', providerCost: view.providerCost, costStorage: view.costStorage,
      costCompute: view.costCompute, costEgress: '0.000000',
      // The window belongs to the month it started in.
      period: view.windowStart.slice(0, 7), measuredAt,
    });
    await inTransaction(pool, scope, (db) => outboxRepo.insert(db, {
      id: uuidv7(), organisationId, topic: storageMeasuredMessage.topic, orderingKey: organisationId, event: storageMeasuredMessage.name,
      schemaVersion: storageMeasuredMessage.version, payload, correlationId,
    }));
    out.push(view);
  }
  return out;
}

/** A BigQuery Silo: bytes from its dataset, scans from its own jobs. */
async function measureSilo(deps: MeteringDeps, organisationId: string, target: Target, correlationId: string): Promise<MeasurementView[]> {
  return measureStore(deps, organisationId, {
    silo: target.silo, store: target.store, pricePerGibMonth: deps.pricePerGibMonthStored, pricePerTib: deps.pricePerTibScanned,
    bytesHeld: () => bytesHeld(deps, target.dataset),
    async bytesScanned(windows) {
      const jobs = (await deps.bigQuery.jobStatistics({
        projectId: target.jobProject, since: new Date(windows[0]!.start).toISOString(), until: new Date(windows.at(-1)!.end).toISOString(),
      })).filter((j) => j.state === 'done' && target.isMine(j));
      return windows.map((w) => jobs.filter((j) => {
        const at = Date.parse(j.createdAt);
        return at >= w.start && at < w.end;
      }).reduce((sum, j) => sum + BigInt(j.bytesBilled), 0n));
    },
  }, correlationId);
}

/** One organisation's BigQuery Siloes, each measured; a Silo that cannot be measured is logged and left for the next pass. */
export async function measureOrganisation(deps: MeteringDeps, organisationId: string, correlationId: string): Promise<MeasurementView[]> {
  const pool = deps.databases.pool('control');
  const targets = await inTransaction(pool, { organisationId }, async (db) => {
    const out: Target[] = [];
    for (const silo of await siloRepo.listInBigQuery(db)) {
      const target = await targetOf(deps, db, silo);
      if (target !== undefined) out.push(target);
    }
    return out;
  }, { readOnly: true });
  const measured: MeasurementView[] = [];
  for (const target of targets) {
    try {
      measured.push(...await measureSilo(deps, organisationId, target, correlationId));
    } catch (error) {
      deps.logger.failure('a Silo could not be measured; the next pass measures its windows', error, {
        event: 'bigquery_metering.silo_failed', organisationId,
      });
    }
  }
  return measured;
}

/** The scheduled pass, across the cell. */
export async function measureAll(deps: MeteringDeps, correlationId: string): Promise<number> {
  const organisations = await inTransaction(deps.databases.pool('control'), {}, (db) => siloRepo.organisationsInBigQuery(db, 10_000), { readOnly: true });
  let count = 0;
  for (const organisationId of organisations) count += (await measureOrganisation(deps, organisationId, correlationId)).length;
  return count;
}
