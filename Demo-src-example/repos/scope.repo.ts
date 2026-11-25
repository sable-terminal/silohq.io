import type { Executor } from '../infra/db.infra';
import type { Scope, ScopeMembership, ScopeType } from '../models/scope.model';

/**
 * The scope tree.
 *
 * `path` AND `depth` ARE NEVER WRITTEN HERE. The trigger in `003_scopes.sql`
 * computes both from the parent, on insert and on move, and rewrites the whole
 * subtree in the same transaction. Every insert below passes a placeholder the
 * trigger overwrites — writing them from the application would give the tree two
 * authors, and a path that disagrees with the parent chain is a security failure
 * rather than a data inconsistency.
 */

const SCOPE_COLUMNS = `
  id, organisation_id, scope_type_id, name, parent_id,
  path::text AS path, depth, archived_at, created_by, created_at
`;

interface ScopeRow {
  id: string;
  organisation_id: string;
  scope_type_id: string;
  name: string;
  parent_id: string | null;
  path: string;
  depth: number;
  archived_at: Date | null;
  created_by: string | null;
  created_at: Date;
}

function mapScope(row: ScopeRow): Scope {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    scopeTypeId: row.scope_type_id,
    name: row.name,
    parentId: row.parent_id,
    path: row.path,
    depth: row.depth,
    archivedAt: row.archived_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/* ── Scope types ─────────────────────────────────────────────────────────── */

export async function createType(
  db: Executor,
  input: { id: string; organisationId: string; name: string; icon?: string | null; colour?: string | null },
): Promise<ScopeType> {
  const { rows } = await db.query<{
    id: string; organisation_id: string; name: string;
    icon: string | null; colour: string | null; created_at: Date;
  }>(
    `INSERT INTO scope_types (id, organisation_id, name, icon, colour)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, organisation_id, name, icon, colour, created_at`,
    [input.id, input.organisationId, input.name, input.icon ?? null, input.colour ?? null],
  );
  const row = rows[0]!;
  return {
    id: row.id,
    organisationId: row.organisation_id,
    name: row.name,
    icon: row.icon,
    colour: row.colour,
    createdAt: row.created_at,
  };
}

export async function listTypes(db: Executor): Promise<ScopeType[]> {
  const { rows } = await db.query<{
    id: string; organisation_id: string; name: string;
    icon: string | null; colour: string | null; created_at: Date;
  }>(`SELECT id, organisation_id, name, icon, colour, created_at FROM scope_types ORDER BY name`);
  return rows.map((row) => ({
    id: row.id,
    organisationId: row.organisation_id,
    name: row.name,
    icon: row.icon,
    colour: row.colour,
    createdAt: row.created_at,
  }));
}

/* ── Scopes ──────────────────────────────────────────────────────────────── */

export async function create(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    scopeTypeId: string;
    name: string;
    parentId: string | null;
    createdBy: string;
  },
): Promise<Scope> {
  // `'x'` and `0` are placeholders the trigger replaces. See the header.
  const { rows } = await db.query<ScopeRow>(
    `INSERT INTO scopes (id, organisation_id, scope_type_id, name, parent_id, path, depth, created_by)
     VALUES ($1, $2, $3, $4, $5, 'x', 0, $6)
     RETURNING ${SCOPE_COLUMNS}`,
    [input.id, input.organisationId, input.scopeTypeId, input.name, input.parentId, input.createdBy],
  );
  return mapScope(rows[0]!);
}

export async function findById(db: Executor, id: string): Promise<Scope | null> {
  const { rows } = await db.query<ScopeRow>(`SELECT ${SCOPE_COLUMNS} FROM scopes WHERE id = $1`, [id]);
  return rows[0] ? mapScope(rows[0]) : null;
}

export async function listAll(db: Executor, includeArchived = false): Promise<Scope[]> {
  const { rows } = await db.query<ScopeRow>(
    `SELECT ${SCOPE_COLUMNS} FROM scopes
      WHERE ($1::boolean OR archived_at IS NULL)
      ORDER BY path`,
    [includeArchived],
  );
  return rows.map(mapScope);
}

/**
 * Everything at or beneath a scope.
 *
 * `<@` IS AN INDEXED OPERATOR ON THE GiST INDEX, so this is a lookup rather than
 * a recursive walk. It is the query behind every delegation check, run on every
 * authorisation decision — a recursive CTE here would be the product's slowest
 * path and it would get slower as customers grew their trees.
 *
 * INCLUSIVE. An admin assigned to Engineering administers Engineering.
 */
export async function listSubtree(db: Executor, path: string): Promise<Scope[]> {
  const { rows } = await db.query<ScopeRow>(
    `SELECT ${SCOPE_COLUMNS} FROM scopes
      WHERE path <@ $1::ltree AND archived_at IS NULL
      ORDER BY path`,
    [path],
  );
  return rows.map(mapScope);
}

/**
 * Move a scope.
 *
 * ONE STATEMENT, AND THE TRIGGERS DO THE REST — the `BEFORE` trigger recomputes
 * this node's path and refuses a cycle, the `AFTER` trigger rewrites every
 * descendant. Doing it here, row by row, leaves a window in which the tree is
 * half-rewritten and some scopes are administered by nobody.
 */
export async function move(db: Executor, id: string, newParentId: string | null): Promise<Scope | null> {
  const { rows } = await db.query<ScopeRow>(
    `UPDATE scopes SET parent_id = $2 WHERE id = $1 RETURNING ${SCOPE_COLUMNS}`,
    [id, newParentId],
  );
  return rows[0] ? mapScope(rows[0]) : null;
}

export async function archive(db: Executor, id: string): Promise<void> {
  await db.query(`UPDATE scopes SET archived_at = COALESCE(archived_at, now()) WHERE id = $1`, [id]);
}

/**
 * Whether anything still points at this scope.
 *
 * ARCHIVE REQUIRES REASSIGNMENT FIRST. A scope with memberships or grants still
 * attached, archived, leaves people holding access through a node nobody
 * administers — invisible in every interface and still effective.
 */
export async function referencesTo(db: Executor, id: string): Promise<{ memberships: number; assignments: number; children: number }> {
  const { rows } = await db.query<{ memberships: string; assignments: string; children: string }>(
    `SELECT
       (SELECT count(*) FROM scope_memberships WHERE scope_id = $1)::text AS memberships,
       (SELECT count(*) FROM role_assignments WHERE scope_id = $1 AND revoked_at IS NULL)::text AS assignments,
       (SELECT count(*) FROM scopes WHERE parent_id = $1 AND archived_at IS NULL)::text AS children`,
    [id],
  );
  const row = rows[0]!;
  return {
    memberships: Number(row.memberships),
    assignments: Number(row.assignments),
    children: Number(row.children),
  };
}

/* ── Scope membership ────────────────────────────────────────────────────── */

export async function addMember(
  db: Executor,
  input: { id: string; membershipId: string; scopeId: string; isPrimary: boolean; addedBy: string },
): Promise<ScopeMembership> {
  const { rows } = await db.query<{
    id: string; membership_id: string; scope_id: string;
    is_primary: boolean; added_by: string | null; added_at: Date;
  }>(
    `INSERT INTO scope_memberships (id, membership_id, scope_id, is_primary, added_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (membership_id, scope_id) DO UPDATE SET is_primary = EXCLUDED.is_primary
     RETURNING id, membership_id, scope_id, is_primary, added_by, added_at`,
    [input.id, input.membershipId, input.scopeId, input.isPrimary, input.addedBy],
  );
  const row = rows[0]!;
  return {
    id: row.id,
    membershipId: row.membership_id,
    scopeId: row.scope_id,
    isPrimary: row.is_primary,
    addedBy: row.added_by,
    addedAt: row.added_at,
  };
}

export async function removeMember(db: Executor, membershipId: string, scopeId: string): Promise<void> {
  await db.query(`DELETE FROM scope_memberships WHERE membership_id = $1 AND scope_id = $2`, [
    membershipId,
    scopeId,
  ]);
}

/**
 * Every scope path a membership sits in.
 *
 * PATHS, NOT IDS, BECAUSE THE CALLER NEEDS TO TEST CONTAINMENT. Returning ids
 * would mean a second query per scope to get its path, on every authorisation
 * decision.
 */
export async function pathsForMembership(db: Executor, membershipId: string): Promise<string[]> {
  const { rows } = await db.query<{ path: string }>(
    `SELECT s.path::text AS path
       FROM scope_memberships sm
       JOIN scopes s ON s.id = sm.scope_id
      WHERE sm.membership_id = $1 AND s.archived_at IS NULL
      ORDER BY s.path`,
    [membershipId],
  );
  return rows.map((row) => row.path);
}

export async function membersOf(db: Executor, scopeId: string): Promise<ScopeMembership[]> {
  const { rows } = await db.query<{
    id: string; membership_id: string; scope_id: string;
    is_primary: boolean; added_by: string | null; added_at: Date;
  }>(
    `SELECT id, membership_id, scope_id, is_primary, added_by, added_at
       FROM scope_memberships WHERE scope_id = $1`,
    [scopeId],
  );
  return rows.map((row) => ({
    id: row.id,
    membershipId: row.membership_id,
    scopeId: row.scope_id,
    isPrimary: row.is_primary,
    addedBy: row.added_by,
    addedAt: row.added_at,
  }));
}

/**
 * §1 — a placement a directory group mapping created.
 *
 * INSERT IF ABSENT, NEVER OVERWRITE. `addMember` upserts `is_primary`, so a
 * directory adding somebody a person had already placed as PRIMARY silently
 * demoted them. A mapping should add a placement that is not there and leave
 * one that is exactly as the person left it.
 */
export async function addScimMember(
  db: Executor,
  input: { id: string; membershipId: string; scopeId: string; addedBy: string },
): Promise<void> {
  await db.query(
    `INSERT INTO scope_memberships (id, membership_id, scope_id, is_primary, added_by, added_by_scim)
     VALUES ($1, $2, $3, false, $4, true)
     ON CONFLICT (membership_id, scope_id) DO NOTHING`,
    [input.id, input.membershipId, input.scopeId, input.addedBy],
  );
}

/**
 * Remove only a placement the directory itself made.
 *
 * BOUNDED THE WAY THE ROLE HALF ALREADY WAS. A placement a person made by hand
 * is not the directory's to remove — and removing one silently removes every
 * connection that reached the subject through that scope.
 */
export async function removeScimMember(
  db: Executor,
  input: { membershipId: string; scopeId: string },
): Promise<void> {
  await db.query(
    `DELETE FROM scope_memberships
      WHERE membership_id = $1 AND scope_id = $2 AND added_by_scim`,
    [input.membershipId, input.scopeId],
  );
}
