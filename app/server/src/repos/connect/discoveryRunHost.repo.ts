// Data access for connect.discovery_run_hosts, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  discoveryRunHostTable,
  type DiscoveryRunHost,
  type DiscoveryRunHostPrimaryKey,
  type NewDiscoveryRunHost,
} from '../../models/connect/discoveryRunHost.model.ts';

export const discoveryRunHostRepo = {
  insert(db: Queryable, row: NewDiscoveryRunHost): Promise<DiscoveryRunHost> {
    return insertRow(db, discoveryRunHostTable, row);
  },

  findByKey(db: Queryable, key: DiscoveryRunHostPrimaryKey): Promise<DiscoveryRunHost | undefined> {
    return findRow(db, discoveryRunHostTable, key);
  },

  /** Adds the hosts a report named; how many of them the run had not seen before. */
  async add(db: Queryable, organisationId: string, runId: string, hosts: readonly string[]): Promise<number> {
    if (hosts.length === 0) return 0;
    const { rows } = await db.query(
      `with added as (
         insert into connect.discovery_run_hosts (organisation_id, run_id, host)
         select $1, $2, h from unnest($3::text[]) as h
         on conflict do nothing
         returning 1)
       select count(*)::int as added from added`, [organisationId, runId, [...new Set(hosts)]]);
    return (rows[0] as { added: number }).added;
  },
};
