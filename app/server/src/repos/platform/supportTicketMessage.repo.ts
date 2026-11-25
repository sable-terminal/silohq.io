// Data access for platform.support_ticket_messages, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  supportTicketMessageTable,
  type NewSupportTicketMessage,
  type SupportTicketMessage,
} from '../../models/platform/supportTicketMessage.model.ts';

export const supportTicketMessageRepo = {
  insert(db: Queryable, row: NewSupportTicketMessage): Promise<SupportTicketMessage> {
    return insertRow(db, supportTicketMessageTable, row);
  },

  findById(db: Queryable, id: SupportTicketMessage['id']): Promise<SupportTicketMessage | undefined> {
    return findRow(db, supportTicketMessageTable, { id });
  },

  /** A ticket's messages, oldest first. */
  async listForTicket(db: Queryable, ticketId: string): Promise<SupportTicketMessage[]> {
    const { rows } = await db.query(
      `select ${supportTicketMessageTable.select} from ${supportTicketMessageTable.sql} where ticket_id = $1 order by created_at, id`, [ticketId]);
    return rows as SupportTicketMessage[];
  },
};
