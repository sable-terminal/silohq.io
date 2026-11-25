// Data access for ontology.contributing_objects, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  contributingObjectTable,
  type ContributingObject,
  type NewContributingObject,
} from '../../models/ontology/contributingObject.model.ts';

export const contributingObjectRepo = {
  insert(db: Queryable, row: NewContributingObject): Promise<ContributingObject> {
    return insertRow(db, contributingObjectTable, row);
  },

  findById(db: Queryable, id: ContributingObject['id']): Promise<ContributingObject | undefined> {
    return findRow(db, contributingObjectTable, { id });
  },

  findByObjectTypeVersionIdAndConnectionIdAndSourceObject(
    db: Queryable,
    key: Pick<ContributingObject, 'organisationId' | 'objectTypeVersionId' | 'connectionId' | 'sourceObject'>,
  ): Promise<ContributingObject | undefined> {
    return findRow(db, contributingObjectTable, key);
  },

  /** The rows of these object type versions. */
  async listForVersions(db: Queryable, typeVersionIds: readonly string[]): Promise<ContributingObject[]> {
    if (typeVersionIds.length === 0) return [];
    const { rows } = await db.query(
      `select ${contributingObjectTable.select} from ontology.contributing_objects where object_type_version_id = any($1::uuid[])`, [typeVersionIds]);
    return rows as ContributingObject[];
  },
};
