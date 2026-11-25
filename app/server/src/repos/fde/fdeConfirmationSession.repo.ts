// Data access for fde.fde_confirmation_sessions, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  fdeConfirmationSessionTable,
  type FdeConfirmationSession,
  type FdeConfirmationSessionChanges,
  type NewFdeConfirmationSession,
} from '../../models/fde/fdeConfirmationSession.model.ts';

export const fdeConfirmationSessionRepo = {
  insert(db: Queryable, row: NewFdeConfirmationSession): Promise<FdeConfirmationSession> {
    return insertRow(db, fdeConfirmationSessionTable, row);
  },

  findById(db: Queryable, id: FdeConfirmationSession['id']): Promise<FdeConfirmationSession | undefined> {
    return findRow(db, fdeConfirmationSessionTable, { id });
  },

  update(
    db: Queryable,
    id: FdeConfirmationSession['id'],
    changes: FdeConfirmationSessionChanges,
  ): Promise<FdeConfirmationSession | undefined> {
    return updateRow(db, fdeConfirmationSessionTable, { id }, changes);
  },

  /** An engagement's sessions, the newest first. */
  async listForEngagement(db: Queryable, engagementId: string, limit = 100): Promise<FdeConfirmationSession[]> {
    const { rows } = await db.query(
      `select ${fdeConfirmationSessionTable.select} from fde.fde_confirmation_sessions where engagement_id = $1
       order by coalesce(started_at, scheduled_at) desc nulls last, id desc limit $2`, [engagementId, limit]);
    return rows as FdeConfirmationSession[];
  },
};
