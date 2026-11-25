// Data access for platform.support_tickets, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  supportTicketTable,
  type NewSupportTicket,
  type SupportTicket,
  type SupportTicketChanges,
} from '../../models/platform/supportTicket.model.ts';

export const supportTicketRepo = {
  insert(db: Queryable, row: NewSupportTicket): Promise<SupportTicket> {
    return insertRow(db, supportTicketTable, row);
  },

  findById(db: Queryable, id: SupportTicket['id']): Promise<SupportTicket | undefined> {
    return findRow(db, supportTicketTable, { id });
  },

  findByReference(db: Queryable, reference: SupportTicket['reference']): Promise<SupportTicket | undefined> {
    return findRow(db, supportTicketTable, { reference });
  },

  async lock(db: Queryable, id: string): Promise<SupportTicket | undefined> {
    const { rows } = await db.query(`select ${supportTicketTable.select} from ${supportTicketTable.sql} where id = $1 for update`, [id]);
    return rows[0] as SupportTicket | undefined;
  },

  /**
   * The organisation's tickets, the latest message first: all of them, or one member's. Open is
   * waiting on Silo or on the customer; done is resolved or closed. Keyset on (last_message_at, id).
   */
  async list(db: Queryable, filter: {
    raisedBy?: string | undefined; state?: 'open' | 'done' | undefined; before?: { lastMessageAt: string; id: string } | undefined; limit: number;
  }): Promise<SupportTicket[]> {
    const { rows } = await db.query(
      `select ${supportTicketTable.select} from ${supportTicketTable.sql}
       where ($1::uuid is null or raised_by_membership_id = $1)
         and ($2::text is null or ($2 = 'open' and status in ('waiting_on_silo', 'waiting_on_customer'))
                               or ($2 = 'done' and status in ('resolved', 'closed')))
         and ($3::timestamptz is null or (last_message_at, id) < ($3, $4::uuid))
       order by last_message_at desc, id desc limit $5`,
      [filter.raisedBy ?? null, filter.state ?? null, filter.before?.lastMessageAt ?? null, filter.before?.id ?? null, filter.limit]);
    return rows as SupportTicket[];
  },

  /** How many of the organisation's tickets (or one member's) wait on the customer. */
  async waitingOnCustomer(db: Queryable, raisedBy: string | undefined): Promise<number> {
    const { rows } = await db.query(
      `select count(*)::int as n from ${supportTicketTable.sql}
       where status = 'waiting_on_customer' and ($1::uuid is null or raised_by_membership_id = $1)`, [raisedBy ?? null]);
    return (rows[0] as { n: number }).n;
  },

  /** Tickets waiting on Silo across organisations, the most urgent and longest waiting first: identifiers only (security definer). */
  async waitingAcrossOrganisations(db: Queryable, limit: number): Promise<{ organisationId: string; id: string }[]> {
    const { rows } = await db.query('select organisation_id as "organisationId", id from platform.support_tickets_waiting($1)', [limit]);
    return rows as { organisationId: string; id: string }[];
  },

  /** A ticket by its reference, across organisations: identifiers only (security definer). */
  async locateByReference(db: Queryable, reference: string): Promise<{ organisationId: string; id: string } | undefined> {
    const { rows } = await db.query('select organisation_id as "organisationId", id from platform.support_ticket_by_reference($1)', [reference]);
    return rows[0] as { organisationId: string; id: string } | undefined;
  },

  update(
    db: Queryable,
    id: SupportTicket['id'],
    changes: SupportTicketChanges,
  ): Promise<SupportTicket | undefined> {
    return updateRow(db, supportTicketTable, { id }, changes);
  },
};
