// Data access for simulation.simulation_results, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  simulationResultTable,
  type NewSimulationResult,
  type SimulationResult,
} from '../../models/simulation/simulationResult.model.ts';

export const simulationResultRepo = {
  insert(db: Queryable, row: NewSimulationResult): Promise<SimulationResult> {
    return insertRow(db, simulationResultTable, row);
  },

  findById(db: Queryable, id: SimulationResult['id']): Promise<SimulationResult | undefined> {
    return findRow(db, simulationResultTable, { id });
  },

  /** A run's results, with the delay in seconds (an interval is not a JavaScript type). */
  async listForRun(db: Queryable, runId: string): Promise<(SimulationResult & { delaySeconds: number | null; unavailableSeconds: number | null })[]> {
    const { rows } = await db.query(
      `select ${simulationResultTable.select}, extract(epoch from accumulated_delay)::float8 as "delaySeconds",
              extract(epoch from unavailable_for)::float8 as "unavailableSeconds"
         from simulation.simulation_results where run_id = $1 order by result_kind, created_at, id`, [runId]);
    return rows as (SimulationResult & { delaySeconds: number | null; unavailableSeconds: number | null })[];
  },
};
