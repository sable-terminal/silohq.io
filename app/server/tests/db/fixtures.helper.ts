// Shared fixtures: a local cell, organisations, users and memberships, each created
// the way the owning service would (as its role, under SET LOCAL context).

import type pg from 'pg';
import { ARGON2_HASH, inTx, uuidv7 } from './harness.helper.ts';

export const CELL_ID = 'uk-lon-1';

export async function createLocalCell(migrate: pg.Client): Promise<void> {
  await migrate.query(`
    insert into platform.cells (id, kind, residency, location, hosting, hostname, is_local, status, placement_open)
    values ($1, 'commercial', 'uk', 'London, GCP europe-west2', 'gke', 'uk-lon-1.silohq.io', true, 'active', true)
    on conflict (id) do nothing`, [CELL_ID]);
}

// Provisioning sets app.org_id to the new id before inserting (identity section).
export async function createOrganisation(app: pg.Client, slug: string): Promise<string> {
  const id = uuidv7();
  await inTx(app, { orgId: id }, () =>
    app.query(
      `insert into iam.organisations (id, name, slug, plan, cell_id, calendar_time_zone)
       values ($1, $2, $3, 'business', $4, 'Europe/London')`,
      [id, `Organisation ${slug}`, slug, CELL_ID],
    ));
  return id;
}

export async function createUser(auth: pg.Client, email: string): Promise<string> {
  const id = uuidv7();
  await inTx(auth, { userId: id }, () =>
    auth.query(
      `insert into iam.users (id, first_name, last_name, email, password_hash)
       values ($1, 'Test', 'User', $2, $3)`,
      [id, email, ARGON2_HASH],
    ));
  return id;
}

export async function createMembership(app: pg.Client, orgId: string, userId: string): Promise<string> {
  const id = uuidv7();
  await inTx(app, { orgId }, () =>
    app.query(
      `insert into iam.memberships (id, user_id, organisation_id, status, joined_at)
       values ($1, $2, $3, 'active', now())`,
      [id, userId, orgId],
    ));
  return id;
}
