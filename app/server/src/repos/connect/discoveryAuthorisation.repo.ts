// Data access for connect.discovery_authorisations, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  discoveryAuthorisationTable,
  type DiscoveryAuthorisation,
  type DiscoveryAuthorisationChanges,
  type NewDiscoveryAuthorisation,
} from '../../models/connect/discoveryAuthorisation.model.ts';

export const discoveryAuthorisationRepo = {
  insert(db: Queryable, row: NewDiscoveryAuthorisation): Promise<DiscoveryAuthorisation> {
    return insertRow(db, discoveryAuthorisationTable, row);
  },

  findById(db: Queryable, id: DiscoveryAuthorisation['id']): Promise<DiscoveryAuthorisation | undefined> {
    return findRow(db, discoveryAuthorisationTable, { id });
  },

  update(
    db: Queryable,
    id: DiscoveryAuthorisation['id'],
    changes: DiscoveryAuthorisationChanges,
  ): Promise<DiscoveryAuthorisation | undefined> {
    return updateRow(db, discoveryAuthorisationTable, { id }, changes);
  },

  /** Newest first. */
  async list(db: Queryable, limit: number): Promise<DiscoveryAuthorisation[]> {
    const { rows } = await db.query(
      `select ${discoveryAuthorisationTable.select} from connect.discovery_authorisations order by created_at desc, id desc limit $1`, [limit]);
    return rows as DiscoveryAuthorisation[];
  },

  /** Sets revoked_at once; undefined when it was already revoked. */
  async revoke(db: Queryable, id: string): Promise<DiscoveryAuthorisation | undefined> {
    const { rows } = await db.query(
      `update connect.discovery_authorisations set revoked_at = now() where id = $1 and revoked_at is null
       returning ${discoveryAuthorisationTable.select}`, [id]);
    return rows[0] as DiscoveryAuthorisation | undefined;
  },
};
