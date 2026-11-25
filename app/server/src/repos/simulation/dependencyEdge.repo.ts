// Data access for simulation.dependency_edges, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  dependencyEdgeTable,
  type DependencyEdge,
  type DependencyEdgeChanges,
  type NewDependencyEdge,
} from '../../models/simulation/dependencyEdge.model.ts';

export const dependencyEdgeRepo = {
  insert(db: Queryable, row: NewDependencyEdge): Promise<DependencyEdge> {
    return insertRow(db, dependencyEdgeTable, row);
  },

  findById(db: Queryable, id: DependencyEdge['id']): Promise<DependencyEdge | undefined> {
    return findRow(db, dependencyEdgeTable, { id });
  },

  update(
    db: Queryable,
    id: DependencyEdge['id'],
    changes: DependencyEdgeChanges,
  ): Promise<DependencyEdge | undefined> {
    return updateRow(db, dependencyEdgeTable, { id }, changes);
  },

  async list(db: Queryable, status?: DependencyEdge['status']): Promise<DependencyEdge[]> {
    const { rows } = await db.query(
      `select ${dependencyEdgeTable.select} from simulation.dependency_edges where ($1::text is null or status = $1)
        order by created_at, id`, [status ?? null]);
    return rows as DependencyEdge[];
  },

  /** Live (proposed or confirmed) edges leaving these object types: what a walk may cross, or must stop at. */
  async liveFrom(db: Queryable, fromObjectTypeIds: readonly string[]): Promise<DependencyEdge[]> {
    if (fromObjectTypeIds.length === 0) return [];
    const { rows } = await db.query(
      `select ${dependencyEdgeTable.select} from simulation.dependency_edges
        where from_object_type_id = any($1::uuid[]) and status <> 'retired' order by created_at, id`, [fromObjectTypeIds]);
    return rows as DependencyEdge[];
  },

  async findLive(db: Queryable, key: Pick<DependencyEdge, 'fromObjectTypeId' | 'toObjectTypeId' | 'viaLinkTypeId' | 'kind'>)
    : Promise<DependencyEdge | undefined> {
    const { rows } = await db.query(
      `select ${dependencyEdgeTable.select} from simulation.dependency_edges
        where from_object_type_id = $1 and to_object_type_id = $2 and via_link_type_id = $3 and kind = $4 and status <> 'retired'`,
      [key.fromObjectTypeId, key.toObjectTypeId, key.viaLinkTypeId, key.kind]);
    return rows[0] as DependencyEdge | undefined;
  },

  /** Optimistic: undefined when the edge moved since it was read. */
  async updateAtVersion(db: Queryable, id: string, version: number, changes: DependencyEdgeChanges): Promise<DependencyEdge | undefined> {
    const current = await findRow(db, dependencyEdgeTable, { id });
    if (current === undefined || current.version !== version) return undefined;
    return updateRow(db, dependencyEdgeTable, { id }, { ...changes, version: version + 1 });
  },
};
