// Data access for fde.fde_confirmation_participants, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  fdeConfirmationParticipantTable,
  type FdeConfirmationParticipant,
  type FdeConfirmationParticipantPrimaryKey,
  type NewFdeConfirmationParticipant,
} from '../../models/fde/fdeConfirmationParticipant.model.ts';

export const fdeConfirmationParticipantRepo = {
  insert(db: Queryable, row: NewFdeConfirmationParticipant): Promise<FdeConfirmationParticipant> {
    return insertRow(db, fdeConfirmationParticipantTable, row);
  },

  findByKey(
    db: Queryable,
    key: FdeConfirmationParticipantPrimaryKey,
  ): Promise<FdeConfirmationParticipant | undefined> {
    return findRow(db, fdeConfirmationParticipantTable, key);
  },

  async listForSession(db: Queryable, sessionId: string): Promise<string[]> {
    const { rows } = await db.query(
      'select membership_id::text as id from fde.fde_confirmation_participants where session_id = $1 order by joined_at', [sessionId]);
    return (rows as { id: string }[]).map((r) => r.id);
  },
};
