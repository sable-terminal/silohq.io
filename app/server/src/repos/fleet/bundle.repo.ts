// Data access for fleet.bundles, in plain SQL through base.repo.ts; no ORM.
// Read by directory_reader, fleet_writer; written by fleet_writer.
// No row-level security: every caller sees every row.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import { bundleTable, type Bundle, type NewBundle } from '../../models/fleet/bundle.model.ts';

export const bundleRepo = {
  insert(db: Queryable, row: NewBundle): Promise<Bundle> {
    return insertRow(db, bundleTable, row);
  },

  findById(db: Queryable, id: Bundle['id']): Promise<Bundle | undefined> {
    return findRow(db, bundleTable, { id });
  },
};
