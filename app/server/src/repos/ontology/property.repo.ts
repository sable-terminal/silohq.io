// Data access for ontology.properties, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import { propertyTable, type NewProperty, type Property } from '../../models/ontology/property.model.ts';

export const propertyRepo = {
  insert(db: Queryable, row: NewProperty): Promise<Property> {
    return insertRow(db, propertyTable, row);
  },

  findById(db: Queryable, id: Property['id']): Promise<Property | undefined> {
    return findRow(db, propertyTable, { id });
  },

  findByPropertyIdentityIdAndObjectTypeVersionId(
    db: Queryable,
    key: Pick<Property, 'organisationId' | 'propertyIdentityId' | 'objectTypeVersionId'>,
  ): Promise<Property | undefined> {
    return findRow(db, propertyTable, key);
  },

  findByObjectTypeVersionIdAndApiName(
    db: Queryable,
    key: Pick<Property, 'organisationId' | 'objectTypeVersionId' | 'apiName'>,
  ): Promise<Property | undefined> {
    return findRow(db, propertyTable, key);
  },

  /** The rows of these object type versions. */
  async listForVersions(db: Queryable, typeVersionIds: readonly string[]): Promise<Property[]> {
    if (typeVersionIds.length === 0) return [];
    const { rows } = await db.query(
      `select ${propertyTable.select} from ontology.properties where object_type_version_id = any($1::uuid[])`, [typeVersionIds]);
    return rows as Property[];
  },
};
