// Data access for recognition.outcome_designations, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  outcomeDesignationTable,
  type NewOutcomeDesignation,
  type OutcomeDesignation,
} from '../../models/recognition/outcomeDesignation.model.ts';

export const outcomeDesignationRepo = {
  insert(db: Queryable, row: NewOutcomeDesignation): Promise<OutcomeDesignation> {
    return insertRow(db, outcomeDesignationTable, row);
  },

  findById(db: Queryable, id: OutcomeDesignation['id']): Promise<OutcomeDesignation | undefined> {
    return findRow(db, outcomeDesignationTable, { id });
  },

  /** Live designations, of one type or all, oldest first. */
  async listLive(db: Queryable, objectTypeId?: string): Promise<OutcomeDesignation[]> {
    const { rows } = await db.query(
      `select ${outcomeDesignationTable.select} from recognition.outcome_designations
        where revoked_at is null and ($1::uuid is null or object_type_id = $1)
        order by designated_at, id`, [objectTypeId ?? null]);
    return rows as OutcomeDesignation[];
  },

  /** The live designation of the same outcome, if one exists. */
  async findLive(db: Queryable, objectTypeId: string, outcome: { property: string | null; detectorId: string | null }): Promise<OutcomeDesignation | undefined> {
    const { rows } = await db.query(
      `select ${outcomeDesignationTable.select} from recognition.outcome_designations
        where revoked_at is null and object_type_id = $1 and property is not distinct from $2 and detector_id is not distinct from $3`,
      [objectTypeId, outcome.property, outcome.detectorId]);
    return rows[0] as OutcomeDesignation | undefined;
  },

  /** Revoked once; a revoked designation is not revoked again. */
  async revoke(db: Queryable, id: string, by: string, at: string): Promise<OutcomeDesignation | undefined> {
    const { rows } = await db.query(
      `update recognition.outcome_designations set revoked_by = $2, revoked_at = $3
        where id = $1 and revoked_at is null returning ${outcomeDesignationTable.select}`, [id, by, at]);
    return rows[0] as OutcomeDesignation | undefined;
  },
};
