import type { Executor } from '../infra/db.infra';

/**
 * AUTH rev 7 — a view that changed hands because its owner did not stay.
 *
 * SQL ONLY, INCLUDING THE ONE STATEMENT THAT LOOKS LIKE A DECISION. Who the
 * admin above somebody is, is a question about two tables — where the person
 * sat and who administers those scopes — and rev 7 answers it in one sentence.
 * Expressing that sentence as an `ORDER BY` keeps it a single statement that
 * can be read against the spec, rather than three queries and a sort in a
 * service where the rule is spread over thirty lines.
 */

export type TransferReason = 'member_removed' | 'member_suspended' | 'scope_archived';
export type TransferDecision = 'shared' | 'retained' | 'archived';

export interface TransferFlag {
  id: string;
  viewId: string;
  transferredTo: string;
  transferredFrom: string;
  reason: TransferReason;
  reviewedAt: Date | null;
  decision: TransferDecision | null;
  createdAt: Date;
}

type Row = {
  id: string;
  view_id: string;
  transferred_to: string;
  transferred_from: string;
  reason: TransferReason;
  reviewed_at: Date | null;
  decision: TransferDecision | null;
  created_at: Date;
};

const COLUMNS = `id, view_id, transferred_to, transferred_from, reason, reviewed_at, decision, created_at`;

const map = (row: Row): TransferFlag => ({
  id: row.id,
  viewId: row.view_id,
  transferredTo: row.transferred_to,
  transferredFrom: row.transferred_from,
  reason: row.reason,
  reviewedAt: row.reviewed_at,
  decision: row.decision,
  createdAt: row.created_at,
});

/** How the receiving admin was arrived at, which the trail records. */
export type Route = 'primary_scope' | 'closest_scope' | 'super_admin';

/**
 * The admin above somebody, as rev 7 defines them.
 *
 * ── THE SENTENCE, CLAUSE BY CLAUSE ────────────────────────────────────────
 *
 * "The admin whose subtree MOST CLOSELY CONTAINS a scope the removed membership
 * belonged to" — hence `s.path @> t.path` (ancestor or the scope itself) and
 * `ORDER BY depth DESC`: of two admins who both contain the scope, the deeper
 * one is the nearer one.
 *
 * "Where the membership belonged to SEVERAL SCOPES with different admins, the
 * view goes to the admin of its PRIMARY scope" — so `is_primary` sorts first
 * and outranks depth. A person's primary scope is where they actually sit; a
 * deeper admin over a secondary placement is a nearer stranger.
 *
 * "Where NO SCOPE APPLIES, it goes to a SUPER ADMIN" — the second statement,
 * run only where the first finds nobody. That covers a membership in no scope
 * at all and a membership whose scopes nobody administers, and both are the
 * same fact: there is no admin above them, so it goes to the top.
 *
 * ── WHAT COUNTS AS AN ADMIN, AND WHY IT IS NOT A PERMISSION CHECK ─────────
 *
 * A scoped role assignment. That is already what `authorityOf` means by
 * `adminPaths` and what `member.service` bounds a removal by, so the person who
 * could remove the member is the person who can inherit from them. Asking for a
 * particular permission instead would invent a second definition of "admin",
 * and the two would answer differently the first time somebody made a role.
 *
 * NEVER A SERVICE PRINCIPAL. A machine identity can hold a scoped assignment
 * and cannot review a queue; leaving one eligible would put an inheritance
 * somewhere nobody looks.
 *
 * NEVER AN INACTIVE MEMBERSHIP, and never the person being removed. An
 * organisation offboarding a team on one afternoon must not hand one leaver's
 * views to the next.
 */
export async function receivingAdminFor(
  db: Executor,
  membershipId: string,
): Promise<{ membershipId: string; route: Route } | null> {
  const { rows: above } = await db.query<{ membership_id: string; is_primary: boolean }>(
    `WITH sat_in AS (
       SELECT s.path AS path, sm.is_primary
         FROM scope_memberships sm
         JOIN scopes s ON s.id = sm.scope_id
        WHERE sm.membership_id = $1 AND s.archived_at IS NULL
     )
     SELECT ra.membership_id, sat_in.is_primary
       FROM role_assignments ra
       JOIN scopes admin_scope
         ON admin_scope.id = ra.scope_id
        AND ra.scope_type = 'scope'
        AND admin_scope.archived_at IS NULL
       JOIN sat_in ON admin_scope.path @> sat_in.path
       JOIN memberships m ON m.id = ra.membership_id
      WHERE ra.membership_id IS NOT NULL
        AND ra.membership_id <> $1
        AND ra.revoked_at IS NULL
        AND (ra.expires_at IS NULL OR ra.expires_at > now())
        AND m.status = 'active'
      ORDER BY sat_in.is_primary DESC, admin_scope.depth DESC, ra.granted_at
      LIMIT 1`,
    [membershipId],
  );

  if (above[0]) {
    return {
      membershipId: above[0].membership_id,
      route: above[0].is_primary ? 'primary_scope' : 'closest_scope',
    };
  }

  /*
   * THE LONGEST-STANDING SUPER ADMIN, so the answer is the same every time it
   * is asked. §6 — an organisation-wide assignment IS a super admin; there is
   * no column saying so, and inventing one here would be a second source of
   * truth for the thing the assignment already states.
   */
  const { rows: top } = await db.query<{ membership_id: string }>(
    `SELECT ra.membership_id
       FROM role_assignments ra
       JOIN memberships m ON m.id = ra.membership_id
      WHERE ra.scope_type IS NULL
        AND ra.membership_id IS NOT NULL
        AND ra.membership_id <> $1
        AND ra.revoked_at IS NULL
        AND (ra.expires_at IS NULL OR ra.expires_at > now())
        AND m.status = 'active'
      ORDER BY ra.granted_at
      LIMIT 1`,
    [membershipId],
  );

  return top[0] ? { membershipId: top[0].membership_id, route: 'super_admin' } : null;
}

export async function flag(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    viewId: string;
    transferredTo: string;
    transferredFrom: string;
    reason: TransferReason;
  },
): Promise<TransferFlag> {
  const { rows } = await db.query<Row>(
    `INSERT INTO view_transfer_flags
       (id, organisation_id, view_id, transferred_to, transferred_from, reason)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${COLUMNS}`,
    [input.id, input.organisationId, input.viewId, input.transferredTo, input.transferredFrom, input.reason],
  );
  return map(rows[0]!);
}

export async function findById(db: Executor, id: string): Promise<TransferFlag | null> {
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM view_transfer_flags WHERE id = $1`, [id]);
  return rows[0] ? map(rows[0]) : null;
}

/** The flag on a view that nobody has answered yet, if there is one. */
export async function outstandingForView(db: Executor, viewId: string): Promise<TransferFlag | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM view_transfer_flags WHERE view_id = $1 AND reviewed_at IS NULL`,
    [viewId],
  );
  return rows[0] ? map(rows[0]) : null;
}

/** How many times this view has changed hands. Nought means it never has. */
export async function countForView(db: Executor, viewId: string): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM view_transfer_flags WHERE view_id = $1`,
    [viewId],
  );
  return Number(rows[0]?.count ?? 0);
}

export type FlaggedView = TransferFlag & {
  viewName: string;
  conceptId: string;
  conceptName: string;
  archived: boolean;
};

/**
 * One admin's queue: what they have inherited, and what became of it.
 *
 * ANSWERED ONES STAY, AND THAT IS NOT CLUTTER. A cron on a transferred view
 * stays paused until the admin resumes it SEPARATELY, so a flag whose decision
 * is made may still have work hanging off it. Dropping it from the list at the
 * moment of the decision would hide the second half of the job.
 *
 * OUTSTANDING FIRST, OLDEST FIRST WITHIN THAT: the queue is work, and the
 * oldest unanswered inheritance is the one that has been unowned longest.
 */
export async function listFor(db: Executor, membershipId: string): Promise<FlaggedView[]> {
  const { rows } = await db.query<Row & { view_name: string; concept_id: string; concept_name: string; archived_at: Date | null }>(
    `SELECT ${COLUMNS.split(', ').map((column) => `f.${column}`).join(', ')},
            v.name AS view_name, v.concept_id, v.archived_at, c.name AS concept_name
       FROM view_transfer_flags f
       JOIN saved_views v ON v.id = f.view_id
       JOIN concepts c ON c.id = v.concept_id
      WHERE f.transferred_to = $1
      ORDER BY (f.reviewed_at IS NOT NULL), f.created_at`,
    [membershipId],
  );

  return rows.map((row) => ({
    ...map(row),
    viewName: row.view_name,
    conceptId: row.concept_id,
    conceptName: row.concept_name,
    archived: row.archived_at !== null,
  }));
}

/**
 * Resolve one.
 *
 * `WHERE reviewed_at IS NULL` IS THE WHOLE RACE GUARD. Two admins cannot answer
 * the same flag, and one admin cannot answer it twice: the second update
 * matches nothing and the service says so rather than writing a second decision
 * over the first.
 */
export async function review(
  db: Executor,
  input: { id: string; decision: TransferDecision },
): Promise<TransferFlag | null> {
  const { rows } = await db.query<Row>(
    `UPDATE view_transfer_flags
        SET reviewed_at = now(), decision = $2
      WHERE id = $1 AND reviewed_at IS NULL
      RETURNING ${COLUMNS}`,
    [input.id, input.decision],
  );
  return rows[0] ? map(rows[0]) : null;
}
