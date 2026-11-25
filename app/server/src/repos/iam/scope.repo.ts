// Data access for iam.scopes, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import { scopeTable, type NewScope, type Scope, type ScopeChanges } from '../../models/iam/scope.model.ts';

export const scopeRepo = {
  insert(db: Queryable, row: NewScope): Promise<Scope> {
    return insertRow(db, scopeTable, row);
  },

  findById(db: Queryable, id: Scope['id']): Promise<Scope | undefined> {
    return findRow(db, scopeTable, { id });
  },

  findByParentScopeIdAndName(
    db: Queryable,
    key: Pick<Scope, 'organisationId' | 'parentScopeId' | 'name'>,
  ): Promise<Scope | undefined> {
    return findRow(db, scopeTable, key);
  },

  findByPath(db: Queryable, key: Pick<Scope, 'organisationId' | 'path'>): Promise<Scope | undefined> {
    return findRow(db, scopeTable, key);
  },

  update(db: Queryable, id: Scope['id'], changes: ScopeChanges): Promise<Scope | undefined> {
    return updateRow(db, scopeTable, { id }, changes);
  },

  /** Every scope of the organisation, parents before children. */
  /** The organisation's root scope: the one with no parent (RLS keeps it to the organisation). */
  async root(db: Queryable): Promise<Scope | undefined> {
    const { rows } = await db.query(`select ${scopeTable.select} from iam.scopes where parent_scope_id is null order by created_at limit 1`);
    return rows[0] as Scope | undefined;
  },

  async list(db: Queryable, includeArchived: boolean): Promise<Scope[]> {
    const { rows } = await db.query(
      `select ${scopeTable.select} from iam.scopes where ($1 or archived_at is null) order by path`, [includeArchived]);
    return rows as Scope[];
  },

  /** The paths of these scopes, for subtree tests. */
  async pathsOf(db: Queryable, ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const { rows } = await db.query('select id, path::text as path from iam.scopes where id = any($1::uuid[])', [ids]);
    return new Map(rows.map((row) => [(row as { id: string }).id, (row as { path: string }).path]));
  },

  /** An update at the version read (optimistic): undefined when another change came first. */
  updateAtVersion(db: Queryable, id: Scope['id'], version: number, changes: Omit<ScopeChanges, 'version'>): Promise<Scope | undefined> {
    return updateRow(db, scopeTable, { id, version }, { ...changes, version: version + 1 });
  },
};
