// Data access for fde.fde_proposals, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  fdeProposalTable,
  type FdeProposal,
  type FdeProposalChanges,
  type NewFdeProposal,
} from '../../models/fde/fdeProposal.model.ts';

export const fdeProposalRepo = {
  insert(db: Queryable, row: NewFdeProposal): Promise<FdeProposal> {
    return insertRow(db, fdeProposalTable, row);
  },

  findById(db: Queryable, id: FdeProposal['id']): Promise<FdeProposal | undefined> {
    return findRow(db, fdeProposalTable, { id });
  },

  update(
    db: Queryable,
    id: FdeProposal['id'],
    changes: FdeProposalChanges,
  ): Promise<FdeProposal | undefined> {
    return updateRow(db, fdeProposalTable, { id }, changes);
  },

  async listForEngagement(db: Queryable, engagementId: string, filter: { status?: string; kind?: string; assigned?: string } = {}): Promise<FdeProposal[]> {
    const { rows } = await db.query(
      `select ${fdeProposalTable.select} from fde.fde_proposals
       where engagement_id = $1 and ($2::text is null or status = $2) and ($3::text is null or kind = $3)
         and ($4::uuid is null or assigned_membership_id = $4)
       order by created_at limit 2000`,
      [engagementId, filter.status ?? null, filter.kind ?? null, filter.assigned ?? null]);
    return rows as FdeProposal[];
  },

  /** The organisation's decided proposals of one kind, every engagement: confidence and outcome, for its band thresholds (52.3). */
  async decidedOfKind(db: Queryable, kind: string): Promise<{ confidence: number; status: string }[]> {
    const { rows } = await db.query(
      `select confidence::float8 as confidence, status from fde.fde_proposals
        where kind = $1 and status in ('accepted', 'accepted_edited', 'rejected') order by decided_at desc nulls last limit 2000`, [kind]);
    return rows as { confidence: number; status: string }[];
  },

  async countByStatus(db: Queryable, engagementId: string): Promise<Record<string, number>> {
    const { rows } = await db.query(
      'select status, count(*)::int as n from fde.fde_proposals where engagement_id = $1 group by status', [engagementId]);
    return Object.fromEntries((rows as { status: string; n: number }[]).map((r) => [r.status, r.n]));
  },

  /** Pending proposals of these kinds: a stage's exit waits for none. */
  async pendingOfKinds(db: Queryable, engagementId: string, kinds: readonly string[]): Promise<number> {
    const { rows } = await db.query(
      `select count(*)::int as n from fde.fde_proposals where engagement_id = $1 and status = 'pending' and kind = any($2::text[])`,
      [engagementId, kinds]);
    return (rows[0] as { n: number }).n;
  },

  /** Pending proposals for one decider, or unrouted ones when none is named (52.5). */
  async pendingFor(db: Queryable, engagementId: string, membershipId: string | null): Promise<number> {
    const { rows } = await db.query(
      `select count(*)::int as n from fde.fde_proposals where engagement_id = $1 and status = 'pending'
         and assigned_membership_id is not distinct from $2::uuid`, [engagementId, membershipId]);
    return (rows[0] as { n: number }).n;
  },

  async createdSince(db: Queryable, engagementId: string, since: string): Promise<number> {
    const { rows } = await db.query(
      'select count(*)::int as n from fde.fde_proposals where engagement_id = $1 and created_at >= $2', [engagementId, since]);
    return (rows[0] as { n: number }).n;
  },

  /** A proposal already made for this subject (a payload key), so a task run again does not repeat it. */
  async existsFor(db: Queryable, engagementId: string, kind: string, key: string, value: string): Promise<boolean> {
    const { rows } = await db.query(
      `select exists (select 1 from fde.fde_proposals where engagement_id = $1 and kind = $2 and payload ->> $3 = $4
         and status not in ('superseded', 'withdrawn', 'expired')) as found`, [engagementId, kind, key, value]);
    return (rows[0] as { found: boolean }).found;
  },

  /** Whether a proposal of this kind whose payload key holds this value waits on a person. */
  async pendingWith(db: Queryable, engagementId: string, kind: string, key: string, value: string): Promise<boolean> {
    const { rows } = await db.query(
      `select exists (select 1 from fde.fde_proposals where engagement_id = $1 and kind = $2 and payload ->> $3 = $4
         and status = 'pending') as found`, [engagementId, kind, key, value]);
    return (rows[0] as { found: boolean }).found;
  },

  /** Withdraws every pending proposal (the stop button, 52.7); returns their ids. */
  async withdrawPending(db: Queryable, engagementId: string): Promise<string[]> {
    const { rows } = await db.query(
      `update fde.fde_proposals set status = 'withdrawn' where engagement_id = $1 and status = 'pending' returning id`, [engagementId]);
    return (rows as { id: string }[]).map((r) => r.id);
  },
};
