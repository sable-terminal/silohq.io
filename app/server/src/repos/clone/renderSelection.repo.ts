// Data access for clone.render_selections, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  renderSelectionTable,
  type NewRenderSelection,
  type RenderSelection,
  type RenderSelectionPrimaryKey,
} from '../../models/clone/renderSelection.model.ts';

export const renderSelectionRepo = {
  insert(db: Queryable, row: NewRenderSelection): Promise<RenderSelection> {
    return insertRow(db, renderSelectionTable, row);
  },

  findByKey(db: Queryable, key: RenderSelectionPrimaryKey): Promise<RenderSelection | undefined> {
    return findRow(db, renderSelectionTable, key);
  },
};
