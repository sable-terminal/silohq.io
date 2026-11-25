import { cellConfig } from '../config/cell.config';
import type { Executor } from '../infra/db.infra';
import type { BillingStatus, Calendar, Organisation, Plan } from '../models/organisation.model';
import type { SharingPolicy } from '../models/map.model';

/**
 * Organisations.
 *
 * UNDER ROW LEVEL SECURITY, WHICH MAKES `findById` LOOK POINTLESS AND IS NOT. The
 * policy already restricts every read to the current tenant, so this can only
 * ever return the organisation in context — and that is exactly the belt-and-
 * braces intended. Passing another tenant's id returns nothing.
 *
 * `findBySlug` IS THE EXCEPTION AND IT NEEDS NO TENANT CONTEXT, because it runs
 * before one exists: resolving `acme` from a URL is how the tenant is chosen.
 * It is deliberately untenanted, declared as such by its caller.
 */

const COLUMNS = `
  id, name, slug, cell_id, plan, sso_required, mfa_required, storage_enabled,
  logo_object_key, logo_content_type, logo_uploaded_by, logo_uploaded_at,
  billing_status, time_zone, year_starts_in_month, sharing_policy, daily_token_limit, created_at
`;

interface Row {
  id: string;
  name: string;
  slug: string;
  plan: Plan;
  sso_required: boolean;
  mfa_required: boolean;
  storage_enabled: boolean;
  logo_object_key: string | null;
  logo_content_type: string | null;
  logo_uploaded_by: string | null;
  logo_uploaded_at: Date | null;
  billing_status: BillingStatus;
  cell_id: string;
  time_zone: string;
  year_starts_in_month: number;
  sharing_policy: SharingPolicy;
  daily_token_limit: number | null;
  created_at: Date;
}

function map(row: Row): Organisation {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    plan: row.plan,
    ssoRequired: row.sso_required,
    mfaRequired: row.mfa_required,
    storageEnabled: row.storage_enabled,
    logoObjectKey: row.logo_object_key,
    logoContentType: row.logo_content_type,
    logoUploadedBy: row.logo_uploaded_by,
    logoUploadedAt: row.logo_uploaded_at,
    billingStatus: row.billing_status,
    cellId: row.cell_id,
    calendar: {
      timeZone: row.time_zone,
      yearStartsInMonth: row.year_starts_in_month,
    },
    sharingPolicy: row.sharing_policy,
    dailyTokenLimit: row.daily_token_limit,
    createdAt: row.created_at,
  };
}

export async function findById(db: Executor, id: string): Promise<Organisation | null> {
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM organisations WHERE id = $1`, [id]);
  return rows[0] ? map(rows[0]) : null;
}

/** Runs before a tenant is known. See the header. */
export async function findBySlug(db: Executor, slug: string): Promise<Organisation | null> {
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM organisations WHERE slug = $1`, [slug]);
  return rows[0] ? map(rows[0]) : null;
}

export async function create(
  db: Executor,
  input: { id: string; name: string; slug: string },
): Promise<Organisation> {
  const { rows } = await db.query<Row>(
    /*
     * THE CELL IS STAMPED AT CREATION AND NEVER CHANGES. It is what lets a
     * process refuse to serve a tenant restored into the wrong place, or reached
     * through a misconfigured connection string — the failure that otherwise
     * presents as "our data looks wrong" rather than as a boundary violation.
     */
    `INSERT INTO organisations (id, name, slug, cell_id) VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`,
    [input.id, input.name, input.slug, cellConfig.id],
  );
  return map(rows[0]!);
}

export async function setBillingStatus(
  db: Executor,
  id: string,
  status: BillingStatus,
): Promise<void> {
  await db.query(`UPDATE organisations SET billing_status = $2 WHERE id = $1`, [id, status]);
}

/**
 * Replace the logo, keeping the old key.
 *
 * IT RETURNS THE PREVIOUS KEY SO THE CALLER CAN SCHEDULE ITS DELETION rather than
 * deleting it now. A bad upload is then recoverable for the retention window, and
 * the person who made it is the least equipped to notice within the minute.
 */
/** The plan the rest of the product reads; billing decides when it changes. */
export async function setPlan(db: Executor, id: string, plan: Plan): Promise<void> {
  await db.query(`UPDATE organisations SET plan = $2 WHERE id = $1`, [id, plan]);
}

export async function setLogo(
  db: Executor,
  input: { id: string; objectKey: string; contentType: string; uploadedBy: string },
): Promise<{ previousKey: string | null }> {
  const { rows } = await db.query<{ previous: string | null }>(
    `UPDATE organisations
        SET logo_object_key = $2, logo_content_type = $3,
            logo_uploaded_by = $4, logo_uploaded_at = now()
      WHERE id = $1
      RETURNING (SELECT logo_object_key FROM organisations WHERE id = $1) AS previous`,
    [input.id, input.objectKey, input.contentType, input.uploadedBy],
  );
  return { previousKey: rows[0]?.previous ?? null };
}

/**
 * Name and slug for a set of organisations.
 *
 * WHAT THE SIGN-IN PICKER IS BUILT FROM. A list showing `organisationId` is a
 * list asking somebody to choose between three uuids, and the name is the whole
 * point of it.
 *
 * ONE QUERY, NOT ONE PER MEMBERSHIP. Three round trips for three organisations
 * is invisible at this size and is the shape that becomes a problem later,
 * inside a loop nobody revisits.
 *
 * IT READS UNDER `organisations_own`, NOT THE TENANT POLICY. At this moment in
 * the flow no organisation has been chosen, so `organisations_tenant` matches
 * nothing; an id the caller may not see is simply absent from the result, and
 * the caller decides what a missing one means.
 */
export interface OrganisationName {
  id: string;
  name: string;
  slug: string;
  ssoRequired: boolean;
}

export async function listNamesByIds(
  db: Executor,
  ids: readonly string[],
): Promise<OrganisationName[]> {
  const { rows } = await db.query<{
    id: string;
    name: string;
    slug: string;
    sso_required: boolean;
  }>(`SELECT id, name, slug, sso_required FROM organisations WHERE id = ANY($1)`, [ids]);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    ssoRequired: row.sso_required,
  }));
}

/**
 * §7.3 — set the calendar every period is measured against.
 *
 * RETURNS THE PREVIOUS VALUES, because the audit row has to say what changed
 * FROM as well as TO. A settings change that records only its destination
 * cannot answer the question anyone actually asks afterwards, which is what
 * the figures meant before somebody moved the year.
 */
export async function setCalendar(
  db: Executor,
  organisationId: string,
  calendar: Calendar,
): Promise<Calendar | null> {
  const { rows } = await db.query<{ time_zone: string; year_starts_in_month: number }>(
    `UPDATE organisations
        SET time_zone = $2, year_starts_in_month = $3
      WHERE id = $1
  RETURNING (SELECT time_zone FROM organisations WHERE id = $1) AS time_zone,
            (SELECT year_starts_in_month FROM organisations WHERE id = $1) AS year_starts_in_month`,
    [organisationId, calendar.timeZone, calendar.yearStartsInMonth],
  );

  const previous = rows[0];
  return previous
    ? { timeZone: previous.time_zone, yearStartsInMonth: previous.year_starts_in_month }
    : null;
}

/**
 * §6.1 — set the ceiling on who a view may be shared with.
 *
 * RETURNS THE PREVIOUS VALUE, for the same reason `setCalendar` does: an audit
 * row that records only its destination cannot answer what somebody was allowed
 * to see last month.
 */
export async function setSharingPolicy(
  db: Executor,
  organisationId: string,
  policy: SharingPolicy,
): Promise<SharingPolicy | null> {
  const { rows } = await db.query<{ sharing_policy: SharingPolicy }>(
    `UPDATE organisations
        SET sharing_policy = $2
      WHERE id = $1
  RETURNING (SELECT sharing_policy FROM organisations WHERE id = $1) AS sharing_policy`,
    [organisationId, policy],
  );

  return rows[0]?.sharing_policy ?? null;
}

/**
 * §10 — the organisation-level storage switch.
 *
 * THE MASTER SWITCH, and off means every Silo beneath it is inert regardless of
 * what it says. `storageAllowed` is what reads it; nothing had ever written it.
 */
export async function setStorageEnabled(
  db: Executor,
  organisationId: string,
  enabled: boolean,
): Promise<void> {
  await db.query(`UPDATE organisations SET storage_enabled = $2 WHERE id = $1`, [
    organisationId,
    enabled,
  ]);
}

/**
 * The organisation's own cap on a person's daily spend.
 *
 * NULL PUTS IT BACK TO THE PLAN'S, which is not the same as no limit: on
 * Enterprise the plan says none, so clearing this there removes the brake
 * rather than tightening it.
 */
export async function setDailyTokenLimit(
  db: Executor,
  organisationId: string,
  limit: number | null,
): Promise<void> {
  await db.query(`UPDATE organisations SET daily_token_limit = $2 WHERE id = $1`, [organisationId, limit]);
}
