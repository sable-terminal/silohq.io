import type { Executor } from '../infra/db.infra';

/**
 * Simulation §8 — `edge_observations`: "edge, sample count, distribution
 * parameters, observed from, observed to, computed at. Counts and statistics,
 * never values."
 */

export interface EdgeObservation {
  edgeId: string;
  sampleCount: number;
  meanHours: number;
  medianHours: number;
  p90Hours: number;
  minHours: number;
  maxHours: number;
  stdDevHours: number;
  /* §4.1 — the minimum, nine deciles and the maximum, ascending. Empty where
     nothing has been measured; a probabilistic run refuses to sample it. */
  quantiles: number[];
  observedFrom: Date;
  observedTo: Date;
  computedAt: Date;
}

type Row = {
  edge_id: string;
  sample_count: number;
  mean_hours: string;
  median_hours: string;
  p90_hours: string;
  min_hours: string;
  max_hours: string;
  stddev_hours: string;
  quantiles: string[];
  observed_from: Date;
  observed_to: Date;
  computed_at: Date;
};

const COLUMNS = `edge_id, sample_count, mean_hours, median_hours, p90_hours,
                 min_hours, max_hours, stddev_hours, quantiles,
                 observed_from, observed_to, computed_at`;

const map = (row: Row): EdgeObservation => ({
  edgeId: row.edge_id,
  sampleCount: row.sample_count,
  meanHours: Number(row.mean_hours),
  medianHours: Number(row.median_hours),
  p90Hours: Number(row.p90_hours),
  minHours: Number(row.min_hours),
  maxHours: Number(row.max_hours),
  stdDevHours: Number(row.stddev_hours),
  quantiles: row.quantiles.map(Number),
  observedFrom: row.observed_from,
  observedTo: row.observed_to,
  computedAt: row.computed_at,
});

/**
 * The same measurement, taken again.
 *
 * AN UPSERT RATHER THAN A NEW ROW. A revision to an edge is a decision and is
 * kept forever; a recomputed distribution is the same thing measured over a
 * window that has moved, and keeping every one would grow the table with the
 * sweep rather than with the operation.
 */
export async function record(
  db: Executor,
  input: {
    edgeId: string;
    organisationId: string;
    sampleCount: number;
    meanHours: number;
    medianHours: number;
    p90Hours: number;
    minHours: number;
    maxHours: number;
    stdDevHours: number;
    quantiles: readonly number[];
    observedFrom: Date;
    observedTo: Date;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO edge_observations
       (edge_id, organisation_id, sample_count, mean_hours, median_hours, p90_hours,
        min_hours, max_hours, stddev_hours, quantiles, observed_from, observed_to)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (edge_id) DO UPDATE SET
       sample_count = EXCLUDED.sample_count,
       mean_hours = EXCLUDED.mean_hours,
       median_hours = EXCLUDED.median_hours,
       p90_hours = EXCLUDED.p90_hours,
       min_hours = EXCLUDED.min_hours,
       max_hours = EXCLUDED.max_hours,
       stddev_hours = EXCLUDED.stddev_hours,
       quantiles = EXCLUDED.quantiles,
       observed_from = EXCLUDED.observed_from,
       observed_to = EXCLUDED.observed_to,
       computed_at = now()`,
    [
      input.edgeId,
      input.organisationId,
      input.sampleCount,
      input.meanHours,
      input.medianHours,
      input.p90Hours,
      input.minHours,
      input.maxHours,
      input.stdDevHours,
      input.quantiles,
      input.observedFrom,
      input.observedTo,
    ],
  );
}

export async function forEdge(db: Executor, edgeId: string): Promise<EdgeObservation | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM edge_observations WHERE edge_id = $1`,
    [edgeId],
  );
  return rows[0] ? map(rows[0]) : null;
}

/** Every edge that has one, for the graph screen and for §4's mode check. */
export async function all(db: Executor): Promise<EdgeObservation[]> {
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM edge_observations`);
  return rows.map(map);
}
