import type { Executor } from '../infra/db.infra';
import type { Membership, MembershipStatus } from '../models/membership.model';

/**
 * Memberships.
 *
 * UNDER ROW LEVEL SECURITY, WITH TWO POLICIES, AND THE DIFFERENCE MATTERS HERE.
 * `memberships_tenant` scopes reads to the current organisation.
 * `memberships_own` lets a user read their own rows across organisations, and is
 * `FOR SELECT` only — it exists so `listForUser` can answer the login question
 * "which organisations do I belong to" before any tenant is known.
 *
 * WHICH MEANS THE TWO READ FUNCTIONS BELOW NEED DIFFERENT CONTEXTS, and calling
 * one with the other's context returns nothing rather than failing. Each says
 * which it needs.
 */

const COLUMNS = `
  id, user_id, organisation_id, status, job_title,
  invited_by, invited_at, joined_at, created_at
`;

interface Row {
  id: string;
  user_id: string;
  organisation_id: string;
  status: MembershipStatus;
  job_title: string | null;
  invited_by: string | null;
  invited_at: Date | null;
  joined_at: Date | null;
  created_at: Date;
}

function map(row: Row): Membership {
  return {
    id: row.id,
    userId: row.user_id,
    organisationId: row.organisation_id,
    status: row.status,
    jobTitle: row.job_title,
    invitedBy: row.invited_by,
    invitedAt: row.invited_at,
    joinedAt: row.joined_at,
    createdAt: row.created_at,
  };
}

/**
 * Every organisation this user belongs to.
 *
 * NEEDS `app.user_id` SET AND NO `app.org_id`. This is the login path: the
 * password has verified, no organisation has been chosen, and this is the list
 * the picker is built from. With a tenant context set instead, the tenant policy
 * narrows it to one organisation and the picker shows one option.
 */
export async function listForUser(db: Executor, userId: string): Promise<Membership[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM memberships
      WHERE user_id = $1 AND status IN ('active', 'invited')
      ORDER BY joined_at DESC NULLS LAST`,
    [userId],
  );
  return rows.map(map);
}

/** Needs a tenant context. */
export async function findById(db: Executor, id: string): Promise<Membership | null> {
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM memberships WHERE id = $1`, [id]);
  return rows[0] ? map(rows[0]) : null;
}

export async function findByUserAndOrganisation(
  db: Executor,
  userId: string,
  organisationId: string,
): Promise<Membership | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM memberships WHERE user_id = $1 AND organisation_id = $2`,
    [userId, organisationId],
  );
  return rows[0] ? map(rows[0]) : null;
}

export async function create(
  db: Executor,
  input: {
    id: string;
    userId: string;
    organisationId: string;
    status: MembershipStatus;
    jobTitle?: string | null;
    invitedBy?: string | null;
  },
): Promise<Membership> {
  const { rows } = await db.query<Row>(
    `INSERT INTO memberships
       (id, user_id, organisation_id, status, job_title, invited_by, invited_at, joined_at)
     VALUES ($1, $2, $3, $4, $5, $6,
             CASE WHEN $6::uuid IS NULL THEN NULL ELSE now() END,
             CASE WHEN $4 = 'active' THEN now() ELSE NULL END)
     RETURNING ${COLUMNS}`,
    [input.id, input.userId, input.organisationId, input.status, input.jobTitle ?? null, input.invitedBy ?? null],
  );
  return map(rows[0]!);
}

/**
 * Change status.
 *
 * `joined_at` IS SET ONCE AND NEVER REWRITTEN. A member suspended and reinstated
 * joined when they first joined; overwriting it on reinstatement loses their
 * tenure, which is the field anybody asking "how long have they had access"
 * reads.
 */
export async function setStatus(
  db: Executor,
  membershipId: string,
  status: MembershipStatus,
): Promise<Membership | null> {
  const { rows } = await db.query<Row>(
    `UPDATE memberships
        SET status = $2,
            joined_at = CASE WHEN $2 = 'active' THEN COALESCE(joined_at, now()) ELSE joined_at END
      WHERE id = $1
      RETURNING ${COLUMNS}`,
    [membershipId, status],
  );
  return rows[0] ? map(rows[0]) : null;
}

/** Everyone in the current organisation. Needs a tenant context. */
/**
 * A membership with the person attached.
 *
 * THE JOIN IS THE SAFE WAY TO READ `users`, AND IT MATTERS THAT IT IS A JOIN.
 * `users` carries no row level security — it cannot sensibly have any, because
 * a person spans organisations and there is no tenant to scope them to — so the
 * application role can read any row in it. Reaching for users directly would
 * work and would be a query one bad `WHERE` away from returning strangers.
 *
 * Starting from `memberships`, which IS tenant-scoped, means the policy has
 * already decided which rows exist before `users` is touched: the join can only
 * reach people who are members of the caller's organisation. The privilege is
 * bounded by the table it starts from rather than by the care of whoever writes
 * the next query.
 */
export interface MemberWithUser extends Membership {
  firstName: string;
  lastName: string;
  email: string;
  lastSeenAt: Date | null;
}

export async function listForOrganisationWithUser(
  db: Executor,
  options: { status?: MembershipStatus; limit?: number } = {},
): Promise<MemberWithUser[]> {
  const { rows } = await db.query<Row & {
    first_name: string;
    last_name: string;
    email: string;
    last_seen_at: Date | null;
  }>(
    /*
     * The columns are written out with their alias rather than derived from
     * `COLUMNS` by string surgery. `COLUMNS` is a multi-line template, so
     * splitting it on ", " produces fragments with newlines in them — which
     * happens to parse and selects the wrong things.
     */
    `SELECT m.id, m.user_id, m.organisation_id, m.status, m.job_title,
            m.invited_by, m.invited_at, m.joined_at, m.created_at,
            u.first_name, u.last_name, u.email::text AS email, u.last_seen_at
       FROM memberships m
       JOIN users u ON u.id = m.user_id
      WHERE ($1::text IS NULL OR m.status = $1)
      ORDER BY m.created_at DESC
      LIMIT $2`,
    [options.status ?? null, options.limit ?? 200],
  );

  return rows.map((row) => ({
    ...map(row),
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    lastSeenAt: row.last_seen_at,
  }));
}

