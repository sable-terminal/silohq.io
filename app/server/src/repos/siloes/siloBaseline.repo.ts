// Data access for siloes.silo_baselines, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app; written by silo_app.
// silo_report may read only some columns, so cannot use these finders, which
// select every column; give them their own query.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  siloBaselineTable,
  type NewSiloBaseline,
  type SiloBaseline,
  type SiloBaselineChanges,
  type SiloBaselinePrimaryKey,
} from '../../models/siloes/siloBaseline.model.ts';

export const siloBaselineRepo = {
  insert(db: Queryable, row: NewSiloBaseline): Promise<SiloBaseline> {
    return insertRow(db, siloBaselineTable, row);
  },

  findByKey(db: Queryable, key: SiloBaselinePrimaryKey): Promise<SiloBaseline | undefined> {
    return findRow(db, siloBaselineTable, key);
  },

  update(
    db: Queryable,
    key: SiloBaselinePrimaryKey,
    changes: SiloBaselineChanges,
  ): Promise<SiloBaseline | undefined> {
    return updateRow(db, siloBaselineTable, key, changes);
  },

  /** The baselines of the keys asked about, in one read. */
  async findMany(db: Queryable, siloId: string, keys: { objectTypeId: string; objectRef: string; property: string }[]): Promise<SiloBaseline[]> {
    if (keys.length === 0) return [];
    const { rows } = await db.query(
      `select ${siloBaselineTable.select} from siloes.silo_baselines
       where silo_id = $1 and (object_type_id, object_ref, property) in (select * from unnest($2::uuid[], $3::text[], $4::text[]))`,
      [siloId, keys.map((k) => k.objectTypeId), keys.map((k) => k.objectRef), keys.map((k) => k.property)]);
    return rows as SiloBaseline[];
  },

  /** A type's baselines for these objects and properties (30.8). */
  async forObjects(db: Queryable, siloId: string, objectTypeId: string, objectRefs: readonly string[], properties: readonly string[]): Promise<SiloBaseline[]> {
    const { rows } = await db.query(
      `select ${siloBaselineTable.select} from siloes.silo_baselines
       where silo_id = $1 and object_type_id = $2 and object_ref = any($3) and property = any($4)`, [siloId, objectTypeId, objectRefs, properties]);
    return rows as SiloBaseline[];
  },

  /** Writes baselines: new ones inserted, existing ones moved on. */
  async upsertMany(db: Queryable, rows: NewSiloBaseline[]): Promise<void> {
    if (rows.length === 0) return;
    await db.query(
      `insert into siloes.silo_baselines (organisation_id, silo_id, object_type_id, object_ref, property, last_observed_value, last_seen_at, first_seen_at)
       select o, s, t, r, p, v, at, at from unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::bytea[], $7::timestamptz[]) as u(o, s, t, r, p, v, at)
       on conflict (organisation_id, silo_id, object_type_id, object_ref, property)
       do update set last_observed_value = excluded.last_observed_value, last_seen_at = excluded.last_seen_at`,
      [rows.map((r) => r.organisationId), rows.map((r) => r.siloId), rows.map((r) => r.objectTypeId), rows.map((r) => r.objectRef),
        rows.map((r) => r.property), rows.map((r) => r.lastObservedValue), rows.map((r) => r.lastSeenAt)]);
  },
};
