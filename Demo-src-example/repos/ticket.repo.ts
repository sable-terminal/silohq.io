import type { Executor } from '../infra/db.infra';
import { TICKET_DAYS } from '../config/constants.config';

/**
 * A ticket somebody raised — see migration 115.
 *
 * EVERY READ FILTERS ON EXPIRY, as conversations and notifications do. An
 * unswept row is unreadable rather than retained: the sweep is housekeeping,
 * not the guarantee.
 */

export type TicketKind = 'support' | 'feature' | 'security' | 'partnership';
export type TicketStatus = 'open' | 'in_progress' | 'closed';

export interface Ticket {
  id: string;
  /** What the person quotes, e.g. `SUP-2041`. */
  reference: string;
  raisedByMembershipId: string;
  kind: TicketKind;
  subject: string;
  body: string;
  status: TicketStatus;
  createdAt: Date;
}

type Row = {
  id: string;
  number: string | number;
  raised_by_membership_id: string;
  kind: TicketKind;
  subject: string;
  body: string;
  status: TicketStatus;
  created_at: Date;
};

const COLUMNS = `id, number, raised_by_membership_id, kind, subject, body, status, created_at`;

/* Computed by the database, for the reason `conversation.repo` states: `now()`
   in a transaction is its start, and a date worked out here lands past the CHECK. */
const EXPIRES = `now() + make_interval(days => ${TICKET_DAYS})`;

/*
 * THE PREFIX IS ADDED HERE, AND THE SAME ONE FOR EVERY KIND. The stored fact is
 * a number; "SUP-2041" is that number said out loud, which is exactly the
 * mapping this layer is for. One series rather than a prefix per kind because
 * the kind is already a column — see the migration.
 */
const referenceOf = (number: string | number) => `SUP-${number}`;

const map = (row: Row): Ticket => ({
  id: row.id,
  reference: referenceOf(row.number),
  raisedByMembershipId: row.raised_by_membership_id,
  kind: row.kind,
  subject: row.subject,
  body: row.body,
  status: row.status,
  createdAt: row.created_at,
});

/** Returns the row, because the reference and the time are the database's to decide. */
export async function create(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    raisedByMembershipId: string;
    kind: TicketKind;
    subject: string;
    body: string;
  },
): Promise<Ticket> {
  const { rows } = await db.query<Row>(
    `INSERT INTO tickets
       (id, organisation_id, raised_by_membership_id, kind, subject, body, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, ${EXPIRES})
     RETURNING ${COLUMNS}`,
    [input.id, input.organisationId, input.raisedByMembershipId, input.kind, input.subject, input.body],
  );
  return map(rows[0]!);
}

/** The panel's list: this membership's own, newest first. */
export async function listRaisedBy(db: Executor, membershipId: string, limit = 50): Promise<Ticket[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM tickets
      WHERE raised_by_membership_id = $1 AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT $2`,
    [membershipId, limit],
  );
  return rows.map(map);
}

/**
 * One ticket, whoever raised it.
 *
 * WHO MAY READ IT IS THE SERVICE'S QUESTION, not this one's — the repos README's
 * rule. It comes back carrying `raisedByMembershipId` so the service can answer
 * it without a second query.
 */
export async function read(db: Executor, id: string): Promise<Ticket | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM tickets WHERE id = $1 AND expires_at > now()`,
    [id],
  );
  return rows[0] ? map(rows[0]) : null;
}

/** Housekeeping for what the CHECK already made unreadable. Run by the sweep, as the migrator. */
export async function discardExpired(db: Executor): Promise<number> {
  const { rowCount } = await db.query(`DELETE FROM tickets WHERE expires_at <= now()`);
  return rowCount ?? 0;
}
