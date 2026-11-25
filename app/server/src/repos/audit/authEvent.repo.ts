// Data access for audit.auth_events, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_audit_writer, silo_report; written by silo_audit_writer.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  authEventTable,
  type AuthEvent,
  type AuthEventPrimaryKey,
  type NewAuthEvent,
} from '../../models/audit/authEvent.model.ts';

export interface AuthEventFilter {
  organisationId: string;
  from?: string | undefined;
  to?: string | undefined;
  event?: string | undefined;
  userId?: string | undefined;
  membershipId?: string | undefined;
  /** Keyset: events strictly before this (occurred_at, id). */
  before?: { occurredAt: string; id: string } | undefined;
  limit: number;
}

export const authEventRepo = {
  insert(db: Queryable, row: NewAuthEvent): Promise<AuthEvent> {
    return insertRow(db, authEventTable, row);
  },

  findByKey(db: Queryable, key: AuthEventPrimaryKey): Promise<AuthEvent | undefined> {
    return findRow(db, authEventTable, key);
  },

  // The audit service stores each outbox event once, by its id. occurred_at is the outbox
  // row's time, so the lookup reads one instant of one organisation (auth_events_source_event).
  async findBySourceEvent(db: Queryable, key: { organisationId: string; occurredAt: string; sourceEventId: string })
    : Promise<AuthEvent | undefined> {
    const { rows } = await db.query(
      `select ${authEventTable.select} from audit.auth_events
       where organisation_id = $1 and occurred_at = $2 and source_event_id = $3 limit 1`,
      [key.organisationId, key.occurredAt, key.sourceEventId]);
    return rows[0] as AuthEvent | undefined;
  },

  /** Newest first, filtered; for the audit view. */
  async list(db: Queryable, filter: AuthEventFilter): Promise<AuthEvent[]> {
    const params: unknown[] = [filter.organisationId];
    const terms = ['organisation_id = $1'];
    const add = (column: string, op: string, value: unknown): void => {
      params.push(value);
      terms.push(`${column} ${op} $${params.length}`);
    };
    if (filter.from !== undefined) add('occurred_at', '>=', filter.from);
    if (filter.to !== undefined) add('occurred_at', '<', filter.to);
    if (filter.event !== undefined) add('event', '=', filter.event);
    if (filter.userId !== undefined) add('user_id', '=', filter.userId);
    if (filter.membershipId !== undefined) add('membership_id', '=', filter.membershipId);
    if (filter.before !== undefined) {
      params.push(filter.before.occurredAt, filter.before.id);
      terms.push(`(occurred_at, id) < ($${params.length - 1}, $${params.length})`);
    }
    params.push(filter.limit);
    const { rows } = await db.query(
      `select ${authEventTable.select} from audit.auth_events where ${terms.join(' and ')}
       order by occurred_at desc, id desc limit $${params.length}`, params);
    return rows as AuthEvent[];
  },
};
