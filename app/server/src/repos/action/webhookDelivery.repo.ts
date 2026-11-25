// Data access for action.webhook_deliveries, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  webhookDeliveryTable,
  type NewWebhookDelivery,
  type WebhookDelivery,
  type WebhookDeliveryChanges,
} from '../../models/action/webhookDelivery.model.ts';

export const webhookDeliveryRepo = {
  insert(db: Queryable, row: NewWebhookDelivery): Promise<WebhookDelivery> {
    return insertRow(db, webhookDeliveryTable, row);
  },

  findById(db: Queryable, id: WebhookDelivery['id']): Promise<WebhookDelivery | undefined> {
    return findRow(db, webhookDeliveryTable, { id });
  },

  update(db: Queryable, id: WebhookDelivery['id'], changes: WebhookDeliveryChanges): Promise<WebhookDelivery | undefined> {
    return updateRow(db, webhookDeliveryTable, { id }, changes);
  },

  /** Once per endpoint and Action: a retried execution adds nothing. Returns whether it was new. */
  async insertOnce(db: Queryable, row: {
    id: string; organisationId: string; endpointId: string; mutationId: string; receiptId: string; executionKey: string; payload: Buffer;
    allowlistEntryId?: string | null | undefined;
  }): Promise<boolean> {
    const { rowCount } = await db.query(
      `insert into action.webhook_deliveries (id, organisation_id, endpoint_id, mutation_id, receipt_id, execution_key, payload, allowlist_entry_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (organisation_id, endpoint_id, mutation_id) do nothing`,
      [row.id, row.organisationId, row.endpointId, row.mutationId, row.receiptId, row.executionKey, row.payload, row.allowlistEntryId ?? null]);
    return (rowCount ?? 0) > 0;
  },

  /** Across organisations: deliveries due now (identifiers only), through the definer function. */
  async due(db: Queryable, now: string, limit: number): Promise<{ organisationId: string; id: string }[]> {
    const { rows } = await db.query('select organisation_id as "organisationId", id from action.webhook_deliveries_due($1::timestamptz, $2)', [now, limit]);
    return rows as { organisationId: string; id: string }[];
  },

  /** Delivered webhooks whose effect is due to be read (action.webhook_effects_due): identifiers only. */
  async effectsDue(db: Queryable, now: string, limit: number): Promise<{ organisationId: string; id: string }[]> {
    const { rows } = await db.query('select organisation_id as "organisationId", id from action.webhook_effects_due($1::timestamptz, $2)', [now, limit]);
    return rows as { organisationId: string; id: string }[];
  },

  listForMutation(db: Queryable, mutationId: string): Promise<WebhookDelivery[]> {
    return db.query(`select ${webhookDeliveryTable.select} from action.webhook_deliveries where mutation_id = $1 order by created_at, id`, [mutationId])
      .then((r) => r.rows as WebhookDelivery[]);
  },
};
