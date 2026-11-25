// Data access for recognition.finding_objects, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  findingObjectTable,
  type FindingObject,
  type FindingObjectPrimaryKey,
  type NewFindingObject,
} from '../../models/recognition/findingObject.model.ts';

export const findingObjectRepo = {
  insert(db: Queryable, row: NewFindingObject): Promise<FindingObject> {
    return insertRow(db, findingObjectTable, row);
  },

  findByKey(db: Queryable, key: FindingObjectPrimaryKey): Promise<FindingObject | undefined> {
    return findRow(db, findingObjectTable, key);
  },

  async insertMany(db: Queryable, organisationId: string, rows: readonly { findingId: string; objectTypeId: string; objectKey: string }[]): Promise<void> {
    if (rows.length === 0) return;
    await db.query(
      `insert into recognition.finding_objects (organisation_id, finding_id, object_type_id, object_key)
       select $1, f, t, k from unnest($2::uuid[], $3::uuid[], $4::text[]) as u (f, t, k)`,
      [organisationId, rows.map((r) => r.findingId), rows.map((r) => r.objectTypeId), rows.map((r) => r.objectKey)]);
  },

  /** The current findings on one object (the findings panel, spec 38.10). */
  async currentFindingsOn(db: Queryable, objectTypeId: string, objectKey: string, limit: number): Promise<string[]> {
    const { rows } = await db.query(
      `select fo.finding_id as id from recognition.finding_objects fo
         join recognition.findings f on f.organisation_id = fo.organisation_id and f.id = fo.finding_id and f.superseded_at is null
        where fo.object_type_id = $1 and fo.object_key = $2 order by f.raised_at desc limit $3`, [objectTypeId, objectKey, limit]);
    return rows.map((r: { id: string }) => r.id);
  },

  async listFor(db: Queryable, findingIds: readonly string[]): Promise<{ findingId: string; objectKey: string }[]> {
    if (findingIds.length === 0) return [];
    const { rows } = await db.query(
      `select finding_id as "findingId", object_key as "objectKey" from recognition.finding_objects
        where finding_id = any($1::uuid[]) order by finding_id, object_key`, [findingIds]);
    return rows as { findingId: string; objectKey: string }[];
  },

  /**
   * Every object a detector's current findings name, per type and detector (38.6), with when
   * its current episode began (the first run naming it since one that examined it and did
   * not, by run start) and the latest such run. Moments in ms since the epoch.
   */
  async currentEpisodes(db: Queryable, limit: number): Promise<{
    objectTypeId: string; detectorId: string; objectKey: string; episodeStartMs: number; lastAbsentMs: number | null;
  }[]> {
    const { rows } = await db.query(
      `with cur as (
         select fo.organisation_id, fo.object_type_id, f.detector_id, fo.object_key
           from recognition.finding_objects fo
           join recognition.findings f on f.organisation_id = fo.organisation_id and f.id = fo.finding_id and f.superseded_at is null
          group by 1, 2, 3, 4 order by 2, 3, 4 limit $1),
       named as (
         select c.object_type_id, c.detector_id, c.object_key, r.id as run_id, r.started_at
           from cur c
           join recognition.finding_objects fo on fo.organisation_id = c.organisation_id and fo.object_type_id = c.object_type_id and fo.object_key = c.object_key
           join recognition.findings f on f.organisation_id = fo.organisation_id and f.id = fo.finding_id and f.detector_id = c.detector_id
           join recognition.detector_runs r on r.organisation_id = f.organisation_id and r.id = f.detector_run_id),
       absent as (
         select c.object_type_id, c.detector_id, c.object_key, max(r.started_at) as last_absent
           from cur c
           join recognition.detector_runs r
             on r.organisation_id = c.organisation_id and r.object_type_id = c.object_type_id and r.detector_id = c.detector_id and r.state = 'ran'
          where not exists (select 1 from named n where n.run_id = r.id and n.object_key = c.object_key)
          group by 1, 2, 3)
       select c.object_type_id as "objectTypeId", c.detector_id as "detectorId", c.object_key as "objectKey",
              (extract(epoch from min(n.started_at) filter (where a.last_absent is null or n.started_at > a.last_absent)) * 1000)::float8 as "episodeStartMs",
              (extract(epoch from a.last_absent) * 1000)::float8 as "lastAbsentMs"
         from cur c
         join named n on n.object_type_id = c.object_type_id and n.detector_id = c.detector_id and n.object_key = c.object_key
         left join absent a on a.object_type_id = c.object_type_id and a.detector_id = c.detector_id and a.object_key = c.object_key
        group by c.object_type_id, c.detector_id, c.object_key, a.last_absent
        order by 1, 2, 3`, [limit]);
    return rows as { objectTypeId: string; detectorId: string; objectKey: string; episodeStartMs: number; lastAbsentMs: number | null }[];
  },

  /** Current findings naming the same objects as these: the pairs to link, with the objects they share. */
  async sharedWithCurrent(db: Queryable, findingIds: readonly string[]): Promise<{ findingId: string; linkedFindingId: string; shared: number }[]> {
    if (findingIds.length === 0) return [];
    const { rows } = await db.query(
      `select a.finding_id as "findingId", b.finding_id as "linkedFindingId", count(*)::int as shared
         from recognition.finding_objects a
         join recognition.finding_objects b
           on b.organisation_id = a.organisation_id and b.object_type_id = a.object_type_id and b.object_key = a.object_key
          and b.finding_id <> a.finding_id
         join recognition.findings f on f.organisation_id = b.organisation_id and f.id = b.finding_id and f.superseded_at is null
        where a.finding_id = any($1::uuid[])
        group by 1, 2`, [findingIds]);
    return rows as { findingId: string; linkedFindingId: string; shared: number }[];
  },
};
