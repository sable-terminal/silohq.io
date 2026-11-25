// Data access for connect.heal_proposals, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  healProposalTable,
  type HealProposal,
  type HealProposalChanges,
  type NewHealProposal,
} from '../../models/connect/healProposal.model.ts';

export const healProposalRepo = {
  insert(db: Queryable, row: NewHealProposal): Promise<HealProposal> {
    return insertRow(db, healProposalTable, row);
  },

  findById(db: Queryable, id: HealProposal['id']): Promise<HealProposal | undefined> {
    return findRow(db, healProposalTable, { id });
  },

  update(
    db: Queryable,
    id: HealProposal['id'],
    changes: HealProposalChanges,
  ): Promise<HealProposal | undefined> {
    return updateRow(db, healProposalTable, { id }, changes);
  },

  /** The proposal, locked for a decision. */
  async findForUpdate(db: Queryable, id: string): Promise<HealProposal | undefined> {
    const { rows } = await db.query(`select ${healProposalTable.select} from connect.heal_proposals where id = $1 for update`, [id]);
    return rows[0] as HealProposal | undefined;
  },

  /** Newest first, by connection and disposition when given. */
  async list(db: Queryable, filter: { connectionId?: string | undefined; disposition?: string | undefined; limit: number }): Promise<HealProposal[]> {
    const { rows } = await db.query(
      `select ${healProposalTable.select} from connect.heal_proposals
       where ($1::uuid is null or connection_id = $1) and ($2::text is null or disposition = $2)
       order by created_at desc, id desc limit $3`, [filter.connectionId ?? null, filter.disposition ?? null, filter.limit]);
    return rows as HealProposal[];
  },
};
