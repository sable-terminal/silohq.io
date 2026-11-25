// Data access for billing.storage_measurements, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  storageMeasurementTable,
  type NewStorageMeasurement,
  type StorageMeasurement,
} from '../../models/billing/storageMeasurement.model.ts';

export const storageMeasurementRepo = {
  insert(db: Queryable, row: NewStorageMeasurement): Promise<StorageMeasurement> {
    return insertRow(db, storageMeasurementTable, row);
  },

  findById(db: Queryable, id: StorageMeasurement['id']): Promise<StorageMeasurement | undefined> {
    return findRow(db, storageMeasurementTable, { id });
  },

  findBySiloIdAndStoreAndMeasuredAt(
    db: Queryable,
    key: Pick<StorageMeasurement, 'organisationId' | 'siloId' | 'store' | 'measuredAt'>,
  ): Promise<StorageMeasurement | undefined> {
    return findRow(db, storageMeasurementTable, key);
  },

  // Records a measurement once: a redelivered message for the same Silo, store and moment
  // finds the row there (the point key) and returns undefined.
  async insertIfAbsent(db: Queryable, row: NewStorageMeasurement): Promise<StorageMeasurement | undefined> {
    const { rows } = await db.query(
      `insert into billing.storage_measurements (id, organisation_id, silo_id, store, bytes_held, bytes_scanned, bytes_egressed,
                                                 provider_cost, cost_storage, cost_compute, cost_egress, period, measured_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       on conflict (organisation_id, silo_id, store, measured_at) do nothing
       returning ${storageMeasurementTable.select}`,
      [row.id, row.organisationId, row.siloId, row.store, row.bytesHeld, row.bytesScanned ?? '0', row.bytesEgressed ?? '0',
        row.providerCost, row.costStorage ?? '0', row.costCompute ?? '0', row.costEgress ?? '0', row.period, row.measuredAt]);
    return rows[0] as StorageMeasurement | undefined;
  },

  /** The latest measurement of a Silo's store: where the next measurement starts. */
  async latestFor(db: Queryable, siloId: string, store: StorageMeasurement['store']): Promise<StorageMeasurement | undefined> {
    const { rows } = await db.query(
      `select ${storageMeasurementTable.select} from billing.storage_measurements
       where silo_id = $1 and store = $2 order by measured_at desc limit 1`, [siloId, store]);
    return rows[0] as StorageMeasurement | undefined;
  },

  /**
   * A month's measurements summed per Silo and store (spec 74.1): the mean bytes held, the
   * bytes scanned and egressed, and the provider cost of each component.
   */
  async periodTotals(db: Queryable, period: string): Promise<{
    siloId: string; store: StorageMeasurement['store']; meanBytesHeld: bigint; bytesScanned: bigint; bytesEgressed: bigint;
    costStorage: string; costCompute: string; costEgress: string;
  }[]> {
    const { rows } = await db.query(
      `select silo_id, store, round(avg(bytes_held))::bigint::text as mean_held, sum(bytes_scanned)::text as scanned,
              sum(bytes_egressed)::text as egressed, sum(cost_storage)::numeric(14,6)::text as storage,
              sum(cost_compute)::numeric(14,6)::text as compute, sum(cost_egress)::numeric(14,6)::text as egress
       from billing.storage_measurements where period = $1 group by silo_id, store order by silo_id, store`, [period]);
    return (rows as Record<string, string>[]).map((r) => ({
      siloId: r['silo_id']!, store: r['store'] as StorageMeasurement['store'], meanBytesHeld: BigInt(r['mean_held']!), bytesScanned: BigInt(r['scanned']!),
      bytesEgressed: BigInt(r['egressed']!), costStorage: r['storage']!, costCompute: r['compute']!, costEgress: r['egress']!,
    }));
  },

  /** A Silo's latest measurement of each store. */
  async latestPerStore(db: Queryable, siloId: string): Promise<StorageMeasurement[]> {
    const { rows } = await db.query(
      `select distinct on (store) ${storageMeasurementTable.select} from billing.storage_measurements
       where silo_id = $1 order by store, measured_at desc`, [siloId]);
    return rows as StorageMeasurement[];
  },
};
