// Data access for ontology.property_mappings, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  propertyMappingTable,
  type NewPropertyMapping,
  type PropertyMapping,
} from '../../models/ontology/propertyMapping.model.ts';

export const propertyMappingRepo = {
  insert(db: Queryable, row: NewPropertyMapping): Promise<PropertyMapping> {
    return insertRow(db, propertyMappingTable, row);
  },

  findById(db: Queryable, id: PropertyMapping['id']): Promise<PropertyMapping | undefined> {
    return findRow(db, propertyMappingTable, { id });
  },

  findByObjectTypeVersionIdAndPropertyIdAndConnectionIdAndSourceObject(
    db: Queryable,
    key: Pick<PropertyMapping, 'organisationId' | 'objectTypeVersionId' | 'propertyId' | 'connectionId' | 'sourceObject'>,
  ): Promise<PropertyMapping | undefined> {
    return findRow(db, propertyMappingTable, key);
  },

  /** One type version's rows with their property's identity and API name, in property order. */
  async listWithProperties(db: Queryable, typeVersionId: string)
    : Promise<{ id: string; propertyIdentityId: string; apiName: string; connectionId: string; sourceObject: string; fieldPath: string }[]> {
    const { rows } = await db.query(
      `select pm.id, p.property_identity_id as "propertyIdentityId", p.api_name as "apiName", pm.connection_id as "connectionId",
              pm.source_object as "sourceObject", pm.field_path as "fieldPath"
         from ontology.property_mappings pm
         join ontology.properties p on p.organisation_id = pm.organisation_id and p.id = pm.property_id
        where pm.object_type_version_id = $1 order by p.api_name, pm.connection_id, pm.field_path`, [typeVersionId]);
    return rows as { id: string; propertyIdentityId: string; apiName: string; connectionId: string; sourceObject: string; fieldPath: string }[];
  },

  /** The rows of these object type versions. */
  async listForVersions(db: Queryable, typeVersionIds: readonly string[]): Promise<PropertyMapping[]> {
    if (typeVersionIds.length === 0) return [];
    const { rows } = await db.query(
      `select ${propertyMappingTable.select} from ontology.property_mappings where object_type_version_id = any($1::uuid[])`, [typeVersionIds]);
    return rows as PropertyMapping[];
  },
};
