// Data access for gov.purpose_definitions, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  purposeDefinitionTable,
  type NewPurposeDefinition,
  type PurposeDefinition,
  type PurposeDefinitionChanges,
} from '../../models/gov/purposeDefinition.model.ts';

export const purposeDefinitionRepo = {
  insert(db: Queryable, row: NewPurposeDefinition): Promise<PurposeDefinition> {
    return insertRow(db, purposeDefinitionTable, row);
  },

  findById(db: Queryable, id: PurposeDefinition['id']): Promise<PurposeDefinition | undefined> {
    return findRow(db, purposeDefinitionTable, { id });
  },

  update(
    db: Queryable,
    id: PurposeDefinition['id'],
    changes: PurposeDefinitionChanges,
  ): Promise<PurposeDefinition | undefined> {
    return updateRow(db, purposeDefinitionTable, { id }, changes);
  },

  /** The live definitions a member answers for (spec 55.7). */
  async ownedBy(db: Queryable, ownerMembershipId: string): Promise<PurposeDefinition[]> {
    const { rows } = await db.query(
      `select ${purposeDefinitionTable.select} from gov.purpose_definitions where owner_membership_id = $1 and status <> 'retired' order by id`, [ownerMembershipId]);
    return rows as PurposeDefinition[];
  },

  async list(db: Queryable): Promise<PurposeDefinition[]> {
    const { rows } = await db.query(`select ${purposeDefinitionTable.select} from gov.purpose_definitions order by name`);
    return rows as PurposeDefinition[];
  },

  /** An update at the version read (optimistic): undefined when another change came first. */
  updateAtVersion(db: Queryable, id: PurposeDefinition['id'], version: number, changes: Omit<PurposeDefinitionChanges, 'version'>)
    : Promise<PurposeDefinition | undefined> {
    return updateRow(db, purposeDefinitionTable, { id, version }, { ...changes, version: version + 1 });
  },
};
