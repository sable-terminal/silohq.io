// Data access for clone.render_jobs, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  renderJobTable,
  type NewRenderJob,
  type RenderJob,
  type RenderJobChanges,
} from '../../models/clone/renderJob.model.ts';

export const renderJobRepo = {
  insert(db: Queryable, row: NewRenderJob): Promise<RenderJob> {
    return insertRow(db, renderJobTable, row);
  },

  findById(db: Queryable, id: RenderJob['id']): Promise<RenderJob | undefined> {
    return findRow(db, renderJobTable, { id });
  },

  update(db: Queryable, id: RenderJob['id'], changes: RenderJobChanges): Promise<RenderJob | undefined> {
    return updateRow(db, renderJobTable, { id }, changes);
  },

  /** Ends a queued job once, before it expires: completed with its file, or failed with its code. */
  async finish(db: Queryable, id: string, outcome: { fileId: string } | { failureCode: string }): Promise<boolean> {
    const { rowCount } = 'fileId' in outcome
      ? await db.query(`update clone.render_jobs set status = 'completed', file_id = $2, completed_at = now() where id = $1 and status = 'queued' and expires_at > now()`,
        [id, outcome.fileId])
      : await db.query(`update clone.render_jobs set status = 'failed', failure_code = $2, completed_at = now() where id = $1 and status = 'queued'`,
        [id, outcome.failureCode]);
    return rowCount === 1;
  },
};
