// Data access for siloes.index_refreshes, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  indexRefreshTable,
  type IndexRefresh,
  type IndexRefreshChanges,
  type NewIndexRefresh,
} from '../../models/siloes/indexRefresh.model.ts';

export const indexRefreshRepo = {
  insert(db: Queryable, row: NewIndexRefresh): Promise<IndexRefresh> {
    return insertRow(db, indexRefreshTable, row);
  },

  findById(db: Queryable, id: IndexRefresh['id']): Promise<IndexRefresh | undefined> {
    return findRow(db, indexRefreshTable, { id });
  },

  update(
    db: Queryable,
    id: IndexRefresh['id'],
    changes: IndexRefreshChanges,
  ): Promise<IndexRefresh | undefined> {
    return updateRow(db, indexRefreshTable, { id }, changes);
  },

  /** The latest refresh of each definition asked about. */
  async latestFor(db: Queryable, definitionIds: readonly string[]): Promise<IndexRefresh[]> {
    if (definitionIds.length === 0) return [];
    const { rows } = await db.query(
      `select distinct on (index_definition_id) ${indexRefreshTable.select} from siloes.index_refreshes
       where index_definition_id = any($1::uuid[]) order by index_definition_id, started_at desc, id desc`, [definitionIds]);
    return rows as IndexRefresh[];
  },
};
