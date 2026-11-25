// Data access for clone.layout_precomputations, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  layoutPrecomputationTable,
  type LayoutPrecomputation,
  type LayoutPrecomputationChanges,
  type NewLayoutPrecomputation,
} from '../../models/clone/layoutPrecomputation.model.ts';

export const layoutPrecomputationRepo = {
  insert(db: Queryable, row: NewLayoutPrecomputation): Promise<LayoutPrecomputation> {
    return insertRow(db, layoutPrecomputationTable, row);
  },

  findById(db: Queryable, id: LayoutPrecomputation['id']): Promise<LayoutPrecomputation | undefined> {
    return findRow(db, layoutPrecomputationTable, { id });
  },

  findByCacheKey(
    db: Queryable,
    key: Pick<LayoutPrecomputation, 'organisationId' | 'cacheKey'>,
  ): Promise<LayoutPrecomputation | undefined> {
    return findRow(db, layoutPrecomputationTable, key);
  },

  update(
    db: Queryable,
    id: LayoutPrecomputation['id'],
    changes: LayoutPrecomputationChanges,
  ): Promise<LayoutPrecomputation | undefined> {
    return updateRow(db, layoutPrecomputationTable, { id }, changes);
  },

  /** An unexpired precomputation of exactly this graph, for reuse. */
  async findReusable(db: Queryable, key: { setDefinitionHash: string; layoutKind: string; ontologyVersion: string; graphHash: string })
    : Promise<LayoutPrecomputation | undefined> {
    const { rows } = await db.query(
      `select ${layoutPrecomputationTable.select} from clone.layout_precomputations
       where set_definition_hash = $1 and layout_kind = $2 and ontology_version = $3 and parameters ->> 'graphHash' = $4
         and expires_at > now()
       order by computed_at desc limit 1`,
      [key.setDefinitionHash, key.layoutKind, key.ontologyVersion, key.graphHash]);
    return rows[0] as LayoutPrecomputation | undefined;
  },
};
