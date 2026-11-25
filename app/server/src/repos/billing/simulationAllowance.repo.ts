// Data access for billing.simulation_allowances, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  simulationAllowanceTable,
  type NewSimulationAllowance,
  type SimulationAllowance,
  type SimulationAllowanceChanges,
} from '../../models/billing/simulationAllowance.model.ts';

export const simulationAllowanceRepo = {
  insert(db: Queryable, row: NewSimulationAllowance): Promise<SimulationAllowance> {
    return insertRow(db, simulationAllowanceTable, row);
  },

  findById(db: Queryable, id: SimulationAllowance['id']): Promise<SimulationAllowance | undefined> {
    return findRow(db, simulationAllowanceTable, { id });
  },

  findByMembershipIdAndPeriodStart(
    db: Queryable,
    key: Pick<SimulationAllowance, 'organisationId' | 'membershipId' | 'periodStart'>,
  ): Promise<SimulationAllowance | undefined> {
    return findRow(db, simulationAllowanceTable, key);
  },

  update(
    db: Queryable,
    id: SimulationAllowance['id'],
    changes: SimulationAllowanceChanges,
  ): Promise<SimulationAllowance | undefined> {
    return updateRow(db, simulationAllowanceTable, { id }, changes);
  },

  // The membership's simulation allowance for the period in force, locked for a charge.
  async lockCurrent(db: Queryable, membershipId: string): Promise<SimulationAllowance | undefined> {
    const { rows } = await db.query(
      `select ${simulationAllowanceTable.select} from ${simulationAllowanceTable.sql}
       where membership_id = $1 and period_start <= now() and period_end > now() for update`, [membershipId]);
    return rows[0] as SimulationAllowance | undefined;
  },

  async findCurrent(db: Queryable, membershipId: string): Promise<SimulationAllowance | undefined> {
    const { rows } = await db.query(
      `select ${simulationAllowanceTable.select} from ${simulationAllowanceTable.sql}
       where membership_id = $1 and period_start <= now() and period_end > now()`, [membershipId]);
    return rows[0] as SimulationAllowance | undefined;
  },

  // The charge, as one statement: consumes the weight (a fraction for a re-run) only when it fits.
  async consume(db: Queryable, id: string, weight: string): Promise<SimulationAllowance | undefined> {
    const { rows } = await db.query(
      `update billing.simulation_allowances set simulations_consumed = simulations_consumed + $2::numeric
        where id = $1 and simulations_consumed + $2::numeric <= simulations_granted
       returning ${simulationAllowanceTable.select}`, [id, weight]);
    return rows[0] as SimulationAllowance | undefined;
  },

  // Creates the period's allowance unless one exists. Undefined when one existed.
  async insertIfAbsent(db: Queryable, row: NewSimulationAllowance): Promise<SimulationAllowance | undefined> {
    const { rows } = await db.query(
      `insert into billing.simulation_allowances (id, organisation_id, membership_id, period_start, period_end, simulations_granted)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (organisation_id, membership_id, period_start) do nothing
       returning ${simulationAllowanceTable.select}`,
      [row.id, row.organisationId, row.membershipId, row.periodStart, row.periodEnd, row.simulationsGranted]);
    return rows[0] as SimulationAllowance | undefined;
  },
};
