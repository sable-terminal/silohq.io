// Data access for ontology.object_type_versions, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  objectTypeVersionTable,
  type NewObjectTypeVersion,
  type ObjectTypeVersion,
  type ObjectTypeVersionChanges,
} from '../../models/ontology/objectTypeVersion.model.ts';

export const objectTypeVersionRepo = {
  insert(db: Queryable, row: NewObjectTypeVersion): Promise<ObjectTypeVersion> {
    return insertRow(db, objectTypeVersionTable, row);
  },

  findById(db: Queryable, id: ObjectTypeVersion['id']): Promise<ObjectTypeVersion | undefined> {
    return findRow(db, objectTypeVersionTable, { id });
  },

  findByObjectTypeIdAndOntologyVersionId(
    db: Queryable,
    key: Pick<ObjectTypeVersion, 'organisationId' | 'objectTypeId' | 'ontologyVersionId'>,
  ): Promise<ObjectTypeVersion | undefined> {
    return findRow(db, objectTypeVersionTable, key);
  },

  update(
    db: Queryable,
    id: ObjectTypeVersion['id'],
    changes: ObjectTypeVersionChanges,
  ): Promise<ObjectTypeVersion | undefined> {
    return updateRow(db, objectTypeVersionTable, { id }, changes);
  },

  /**
   * The latest type version of each object type in a version chain (ids, depths and the
   * main flag parallel), and whether the type has any version on main in that chain.
   */
  async latestInChain(db: Queryable, chain: { id: string; depth: number; onMain: boolean }[])
    : Promise<{ objectTypeId: string; typeVersionId: string; onMain: boolean }[]> {
    const { rows } = await db.query(
      `with c as (select * from unnest($1::uuid[], $2::int[], $3::bool[]) as c(cid, cdepth, con_main)),
            e as (select v.object_type_id, v.id, c.cdepth, c.con_main
                    from ontology.object_type_versions v join c on c.cid = v.ontology_version_id)
       select distinct on (object_type_id) object_type_id as "objectTypeId", id as "typeVersionId",
              bool_or(con_main) over (partition by object_type_id) as "onMain"
         from e order by object_type_id, cdepth`,
      [chain.map((c) => c.id), chain.map((c) => c.depth), chain.map((c) => c.onMain)]);
    return rows as { objectTypeId: string; typeVersionId: string; onMain: boolean }[];
  },

  async listByIds(db: Queryable, ids: readonly string[]): Promise<ObjectTypeVersion[]> {
    if (ids.length === 0) return [];
    const { rows } = await db.query(`select ${objectTypeVersionTable.select} from ontology.object_type_versions where id = any($1::uuid[])`, [ids]);
    return rows as ObjectTypeVersion[];
  },
};
