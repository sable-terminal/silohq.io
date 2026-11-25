// Data access for simulation.scenarios, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  scenarioTable,
  type NewScenario,
  type Scenario,
  type ScenarioChanges,
} from '../../models/simulation/scenario.model.ts';

export const scenarioRepo = {
  insert(db: Queryable, row: NewScenario): Promise<Scenario> {
    return insertRow(db, scenarioTable, row);
  },

  findById(db: Queryable, id: Scenario['id']): Promise<Scenario | undefined> {
    return findRow(db, scenarioTable, { id });
  },

  update(db: Queryable, id: Scenario['id'], changes: ScenarioChanges): Promise<Scenario | undefined> {
    return updateRow(db, scenarioTable, { id }, changes);
  },

  /**
   * What touches an object (34.2): staged Actions targeting it, and the latest completed run
   * of each scenario or branch reaching it. Identifiers and figures only.
   */
  async touchingObject(db: Queryable, f: { objectTypeId: string; objectId: string }): Promise<{
    staged: { scenarioId: string; branchId: string; branchName: string; branchStatus: string; stagedActionId: string; actionTypeId: string; staleness: string }[];
    reached: { scenarioId: string; branchId: string | null; runId: string; completedAt: string; capacityShortfall: string | null; delaySeconds: number | null;
      unavailableSeconds: number | null; probability: string | null }[];
  }> {
    // A staged Action's manifest names its targets by Silo object id.
    const { rows: staged } = await db.query(
      `select b.scenario_id as "scenarioId", b.id as "branchId", b.name as "branchName", b.status as "branchStatus",
              sa.id as "stagedActionId", sa.action_type_id as "actionTypeId", sa.staleness
         from simulation.staged_actions sa
         join simulation.scenario_branches b on b.organisation_id = sa.organisation_id and b.id = sa.branch_id
        where sa.manifest ->> 'objectTypeId' = $1::text
          and sa.manifest -> 'targets' @> jsonb_build_array(jsonb_build_object('objectId', $2::text))
        order by b.name, b.id, sa.sequence`, [f.objectTypeId, f.objectId]);
    const { rows: reached } = await db.query(
      `select r.scenario_id as "scenarioId", r.branch_id as "branchId", r.id as "runId", r.completed_at as "completedAt",
              res.capacity_shortfall as "capacityShortfall", extract(epoch from res.accumulated_delay)::float8 as "delaySeconds",
              extract(epoch from res.unavailable_for)::float8 as "unavailableSeconds", res.probability
         from simulation.simulation_results res
         join simulation.simulation_runs r on r.organisation_id = res.organisation_id and r.id = res.run_id
        where res.result_kind = 'reached' and res.affected_object_type_id = $1 and res.affected_object_key = $2 and r.status = 'completed'
          and not exists (select 1 from simulation.simulation_runs later
                           where later.organisation_id = r.organisation_id and later.scenario_id = r.scenario_id
                             and later.branch_id is not distinct from r.branch_id and later.status = 'completed'
                             and later.completed_at > r.completed_at)
        order by r.completed_at desc, r.id`, [f.objectTypeId, f.objectId]);
    return {
      staged: staged as never,
      reached: (reached as { completedAt: Date | string }[]).map((x) => ({ ...x, completedAt: new Date(x.completedAt).toISOString() })) as never,
    };
  },

  async listForOwner(db: Queryable, ownerMembershipId: string): Promise<Scenario[]> {
    const { rows } = await db.query(
      `select ${scenarioTable.select} from simulation.scenarios where owner_membership_id = $1 and archived_at is null
        order by created_at desc, id`, [ownerMembershipId]);
    return rows as Scenario[];
  },
};
