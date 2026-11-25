// Data access for siloes.silo_object_types, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  siloObjectTypeTable,
  type NewSiloObjectType,
  type SiloObjectType,
  type SiloObjectTypeChanges,
} from '../../models/siloes/siloObjectType.model.ts';

export const siloObjectTypeRepo = {
  insert(db: Queryable, row: NewSiloObjectType): Promise<SiloObjectType> {
    return insertRow(db, siloObjectTypeTable, row);
  },

  findById(db: Queryable, id: SiloObjectType['id']): Promise<SiloObjectType | undefined> {
    return findRow(db, siloObjectTypeTable, { id });
  },

  update(
    db: Queryable,
    id: SiloObjectType['id'],
    changes: SiloObjectTypeChanges,
  ): Promise<SiloObjectType | undefined> {
    return updateRow(db, siloObjectTypeTable, { id }, changes);
  },

  /** The object types a Silo holds now, with their nominated properties. */
  async listLive(db: Queryable, siloId: string): Promise<SiloObjectType[]> {
    const { rows } = await db.query(
      `select ${siloObjectTypeTable.select} from siloes.silo_object_types
       where silo_id = $1 and removed_at is null order by added_at, id`, [siloId]);
    return rows as SiloObjectType[];
  },

  /**
   * The markings on what a Silo holds (spec 69.16): its nominated types, the properties
   * nominated (by API name in any version of the type), the connections the types are read
   * through, and the Silo itself. Conservative by design: a marking that might cover held
   * data counts. Read whatever the reader may see, so a marking cannot hide itself.
   */
  async markingsOnHeld(db: Queryable, siloId: string): Promise<{ kind: 'object_type' | 'property' | 'connection' | 'silo'; objectTypeId: string | null;
    markingId: string }[]> {
    const { rows } = await db.query(
      `with nominated as (
         select n.object_type_id, unnest(n.nominated_properties) as api_name from siloes.silo_object_types n
         where n.silo_id = $1 and n.removed_at is null
       ), types as (select distinct object_type_id from nominated)
       select 'object_type' as kind, m.object_type_id as "objectTypeId", m.marking_id as "markingId"
         from iam.object_type_markings m where m.object_type_id in (select object_type_id from types)
       union
       select 'property', v.object_type_id, r.marking_id
         from gov.resource_markings r
         join ontology.properties p on p.organisation_id = r.organisation_id and p.property_identity_id = r.property_id
         join ontology.object_type_versions v on v.organisation_id = p.organisation_id and v.id = p.object_type_version_id
         join nominated n on n.object_type_id = v.object_type_id and n.api_name = p.api_name
       union
       select 'connection', v.object_type_id, r.marking_id
         from gov.resource_markings r
         join ontology.contributing_objects c on c.organisation_id = r.organisation_id and c.connection_id = r.connection_id
         join ontology.object_type_versions v on v.organisation_id = c.organisation_id and v.id = c.object_type_version_id
         where v.object_type_id in (select object_type_id from types)
       union
       select 'silo', null, r.marking_id from gov.resource_markings r where r.silo_id = $1`, [siloId]);
    return rows as { kind: 'object_type' | 'property' | 'connection' | 'silo'; objectTypeId: string | null; markingId: string }[];
  },

  /** The live Capture nominations of the types asked about, in Capture Siloes taking observations. */
  /** Every nomination of a type in a Silo, live and removed, oldest first: when it was captured (30.8). */
  async historyFor(db: Queryable, siloId: string, objectTypeId: string): Promise<SiloObjectType[]> {
    const { rows } = await db.query(
      `select ${siloObjectTypeTable.select} from siloes.silo_object_types where silo_id = $1 and object_type_id = $2 order by added_at, id`,
      [siloId, objectTypeId]);
    return rows as SiloObjectType[];
  },

  async liveCaptureFor(db: Queryable, objectTypeIds: readonly string[]): Promise<SiloObjectType[]> {
    if (objectTypeIds.length === 0) return [];
    const { rows } = await db.query(
      `select ${siloObjectTypeTable.select} from siloes.silo_object_types n
       where n.object_type_id = any($1::uuid[]) and n.removed_at is null
         and exists (select 1 from siloes.siloes s where s.organisation_id = n.organisation_id and s.id = n.silo_id
                     and ((s.kind = 'capture' and s.status = 'active')
                          -- A Warehouse serves while provisioning: it is active only once it answers as a source (69.16).
                          or (s.kind = 'warehouse' and s.status in ('provisioning', 'active'))))`, [objectTypeIds]);
    return rows as SiloObjectType[];
  },

  async findLive(db: Queryable, siloId: string, objectTypeId: string): Promise<SiloObjectType | undefined> {
    const { rows } = await db.query(
      `select ${siloObjectTypeTable.select} from siloes.silo_object_types where silo_id = $1 and object_type_id = $2 and removed_at is null`,
      [siloId, objectTypeId]);
    return rows[0] as SiloObjectType | undefined;
  },

  /** Ends every nomination of a Silo (disable and purge). */
  async endAll(db: Queryable, siloId: string, at: string): Promise<number> {
    const { rowCount } = await db.query(
      `update siloes.silo_object_types set removed_at = $2, version = version + 1 where silo_id = $1 and removed_at is null`, [siloId, at]);
    return rowCount ?? 0;
  },
};
