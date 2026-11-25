// Data access for connect.discovery_probes, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  discoveryProbeTable,
  type DiscoveryProbe,
  type DiscoveryProbePrimaryKey,
  type NewDiscoveryProbe,
} from '../../models/connect/discoveryProbe.model.ts';

export const discoveryProbeRepo = {
  insert(db: Queryable, row: NewDiscoveryProbe): Promise<DiscoveryProbe> {
    return insertRow(db, discoveryProbeTable, row);
  },

  findByKey(db: Queryable, key: DiscoveryProbePrimaryKey): Promise<DiscoveryProbe | undefined> {
    return findRow(db, discoveryProbeTable, key);
  },

  /** A batch of probes, one row each (spec 19.3: every probe logged individually), in one statement. */
  async insertMany(db: Queryable, rows: readonly Omit<NewDiscoveryProbe, 'id'>[]): Promise<void> {
    if (rows.length === 0) return;
    const values: unknown[] = [];
    const tuples = rows.map((r, i) => {
      values.push(r.organisationId, r.runId, r.agentId, r.host, r.port ?? null, r.method, r.outcome, r.probedAt);
      const b = i * 8;
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8})`;
    });
    await db.query(
      `insert into connect.discovery_probes (organisation_id, run_id, agent_id, host, port, method, outcome, probed_at) values ${tuples.join(', ')}`, values);
  },
};
