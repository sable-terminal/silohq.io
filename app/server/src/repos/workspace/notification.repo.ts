// Data access for workspace.notifications, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  notificationTable,
  type NewNotification,
  type Notification,
  type NotificationChanges,
} from '../../models/workspace/notification.model.ts';

export const notificationRepo = {
  insert(db: Queryable, row: NewNotification): Promise<Notification> {
    return insertRow(db, notificationTable, row);
  },

  findById(db: Queryable, id: Notification['id']): Promise<Notification | undefined> {
    return findRow(db, notificationTable, { id });
  },

  update(
    db: Queryable,
    id: Notification['id'],
    changes: NotificationChanges,
  ): Promise<Notification | undefined> {
    return updateRow(db, notificationTable, { id }, changes);
  },

  /**
   * Inserts the item unless the recipient already has one of this kind, channel and source
   * (the partial unique indexes); returns the item either way.
   */
  async insertOnce(db: Queryable, row: NewNotification): Promise<{ notification: Notification; created: boolean }> {
    const inserted = await db.query(
      `insert into workspace.notifications (id, organisation_id, recipient_membership_id, automation_run_action_id, approval_chain_id,
         finding_id, simulation_run_id, operator_access_session_id, receipt_id, action_event_subscription_id, object_view_layout_id,
         ontology_element_id, kind, channel, delivered_at, acknowledge_due_at, pipeline_run_id, support_ticket_message_id, support_ticket_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       on conflict do nothing returning ${notificationTable.select}`,
      [row.id, row.organisationId, row.recipientMembershipId, row.automationRunActionId ?? null, row.approvalChainId ?? null,
        row.findingId ?? null, row.simulationRunId ?? null, row.operatorAccessSessionId ?? null, row.receiptId ?? null,
        row.actionEventSubscriptionId ?? null, row.objectViewLayoutId ?? null, row.ontologyElementId ?? null, row.kind, row.channel ?? 'in_app',
        row.deliveredAt ?? null, row.acknowledgeDueAt ?? null, row.pipelineRunId ?? null, row.supportTicketMessageId ?? null, row.supportTicketId ?? null]);
    if (inserted.rows[0]) return { notification: inserted.rows[0] as Notification, created: true };
    const { rows } = await db.query(
      `select ${notificationTable.select} from workspace.notifications
       where organisation_id = $1 and recipient_membership_id = $2 and kind = $3 and channel = $4
         and automation_run_action_id is not distinct from $5 and approval_chain_id is not distinct from $6
         and finding_id is not distinct from $7 and simulation_run_id is not distinct from $8
         and operator_access_session_id is not distinct from $9 and receipt_id is not distinct from $10
         and action_event_subscription_id is not distinct from $11 and object_view_layout_id is not distinct from $12
         and ontology_element_id is not distinct from $13 and pipeline_run_id is not distinct from $14
         and support_ticket_message_id is not distinct from $15
       order by created_at desc limit 1`,
      [row.organisationId, row.recipientMembershipId, row.kind, row.channel ?? 'in_app', row.automationRunActionId ?? null,
        row.approvalChainId ?? null, row.findingId ?? null, row.simulationRunId ?? null, row.operatorAccessSessionId ?? null,
        row.receiptId ?? null, row.actionEventSubscriptionId ?? null, row.objectViewLayoutId ?? null, row.ontologyElementId ?? null, row.pipelineRunId ?? null,
        row.supportTicketMessageId ?? null]);
    return { notification: rows[0] as Notification, created: false };
  },

  /** A recipient's items, newest first. Keyset on (created_at, id). */
  async listForRecipient(db: Queryable, filter: {
    organisationId: string; membershipId: string; unread: boolean; before?: { createdAt: string; id: string } | undefined; limit: number;
  }): Promise<Notification[]> {
    const { rows } = await db.query(
      `select ${notificationTable.select} from workspace.notifications
       where organisation_id = $1 and recipient_membership_id = $2 and ($3::boolean is false or read_at is null)
         and ($4::timestamptz is null or (created_at, id) < ($4::timestamptz, $5::uuid))
       order by created_at desc, id desc limit $6`,
      [filter.organisationId, filter.membershipId, filter.unread, filter.before?.createdAt ?? null, filter.before?.id ?? null, filter.limit]);
    return rows as Notification[];
  },

  /** Sets read_at once, for the recipient only. Undefined when the item is not theirs. */
  async markRead(db: Queryable, key: { organisationId: string; id: string; membershipId: string }): Promise<Notification | undefined> {
    const { rows } = await db.query(
      `update workspace.notifications set read_at = coalesce(read_at, now())
       where organisation_id = $1 and id = $2 and recipient_membership_id = $3 returning ${notificationTable.select}`,
      [key.organisationId, key.id, key.membershipId]);
    return rows[0] as Notification | undefined;
  },

  /** Acknowledges an escalation once (reading it too), for the recipient only. */
  async acknowledge(db: Queryable, key: { organisationId: string; id: string; membershipId: string }): Promise<Notification | undefined> {
    const { rows } = await db.query(
      `update workspace.notifications set read_at = coalesce(read_at, now()), acknowledged_at = coalesce(acknowledged_at, now())
       where organisation_id = $1 and id = $2 and recipient_membership_id = $3 and kind = 'cron_escalate'
       returning ${notificationTable.select}`,
      [key.organisationId, key.id, key.membershipId]);
    return rows[0] as Notification | undefined;
  },

  /** A member's unread items in the product: the count a push carries. */
  async unreadCount(db: Queryable, membershipId: string): Promise<number> {
    const { rows } = await db.query(
      `select count(*)::int as n from workspace.notifications where recipient_membership_id = $1 and channel = 'in_app' and read_at is null`, [membershipId]);
    return (rows[0] as { n: number }).n;
  },

  async markDelivered(db: Queryable, id: string): Promise<void> {
    await db.query('update workspace.notifications set delivered_at = now() where id = $1 and delivered_at is null', [id]);
  },
};
