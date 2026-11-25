// Data access for recognition.finding_markings, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  findingMarkingTable,
  type FindingMarking,
  type FindingMarkingPrimaryKey,
  type NewFindingMarking,
} from '../../models/recognition/findingMarking.model.ts';

export const findingMarkingRepo = {
  insert(db: Queryable, row: NewFindingMarking): Promise<FindingMarking> {
    return insertRow(db, findingMarkingTable, row);
  },

  findByKey(db: Queryable, key: FindingMarkingPrimaryKey): Promise<FindingMarking | undefined> {
    return findRow(db, findingMarkingTable, key);
  },

  async insertMany(db: Queryable, organisationId: string, rows: readonly { findingId: string; markingId: string }[]): Promise<void> {
    if (rows.length === 0) return;
    await db.query(
      `insert into recognition.finding_markings (organisation_id, finding_id, marking_id)
       select $1, f, m from unnest($2::uuid[], $3::uuid[]) as u (f, m) on conflict do nothing`,
      [organisationId, rows.map((r) => r.findingId), rows.map((r) => r.markingId)]);
  },

  async listFor(db: Queryable, findingIds: readonly string[]): Promise<{ findingId: string; markingId: string }[]> {
    if (findingIds.length === 0) return [];
    const { rows } = await db.query(
      `select finding_id as "findingId", marking_id as "markingId" from recognition.finding_markings
        where finding_id = any($1::uuid[]) order by finding_id, marking_id`, [findingIds]);
    return rows as { findingId: string; markingId: string }[];
  },

  /** The markings on each detector's current findings, per type: what reading a population of them needs (38.11). */
  async currentMarkingsBy(db: Queryable, objectTypeIds: readonly string[]): Promise<{ objectTypeId: string; detectorId: string; markingId: string }[]> {
    if (objectTypeIds.length === 0) return [];
    const { rows } = await db.query(
      `select distinct f.object_type_id as "objectTypeId", f.detector_id as "detectorId", m.marking_id as "markingId"
         from recognition.finding_markings m
         join recognition.findings f on f.organisation_id = m.organisation_id and f.id = m.finding_id and f.superseded_at is null
        where f.object_type_id = any($1::uuid[])`, [objectTypeIds]);
    return rows as { objectTypeId: string; detectorId: string; markingId: string }[];
  },
};
