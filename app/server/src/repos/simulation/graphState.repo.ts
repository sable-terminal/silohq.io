// Data access for simulation.graph_state, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  graphStateTable,
  type GraphState,
  type GraphStateChanges,
  type NewGraphState,
} from '../../models/simulation/graphState.model.ts';

export const graphStateRepo = {
  insert(db: Queryable, row: NewGraphState): Promise<GraphState> {
    return insertRow(db, graphStateTable, row);
  },

  findByOrganisationId(
    db: Queryable,
    organisationId: GraphState['organisationId'],
  ): Promise<GraphState | undefined> {
    return findRow(db, graphStateTable, { organisationId });
  },

  update(
    db: Queryable,
    organisationId: GraphState['organisationId'],
    changes: GraphStateChanges,
  ): Promise<GraphState | undefined> {
    return updateRow(db, graphStateTable, { organisationId }, changes);
  },

  /**
   * Increments the organisation's graph version, first, under the row lock: every edge change
   * produces exactly one version (spec 39.3). Creates the row at version 1.
   */
  async bump(db: Queryable, organisationId: string): Promise<number> {
    const { rows } = await db.query(
      `insert into simulation.graph_state (organisation_id, graph_version) values ($1, 1)
       on conflict (organisation_id) do update set graph_version = simulation.graph_state.graph_version + 1
       returning graph_version::text as v`, [organisationId]);
    return Number((rows[0] as { v: string }).v);
  },

  async current(db: Queryable, organisationId: string): Promise<number> {
    const { rows } = await db.query('select graph_version::text as v from simulation.graph_state where organisation_id = $1', [organisationId]);
    return rows[0] === undefined ? 0 : Number((rows[0] as { v: string }).v);
  },
};
