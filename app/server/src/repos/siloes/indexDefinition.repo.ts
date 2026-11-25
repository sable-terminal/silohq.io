// Data access for siloes.index_definitions, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  indexDefinitionTable,
  type IndexDefinition,
  type IndexDefinitionChanges,
  type NewIndexDefinition,
} from '../../models/siloes/indexDefinition.model.ts';

export const indexDefinitionRepo = {
  insert(db: Queryable, row: NewIndexDefinition): Promise<IndexDefinition> {
    return insertRow(db, indexDefinitionTable, row);
  },

  findById(db: Queryable, id: IndexDefinition['id']): Promise<IndexDefinition | undefined> {
    return findRow(db, indexDefinitionTable, { id });
  },

  update(
    db: Queryable,
    id: IndexDefinition['id'],
    changes: IndexDefinitionChanges,
  ): Promise<IndexDefinition | undefined> {
    return updateRow(db, indexDefinitionTable, { id }, changes);
  },

  /** An Object Index's definitions, live first, oldest first. */
  async listForSilo(db: Queryable, siloId: string, live: boolean): Promise<IndexDefinition[]> {
    const { rows } = await db.query(
      `select ${indexDefinitionTable.select} from siloes.index_definitions
       where silo_id = $1 and ($2::boolean is false or removed_at is null) order by added_at, id`, [siloId, live]);
    return rows as IndexDefinition[];
  },

  /** The live definitions of the object types asked about, in Object Indexes that are not disabled. */
  async liveForTypes(db: Queryable, objectTypeIds: readonly string[]): Promise<IndexDefinition[]> {
    if (objectTypeIds.length === 0) return [];
    const { rows } = await db.query(
      `select ${indexDefinitionTable.select} from siloes.index_definitions d
       where d.object_type_id = any($1::uuid[]) and d.removed_at is null
         and exists (select 1 from siloes.siloes s where s.organisation_id = d.organisation_id and s.id = d.silo_id and s.disabled_at is null)
       order by d.last_refreshed_at desc nulls last, d.id`, [objectTypeIds]);
    return rows as IndexDefinition[];
  },

  /** The definitions due a scheduled refresh, across organisations: identifiers only. */
  async listDue(db: Queryable, limit: number): Promise<{ organisationId: string; id: string }[]> {
    const { rows } = await db.query('select organisation_id as "organisationId", id from siloes.due_index_definitions($1)', [limit]);
    return rows as { organisationId: string; id: string }[];
  },

  /** Takes a due refresh once: moves its next time on only if no other worker has. */
  async claimDue(db: Queryable, id: string, expected: string, next: string | null): Promise<boolean> {
    const { rowCount } = await db.query(
      `update siloes.index_definitions set next_refresh_at = $3, version = version + 1
       where id = $1 and removed_at is null and next_refresh_at = $2`, [id, expected, next]);
    return (rowCount ?? 0) > 0;
  },
};
