// Data access for fde.fde_escalations, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  fdeEscalationTable,
  type FdeEscalation,
  type FdeEscalationChanges,
  type NewFdeEscalation,
} from '../../models/fde/fdeEscalation.model.ts';

export const fdeEscalationRepo = {
  insert(db: Queryable, row: NewFdeEscalation): Promise<FdeEscalation> {
    return insertRow(db, fdeEscalationTable, row);
  },

  findById(db: Queryable, id: FdeEscalation['id']): Promise<FdeEscalation | undefined> {
    return findRow(db, fdeEscalationTable, { id });
  },

  update(
    db: Queryable,
    id: FdeEscalation['id'],
    changes: FdeEscalationChanges,
  ): Promise<FdeEscalation | undefined> {
    return updateRow(db, fdeEscalationTable, { id }, changes);
  },

  async listForEngagement(db: Queryable, engagementId: string): Promise<FdeEscalation[]> {
    const { rows } = await db.query(
      `select ${fdeEscalationTable.select} from fde.fde_escalations where engagement_id = $1 order by created_at desc`, [engagementId]);
    return rows as FdeEscalation[];
  },

  /** An open escalation of this cause for one system in one stage (through the failing task's connection). */
  async openForConnection(db: Queryable, stageId: string, cause: string, connectionId: string): Promise<boolean> {
    const { rows } = await db.query(
      `select exists (select 1 from fde.fde_escalations e join fde.fde_tasks t on t.id = e.task_id
         where e.stage_id = $1 and e.cause = $2 and e.status = 'open' and t.connection_id = $3) as found`, [stageId, cause, connectionId]);
    return (rows[0] as { found: boolean }).found;
  },

  async countOpen(db: Queryable, engagementId: string): Promise<number> {
    const { rows } = await db.query(
      `select count(*)::int as n from fde.fde_escalations where engagement_id = $1 and status = 'open'`, [engagementId]);
    return (rows[0] as { n: number }).n;
  },
};
