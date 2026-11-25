// Data access for connect.agent_enrolment_tokens, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  agentEnrolmentTokenTable,
  type AgentEnrolmentToken,
  type AgentEnrolmentTokenChanges,
  type NewAgentEnrolmentToken,
} from '../../models/connect/agentEnrolmentToken.model.ts';

export const agentEnrolmentTokenRepo = {
  insert(db: Queryable, row: NewAgentEnrolmentToken): Promise<AgentEnrolmentToken> {
    return insertRow(db, agentEnrolmentTokenTable, row);
  },

  findById(db: Queryable, id: AgentEnrolmentToken['id']): Promise<AgentEnrolmentToken | undefined> {
    return findRow(db, agentEnrolmentTokenTable, { id });
  },

  findByTokenHash(
    db: Queryable,
    tokenHash: AgentEnrolmentToken['tokenHash'],
  ): Promise<AgentEnrolmentToken | undefined> {
    return findRow(db, agentEnrolmentTokenTable, { tokenHash });
  },

  update(
    db: Queryable,
    id: AgentEnrolmentToken['id'],
    changes: AgentEnrolmentTokenChanges,
  ): Promise<AgentEnrolmentToken | undefined> {
    return updateRow(db, agentEnrolmentTokenTable, { id }, changes);
  },

  /**
   * Consumes a token by its hash for the agent about to be enrolled (connect.resolve_enrolment_token:
   * single use, unexpired, unrevoked), before any organisation is known. Its organisation and pool,
   * or undefined. Call in the transaction that then inserts the agent: the link to it is deferred.
   */
  async consume(db: Queryable, tokenHash: Buffer, agentId: string): Promise<{ organisationId: string; tokenId: string; poolId: string; createdBy: string } | undefined> {
    const { rows } = await db.query(
      `select r.organisation_id as "organisationId", r.token_id as "tokenId", r.pool_id as "poolId"
         from connect.resolve_enrolment_token($1, $2) r`, [tokenHash, agentId]);
    const found = rows[0] as { organisationId: string; tokenId: string; poolId: string } | undefined;
    if (found === undefined) return undefined;
    await db.query(`select set_config('app.org_id', $1, true)`, [found.organisationId]);
    const { rows: [token] } = await db.query('select created_by as "createdBy" from connect.agent_enrolment_tokens where id = $1', [found.tokenId]);
    return { ...found, createdBy: (token as { createdBy: string }).createdBy };
  },
};
