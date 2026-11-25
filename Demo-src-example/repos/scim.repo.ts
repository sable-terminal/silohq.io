import type { Executor } from '../infra/db.infra';

/**
 * §1 — SCIM: the credential, what the directory says, and what an
 * administrator authorised it to carry.
 *
 * SQL, AND THE MAPPING BETWEEN A ROW AND A MODEL. Whether a directory group may
 * carry a role, whether the person declaring that could have granted it, and
 * whether a deactivation should suspend or be ignored are all the service's
 * decisions. Nothing here decides any of them.
 */

export interface ScimToken {
  id: string;
  organisationId: string;
  name: string;
  lastFour: string;
  createdBy: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface ScimGroup {
  id: string;
  organisationId: string;
  externalId: string;
  displayName: string;
}

export interface ScimGroupGrant {
  id: string;
  groupId: string;
  scopeId: string | null;
  roleId: string | null;
  declaredBy: string;
  declaredAt: Date;
}

/* ── The credential ──────────────────────────────────────────────────────── */

/**
 * Which organisation owns this token, by hash.
 *
 * THROUGH `scim_token_owner`, WHICH IS `SECURITY DEFINER`. The token is what
 * says which organisation the request belongs to, so the read that finds it
 * cannot already be inside one — there is no tenant to be inside yet. The
 * function answers that one question and exposes nothing else.
 */
export async function ownerOf(
  db: Executor,
  tokenHash: string,
): Promise<{ tokenId: string; organisationId: string } | null> {
  const { rows } = await db.query<{ token_id: string; organisation_id: string }>(
    `SELECT token_id, organisation_id FROM scim_token_owner($1)`,
    [tokenHash],
  );

  const row = rows[0];
  return row ? { tokenId: row.token_id, organisationId: row.organisation_id } : null;
}

export async function markUsed(db: Executor, tokenId: string): Promise<void> {
  await db.query(`UPDATE scim_tokens SET last_used_at = now() WHERE id = $1`, [tokenId]);
}

export async function issueToken(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    name: string;
    tokenHash: string;
    lastFour: string;
    createdBy: string;
  },
): Promise<ScimToken> {
  const { rows } = await db.query<Row>(
    `INSERT INTO scim_tokens (id, organisation_id, name, token_hash, last_four, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING ${TOKEN_COLUMNS}`,
    [input.id, input.organisationId, input.name, input.tokenHash, input.lastFour, input.createdBy],
  );
  return mapToken(rows[0]!);
}

export async function listTokens(db: Executor): Promise<ScimToken[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${TOKEN_COLUMNS} FROM scim_tokens ORDER BY created_at DESC`,
  );
  return rows.map(mapToken);
}

/** Returns whether a live token was actually revoked, so a repeat is not a lie. */
export async function revokeToken(db: Executor, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE scim_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

const TOKEN_COLUMNS = `
  id, organisation_id, name, last_four, created_by, created_at, last_used_at, revoked_at
`;

interface Row {
  id: string;
  organisation_id: string;
  name: string;
  last_four: string;
  created_by: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

const mapToken = (row: Row): ScimToken => ({
  id: row.id,
  organisationId: row.organisation_id,
  name: row.name,
  lastFour: row.last_four,
  createdBy: row.created_by,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
  revokedAt: row.revoked_at,
});

/* ── What the directory says ─────────────────────────────────────────────── */

/**
 * A group, by the provider's own id.
 *
 * `external_id` AND NOT THE DISPLAY NAME. A directory rename is an ordinary
 * event; keyed on the name it would look like one group vanishing and another
 * appearing, taking every mapping with it.
 */
export async function upsertGroup(
  db: Executor,
  input: { id: string; organisationId: string; externalId: string; displayName: string },
): Promise<ScimGroup> {
  const { rows } = await db.query<{
    id: string;
    organisation_id: string;
    external_id: string;
    display_name: string;
  }>(
    `INSERT INTO scim_groups (id, organisation_id, external_id, display_name)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (organisation_id, external_id) DO UPDATE
        SET display_name = EXCLUDED.display_name, updated_at = now()
     RETURNING id, organisation_id, external_id, display_name`,
    [input.id, input.organisationId, input.externalId, input.displayName],
  );

  const row = rows[0]!;
  return {
    id: row.id,
    organisationId: row.organisation_id,
    externalId: row.external_id,
    displayName: row.display_name,
  };
}

export async function findGroup(db: Executor, id: string): Promise<ScimGroup | null> {
  const { rows } = await db.query<{
    id: string;
    organisation_id: string;
    external_id: string;
    display_name: string;
  }>(`SELECT id, organisation_id, external_id, display_name FROM scim_groups WHERE id = $1`, [id]);

  const row = rows[0];
  return row
    ? {
        id: row.id,
        organisationId: row.organisation_id,
        externalId: row.external_id,
        displayName: row.display_name,
      }
    : null;
}

export async function listGroups(db: Executor): Promise<ScimGroup[]> {
  const { rows } = await db.query<{
    id: string;
    organisation_id: string;
    external_id: string;
    display_name: string;
  }>(`SELECT id, organisation_id, external_id, display_name FROM scim_groups ORDER BY display_name`);

  return rows.map((row) => ({
    id: row.id,
    organisationId: row.organisation_id,
    externalId: row.external_id,
    displayName: row.display_name,
  }));
}

export async function deleteGroup(db: Executor, id: string): Promise<boolean> {
  const { rowCount } = await db.query(`DELETE FROM scim_groups WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

export async function membersOf(db: Executor, groupId: string): Promise<string[]> {
  const { rows } = await db.query<{ membership_id: string }>(
    `SELECT membership_id FROM scim_group_members WHERE group_id = $1`,
    [groupId],
  );
  return rows.map((row) => row.membership_id);
}


export async function addMember(
  db: Executor,
  input: { id: string; organisationId: string; groupId: string; membershipId: string },
): Promise<void> {
  await db.query(
    `INSERT INTO scim_group_members (id, organisation_id, group_id, membership_id)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (group_id, membership_id) DO NOTHING`,
    [input.id, input.organisationId, input.groupId, input.membershipId],
  );
}

export async function removeMember(
  db: Executor,
  input: { groupId: string; membershipId: string },
): Promise<void> {
  await db.query(`DELETE FROM scim_group_members WHERE group_id = $1 AND membership_id = $2`, [
    input.groupId,
    input.membershipId,
  ]);
}

/* ── The envelope an administrator authorised ────────────────────────────── */

export async function declareGrant(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    groupId: string;
    scopeId: string | null;
    roleId: string | null;
    declaredBy: string;
  },
): Promise<ScimGroupGrant> {
  const { rows } = await db.query<GrantRow>(
    `INSERT INTO scim_group_grants
       (id, organisation_id, group_id, scope_id, role_id, declared_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING ${GRANT_COLUMNS}`,
    [input.id, input.organisationId, input.groupId, input.scopeId, input.roleId, input.declaredBy],
  );
  return mapGrant(rows[0]!);
}

export async function grantsFor(db: Executor, groupId: string): Promise<ScimGroupGrant[]> {
  const { rows } = await db.query<GrantRow>(
    `SELECT ${GRANT_COLUMNS} FROM scim_group_grants WHERE group_id = $1`,
    [groupId],
  );
  return rows.map(mapGrant);
}

/** One mapping, so a withdrawal can take back exactly what it conferred. */
export async function findGrant(db: Executor, id: string): Promise<ScimGroupGrant | null> {
  const { rows } = await db.query<GrantRow>(
    `SELECT ${GRANT_COLUMNS} FROM scim_group_grants WHERE id = $1`,
    [id],
  );
  return rows[0] ? mapGrant(rows[0]) : null;
}

export async function withdrawGrant(db: Executor, id: string): Promise<boolean> {
  const { rowCount } = await db.query(`DELETE FROM scim_group_grants WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

const GRANT_COLUMNS = `id, group_id, scope_id, role_id, declared_by, declared_at`;

interface GrantRow {
  id: string;
  group_id: string;
  scope_id: string | null;
  role_id: string | null;
  declared_by: string;
  declared_at: Date;
}

const mapGrant = (row: GrantRow): ScimGroupGrant => ({
  id: row.id,
  groupId: row.group_id,
  scopeId: row.scope_id,
  roleId: row.role_id,
  declaredBy: row.declared_by,
  declaredAt: row.declared_at,
});

/* ── Provisioned memberships ─────────────────────────────────────────────── */

/**
 * A membership the directory created is one the directory may deactivate.
 *
 * ONE IT DID NOT CREATE IS NOT. A provider that starts syncing an existing
 * organisation must not be able to suspend the founder for the crime of not
 * appearing in its directory.
 */
export async function markProvisioned(db: Executor, membershipId: string): Promise<void> {
  await db.query(`UPDATE memberships SET provisioned_by_scim = true WHERE id = $1`, [membershipId]);
}

export async function isProvisioned(db: Executor, membershipId: string): Promise<boolean> {
  const { rows } = await db.query<{ provisioned_by_scim: boolean }>(
    `SELECT provisioned_by_scim FROM memberships WHERE id = $1`,
    [membershipId],
  );
  return rows[0]?.provisioned_by_scim ?? false;
}

/**
 * Whether the DIRECTORY is what stopped this person, as against a person.
 *
 * TWO DIFFERENT ACTS WEARING ONE STATUS. "They have left" is the directory's to
 * reverse; "their access is stopped while we look into something" is not, and a
 * provider re-sends constantly enough that the difference is minutes.
 */
export async function suspendedByScim(db: Executor, membershipId: string): Promise<boolean> {
  const { rows } = await db.query<{ suspended_by_scim: boolean }>(
    `SELECT suspended_by_scim FROM memberships WHERE id = $1`,
    [membershipId],
  );
  return rows[0]?.suspended_by_scim ?? false;
}

/** Records which kind of suspension this is, in the same statement as the status. */
export async function setSuspendedByScim(
  db: Executor,
  membershipId: string,
  byScim: boolean,
): Promise<void> {
  await db.query(`UPDATE memberships SET suspended_by_scim = $2 WHERE id = $1`, [
    membershipId,
    byScim,
  ]);
}
