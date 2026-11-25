// The generated Zod schemas agree with Postgres: rows the database returns parse, and an
// insert the schema refuses is one the database refuses (and the reverse).

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type pg from 'pg';
import { withTransaction } from '../../src/infra/postgres.infra.ts';
import type { JsonValue } from '../../src/models/table.model.ts';
import { membershipRepo, mfaFactorRepo, organisationRepo, userRepo } from '../../src/repos/iam/index.repo.ts';
import { jsonbTextBytes } from '../../src/schemas/column.schema.ts';
import {
  membershipSchema, mfaFactorSchema, newOrganisationSchema, organisationSchema, userSchema,
} from '../../src/schemas/iam/index.schema.ts';
import { CELL_ID, createLocalCell, createMembership, createOrganisation, createUser } from './fixtures.helper.ts';
import { createHarness, uuidv7, type Harness } from './harness.helper.ts';

let h: Harness;
let migrate: pg.Client;
let app: pg.Client;
let auth: pg.Client;

before(async () => {
  h = await createHarness();
  migrate = await h.connect('test_migrate');
  app = await h.connect('test_app');
  auth = await h.connect('test_auth');
  await createLocalCell(migrate);
});

after(async () => {
  await h?.close();
});

describe('row schemas', () => {
  test('parse rows as the database returns them', async () => {
    const orgId = await createOrganisation(app, 'acme');
    const userId = await createUser(auth, 'ada@acme.example');
    const membershipId = await createMembership(app, orgId, userId);
    const keyVersion = uuidv7();
    await migrate.query(
      `insert into iam.kms_key_versions (id, provider, key_uri, version, status, activated_at)
       values ($1, 'gcp_kms', 'projects/p/locations/l/keyRings/r/cryptoKeys/k', 1, 'active', now())`, [keyVersion]);
    const factorId = uuidv7();
    await withTransaction(auth, { userId }, (db) => mfaFactorRepo.insert(db, {
      id: factorId, userId, kind: 'totp', secretSealed: randomBytes(36), nonce: randomBytes(12), dekWrapped: randomBytes(40),
      keyVersionId: keyVersion,
    }));

    const organisation = await withTransaction(app, { organisationId: orgId }, (db) => organisationRepo.findById(db, orgId));
    const membership = await withTransaction(app, { organisationId: orgId }, (db) => membershipRepo.findById(db, membershipId));
    const user = await withTransaction(auth, { userId }, (db) => userRepo.findById(db, userId));
    const factor = await withTransaction(auth, { userId }, (db) => mfaFactorRepo.findById(db, factorId));
    for (const [schema, row] of [[organisationSchema, organisation], [membershipSchema, membership], [userSchema, user],
      [mfaFactorSchema, factor]] as const) {
      const parsed = schema.safeParse(row);
      assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
    }
  });
});

describe('insert schemas', () => {
  const base = () => ({
    id: uuidv7(), name: 'Initech', slug: `initech-${Date.now().toString(36)}`, plan: 'standard' as const, cellId: CELL_ID,
    calendarTimeZone: 'Europe/London',
  });

  const databaseAccepts = async (values: Record<string, unknown>): Promise<boolean> => {
    try {
      await withTransaction(app, { organisationId: String(values['id']) }, (db) => organisationRepo.insert(db, values as never));
      return true;
    } catch {
      return false;
    }
  };

  test('refuse what Postgres refuses and accept what it accepts', async () => {
    const cases: [string, Record<string, unknown>][] = [
      ['valid', {}],
      ['blank name', { name: '   ' }],
      ['tab name (btrim trims spaces only)', { name: '\t' }],
      ['uppercase slug', { slug: 'Initech' }],
      ['slug of 64 characters', { slug: `a${'b'.repeat(63)}` }],
      ['month 13', { financialYearStartMonth: 13 }],
      ['month 12', { financialYearStartMonth: 12, financialYearLabel: 'start_year' }],
      ['unknown status', { status: 'deleted' }],
      ['NUL in name', { name: 'a\u0000b' }],
      ['day 0', { financialYearStartDay: 0 }],
    ];
    const disagreements: string[] = [];
    for (const [name, change] of cases) {
      const values = { ...base(), ...change };
      const schema = newOrganisationSchema.safeParse(values).success;
      const database = await databaseAccepts(values);
      if (schema !== database) disagreements.push(`${name}: schema ${schema}, database ${database}`);
    }
    assert.deepEqual(disagreements, []);
  });
});

describe('column rules against Postgres', () => {
  test('the jsonb text size matches octet_length(x::text)', async () => {
    const values: JsonValue[] = [
      { b: 1, a: [1, 2, { c: null }] }, [], {}, 'naïve "quoted" \\ text', 12.5, true, null,
      { emoji: '😀', nested: { deep: [[], {}] } }, [1e21, -0.5, 1.5e-7, -2.5e22],
    ];
    for (const value of values) {
      const { rows } = await migrate.query('select octet_length(($1::jsonb)::text) as n', [JSON.stringify(value)]);
      assert.equal(jsonbTextBytes(value), rows[0]!.n, JSON.stringify(value));
    }
  });
});
