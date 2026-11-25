import type { Executor } from '../infra/db.infra';
import type { Rates } from '../models/storagePricing.model';

/**
 * What a Silo held and scanned in a period, and what the provider charged.
 *
 * SQL, AND THE MAPPING BETWEEN A ROW AND A MODEL. The rates and the margin are
 * `storagePricing.model`; what to measure is the service's.
 */

export interface Measurement {
  siloId: string;
  periodStart: Date;
  bytesHeld: number;
  bytesScanned: number;
  scannedCumulative: number;
  providerCostPence: number;
  rates: Rates;
  residency: string;
  measuredAt: Date;
}

type Row = {
  silo_id: string;
  period_start: Date;
  bytes_held: string;
  bytes_scanned: string;
  scanned_cumulative: string;
  provider_cost_pence: number;
  rates: Rates;
  residency: string;
  measured_at: Date;
};

const map = (row: Row): Measurement => ({
  siloId: row.silo_id,
  periodStart: row.period_start,
  bytesHeld: Number(row.bytes_held),
  bytesScanned: Number(row.bytes_scanned),
  scannedCumulative: Number(row.scanned_cumulative),
  providerCostPence: row.provider_cost_pence,
  rates: row.rates,
  residency: row.residency,
  measuredAt: row.measured_at,
});

const COLUMNS = `silo_id, period_start, bytes_held, bytes_scanned, scanned_cumulative,
                 provider_cost_pence, rates, residency, measured_at`;

/**
 * Take this period's reading, replacing the one taken earlier in the same month.
 *
 * STORAGE IS A LEVEL, NOT AN EVENT. Two readings in a month are one figure
 * measured twice, and the later one is the truer.
 */
export async function record(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    siloId: string;
    periodStart: Date;
    bytesHeld: number;
    bytesScanned: number;
    scannedCumulative: number;
    providerCostPence: number;
    rates: Rates;
    residency: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO storage_measurements
       (id, organisation_id, silo_id, period_start, bytes_held, bytes_scanned, scanned_cumulative,
        provider_cost_pence, rates, residency)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (silo_id, period_start) DO UPDATE
        SET bytes_held          = EXCLUDED.bytes_held,
            /* The month's scanning, not this reading's: added to what was already counted. */
            bytes_scanned       = storage_measurements.bytes_scanned + EXCLUDED.bytes_scanned,
            scanned_cumulative  = EXCLUDED.scanned_cumulative,
            provider_cost_pence = EXCLUDED.provider_cost_pence,
            rates               = EXCLUDED.rates,
            residency           = EXCLUDED.residency,
            measured_at         = now()`,
    [
      input.id,
      input.organisationId,
      input.siloId,
      input.periodStart,
      input.bytesHeld,
      input.bytesScanned,
      input.scannedCumulative,
      input.providerCostPence,
      JSON.stringify(input.rates),
      input.residency,
    ],
  );
}

/** The last reading before this period, for the running total a difference is taken from. */
export async function latestBefore(
  db: Executor,
  input: { siloId: string; period: Date },
): Promise<Measurement | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM storage_measurements
      WHERE silo_id = $1 AND period_start <= $2
      ORDER BY period_start DESC, measured_at DESC
      LIMIT 1`,
    [input.siloId, input.period],
  );
  return rows[0] ? map(rows[0]) : null;
}

export async function since(
  db: Executor,
  input: { organisationId: string; from: Date },
): Promise<Measurement[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM storage_measurements
      WHERE organisation_id = $1 AND period_start >= $2
      ORDER BY period_start DESC, silo_id`,
    [input.organisationId, input.from],
  );
  return rows.map(map);
}

/**
 * Every organisation with a Silo. Cross-tenant: the scheduled measurement's.
 *
 * A DISABLED SILO IS STILL MEASURED. Disabling happens as part of a purge, so
 * its reading is close to nothing — but it is the reading that says the month
 * ended smaller, and skipping it would leave the last month billed as though
 * the data were never deleted.
 */
export async function organisationsWithSiloes(db: Executor): Promise<string[]> {
  const { rows } = await db.query<{ organisation_id: string }>(
    `SELECT DISTINCT organisation_id FROM siloes ORDER BY organisation_id`,
  );
  return rows.map((row) => row.organisation_id);
}
