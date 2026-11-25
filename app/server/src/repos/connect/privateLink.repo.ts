// Data access for connect.private_links, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app (connect-registry, for staff).
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import { privateLinkTable, type NewPrivateLink, type PrivateLink } from '../../models/connect/privateLink.model.ts';

/** More live links than any organisation has; a bound on what the egress reads per request. */
const MAX_LINKS = 200;

export const privateLinkRepo = {
  insert(db: Queryable, row: NewPrivateLink): Promise<PrivateLink> {
    return insertRow(db, privateLinkTable, row);
  },

  findById(db: Queryable, id: PrivateLink['id']): Promise<PrivateLink | undefined> {
    return findRow(db, privateLinkTable, { id });
  },

  /** The organisation's links, live ones first, oldest first. */
  async list(db: Queryable, options: { includeRemoved: boolean }): Promise<PrivateLink[]> {
    const { rows } = await db.query(
      `select ${privateLinkTable.select} from ${privateLinkTable.sql}
       where ($1 or status = 'active')
       order by status, created_at, id limit ${MAX_LINKS}`, [options.includeRemoved]);
    return rows as PrivateLink[];
  },

  /** The ranges of the organisation's live links, for the egress. */
  async liveNetworks(db: Queryable): Promise<string[]> {
    const { rows } = await db.query(
      `select network::text as network from ${privateLinkTable.sql} where status = 'active' order by created_at limit ${MAX_LINKS}`);
    return rows.map((row: { network: string }) => row.network);
  },

  /** Marks a live link removed if it is still at `version`; undefined when someone changed it first. */
  remove(db: Queryable, id: string, version: number, operatorId: string): Promise<PrivateLink | undefined> {
    return updateRow(db, privateLinkTable, { id, version, status: 'active' }, {
      status: 'removed', removedByOperatorId: operatorId, removedAt: new Date().toISOString(), version: version + 1,
    });
  },
};
