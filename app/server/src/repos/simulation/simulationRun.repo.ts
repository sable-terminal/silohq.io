// Data access for simulation.simulation_runs, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  simulationRunTable,
  type NewSimulationRun,
  type SimulationRun,
  type SimulationRunChanges,
} from '../../models/simulation/simulationRun.model.ts';

export const simulationRunRepo = {
  insert(db: Queryable, row: NewSimulationRun): Promise<SimulationRun> {
    return insertRow(db, simulationRunTable, row);
  },

  findById(db: Queryable, id: SimulationRun['id']): Promise<SimulationRun | undefined> {
    return findRow(db, simulationRunTable, { id });
  },

  update(
    db: Queryable,
    id: SimulationRun['id'],
    changes: SimulationRunChanges,
  ): Promise<SimulationRun | undefined> {
    return updateRow(db, simulationRunTable, { id }, changes);
  },

  /** Completed or running runs of a scenario before this one: a later run is a re-run (spec 39.9). */
  async countEarlier(db: Queryable, scenarioId: string, runId: string): Promise<number> {
    const { rows } = await db.query(
      `select count(*)::int as n from simulation.simulation_runs where scenario_id = $1 and id <> $2 and status <> 'failed'`, [scenarioId, runId]);
    return (rows[0] as { n: number }).n;
  },

  /** A scenario's own runs (not a branch's), newest first. */
  async listForScenario(db: Queryable, scenarioId: string, limit: number): Promise<SimulationRun[]> {
    const { rows } = await db.query(
      `select ${simulationRunTable.select} from simulation.simulation_runs
        where scenario_id = $1 and branch_id is null order by started_at desc, id desc limit $2`, [scenarioId, limit]);
    return rows as SimulationRun[];
  },

  /** A branch's latest completed run. */
  async latestForBranch(db: Queryable, branchId: string): Promise<SimulationRun | undefined> {
    const { rows } = await db.query(
      `select ${simulationRunTable.select} from simulation.simulation_runs where branch_id = $1 and status = 'completed' order by started_at desc, id desc limit 1`, [branchId]);
    return rows[0] as SimulationRun | undefined;
  },

  /** A scenario's latest completed run of its own (not a branch's). */
  async latestForScenario(db: Queryable, scenarioId: string): Promise<SimulationRun | undefined> {
    const { rows } = await db.query(
      `select ${simulationRunTable.select} from simulation.simulation_runs
        where scenario_id = $1 and branch_id is null and status = 'completed' order by started_at desc, id desc limit 1`, [scenarioId]);
    return rows[0] as SimulationRun | undefined;
  },
};
