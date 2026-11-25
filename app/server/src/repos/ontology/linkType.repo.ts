// Data access for ontology.link_types, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  linkTypeTable,
  type LinkType,
  type LinkTypeChanges,
  type NewLinkType,
} from '../../models/ontology/linkType.model.ts';

export const linkTypeRepo = {
  insert(db: Queryable, row: NewLinkType): Promise<LinkType> {
    return insertRow(db, linkTypeTable, row);
  },

  findById(db: Queryable, id: LinkType['id']): Promise<LinkType | undefined> {
    return findRow(db, linkTypeTable, { id });
  },

  findByApiName(
    db: Queryable,
    key: Pick<LinkType, 'organisationId' | 'apiName'>,
  ): Promise<LinkType | undefined> {
    return findRow(db, linkTypeTable, key);
  },

  update(db: Queryable, id: LinkType['id'], changes: LinkTypeChanges): Promise<LinkType | undefined> {
    return updateRow(db, linkTypeTable, { id }, changes);
  },
};
