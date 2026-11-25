// Data access for action.action_parameters, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  actionParameterTable,
  type ActionParameter,
  type NewActionParameter,
} from '../../models/action/actionParameter.model.ts';

export const actionParameterRepo = {
  insert(db: Queryable, row: NewActionParameter): Promise<ActionParameter> {
    return insertRow(db, actionParameterTable, row);
  },

  findById(db: Queryable, id: ActionParameter['id']): Promise<ActionParameter | undefined> {
    return findRow(db, actionParameterTable, { id });
  },

  findByActionTypeVersionIdAndName(
    db: Queryable,
    key: Pick<ActionParameter, 'organisationId' | 'actionTypeVersionId' | 'name'>,
  ): Promise<ActionParameter | undefined> {
    return findRow(db, actionParameterTable, key);
  },

  findByActionTypeVersionIdAndSequence(
    db: Queryable,
    key: Pick<ActionParameter, 'organisationId' | 'actionTypeVersionId' | 'sequence'>,
  ): Promise<ActionParameter | undefined> {
    return findRow(db, actionParameterTable, key);
  },

  async listByVersion(db: Queryable, actionTypeVersionId: string): Promise<ActionParameter[]> {
    const { rows } = await db.query(
      `select ${actionParameterTable.select} from action.action_parameters where action_type_version_id = $1 order by sequence`, [actionTypeVersionId]);
    return rows as ActionParameter[];
  },
};
