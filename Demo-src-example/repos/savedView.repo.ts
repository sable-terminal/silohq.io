import type { Executor } from '../infra/db.infra';
import type { ConceptQuery } from '../engine/ontology/plan.ontology';

/**
 * §7 — a saved question.
 *
 * THE QUESTION, NEVER THE ANSWER. `query` is the compiled ConceptQuery and
 * nothing here holds a row or a value; a view that cached its result would put
 * a copy of customer data in the control plane and go stale invisibly.
 */

export interface SavedView {
  id: string;
  ownerMembershipId: string;
  name: string;
  conceptId: string;
  query: ConceptQuery;
  createdAt: Date;
  updatedAt: Date;
}

type Row = {
  id: string;
  owner_membership_id: string;
  name: string;
  concept_id: string;
  query: ConceptQuery;
  created_at: Date;
  updated_at: Date;
};

const COLUMNS = `id, owner_membership_id, name, concept_id, query, created_at, updated_at`;

const map = (row: Row): SavedView => ({
  id: row.id,
  ownerMembershipId: row.owner_membership_id,
  name: row.name,
  conceptId: row.concept_id,
  query: row.query,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export async function create(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    ownerMembershipId: string;
    name: string;
    conceptId: string;
    query: ConceptQuery;
  },
): Promise<SavedView> {
  const { rows } = await db.query<Row>(
    `INSERT INTO saved_views (id, organisation_id, owner_membership_id, name, concept_id, query)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${COLUMNS}`,
    [input.id, input.organisationId, input.ownerMembershipId, input.name, input.conceptId, JSON.stringify(input.query)],
  );
  return map(rows[0]!);
}

export async function read(db: Executor, id: string): Promise<SavedView | null> {
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM saved_views WHERE id = $1`, [id]);
  return rows[0] ? map(rows[0]) : null;
}

/**
 * The caller's own, most recently touched first — the order a sidebar wants.
 *
 * AN ARCHIVED VIEW IS NOT IN THE LIST. 114 — archiving is one of the three
 * answers to an inherited view, and a view somebody put away should not come
 * back on the sidebar of the person who put it away.
 */
export async function listOwnedBy(db: Executor, membershipId: string): Promise<SavedView[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM saved_views
      WHERE owner_membership_id = $1 AND archived_at IS NULL
      ORDER BY updated_at DESC`,
    [membershipId],
  );
  return rows.map(map);
}

/**
 * Every name this membership has already used.
 *
 * `saved_views` IS UNIQUE ON (OWNER, NAME), AND AN INHERITANCE DOES NOT ASK
 * PERMISSION. Two people calling a view "Overdue invoices" is ordinary, and
 * without this the second one's departure would fail the whole removal
 * transaction on a unique index. The service picks a free name from these.
 */
export async function namesOwnedBy(db: Executor, membershipId: string): Promise<string[]> {
  const { rows } = await db.query<{ name: string }>(
    `SELECT name FROM saved_views WHERE owner_membership_id = $1`,
    [membershipId],
  );
  return rows.map((row) => row.name);
}

export async function rename(db: Executor, input: { id: string; name: string }): Promise<SavedView | null> {
  const { rows } = await db.query<Row>(
    `UPDATE saved_views SET name = $2, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
    [input.id, input.name],
  );
  return rows[0] ? map(rows[0]) : null;
}

export async function remove(db: Executor, id: string): Promise<boolean> {
  const { rowCount } = await db.query(`DELETE FROM saved_views WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

/* ── AUTH rev 7: transfer on membership removal ──────────────────────────── */

/**
 * Hand a view to somebody else, under a name they do not already use.
 *
 * THE NAME TRAVELS WITH IT WHERE IT CAN. A view is known by what it is called,
 * and renaming one on the way to a new owner loses the only description of it
 * anybody has. It is changed only where the unique index leaves no choice.
 */
export async function transferTo(
  db: Executor,
  input: { viewId: string; membershipId: string; name: string },
): Promise<SavedView | null> {
  const { rows } = await db.query<Row>(
    `UPDATE saved_views
        SET owner_membership_id = $2, name = $3, updated_at = now()
      WHERE id = $1
      RETURNING ${COLUMNS}`,
    [input.viewId, input.membershipId, input.name],
  );
  return rows[0] ? map(rows[0]) : null;
}

/** Put it away. Never a delete: a flag points at this row and cannot be deleted. */
export async function archive(db: Executor, id: string): Promise<void> {
  await db.query(`UPDATE saved_views SET archived_at = now() WHERE id = $1 AND archived_at IS NULL`, [id]);
}

/* ── AUTH rev 7: sharing ─────────────────────────────────────────────────── */

export type ViewAccess = 'view' | 'run' | 'copy';

export interface ViewShare {
  id: string;
  viewId: string;
  membershipId: string | null;
  scopeId: string | null;
  organisationWide: boolean;
  access: ViewAccess;
  sharedBy: string;
  sharedAt: Date;
  expiresAt: Date | null;
}

type ShareRow = {
  id: string;
  view_id: string;
  membership_id: string | null;
  scope_id: string | null;
  organisation_wide: boolean;
  access: ViewAccess;
  shared_by: string;
  shared_at: Date;
  expires_at: Date | null;
};

const SHARE_COLUMNS = `id, view_id, membership_id, scope_id, organisation_wide, access, shared_by, shared_at, expires_at`;

/**
 * A share nobody has revoked, nothing is holding still, and time has not taken
 * back.
 *
 * `suspended_at` READS AS DEAD EVERYWHERE, WHICH IS WHY IT IS IN THIS ONE
 * STRING. rev 7 — an inherited view "is visible to the receiving admin alone"
 * until it is reviewed, and that is true only if every path a share is read on
 * ignores a suspended one. There is one predicate, so there is one answer.
 */
const LIVE = `revoked_at IS NULL AND suspended_at IS NULL AND (expires_at IS NULL OR expires_at > now())`;

const mapShare = (row: ShareRow): ViewShare => ({
  id: row.id,
  viewId: row.view_id,
  membershipId: row.membership_id,
  scopeId: row.scope_id,
  organisationWide: row.organisation_wide,
  access: row.access,
  sharedBy: row.shared_by,
  sharedAt: row.shared_at,
  expiresAt: row.expires_at,
});

/**
 * Share it, or change the share that is already there.
 *
 * UPDATE THEN INSERT, AS MAPS DO. `ON CONFLICT` cannot name this constraint
 * without repeating its shape per grantee kind, and `IS NOT DISTINCT FROM` is
 * what makes two NULL grantee columns compare equal — which is the whole reason
 * the equivalent constraint on maps once matched nothing.
 */
export async function upsertShare(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    viewId: string;
    membershipId: string | null;
    scopeId: string | null;
    organisationWide: boolean;
    access: ViewAccess;
    sharedBy: string;
    expiresAt: string | null;
  },
): Promise<string> {
  const { rows: updated } = await db.query<{ id: string }>(
    `UPDATE view_shares
        SET access = $5, expires_at = $6, shared_by = $4, shared_at = now(), revoked_at = NULL
      WHERE view_id = $1
        AND membership_id IS NOT DISTINCT FROM $2
        AND scope_id IS NOT DISTINCT FROM $3
        AND organisation_wide = $7
      RETURNING id`,
    [input.viewId, input.membershipId, input.scopeId, input.sharedBy, input.access, input.expiresAt, input.organisationWide],
  );
  if (updated[0]) return updated[0].id;

  await db.query(
    `INSERT INTO view_shares
       (id, organisation_id, view_id, membership_id, scope_id, organisation_wide, access, shared_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.id,
      input.organisationId,
      input.viewId,
      input.membershipId,
      input.scopeId,
      input.organisationWide,
      input.access,
      input.sharedBy,
      input.expiresAt,
    ],
  );
  return input.id;
}

export async function sharesOf(db: Executor, viewId: string): Promise<ViewShare[]> {
  const { rows } = await db.query<ShareRow>(
    `SELECT ${SHARE_COLUMNS} FROM view_shares WHERE view_id = $1 AND ${LIVE} ORDER BY shared_at DESC`,
    [viewId],
  );
  return rows.map(mapShare);
}

export async function findLiveShare(db: Executor, shareId: string): Promise<ViewShare | null> {
  const { rows } = await db.query<ShareRow>(
    `SELECT ${SHARE_COLUMNS} FROM view_shares WHERE id = $1 AND revoked_at IS NULL`,
    [shareId],
  );
  return rows[0] ? mapShare(rows[0]) : null;
}

export async function revokeShare(db: Executor, shareId: string): Promise<void> {
  await db.query(`UPDATE view_shares SET revoked_at = now() WHERE id = $1`, [shareId]);
}

/**
 * Hold every live share on a view still, without taking any of them back.
 *
 * ONLY THE LIVE ONES, so restoring cannot resurrect a share the owner revoked
 * before they left. A revoked share is a decision somebody took; this is the
 * absence of one.
 */
export async function suspendSharesOf(db: Executor, viewId: string): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE view_shares SET suspended_at = now()
      WHERE view_id = $1 AND revoked_at IS NULL AND suspended_at IS NULL`,
    [viewId],
  );
  return rowCount ?? 0;
}

/** Let them run again, exactly as they were. The reversal suspension exists for. */
export async function restoreSharesOf(db: Executor, viewId: string): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE view_shares SET suspended_at = NULL
      WHERE view_id = $1 AND revoked_at IS NULL AND suspended_at IS NOT NULL`,
    [viewId],
  );
  return rowCount ?? 0;
}

/**
 * End the suspended ones for good.
 *
 * AFTER A REVIEW, "SUSPENDED" MEANS NOTHING ANY MORE. Suspension is the state
 * of waiting for an admin to decide; once they have decided to keep the view to
 * themselves or to put it away, a share held still for ever is a row nobody can
 * read the intent of. Revoking says a person ended it, which is what happened.
 */
export async function revokeSuspendedSharesOf(db: Executor, viewId: string): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE view_shares SET revoked_at = now(), suspended_at = NULL
      WHERE view_id = $1 AND revoked_at IS NULL AND suspended_at IS NOT NULL`,
    [viewId],
  );
  return rowCount ?? 0;
}

/**
 * What one person may do with a view somebody else owns.
 *
 * THE STRONGEST LIVE SHARE THAT REACHES THEM. Somebody named directly and also
 * covered by an organisation-wide share has both; the answer is the one that
 * lets them do more, because the owner granted both deliberately.
 */
export async function accessFor(
  db: Executor,
  input: { viewId: string; membershipId: string },
): Promise<ViewAccess | null> {
  const { rows } = await db.query<{ access: ViewAccess }>(
    `SELECT access FROM view_shares
      WHERE view_id = $1
        AND ${LIVE}
        AND (
          membership_id = $2
          OR organisation_wide
          OR scope_id IN (SELECT scope_id FROM scope_memberships WHERE membership_id = $2)
        )
      ORDER BY CASE access WHEN 'copy' THEN 3 WHEN 'run' THEN 2 ELSE 1 END DESC
      LIMIT 1`,
    [input.viewId, input.membershipId],
  );
  return rows[0]?.access ?? null;
}

/** Views somebody else owns and shared with this person, most recently touched first. */
export async function sharedWith(db: Executor, membershipId: string): Promise<Array<SavedView & { access: ViewAccess }>> {
  const { rows } = await db.query<Row & { access: ViewAccess }>(
    `SELECT ${COLUMNS.split(', ').map((column) => `v.${column}`).join(', ')}, s.access
       FROM saved_views v
       JOIN LATERAL (
         SELECT access FROM view_shares
          WHERE view_id = v.id
            AND ${LIVE}
            AND (
              membership_id = $1
              OR organisation_wide
              OR scope_id IN (SELECT scope_id FROM scope_memberships WHERE membership_id = $1)
            )
          ORDER BY CASE access WHEN 'copy' THEN 3 WHEN 'run' THEN 2 ELSE 1 END DESC
          LIMIT 1
       ) s ON true
      WHERE v.owner_membership_id <> $1 AND v.archived_at IS NULL
      ORDER BY v.updated_at DESC`,
    [membershipId],
  );
  return rows.map((row) => ({ ...map(row), access: row.access }));
}
