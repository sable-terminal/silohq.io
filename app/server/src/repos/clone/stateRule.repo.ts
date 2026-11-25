// Data access for clone.state_rules, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  stateRuleTable,
  type NewStateRule,
  type StateRule,
  type StateRuleChanges,
} from '../../models/clone/stateRule.model.ts';

export const stateRuleRepo = {
  insert(db: Queryable, row: NewStateRule): Promise<StateRule> {
    return insertRow(db, stateRuleTable, row);
  },

  findById(db: Queryable, id: StateRule['id']): Promise<StateRule | undefined> {
    return findRow(db, stateRuleTable, { id });
  },

  findByObjectTypeIdAndVersion(
    db: Queryable,
    key: Pick<StateRule, 'organisationId' | 'objectTypeId' | 'version'>,
  ): Promise<StateRule | undefined> {
    return findRow(db, stateRuleTable, key);
  },

  update(db: Queryable, id: StateRule['id'], changes: StateRuleChanges): Promise<StateRule | undefined> {
    return updateRow(db, stateRuleTable, { id }, changes);
  },

  /** The next version of a type's rules. */
  async nextVersion(db: Queryable, objectTypeId: string): Promise<number> {
    const { rows } = await db.query(
      'select coalesce(max(version), 0) + 1 as next from clone.state_rules where object_type_id = $1', [objectTypeId]);
    return Number((rows[0] as { next: number | string }).next);
  },

  async findForUpdate(db: Queryable, id: string): Promise<StateRule | undefined> {
    const { rows } = await db.query(`select ${stateRuleTable.select} from clone.state_rules where id = $1 for update`, [id]);
    return rows[0] as StateRule | undefined;
  },

  /** The type's confirmed, unretired rule (state_rules_active), locked for replacement. */
  async findActiveForUpdate(db: Queryable, objectTypeId: string): Promise<StateRule | undefined> {
    const { rows } = await db.query(
      `select ${stateRuleTable.select} from clone.state_rules
       where object_type_id = $1 and confirmed_at is not null and retired_at is null for update`, [objectTypeId]);
    return rows[0] as StateRule | undefined;
  },

  async activeFor(db: Queryable, objectTypeIds: readonly string[]): Promise<StateRule[]> {
    if (objectTypeIds.length === 0) return [];
    const { rows } = await db.query(
      `select ${stateRuleTable.select} from clone.state_rules
       where object_type_id = any($1::uuid[]) and confirmed_at is not null and retired_at is null order by object_type_id`, [objectTypeIds]);
    return rows as StateRule[];
  },

  /** Every version of a type's rules, newest first. */
  async listForType(db: Queryable, objectTypeId: string): Promise<StateRule[]> {
    const { rows } = await db.query(
      `select ${stateRuleTable.select} from clone.state_rules where object_type_id = $1 order by version desc`, [objectTypeId]);
    return rows as StateRule[];
  },
};
