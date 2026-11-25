// Data access for connect.oauth_pending_flows, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app; written by silo_app.
// silo_report may read only some columns, so cannot use these finders, which
// select every column; give them their own query.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  oauthPendingFlowTable,
  type NewOauthPendingFlow,
  type OauthPendingFlow,
  type OauthPendingFlowChanges,
  type OauthPendingFlowPrimaryKey,
} from '../../models/connect/oauthPendingFlow.model.ts';

export const oauthPendingFlowRepo = {
  insert(db: Queryable, row: NewOauthPendingFlow): Promise<OauthPendingFlow> {
    return insertRow(db, oauthPendingFlowTable, row);
  },

  findByKey(db: Queryable, key: OauthPendingFlowPrimaryKey): Promise<OauthPendingFlow | undefined> {
    return findRow(db, oauthPendingFlowTable, key);
  },

  findByStateHash(
    db: Queryable,
    stateHash: OauthPendingFlow['stateHash'],
  ): Promise<OauthPendingFlow | undefined> {
    return findRow(db, oauthPendingFlowTable, { stateHash });
  },

  update(
    db: Queryable,
    key: OauthPendingFlowPrimaryKey,
    changes: OauthPendingFlowChanges,
  ): Promise<OauthPendingFlow | undefined> {
    return updateRow(db, oauthPendingFlowTable, key, changes);
  },

  /**
   * The OAuth callback, before the organisation is known: consumes the flow in one
   * statement through connect.resolve_oauth_flow (single use, unexpired), returning only
   * what is needed to set the organisation, or undefined.
   */
  /** Pending flows past their expiry in every organisation (connect.oauth_flows_expired, security definer): what the sweep marks. */
  async expiredAcross(db: Queryable, limit: number): Promise<{ organisationId: string; stateHash: Buffer }[]> {
    const { rows } = await db.query('select organisation_id as "organisationId", state_hash as "stateHash" from connect.oauth_flows_expired($1)', [limit]);
    return rows as { organisationId: string; stateHash: Buffer }[];
  },

  /** Marks one pending flow expired, once; undefined when it was consumed or marked already. */
  async markExpired(db: Queryable, stateHash: Buffer): Promise<{ connectionId: string; connectorId: string; membershipId: string } | undefined> {
    const { rows } = await db.query(
      `update connect.oauth_pending_flows set expired_at = now()
        where state_hash = $1 and consumed_at is null and expired_at is null and expires_at <= now()
        returning connection_id as "connectionId", connector_id as "connectorId", membership_id as "membershipId"`, [stateHash]);
    return rows[0] as { connectionId: string; connectorId: string; membershipId: string } | undefined;
  },

  async consume(db: Queryable, stateHash: Buffer): Promise<{ organisationId: string; connectionId: string; sessionId: string } | undefined> {
    const { rows } = await db.query(
      'select organisation_id as "organisationId", connection_id as "connectionId", session_id as "sessionId" from connect.resolve_oauth_flow($1)',
      [stateHash]);
    return rows[0] as { organisationId: string; connectionId: string; sessionId: string } | undefined;
  },
};
