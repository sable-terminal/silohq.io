// Data access for iam.field_policies, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  fieldPolicyTable,
  type FieldPolicy,
  type FieldPolicyChanges,
  type NewFieldPolicy,
} from '../../models/iam/fieldPolicy.model.ts';

export const fieldPolicyRepo = {
  insert(db: Queryable, row: NewFieldPolicy): Promise<FieldPolicy> {
    return insertRow(db, fieldPolicyTable, row);
  },

  findById(db: Queryable, id: FieldPolicy['id']): Promise<FieldPolicy | undefined> {
    return findRow(db, fieldPolicyTable, { id });
  },

  update(
    db: Queryable,
    id: FieldPolicy['id'],
    changes: FieldPolicyChanges,
  ): Promise<FieldPolicy | undefined> {
    return updateRow(db, fieldPolicyTable, { id }, changes);
  },

  /**
   * The live field policies on these source fields and properties (spec 57.4), each with
   * the path of the scope it applies to, resolved before any plan exists.
   */
  async liveFor(db: Queryable, targets: { fields: readonly { connectionId: string; path: string }[]; propertyIds: readonly string[] })
    : Promise<(FieldPolicy & { appliesToScopePath: string | null })[]> {
    if (targets.fields.length === 0 && targets.propertyIds.length === 0) return [];
    const columns = fieldPolicyTable.select.split(',').map((c) => `fp.${c.trim()}`).join(', ');
    const { rows } = await db.query(
      `select ${columns}, s.path::text as "appliesToScopePath"
       from iam.field_policies fp
       left join iam.scopes s on s.organisation_id = fp.organisation_id and s.id = fp.applies_to_scope_id
       where fp.retired_at is null
         and ((fp.connection_id, fp.field_path) in (select * from unnest($1::uuid[], $2::text[]))
              or fp.property_id = any($3::uuid[]))`,
      [targets.fields.map((f) => f.connectionId), targets.fields.map((f) => f.path), targets.propertyIds]);
    return rows as (FieldPolicy & { appliesToScopePath: string | null })[];
  },

  async list(db: Queryable, filter: { connectionId?: string | undefined; propertyId?: string | undefined }): Promise<FieldPolicy[]> {
    const { rows } = await db.query(
      `select ${fieldPolicyTable.select} from iam.field_policies
       where retired_at is null and ($1::uuid is null or connection_id = $1) and ($2::uuid is null or property_id = $2)
       order by created_at limit 500`, [filter.connectionId ?? null, filter.propertyId ?? null]);
    return rows as FieldPolicy[];
  },
};
