// Data access for action.action_type_versions, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  actionTypeVersionTable,
  type ActionTypeVersion,
  type NewActionTypeVersion,
} from '../../models/action/actionTypeVersion.model.ts';

export const actionTypeVersionRepo = {
  insert(db: Queryable, row: NewActionTypeVersion): Promise<ActionTypeVersion> {
    return insertRow(db, actionTypeVersionTable, row);
  },

  findById(db: Queryable, id: ActionTypeVersion['id']): Promise<ActionTypeVersion | undefined> {
    return findRow(db, actionTypeVersionTable, { id });
  },

  findByActionTypeIdAndVersion(
    db: Queryable,
    key: Pick<ActionTypeVersion, 'organisationId' | 'actionTypeId' | 'version'>,
  ): Promise<ActionTypeVersion | undefined> {
    return findRow(db, actionTypeVersionTable, key);
  },

  /** The newest version of a type bound to an ontology version (silo.edit has one per ontology version it compiled against). */
  async findForOntologyVersion(db: Queryable, actionTypeId: string, ontologyVersionId: string): Promise<ActionTypeVersion | undefined> {
    const { rows } = await db.query(
      `select ${actionTypeVersionTable.select} from action.action_type_versions where action_type_id = $1 and ontology_version_id = $2
       order by version desc limit 1`, [actionTypeId, ontologyVersionId]);
    return rows[0] as ActionTypeVersion | undefined;
  },

  async latestVersionNumber(db: Queryable, actionTypeId: string): Promise<number> {
    const { rows } = await db.query('select coalesce(max(version), 0)::int as n from action.action_type_versions where action_type_id = $1', [actionTypeId]);
    return (rows[0] as { n: number }).n;
  },
};
