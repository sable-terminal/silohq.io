import type { Executor } from '../infra/db.infra';
import type { SimulationMode } from './scenario.repo';
import type { EdgeSource } from './dependencyEdge.repo';

/** Simulation §8 — a run, and the records it named. */

export interface SimulationRun {
  id: string;
  scenarioId: string;
  runBy: string;
  mode: SimulationMode;
  iterations: number;
  graphVersion: string;
  startedAt: Date;
  completedAt: Date | null;
  boundedAtHop: number | null;
}

type RunRow = {
  id: string;
  scenario_id: string;
  run_by: string;
  mode: SimulationMode;
  iterations: number;
  graph_version: string;
  started_at: Date;
  completed_at: Date | null;
  bounded_at_hop: number | null;
};

const RUN_COLUMNS = `id, scenario_id, run_by, mode, iterations, graph_version,
                     started_at, completed_at, bounded_at_hop`;

const mapRun = (row: RunRow): SimulationRun => ({
  id: row.id,
  scenarioId: row.scenario_id,
  runBy: row.run_by,
  mode: row.mode,
  iterations: row.iterations,
  graphVersion: row.graph_version,
  startedAt: row.started_at,
  completedAt: row.completed_at,
  boundedAtHop: row.bounded_at_hop,
});

export async function start(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    scenarioId: string;
    runBy: string;
    mode: SimulationMode;
    iterations: number;
    graphVersion: string;
    spentFromPeriod: Date;
  },
): Promise<SimulationRun> {
  const { rows } = await db.query<RunRow>(
    `INSERT INTO simulation_runs
       (id, organisation_id, scenario_id, run_by, mode, iterations, graph_version, spent_from_period)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${RUN_COLUMNS}`,
    [
      input.id,
      input.organisationId,
      input.scenarioId,
      input.runBy,
      input.mode,
      input.iterations,
      input.graphVersion,
      input.spentFromPeriod,
    ],
  );
  return mapRun(rows[0]!);
}

/**
 * §3.1 — "Fan-out that exceeds the bound stops and names the hop rather than
 * truncating." A run that never completes is a run that failed; one that
 * completes with a hop named is a run that stopped honestly, and the two must
 * be distinguishable afterwards.
 */
export async function complete(
  db: Executor,
  input: { id: string; boundedAtHop: number | null },
): Promise<void> {
  await db.query(
    `UPDATE simulation_runs SET completed_at = now(), bounded_at_hop = $2 WHERE id = $1`,
    [input.id, input.boundedAtHop],
  );
}

export async function read(db: Executor, id: string): Promise<SimulationRun | null> {
  const { rows } = await db.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM simulation_runs WHERE id = $1`, [id]);
  return rows[0] ? mapRun(rows[0]) : null;
}

export async function forScenario(db: Executor, scenarioId: string): Promise<SimulationRun[]> {
  const { rows } = await db.query<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM simulation_runs WHERE scenario_id = $1 ORDER BY started_at DESC`,
    [scenarioId],
  );
  return rows.map(mapRun);
}

export interface SimulationResult {
  id: string;
  affectedConceptId: string;
  entityRef: string;
  path: Array<{ edgeId: string; fromConceptId: string; toConceptId: string }>;
  hops: number;
  delayHours: number;
  probability: number | null;
  edgeSources: EdgeSource[];
  /* §3.2 — a path through only hard edges, or one with a soft edge on it. */
  severity: 'failed' | 'degraded';
  /* §3.2 — the stated cost of every soft edge on the path, in order. Never
     summed: a total would need units nobody agreed. */
  degradedCosts: string[];
  /* §4.3 — "median delay, and the spread". Null in deterministic mode, where
     the delay is computed once and has no spread. */
  delayP10Hours: number | null;
  delayP90Hours: number | null;
  /* §4.1 — "that path is computed deterministically and the result says so per
     path, not per simulation". */
  estimated: boolean;
  /* §2.1 — how many records draw on the resource this one was reached through,
     and how long they take to clear between them. Null where the last hop was
     not a resource edge. No position: nothing in the graph says who is first. */
  contendingRecords: number | null;
  clearanceHours: number | null;
}

type ResultRow = {
  id: string;
  affected_concept_id: string;
  entity_ref: string;
  path: SimulationResult['path'];
  hops: number;
  delay_hours: string;
  probability: string | null;
  edge_sources: EdgeSource[];
  severity: 'failed' | 'degraded';
  degraded_costs: string[];
  delay_p10_hours: string | null;
  delay_p90_hours: string | null;
  estimated: boolean;
  contending_records: number | null;
  clearance_hours: string | null;
};

/**
 * One statement per record reached.
 *
 * WRITTEN IN ONE STATEMENT rather than a loop, because a run that reaches four
 * hundred records would otherwise be four hundred round trips inside a
 * transaction that is already holding a pooled client.
 */
export async function recordResults(
  db: Executor,
  input: {
    organisationId: string;
    runId: string;
    expiresAt: Date;
    results: ReadonlyArray<{
      id: string;
      affectedConceptId: string;
      entityRef: string;
      path: SimulationResult['path'];
      hops: number;
      delayHours: number;
      probability: number | null;
      edgeSources: readonly EdgeSource[];
      severity: 'failed' | 'degraded';
      degradedCosts: readonly string[];
      delayP10Hours: number | null;
      delayP90Hours: number | null;
      estimated: boolean;
      contendingRecords: number | null;
      clearanceHours: number | null;
    }>;
  },
): Promise<void> {
  if (input.results.length === 0) return;

  /*
   * `edge_sources` TRAVELS AS JSONB AND ARRIVES AS `text[]`. A parameter of
   * arrays-of-strings would be a two-dimensional `text[][]`, and `unnest`
   * flattens those into one long list of words rather than giving each row its
   * own array — which Postgres refuses outright rather than silently
   * mis-assigning, and is the only reason this is not simply `$10::text[][]`.
   */
  await db.query(
    `INSERT INTO simulation_results
       (id, organisation_id, run_id, affected_concept_id, entity_ref, path, hops,
        delay_hours, probability, edge_sources, severity, degraded_costs,
        delay_p10_hours, delay_p90_hours, estimated,
        contending_records, clearance_hours, expires_at)
     SELECT r.id, r.organisation_id, r.run_id, r.affected_concept_id, r.entity_ref,
            r.path, r.hops, r.delay_hours, r.probability,
            ARRAY(SELECT jsonb_array_elements_text(r.edge_sources)),
            r.severity,
            ARRAY(SELECT jsonb_array_elements_text(r.degraded_costs)),
            r.delay_p10_hours, r.delay_p90_hours, r.estimated,
            r.contending_records, r.clearance_hours, r.expires_at
       FROM unnest(
         $1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::text[], $6::jsonb[],
         $7::integer[], $8::numeric[], $9::numeric[], $10::jsonb[], $11::text[],
         $12::jsonb[], $13::numeric[], $14::numeric[], $15::boolean[],
         $16::integer[], $17::numeric[], $18::timestamptz[]
       ) AS r(id, organisation_id, run_id, affected_concept_id, entity_ref, path,
              hops, delay_hours, probability, edge_sources, severity,
              degraded_costs, delay_p10_hours, delay_p90_hours, estimated,
              contending_records, clearance_hours, expires_at)`,
    [
      input.results.map((one) => one.id),
      input.results.map(() => input.organisationId),
      input.results.map(() => input.runId),
      input.results.map((one) => one.affectedConceptId),
      input.results.map((one) => one.entityRef),
      input.results.map((one) => JSON.stringify(one.path)),
      input.results.map((one) => one.hops),
      input.results.map((one) => one.delayHours),
      input.results.map((one) => one.probability),
      input.results.map((one) => JSON.stringify(one.edgeSources)),
      input.results.map((one) => one.severity),
      input.results.map((one) => JSON.stringify(one.degradedCosts)),
      input.results.map((one) => one.delayP10Hours),
      input.results.map((one) => one.delayP90Hours),
      input.results.map((one) => one.estimated),
      input.results.map((one) => one.contendingRecords),
      input.results.map((one) => one.clearanceHours),
      input.results.map(() => input.expiresAt),
    ],
  );
}

export async function resultsFor(db: Executor, runId: string): Promise<SimulationResult[]> {
  const { rows } = await db.query<ResultRow>(
    `SELECT id, affected_concept_id, entity_ref, path, hops, delay_hours, probability,
            edge_sources, severity, degraded_costs, delay_p10_hours, delay_p90_hours,
            estimated, contending_records, clearance_hours
       FROM simulation_results
      WHERE run_id = $1
      /* §3.2 — the failures first. A reader scanning the top of a list should
         find what does not happen before what happens at a cost, and
         alphabetical order would put 'degraded' there instead. */
      ORDER BY (severity = 'degraded'), hops, delay_hours, entity_ref`,
    [runId],
  );
  return rows.map((row) => ({
    id: row.id,
    affectedConceptId: row.affected_concept_id,
    entityRef: row.entity_ref,
    path: row.path,
    hops: row.hops,
    delayHours: Number(row.delay_hours),
    probability: row.probability === null ? null : Number(row.probability),
    edgeSources: row.edge_sources,
    severity: row.severity,
    degradedCosts: row.degraded_costs,
    delayP10Hours: row.delay_p10_hours === null ? null : Number(row.delay_p10_hours),
    delayP90Hours: row.delay_p90_hours === null ? null : Number(row.delay_p90_hours),
    estimated: row.estimated,
    contendingRecords: row.contending_records,
    clearanceHours: row.clearance_hours === null ? null : Number(row.clearance_hours),
  }));
}

/** Retention: §5's answers have a shelf life, and the schema caps it at thirty days. */
export async function sweepExpired(db: Executor, now: Date): Promise<number> {
  const { rowCount } = await db.query(`DELETE FROM simulation_results WHERE expires_at <= $1`, [now]);
  return rowCount ?? 0;
}
