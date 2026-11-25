// Data access for action.action_types, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  actionTypeTable,
  type ActionType,
  type ActionTypeChanges,
  type NewActionType,
} from '../../models/action/actionType.model.ts';

export const actionTypeRepo = {
  insert(db: Queryable, row: NewActionType): Promise<ActionType> {
    return insertRow(db, actionTypeTable, row);
  },

  findById(db: Queryable, id: ActionType['id']): Promise<ActionType | undefined> {
    return findRow(db, actionTypeTable, { id });
  },

  findByApiName(
    db: Queryable,
    key: Pick<ActionType, 'organisationId' | 'apiName'>,
  ): Promise<ActionType | undefined> {
    return findRow(db, actionTypeTable, key);
  },

  /** The organisation's silo.edit row (42.9), if it has been made. */
  async findSystem(db: Queryable): Promise<ActionType | undefined> {
    const { rows } = await db.query(`select ${actionTypeTable.select} from action.action_types where is_system`, []);
    return rows[0] as ActionType | undefined;
  },

  /** Makes silo.edit, proposed by Silo itself (no proposer); a row already there wins. */
  async insertSystemIfAbsent(db: Queryable, row: Pick<ActionType, 'id' | 'organisationId' | 'apiName' | 'displayName' | 'owningScopeId'>): Promise<void> {
    await db.query(
      `insert into action.action_types (id, organisation_id, api_name, display_name, owning_scope_id, is_system)
       values ($1, $2, $3, $4, $5, true) on conflict do nothing`,
      [row.id, row.organisationId, row.apiName, row.displayName, row.owningScopeId]);
  },

  update(db: Queryable, id: ActionType['id'], changes: ActionTypeChanges): Promise<ActionType | undefined> {
    return updateRow(db, actionTypeTable, { id }, changes);
  },

  /** Newest first, optionally by status. silo.edit is not listed: it is read through the settings (42.9). */
  async list(db: Queryable, status: ActionType['status'] | undefined, limit: number): Promise<ActionType[]> {
    const { rows } = await db.query(
      `select ${actionTypeTable.select} from action.action_types where not is_system and ($1::text is null or status = $1) order by created_at desc limit $2`,
      [status ?? null, limit]);
    return rows as ActionType[];
  },

  /** Locks the row for a version publish, so two publishes number their versions in turn. */
  async findForUpdate(db: Queryable, id: ActionType['id']): Promise<ActionType | undefined> {
    const { rows } = await db.query(`select ${actionTypeTable.select} from action.action_types where id = $1 for update`, [id]);
    return rows[0] as ActionType | undefined;
  },
};
