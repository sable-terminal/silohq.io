// Data access for recognition.findings, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  findingTable,
  type Finding,
  type FindingChanges,
  type NewFinding,
} from '../../models/recognition/finding.model.ts';

export const findingRepo = {
  insert(db: Queryable, row: NewFinding): Promise<Finding> {
    return insertRow(db, findingTable, row);
  },

  findById(db: Queryable, id: Finding['id']): Promise<Finding | undefined> {
    return findRow(db, findingTable, { id });
  },

  update(db: Queryable, id: Finding['id'], changes: FindingChanges): Promise<Finding | undefined> {
    return updateRow(db, findingTable, { id }, changes);
  },

  /** Marks a detector's current findings on a type superseded: a later run states the facts afresh. */
  async supersedeCurrent(db: Queryable, detectorId: string, objectTypeId: string, at: string): Promise<number> {
    const { rowCount } = await db.query(
      `update recognition.findings set superseded_at = $3, version = version + 1
        where detector_id = $1 and object_type_id = $2 and superseded_at is null`, [detectorId, objectTypeId, at]);
    return rowCount ?? 0;
  },

  async list(db: Queryable, filter: {
    objectTypeId?: string; objectTypeIds?: readonly string[]; detectorId?: string; includeSuperseded: boolean; ids?: readonly string[];
    /** Raised after this moment (Home's "new findings", spec 33.7). */
    raisedSince?: string; limit: number;
  }): Promise<Finding[]> {
    const params: unknown[] = [];
    const terms: string[] = [];
    const add = (sql: (n: number) => string, value: unknown): void => { params.push(value); terms.push(sql(params.length)); };
    if (filter.objectTypeId !== undefined) add((n) => `object_type_id = $${n}`, filter.objectTypeId);
    if (filter.detectorId !== undefined) add((n) => `detector_id = $${n}`, filter.detectorId);
    if (filter.ids !== undefined) add((n) => `id = any($${n}::uuid[])`, filter.ids);
    if (filter.objectTypeIds !== undefined) add((n) => `object_type_id = any($${n}::uuid[])`, filter.objectTypeIds);
    if (filter.raisedSince !== undefined) add((n) => `raised_at > $${n}`, filter.raisedSince);
    if (!filter.includeSuperseded) terms.push('superseded_at is null');
    params.push(filter.limit);
    const { rows } = await db.query(
      `select ${findingTable.select} from recognition.findings ${terms.length > 0 ? `where ${terms.join(' and ')}` : ''}
       order by raised_at desc, id limit $${params.length}`, params);
    return rows as Finding[];
  },

  /** The property names each detector's current findings examine, per type (38.6, 38.11). */
  async currentPropertiesBy(db: Queryable, objectTypeIds: readonly string[]): Promise<{ objectTypeId: string; detectorId: string; properties: string[] }[]> {
    if (objectTypeIds.length === 0) return [];
    const { rows } = await db.query(
      `select f.object_type_id as "objectTypeId", f.detector_id as "detectorId", array_agg(distinct p order by p) as properties
         from recognition.findings f, unnest(f.properties) as p
        where f.superseded_at is null and f.object_type_id = any($1::uuid[])
        group by 1, 2`, [objectTypeIds]);
    return rows as { objectTypeId: string; detectorId: string; properties: string[] }[];
  },

  /** Optimistic: undefined when the finding moved since it was read. */
  async dispositionAtVersion(db: Queryable, id: string, version: number, change: { disposition: NonNullable<Finding['orgDisposition']>; by: string; at: string })
    : Promise<Finding | undefined> {
    const { rows } = await db.query(
      `update recognition.findings set org_disposition = $3, org_disposition_by = $4, org_disposition_at = $5, version = version + 1
        where id = $1 and version = $2 returning ${findingTable.select}`, [id, version, change.disposition, change.by, change.at]);
    return rows[0] as Finding | undefined;
  },

  /**
   * Organisation dispositions on a detector's findings for a type (and a property, when the
   * threshold is per property) recorded after a moment: the evidence for tuning (spec 38.5).
   */
  async dispositionsSince(db: Queryable, detectorId: string, objectTypeId: string, property: string | null, since: string)
    : Promise<{ confirmed: number; dismissed: number; deferred: number }> {
    const { rows } = await db.query(
      `select count(*) filter (where org_disposition = 'confirmed')::int as confirmed,
              count(*) filter (where org_disposition = 'dismissed')::int as dismissed,
              count(*) filter (where org_disposition = 'deferred')::int as deferred
         from recognition.findings
        where detector_id = $1 and object_type_id = $2 and org_disposition_at > $4
          and ($3::text is null or $3 = any(properties))`, [detectorId, objectTypeId, property, since]);
    return rows[0] as { confirmed: number; dismissed: number; deferred: number };
  },
};
