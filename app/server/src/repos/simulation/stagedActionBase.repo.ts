// Data access for simulation.staged_action_bases, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app; written by silo_app.
// silo_report may read only some columns, so cannot use these finders, which
// select every column; give them their own query.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  stagedActionBaseTable,
  type NewStagedActionBase,
  type StagedActionBase,
  type StagedActionBaseChanges,
} from '../../models/simulation/stagedActionBase.model.ts';

export const stagedActionBaseRepo = {
  insert(db: Queryable, row: NewStagedActionBase): Promise<StagedActionBase> {
    return insertRow(db, stagedActionBaseTable, row);
  },

  findById(db: Queryable, id: StagedActionBase['id']): Promise<StagedActionBase | undefined> {
    return findRow(db, stagedActionBaseTable, { id });
  },

  findByStagedActionIdAndConnectionIdAndObjectTypeIdAndObjectKeyAndProperty(
    db: Queryable,
    key: Pick<StagedActionBase, 'organisationId' | 'stagedActionId' | 'connectionId' | 'objectTypeId' | 'objectKey' | 'property'>,
  ): Promise<StagedActionBase | undefined> {
    return findRow(db, stagedActionBaseTable, key);
  },

  update(
    db: Queryable,
    id: StagedActionBase['id'],
    changes: StagedActionBaseChanges,
  ): Promise<StagedActionBase | undefined> {
    return updateRow(db, stagedActionBaseTable, { id }, changes);
  },

  listForStagedAction(db: Queryable, stagedActionId: string): Promise<StagedActionBase[]> {
    return db.query(`select ${stagedActionBaseTable.select} from simulation.staged_action_bases where staged_action_id = $1 order by id`, [stagedActionId])
      .then((r) => r.rows as StagedActionBase[]);
  },

  /** A re-staged base: the value now and the staged value replace what was read before. */
  async upsert(db: Queryable, row: NewStagedActionBase): Promise<void> {
    await db.query(
      `insert into simulation.staged_action_bases (id, organisation_id, staged_action_id, object_type_id, object_key, connection_id, property, base_value, staged_value, read_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict on constraint staged_action_bases_target_key
       do update set base_value = excluded.base_value, staged_value = excluded.staged_value, read_at = excluded.read_at`,
      [row.id, row.organisationId, row.stagedActionId, row.objectTypeId, row.objectKey, row.connectionId, row.property, row.baseValue, row.stagedValue, row.readAt]);
  },
};
