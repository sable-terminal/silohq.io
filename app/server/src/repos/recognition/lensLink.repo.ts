// Data access for recognition.lens_links, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  lensLinkTable,
  type LensLink,
  type LensLinkChanges,
  type LensLinkPrimaryKey,
  type NewLensLink,
} from '../../models/recognition/lensLink.model.ts';

export const lensLinkRepo = {
  insert(db: Queryable, row: NewLensLink): Promise<LensLink> {
    return insertRow(db, lensLinkTable, row);
  },

  findByKey(db: Queryable, key: LensLinkPrimaryKey): Promise<LensLink | undefined> {
    return findRow(db, lensLinkTable, key);
  },

  update(db: Queryable, key: LensLinkPrimaryKey, changes: LensLinkChanges): Promise<LensLink | undefined> {
    return updateRow(db, lensLinkTable, key, changes);
  },
};
