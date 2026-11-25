// Data access for ontology.link_type_routes, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  linkTypeRouteTable,
  type LinkTypeRoute,
  type LinkTypeRouteChanges,
  type NewLinkTypeRoute,
} from '../../models/ontology/linkTypeRoute.model.ts';

export const linkTypeRouteRepo = {
  insert(db: Queryable, row: NewLinkTypeRoute): Promise<LinkTypeRoute> {
    return insertRow(db, linkTypeRouteTable, row);
  },

  findById(db: Queryable, id: LinkTypeRoute['id']): Promise<LinkTypeRoute | undefined> {
    return findRow(db, linkTypeRouteTable, { id });
  },

  update(
    db: Queryable,
    id: LinkTypeRoute['id'],
    changes: LinkTypeRouteChanges,
  ): Promise<LinkTypeRoute | undefined> {
    return updateRow(db, linkTypeRouteTable, { id }, changes);
  },

  async liveForLinkType(db: Queryable, linkTypeId: string): Promise<LinkTypeRoute[]> {
    const { rows } = await db.query(
      `select ${linkTypeRouteTable.select} from ontology.link_type_routes where link_type_id = $1 and removed_at is null order by position`,
      [linkTypeId]);
    return rows as LinkTypeRoute[];
  },
};
