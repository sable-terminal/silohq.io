// Data access for simulation.simulation_result_edges, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  simulationResultEdgeTable,
  type NewSimulationResultEdge,
  type SimulationResultEdge,
  type SimulationResultEdgePrimaryKey,
} from '../../models/simulation/simulationResultEdge.model.ts';

export const simulationResultEdgeRepo = {
  insert(db: Queryable, row: NewSimulationResultEdge): Promise<SimulationResultEdge> {
    return insertRow(db, simulationResultEdgeTable, row);
  },

  findByKey(db: Queryable, key: SimulationResultEdgePrimaryKey): Promise<SimulationResultEdge | undefined> {
    return findRow(db, simulationResultEdgeTable, key);
  },

  async insertMany(db: Queryable, rows: readonly NewSimulationResultEdge[]): Promise<void> {
    if (rows.length === 0) return;
    await db.query(
      `insert into simulation.simulation_result_edges (organisation_id, result_id, position, edge_id, edge_kind, edge_source, sample_size)
       select o, r, p, e, k, s, n from unnest($1::uuid[], $2::uuid[], $3::int[], $4::uuid[], $5::text[], $6::text[], $7::int[]) as u (o, r, p, e, k, s, n)`,
      [rows.map((r) => r.organisationId), rows.map((r) => r.resultId), rows.map((r) => r.position), rows.map((r) => r.edgeId),
        rows.map((r) => r.edgeKind), rows.map((r) => r.edgeSource), rows.map((r) => r.sampleSize ?? null)]);
  },

  async listFor(db: Queryable, resultIds: readonly string[]): Promise<SimulationResultEdge[]> {
    if (resultIds.length === 0) return [];
    const { rows } = await db.query(
      `select ${simulationResultEdgeTable.select} from simulation.simulation_result_edges where result_id = any($1::uuid[])
        order by result_id, position`, [resultIds]);
    return rows as SimulationResultEdge[];
  },
};
