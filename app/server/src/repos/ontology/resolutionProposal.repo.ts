// Data access for ontology.resolution_proposals, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  resolutionProposalTable,
  type NewResolutionProposal,
  type ResolutionProposal,
  type ResolutionProposalChanges,
} from '../../models/ontology/resolutionProposal.model.ts';

export const resolutionProposalRepo = {
  insert(db: Queryable, row: NewResolutionProposal): Promise<ResolutionProposal> {
    return insertRow(db, resolutionProposalTable, row);
  },

  findById(db: Queryable, id: ResolutionProposal['id']): Promise<ResolutionProposal | undefined> {
    return findRow(db, resolutionProposalTable, { id });
  },

  update(
    db: Queryable,
    id: ResolutionProposal['id'],
    changes: ResolutionProposalChanges,
  ): Promise<ResolutionProposal | undefined> {
    return updateRow(db, resolutionProposalTable, { id }, changes);
  },

  /** Newest first: the review queue (resolution_proposals_open) or a type's history. */
  async list(db: Queryable, filter: { status?: ResolutionProposal['status'] | undefined; objectTypeId?: string | undefined; limit: number })
    : Promise<ResolutionProposal[]> {
    const { rows } = await db.query(
      `select ${resolutionProposalTable.select} from ontology.resolution_proposals
       where ($1::text is null or status = $1) and ($2::uuid is null or object_type_id = $2)
       order by created_at desc, id desc limit $3`, [filter.status ?? null, filter.objectTypeId ?? null, filter.limit]);
    return rows as ResolutionProposal[];
  },

  /** A type's confirmed normalisation rules, in the order they were confirmed: applied in that order. */
  async confirmedRules(db: Queryable, objectTypeId: string): Promise<ResolutionProposal[]> {
    const { rows } = await db.query(
      `select ${resolutionProposalTable.select} from ontology.resolution_proposals
       where object_type_id = $1 and kind = 'normalisation_rule' and status = 'confirmed' order by decided_at, id`, [objectTypeId]);
    return rows as ResolutionProposal[];
  },

  /** Decided inferred pair lists of a type (D74): the evidence the next inference learns from. */
  async decidedInferredPairs(db: Queryable, objectTypeId: string): Promise<ResolutionProposal[]> {
    const { rows } = await db.query(
      `select ${resolutionProposalTable.select} from ontology.resolution_proposals
       where object_type_id = $1 and kind = 'pair_list' and status in ('confirmed', 'rejected') and proposal ? 'inference'
       order by decided_at desc limit 500`, [objectTypeId]);
    return rows as ResolutionProposal[];
  },

  /** Whether an open inferred pair list waits for the type: one at a time. */
  async openInferredPairsExist(db: Queryable, objectTypeId: string): Promise<boolean> {
    const { rows } = await db.query(
      `select 1 from ontology.resolution_proposals where object_type_id = $1 and kind = 'pair_list' and status = 'open' and proposal ? 'inference' limit 1`,
      [objectTypeId]);
    return rows.length > 0;
  },

  /** Whether an open rule with this expression is already waiting for the type. */
  async openRuleExists(db: Queryable, objectTypeId: string, cel: string): Promise<boolean> {
    const { rows } = await db.query(
      `select 1 from ontology.resolution_proposals
       where object_type_id = $1 and kind = 'normalisation_rule' and status = 'open' and proposal ->> 'cel' = $2 limit 1`, [objectTypeId, cel]);
    return rows.length > 0;
  },

  /** Decides an open proposal. Undefined when it was already decided. */
  async decide(db: Queryable, id: string, status: 'confirmed' | 'rejected', decidedBy: string): Promise<ResolutionProposal | undefined> {
    const { rows } = await db.query(
      `update ontology.resolution_proposals set status = $2, decided_by = $3, decided_at = now()
       where id = $1 and status = 'open' returning ${resolutionProposalTable.select}`, [id, status, decidedBy]);
    return rows[0] as ResolutionProposal | undefined;
  },
};
