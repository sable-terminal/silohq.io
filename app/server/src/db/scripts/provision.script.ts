// Provisions what a cell needs before anyone can sign in, until the admin portal and the
// policy service exist to do it: a key-encryption key version, and a design partner's
// first organisation with its first person and membership.
//
// Runs as the migration login (SET ROLE silo_migrate), like the other database scripts,
// and goes through the repos. The password comes from PROVISION_PASSWORD, never an
// argument, so it is not in shell history or the process list; it is checked as any new
// password is (length, and the breach list when BREACH_LIST_DIR is set).
//
// Usage:
//   CELL_MIGRATE_URL=... npm run provision -- cell --local [--cell uk-lon-1]
//   CELL_MIGRATE_URL=... npm run provision -- key --provider local --key-uri local:dev
//   CELL_MIGRATE_URL=... PROVISION_PASSWORD=... npm run provision -- organisation \
//     --slug acme --name "Acme Ltd" --email ada@acme.example --first-name Ada --last-name Lovelace \
//     [--cell uk-lon-1] [--plan business] [--time-zone Europe/London]
//
// The first person is the organisation's super admin (spec 56.5): the seeded Super admin
// role, organisation-wide, from which every other grant descends under the delegation
// rules. Running as silo_migrate is what lets this first grant have no granter above it.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Env } from '../../config/env.config.ts';
import { loadSecurityConfig } from '../../config/security.config.ts';
import { createBreachList } from '../../infra/breachList.infra.ts';
import { connectionDefaults, withTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { KmsKeyVersion } from '../../models/iam/kmsKeyVersion.model.ts';
import type { Organisation } from '../../models/iam/organisation.model.ts';
import { cellRepo, organisationDirectoryRepo } from '../../repos/directory/index.repo.ts';
import { kmsKeyVersionRepo, membershipRepo, organisationRepo, roleAssignmentRepo, roleRepo, userRepo } from '../../repos/iam/index.repo.ts';
import { normaliseEmail } from '../../utils/email.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { hashPassword } from '../../utils/password.util.ts';

export interface KeyInput {
  provider: KmsKeyVersion['provider'];
  keyUri: string;
}

/**
 * Registers a key version as the active one; the version it replaces stays able to open
 * what it sealed (decrypt_only), as rotation leaves it (spec 61.5). The key itself is made
 * by Terraform (decision 2026-10-29).
 */
export async function provisionKey(db: Queryable, input: KeyInput): Promise<string> {
  const existing = await kmsKeyVersionRepo.listUsable(db, [input.provider]);
  const id = uuidv7();
  await db.query(`update iam.kms_key_versions set status = 'decrypt_only' where status = 'active'`);
  await db.query(
    `insert into iam.kms_key_versions (id, provider, key_uri, version, status, activated_at)
     values ($1, $2, $3, $4, 'active', now())`, [id, input.provider, input.keyUri, existing.length + 1]);
  return id;
}

/** A local development cell row, as tests create it. Real cells are registered by Fleet. */
export async function provisionLocalCell(db: Queryable, cellId: string): Promise<void> {
  await db.query(
    `insert into platform.cells (id, kind, residency, location, hosting, hostname, is_local, status, placement_open)
     values ($1, 'commercial', 'uk', 'Local development', 'gke', $2, true, 'active', true)
     on conflict (id) do nothing`, [cellId, `${cellId}.silohq.io`]);
}

/** The local cell in the directory too, so its organisations route (Fleet registers real cells). */
export async function registerLocalCellInDirectory(db: Queryable, cellId: string): Promise<void> {
  await db.query(
    `insert into directory.cells (id, kind, residency, hostname, status, placement_open)
     values ($1, 'commercial', 'uk', $2, 'active', true)
     on conflict (id) do nothing`, [cellId, `${cellId}.silohq.io`]);
}

/**
 * The organisation's slug routes to its cell (spec 6.3): sign-in and the API find the
 * organisation through the directory. Refused when the cell is not in the directory, is
 * sovereign, or takes no new organisations; a slug already placed elsewhere is refused.
 */
export async function registerOrganisationInDirectory(db: Queryable, slug: string, cellId: string): Promise<'registered' | 'already'> {
  const cell = await cellRepo.findById(db, cellId);
  if (cell === undefined) throw new Error(`cell ${cellId} is not in the directory: register it first (Fleet, or provision cell --local)`);
  if (cell.kind === 'sovereign') throw new Error('a sovereign cell keeps its own directory: register the organisation there');
  const existing = await organisationDirectoryRepo.findForUpdate(db, slug);
  if (existing !== undefined) {
    if (existing.cellId !== cellId) throw new Error(`the slug ${slug} is already placed in cell ${existing.cellId}`);
    return 'already';
  }
  if (!cell.placementOpen || cell.status !== 'active') throw new Error(`cell ${cellId} takes no new organisations`);
  await organisationDirectoryRepo.insert(db, { organisationSlug: slug, cellId, status: 'active' });
  return 'registered';
}

/** Runs work against the directory database when DIRECTORY_MIGRATE_URL is set; says so when it is not. */
async function withDirectory(work: (db: Queryable) => Promise<string>, missing: string): Promise<void> {
  const url = process.env['DIRECTORY_MIGRATE_URL'];
  if (!url) {
    console.warn(missing);
    return;
  }
  const directory = new pg.Client({ connectionString: url, ...connectionDefaults });
  await directory.connect();
  try {
    await directory.query('set role directory_migrate');
    console.log(await withTransaction(directory, {}, work));
  } finally {
    await directory.end();
  }
}

export interface OrganisationInput {
  slug: string;
  name: string;
  email: string;
  firstName: string;
  lastName: string;
  password: string;
  cellId: string;
  plan: Organisation['plan'];
  timeZone: string;
}

export interface Provisioned {
  organisationId: string;
  userId: string;
  membershipId: string;
}

export async function provisionOrganisation(db: Queryable, input: OrganisationInput, env: Env = process.env): Promise<Provisioned> {
  const problems: string[] = [];
  const security = loadSecurityConfig(env, problems);
  if (!security) throw new Error(problems.join('; '));
  if ([...input.password.normalize('NFC')].length < security.passwordMinLength) {
    throw new Error(`PROVISION_PASSWORD: at least ${security.passwordMinLength} characters`);
  }
  if (await createBreachList(security.breachListDir).contains(input.password)) {
    throw new Error('PROVISION_PASSWORD: appears in known breaches');
  }
  const passwordHash = await hashPassword(input.password, security.argon2);
  const organisationId = uuidv7();
  const userId = uuidv7();
  const membershipId = uuidv7();
  await organisationRepo.insert(db, {
    id: organisationId, name: input.name, slug: input.slug, plan: input.plan, cellId: input.cellId, calendarTimeZone: input.timeZone,
  });
  await userRepo.insert(db, {
    id: userId, firstName: input.firstName, lastName: input.lastName, email: normaliseEmail(input.email), passwordHash,
  });
  await membershipRepo.insert(db, { id: membershipId, userId, organisationId, status: 'active', joinedAt: new Date().toISOString() });
  const superAdmin = await roleRepo.findByName(db, { organisationId, name: 'Super admin' });
  if (!superAdmin) throw new Error('the organisation has no seeded Super admin role');
  await roleAssignmentRepo.insert(db, { id: uuidv7(), organisationId, membershipId, roleId: superAdmin.id, grantedBy: membershipId });
  return { organisationId, userId, membershipId };
}

function option(args: string[], name: string, fallback?: string): string {
  const at = args.indexOf(`--${name}`);
  const value = at >= 0 ? args[at + 1] : fallback;
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const url = process.env['CELL_MIGRATE_URL'];
  if (!url) throw new Error('CELL_MIGRATE_URL must be set');
  const [command, ...args] = process.argv.slice(2);
  const client = new pg.Client({ connectionString: url, ...connectionDefaults });
  await client.connect();
  try {
    await client.query('set role silo_migrate');
    if (command === 'cell') {
      if (!args.includes('--local')) throw new Error('only a local cell is provisioned here (--local); Fleet registers real cells');
      const cellId = option(args, 'cell', process.env['SILO_CELL_ID'] ?? 'uk-lon-1');
      await withTransaction(client, {}, (db) => provisionLocalCell(db, cellId));
      console.log(`cell ${cellId} is registered`);
      await withDirectory(async (db) => {
        await registerLocalCellInDirectory(db, cellId);
        return `cell ${cellId} is in the directory`;
      }, 'DIRECTORY_MIGRATE_URL is not set: the cell is not in the directory, so its organisations will not route');
    } else if (command === 'key') {
      const id = await withTransaction(client, {}, (db) => provisionKey(db, {
        provider: option(args, 'provider') as KmsKeyVersion['provider'], keyUri: option(args, 'key-uri'),
      }));
      console.log(`key version ${id} is active`);
    } else if (command === 'organisation') {
      const password = process.env['PROVISION_PASSWORD'];
      if (!password) throw new Error('PROVISION_PASSWORD must be set');
      const created = await withTransaction(client, {}, (db) => provisionOrganisation(db, {
        slug: option(args, 'slug'), name: option(args, 'name'), email: option(args, 'email'),
        firstName: option(args, 'first-name'), lastName: option(args, 'last-name'), password,
        cellId: option(args, 'cell', process.env['SILO_CELL_ID'] ?? 'uk-lon-1'),
        plan: option(args, 'plan', 'business') as Organisation['plan'], timeZone: option(args, 'time-zone', 'Europe/London'),
      }));
      console.log(`organisation ${created.organisationId}, person ${created.userId}, membership ${created.membershipId}`);
      const slug = option(args, 'slug');
      const cellId = option(args, 'cell', process.env['SILO_CELL_ID'] ?? 'uk-lon-1');
      await withDirectory(async (db) => `directory: ${slug} ${await registerOrganisationInDirectory(db, slug, cellId)} in ${cellId}`,
        `DIRECTORY_MIGRATE_URL is not set: ${slug} is not in the directory, so it does not route until it is registered`);
    } else {
      throw new Error('usage: provision cell --local | provision key ... | provision organisation ...');
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
