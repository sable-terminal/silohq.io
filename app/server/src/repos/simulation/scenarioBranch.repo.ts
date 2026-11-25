// Data access for simulation.scenario_branches, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  scenarioBranchTable,
  type NewScenarioBranch,
  type ScenarioBranch,
  type ScenarioBranchChanges,
} from '../../models/simulation/scenarioBranch.model.ts';

export const scenarioBranchRepo = {
  insert(db: Queryable, row: NewScenarioBranch): Promise<ScenarioBranch> {
    return insertRow(db, scenarioBranchTable, row);
  },

  findById(db: Queryable, id: ScenarioBranch['id']): Promise<ScenarioBranch | undefined> {
    return findRow(db, scenarioBranchTable, { id });
  },

  findByScenarioIdAndName(
    db: Queryable,
    key: Pick<ScenarioBranch, 'organisationId' | 'scenarioId' | 'name'>,
  ): Promise<ScenarioBranch | undefined> {
    return findRow(db, scenarioBranchTable, key);
  },

  update(
    db: Queryable,
    id: ScenarioBranch['id'],
    changes: ScenarioBranchChanges,
  ): Promise<ScenarioBranch | undefined> {
    return updateRow(db, scenarioBranchTable, { id }, changes);
  },

  listForScenario(db: Queryable, scenarioId: string): Promise<ScenarioBranch[]> {
    return db.query(`select ${scenarioBranchTable.select} from simulation.scenario_branches where scenario_id = $1 order by created_at, id`, [scenarioId])
      .then((r) => r.rows as ScenarioBranch[]);
  },

  /** Closes the branch at this version: its bases purge at closed_at + retention, as the table requires. */
  async close(db: Queryable, id: string, version: number): Promise<ScenarioBranch | undefined> {
    const { rows } = await db.query(
      `update simulation.scenario_branches set status = 'closed', closed_at = now(), bases_purge_at = now() + retention, version = version + 1
        where id = $1 and version = $2 and status <> 'closed' returning ${scenarioBranchTable.select}`, [id, version]);
    return rows[0] as ScenarioBranch | undefined;
  },
};
