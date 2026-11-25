// Data access for connect.email_addresses, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  emailAddressTable,
  type EmailAddress,
  type EmailAddressChanges,
  type NewEmailAddress,
} from '../../models/connect/emailAddress.model.ts';

export const emailAddressRepo = {
  insert(db: Queryable, row: NewEmailAddress): Promise<EmailAddress> {
    return insertRow(db, emailAddressTable, row);
  },

  findById(db: Queryable, id: EmailAddress['id']): Promise<EmailAddress | undefined> {
    return findRow(db, emailAddressTable, { id });
  },

  update(db: Queryable, id: EmailAddress['id'], changes: EmailAddressChanges): Promise<EmailAddress | undefined> {
    return updateRow(db, emailAddressTable, { id }, changes);
  },

  async liveFor(db: Queryable, connectionId: string): Promise<EmailAddress | undefined> {
    const { rows } = await db.query(`select ${emailAddressTable.select} from connect.email_addresses where connection_id = $1 and status = 'active'`, [connectionId]);
    return rows[0] as EmailAddress | undefined;
  },

  /** The live address a token's hash names, across the cell (connect.resolve_email_address): identifiers only. */
  async resolve(db: Queryable, tokenHash: Buffer): Promise<{ organisationId: string; id: string; connectionId: string } | undefined> {
    const { rows } = await db.query(
      'select organisation_id as "organisationId", id, connection_id as "connectionId" from connect.resolve_email_address($1)', [tokenHash]);
    return rows[0] as { organisationId: string; id: string; connectionId: string } | undefined;
  },

  /** A message taken, or set aside. */
  async countMessage(db: Queryable, id: string, taken: boolean): Promise<void> {
    await db.query(
      `update connect.email_addresses set ${taken ? 'messages_taken = messages_taken + 1' : 'messages_set_aside = messages_set_aside + 1'}, last_message_at = now()
        where id = $1`, [id]);
  },
};
