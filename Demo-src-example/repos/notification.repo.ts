import type { Executor } from '../infra/db.infra';
import { NOTIFICATION_DAYS } from '../config/constants.config';

/** Something that happened to somebody — see migration 113. Every read filters on expiry. */

export type NotificationKind =
  | 'change'
  | 'cron'
  | 'view'
  | 'import'
  | 'connection'
  | 'people'
  | 'security'
  | 'billing';

export interface Notification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  href: string;
  createdAt: Date;
  readAt: Date | null;
}

type Row = {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  href: string;
  created_at: Date;
  read_at: Date | null;
};

const COLUMNS = `id, kind, title, body, href, created_at, read_at`;

/* Computed by the database, for the reason `conversation.repo` states: `now()`
   in a transaction is its start, and a date worked out here lands past the CHECK. */
const EXPIRES = `now() + make_interval(days => ${NOTIFICATION_DAYS})`;

const map = (row: Row): Notification => ({
  id: row.id,
  kind: row.kind,
  title: row.title,
  body: row.body,
  href: row.href,
  createdAt: row.created_at,
  readAt: row.read_at,
});

export async function create(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    membershipId: string;
    kind: NotificationKind;
    title: string;
    body: string | null;
    href: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO notifications (id, organisation_id, membership_id, kind, title, body, href, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, ${EXPIRES})`,
    [input.id, input.organisationId, input.membershipId, input.kind, input.title, input.body, input.href],
  );
}

export async function listFor(db: Executor, membershipId: string, limit = 50): Promise<Notification[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM notifications
      WHERE membership_id = $1 AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT $2`,
    [membershipId, limit],
  );
  return rows.map(map);
}

export async function unreadCount(db: Executor, membershipId: string): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `SELECT count(*) FROM notifications WHERE membership_id = $1 AND read_at IS NULL AND expires_at > now()`,
    [membershipId],
  );
  return Number(rows[0]?.count ?? 0);
}

/** Reading one is what marks it; the row says when, so a second read does not move it. */
export async function markRead(db: Executor, input: { id: string; membershipId: string }): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE notifications SET read_at = coalesce(read_at, now())
      WHERE id = $1 AND membership_id = $2 AND expires_at > now()`,
    [input.id, input.membershipId],
  );
  return (rowCount ?? 0) > 0;
}

export async function markAllRead(db: Executor, membershipId: string): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE notifications SET read_at = now() WHERE membership_id = $1 AND read_at IS NULL AND expires_at > now()`,
    [membershipId],
  );
  return rowCount ?? 0;
}

/** Housekeeping for what the CHECK already made unreadable. */
export async function discardExpired(db: Executor): Promise<number> {
  const { rowCount } = await db.query(`DELETE FROM notifications WHERE expires_at <= now()`);
  return rowCount ?? 0;
}
