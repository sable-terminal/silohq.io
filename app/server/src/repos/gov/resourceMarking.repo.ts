// Data access for gov.resource_markings, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { deleteRow, findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  resourceMarkingTable,
  type NewResourceMarking,
  type ResourceMarking,
} from '../../models/gov/resourceMarking.model.ts';

/** The resources gov.resource_markings marks; object types are marked in iam.object_type_markings. */
export type MarkableResource = 'connection' | 'property_mapping' | 'property' | 'link_type' | 'action_type' | 'silo' | 'view' | 'app'
  | 'function' | 'interface';

// The arc's column per resource type: a closed map, so no caller's text reaches the statement.
const RESOURCE_COLUMNS: Record<MarkableResource, string> = {
  connection: 'connection_id', property_mapping: 'property_mapping_id', property: 'property_id', link_type: 'link_type_id',
  action_type: 'action_type_id', silo: 'silo_id', view: 'view_id', app: 'app_id', function: 'function_id', interface: 'interface_id',
};

export const resourceMarkingRepo = {
  insert(db: Queryable, row: NewResourceMarking): Promise<ResourceMarking> {
    return insertRow(db, resourceMarkingTable, row);
  },

  findById(db: Queryable, id: ResourceMarking['id']): Promise<ResourceMarking | undefined> {
    return findRow(db, resourceMarkingTable, { id });
  },

  remove(db: Queryable, id: ResourceMarking['id']): Promise<boolean> {
    return deleteRow(db, resourceMarkingTable, { id });
  },

  /** The direct markings on these resources of one type (spec 58.3). */
  async markingsFor(db: Queryable, type: MarkableResource, ids: readonly string[]): Promise<{ resourceId: string; markingId: string }[]> {
    if (ids.length === 0) return [];
    const column = RESOURCE_COLUMNS[type];
    const { rows } = await db.query(
      `select ${column} as "resourceId", marking_id as "markingId" from gov.resource_markings where ${column} = any($1::uuid[])`, [ids]);
    return rows as { resourceId: string; markingId: string }[];
  },

  /**
   * Markings on source fields, by connection and field path: a marking on any mapping of the
   * field, in any version of a type, holds for the field (58.3, 21.15).
   */
  async fieldMarkings(db: Queryable, fields: readonly { connectionId: string; path: string }[])
    : Promise<{ connectionId: string; path: string; markingId: string }[]> {
    if (fields.length === 0) return [];
    const { rows } = await db.query(
      `select distinct pm.connection_id as "connectionId", pm.field_path as "path", rm.marking_id as "markingId"
         from gov.resource_markings rm
         join ontology.property_mappings pm on pm.organisation_id = rm.organisation_id and pm.id = rm.property_mapping_id
        where (pm.connection_id, pm.field_path) in (select * from unnest($1::uuid[], $2::text[]))`,
      [fields.map((f) => f.connectionId), fields.map((f) => f.path)]);
    return rows as { connectionId: string; path: string; markingId: string }[];
  },

  /** The markings of the source fields these properties (identities) map, in any version: a property is never less restricted (21.15). */
  async mappedFieldMarkings(db: Queryable, propertyIdentityIds: readonly string[]): Promise<{ resourceId: string; markingId: string }[]> {
    if (propertyIdentityIds.length === 0) return [];
    const { rows } = await db.query(
      `select distinct p.property_identity_id as "resourceId", rm.marking_id as "markingId"
         from ontology.properties p
         join ontology.property_mappings pm on pm.organisation_id = p.organisation_id and pm.property_id = p.id
         join ontology.property_mappings marked on marked.organisation_id = pm.organisation_id and marked.connection_id = pm.connection_id
              and marked.source_object = pm.source_object and marked.field_path = pm.field_path
         join gov.resource_markings rm on rm.organisation_id = marked.organisation_id and rm.property_mapping_id = marked.id
        where p.property_identity_id = any($1::uuid[])`, [propertyIdentityIds]);
    return rows as { resourceId: string; markingId: string }[];
  },

  /** One resource's direct markings. */
  async listFor(db: Queryable, type: MarkableResource, id: string): Promise<ResourceMarking[]> {
    const { rows } = await db.query(
      `select ${resourceMarkingTable.select} from gov.resource_markings where ${RESOURCE_COLUMNS[type]} = $1 order by applied_at`, [id]);
    return rows as ResourceMarking[];
  },
};
