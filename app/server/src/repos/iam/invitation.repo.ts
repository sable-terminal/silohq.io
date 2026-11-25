// Data access for iam.invitations, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  invitationTable,
  type Invitation,
  type InvitationChanges,
  type NewInvitation,
} from '../../models/iam/invitation.model.ts';

export const invitationRepo = {
  insert(db: Queryable, row: NewInvitation): Promise<Invitation> {
    return insertRow(db, invitationTable, row);
  },

  findById(db: Queryable, id: Invitation['id']): Promise<Invitation | undefined> {
    return findRow(db, invitationTable, { id });
  },

  findByTokenHash(
    db: Queryable,
    key: Pick<Invitation, 'organisationId' | 'tokenHash'>,
  ): Promise<Invitation | undefined> {
    return findRow(db, invitationTable, key);
  },

  update(db: Queryable, id: Invitation['id'], changes: InvitationChanges): Promise<Invitation | undefined> {
    return updateRow(db, invitationTable, { id }, changes);
  },
};
