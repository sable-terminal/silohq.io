// Data access for connect.webhook_endpoints, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  webhookEndpointTable,
  type NewWebhookEndpoint,
  type WebhookEndpoint,
  type WebhookEndpointChanges,
} from '../../models/connect/webhookEndpoint.model.ts';

export const webhookEndpointRepo = {
  insert(db: Queryable, row: NewWebhookEndpoint): Promise<WebhookEndpoint> {
    return insertRow(db, webhookEndpointTable, row);
  },

  findById(db: Queryable, id: WebhookEndpoint['id']): Promise<WebhookEndpoint | undefined> {
    return findRow(db, webhookEndpointTable, { id });
  },

  update(
    db: Queryable,
    id: WebhookEndpoint['id'],
    changes: WebhookEndpointChanges,
  ): Promise<WebhookEndpoint | undefined> {
    return updateRow(db, webhookEndpointTable, { id }, changes);
  },

  /** The inbound endpoint a path token routes to, by the token's SHA-256 (spec 18.8). */
  async findInbound(db: Queryable, pathTokenHash: Buffer): Promise<WebhookEndpoint | undefined> {
    const { rows } = await db.query(
      `select ${webhookEndpointTable.select} from connect.webhook_endpoints where path_token_hash = $1 and direction = 'inbound'`,
      [pathTokenHash]);
    return rows[0] as WebhookEndpoint | undefined;
  },

  /**
   * A connection's live inbound endpoint (active or paused), if it has one, with its secret's
   * last four from the safe view (the sealed columns are the credential service's alone).
   */
  async liveInbound(db: Queryable, connectionId: string): Promise<(WebhookEndpoint & { secretLastFour: string | null }) | undefined> {
    const { rows } = await db.query(
      `select ${webhookEndpointTable.select.split(', ').map((c) => `e.${c}`).join(', ')}, s.last_four as "secretLastFour"
         from connect.webhook_endpoints e
         left join connect.connection_credentials_safe s on s.organisation_id = e.organisation_id and s.id = e.secret_credential_id
        where e.connection_id = $1 and e.direction = 'inbound' and e.status <> 'revoked' order by e.created_at desc limit 1`,
      [connectionId]);
    return rows[0] as (WebhookEndpoint & { secretLastFour: string | null }) | undefined;
  },

  /** Revokes the connection's live inbound endpoints. */
  async revokeInbound(db: Queryable, connectionId: string): Promise<number> {
    const { rowCount } = await db.query(
      `update connect.webhook_endpoints set status = 'revoked', revoked_at = now()
        where connection_id = $1 and direction = 'inbound' and status <> 'revoked'`, [connectionId]);
    return rowCount ?? 0;
  },

  async countRejected(db: Queryable, id: WebhookEndpoint['id']): Promise<void> {
    await db.query('update connect.webhook_endpoints set rejected_count = rejected_count + 1 where id = $1', [id]);
  },

  async markDelivered(db: Queryable, id: WebhookEndpoint['id']): Promise<void> {
    await db.query('update connect.webhook_endpoints set last_delivery_at = now() where id = $1', [id]);
  },

  /** A connection's outbound targets, newest first. */
  async listOutbound(db: Queryable, connectionId: string): Promise<WebhookEndpoint[]> {
    const { rows } = await db.query(
      `select ${webhookEndpointTable.select} from connect.webhook_endpoints where connection_id = $1 and direction = 'outbound' order by created_at desc, id`,
      [connectionId]);
    return rows as WebhookEndpoint[];
  },

  /** The connection's live outbound target named for a webhook action (20.3, 47.4): at most one, by the unique index. */
  async liveAction(db: Queryable, connectionId: string, actionName: string): Promise<WebhookEndpoint | undefined> {
    const { rows } = await db.query(
      `select ${webhookEndpointTable.select} from connect.webhook_endpoints
        where connection_id = $1 and direction = 'outbound' and action_name = $2 and status <> 'revoked'`,
      [connectionId, actionName]);
    return rows[0] as WebhookEndpoint | undefined;
  },
};
