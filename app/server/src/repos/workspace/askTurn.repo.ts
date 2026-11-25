// Data access for workspace.ask_turns, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app; written by silo_app.
// silo_report may read only some columns, so cannot use these finders, which
// select every column; give them their own query.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  askTurnTable,
  type AskTurn,
  type AskTurnPrimaryKey,
  type NewAskTurn,
} from '../../models/workspace/askTurn.model.ts';

export const askTurnRepo = {
  insert(db: Queryable, row: NewAskTurn): Promise<AskTurn> {
    return insertRow(db, askTurnTable, row);
  },

  findByKey(db: Queryable, key: AskTurnPrimaryKey): Promise<AskTurn | undefined> {
    return findRow(db, askTurnTable, key);
  },

  findByThreadIdAndSequenceAndCreatedAt(
    db: Queryable,
    key: Pick<AskTurn, 'organisationId' | 'threadId' | 'sequence' | 'createdAt'>,
  ): Promise<AskTurn | undefined> {
    return findRow(db, askTurnTable, key);
  },

  /** A thread's turns in order. */
  async listForThread(db: Queryable, threadId: string): Promise<AskTurn[]> {
    const { rows } = await db.query(
      `select ${askTurnTable.select} from workspace.ask_turns where thread_id = $1 order by sequence`, [threadId]);
    return rows as AskTurn[];
  },

  async findBySequence(db: Queryable, threadId: string, sequence: number): Promise<AskTurn | undefined> {
    const { rows } = await db.query(
      `select ${askTurnTable.select} from workspace.ask_turns where thread_id = $1 and sequence = $2`, [threadId, sequence]);
    return rows[0] as AskTurn | undefined;
  },

  /** The compiled manifests of a thread's latest answers, newest first: the context compile reads as references. */
  async recentManifests(db: Queryable, threadId: string, limit: number): Promise<string[]> {
    const { rows } = await db.query(
      `select manifest_id as "manifestId" from workspace.ask_turns
       where thread_id = $1 and manifest_id is not null order by sequence desc limit $2`, [threadId, limit]);
    return rows.map((r) => (r as { manifestId: string }).manifestId);
  },

  /** Whether a member has a turn that compiled this manifest: what lets them save it as a view. */
  async manifestAskedBy(db: Queryable, manifestId: string, membershipId: string): Promise<boolean> {
    const { rows } = await db.query(
      `select exists (select 1 from workspace.ask_turns t join workspace.ask_threads th
                        on th.organisation_id = t.organisation_id and th.id = t.thread_id
                      where t.manifest_id = $1 and th.owner_membership_id = $2) as yes`, [manifestId, membershipId]);
    return (rows[0] as { yes: boolean }).yes;
  },
};
