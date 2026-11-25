// The directory end to end (spec 6.2, 6.4, 6.5, 55.1): a real directory process on a fresh
// directory database, registering cells, organisations and identities as the cells would,
// and routing logins for the browser on its public listener.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type pg from 'pg';
import { loadConfig, type Config } from '../../src/config/index.config.ts';
import {
  findOrganisation, LOGIN_ROUTE_PATH, moveOrganisation, registerCell, registerIdentity, registerOrganisation,
} from '../../src/contracts/directory/registration.contract.ts';
import { createKeyManagement, type KeyManagement } from '../../src/infra/kms.infra.ts';
import { createLogger } from '../../src/infra/logger.infra.ts';
import { createServiceClient, type ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { runProcess, type RunningProcess } from '../../src/process.ts';
import { createDirectoryService } from '../../src/routes/directory/index.route.ts';
import { AddressRateLimit } from '../../src/middleware/rateLimit.middleware.ts';
import { emailRoutingInput } from '../../src/utils/email.util.ts';
import { createHarness, type Harness } from '../db/harness.helper.ts';

const ORIGIN = 'https://silohq.io';
const KMS_KEY = randomBytes(32).toString('base64');

let h: Harness;
let reader: pg.Client;
let directory: RunningProcess;
let publicPort = 0;
let fleet: ServiceClient;
let directoryUrl: string;
let auth: ServiceClient;
let migrations: ServiceClient;
let kms: KeyManagement;
const lines: string[] = [];

const env = (extra: Record<string, string> = {}): Config => loadConfig({
  SILO_ENV: 'test', SILO_SERVICE: 'directory', SILO_CELL_ID: 'global-uk', SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk',
  SILO_HOSTING: 'gke', SILO_BUILD_TARGET: 'commercial', HTTP_HOST: '127.0.0.1', HTTP_PORT: '0', HTTP_DRAIN_SECONDS: '0',
  PG_DIRECTORY_URL: h.url('test_dir_writer', 'directory'), KMS_PROVIDER: 'local', KMS_LOCAL_KEY: KMS_KEY,
  KMS_DIRECTORY_KEY_URI: 'local:directory', DIRECTORY_PUBLIC_PORT: '0', DIRECTORY_PUBLIC_HOST: '127.0.0.1',
  DIRECTORY_PUBLIC_ORIGINS: ORIGIN, DIRECTORY_PUBLIC_REQUESTS_PER_MINUTE: '60', TRUST_PROXY_HOPS: '0', ...extra,
});

const hashOf = async (email: string): Promise<string> =>
  (await kms.mac('local:directory', emailRoutingInput(email))).toString('base64url');

const route = (body: unknown, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${publicPort}${LOGIN_ROUTE_PATH}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

const cell = (id: string, kind: 'commercial' | 'sovereign' | 'dedicated', residency: 'uk' | 'eu' | 'us', status: 'active' | 'provisioning' = 'active') =>
  fleet.call(registerCell, { params: { cellId: id }, body: { kind, residency, hostname: `${id}.silohq.io`, status } });

before(async () => {
  h = await createHarness();
  reader = await h.connect('test_dir_reader', 'directory');
  const config = env();
  let listening!: (port: number) => void;
  const port = new Promise<number>((resolve) => { listening = resolve; });
  directory = await runProcess([createDirectoryService({ onPublicListening: listening })], config, {
    logger: createLogger({ service: 'directory', cell: 'global-uk', release: 'test', level: 'debug', write: (line) => lines.push(line) }),
  });
  publicPort = await port;
  directoryUrl = `http://127.0.0.1:${directory.port}`;
  const http = { ...config.http, serviceUrls: { directory: directoryUrl } };
  fleet = createServiceClient({ caller: 'fleet-control', http });
  auth = createServiceClient({ caller: 'auth', http });
  migrations = createServiceClient({ caller: 'tenant-migrations', http });
  kms = await createKeyManagement({ provider: 'local', localKey: Buffer.from(KMS_KEY, 'base64'), vaultTransitMount: 'transit' });
});

after(async () => {
  for (const client of [fleet, auth, migrations]) client?.close();
  await directory?.stop('test');
  await kms?.close();
  await h?.close();
});

describe('the cell registry', () => {
  test('a cell registers itself; registering again changes nothing', async () => {
    for (const [id, kind, residency] of [['uk-lon-1', 'commercial', 'uk'], ['eu-fra-1', 'commercial', 'eu'], ['us-va-1', 'commercial', 'us'],
      ['ded-acme', 'dedicated', 'uk'], ['uk-sov-1', 'sovereign', 'uk']] as const) {
      const registered = await cell(id, kind, residency);
      assert.deepEqual(registered, { id, kind, residency, hostname: `${id}.silohq.io`, status: 'active' });
    }
    await cell('uk-lon-2', 'commercial', 'uk', 'provisioning');
    assert.equal((await cell('uk-lon-1', 'commercial', 'uk')).status, 'active');
    const { rows } = await reader.query('select count(*)::int as n from directory.cells');
    assert.equal(rows[0].n, 6);
  });

  test('a cell keeps its kind, residency and hostname; its status moves only forward', async () => {
    await assert.rejects(cell('uk-lon-1', 'commercial', 'eu'), { code: 'directory.cell_immutable' });
    await assert.rejects(fleet.call(registerCell, {
      params: { cellId: 'uk-lon-1' }, body: { kind: 'commercial', residency: 'uk', hostname: 'elsewhere.silohq.io', status: 'active' },
    }), { code: 'directory.cell_immutable' });
    const move = (status: 'retired' | 'closed_to_placement' | 'active' | 'draining', id = 'us-va-1') => fleet.call(registerCell, {
      params: { cellId: id }, body: { kind: 'commercial', residency: 'us', hostname: `${id}.silohq.io`, status },
    });
    await assert.rejects(move('retired'), { code: 'directory.cell_transition' });
    assert.equal((await move('closed_to_placement')).status, 'closed_to_placement');
    assert.equal((await move('active')).status, 'active');
    await assert.rejects(move('draining', 'us-new-1'), { code: 'directory.cell_status_invalid' });
  });

  test('only the listed callers reach a registration endpoint', async () => {
    const response = await fetch(`http://127.0.0.1:${directory.port}/v1/cells/uk-lon-9`, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'x-silo-caller': 'gateway' },
      body: JSON.stringify({ kind: 'commercial', residency: 'uk', hostname: 'uk-lon-9.silohq.io', status: 'active' }),
    });
    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'caller.not_listed');
  });
});

describe('organisations', () => {
  const register = (slug: string, cellId: string, status: 'active' | 'suspended' | 'closed' = 'active') =>
    auth.call(registerOrganisation, { params: { organisationSlug: slug }, body: { cellId, status } });

  test('a slug is placed once, in an open cell, and never in another', async () => {
    assert.deepEqual(await register('acme', 'uk-lon-1'), { organisationSlug: 'acme', cellId: 'uk-lon-1', status: 'active' });
    assert.deepEqual(await register('ACME', 'uk-lon-1'), { organisationSlug: 'acme', cellId: 'uk-lon-1', status: 'active' },
      'slugs compare without case');
    await assert.rejects(register('acme', 'eu-fra-1'), { code: 'directory.slug_taken' });
    await assert.rejects(register('fresh', 'uk-lon-2'), { code: 'directory.cell_not_open' });
    await assert.rejects(register('fresh', 'uk-nowhere-1'), { code: 'directory.cell_unknown' });
    await assert.rejects(register('fresh', 'uk-lon-1', 'closed'), { code: 'directory.organisation_status_invalid' });
  });

  test('a cell registers organisations only in itself; a move is made from either end', async () => {
    const http = { ...env().http, serviceUrls: { directory: directoryUrl } };
    const fromCell = (cell: string, caller: 'auth' | 'fleet-control' = 'auth') => createServiceClient({ caller, cell, http });
    const london = fromCell('uk-lon-1');
    const frankfurt = fromCell('eu-fra-1');
    const frankfurtFleet = fromCell('eu-fra-1', 'fleet-control');
    try {
      assert.equal((await london.call(registerOrganisation, { params: { organisationSlug: 'initech' }, body: { cellId: 'uk-lon-1', status: 'active' } })).cellId,
        'uk-lon-1');
      await assert.rejects(frankfurt.call(registerOrganisation, { params: { organisationSlug: 'initech' }, body: { cellId: 'uk-lon-1', status: 'closed' } }),
        { category: 'forbidden', code: 'directory.foreign_cell' });
      await assert.rejects(frankfurtFleet.call(registerCell, {
        params: { cellId: 'uk-lon-1' }, body: { kind: 'commercial', residency: 'uk', hostname: 'uk-lon-1.silo.example', status: 'retired' },
      }), { code: 'directory.foreign_cell' });
    } finally {
      for (const client of [london, frankfurt, frankfurtFleet]) client.close();
    }
  });

  test('the shared directory holds nothing for a sovereign cell (spec 6.5)', async () => {
    await assert.rejects(register('crown', 'uk-sov-1'), { code: 'directory.sovereign_elsewhere' });
  });

  test('the holding cell changes the status; closed is final', async () => {
    assert.equal((await register('acme', 'uk-lon-1', 'suspended')).status, 'suspended');
    assert.equal((await register('acme', 'uk-lon-1', 'active')).status, 'active');
    assert.equal((await register('acme', 'uk-lon-1', 'closed')).status, 'closed');
    await assert.rejects(register('acme', 'uk-lon-1', 'active'), { code: 'directory.organisation_closed' });
  });

  test('a tenant migration moves the entry from its source, once (spec 6.4)', async () => {
    await register('globex', 'uk-lon-1');
    const move = (fromCellId: string, toCellId: string) =>
      migrations.call(moveOrganisation, { params: { organisationSlug: 'globex' }, body: { fromCellId, toCellId } });
    await assert.rejects(move('eu-fra-1', 'us-va-1'), { code: 'directory.move_source_mismatch' });
    await assert.rejects(move('uk-lon-1', 'uk-lon-2'), { code: 'directory.cell_not_open' });
    await assert.rejects(move('uk-lon-1', 'uk-sov-1'), { code: 'directory.sovereign_elsewhere' });
    assert.equal((await move('uk-lon-1', 'eu-fra-1')).cellId, 'eu-fra-1');
    assert.equal((await move('uk-lon-1', 'eu-fra-1')).cellId, 'eu-fra-1', 'repeating a finished move changes nothing');
    assert.deepEqual(await auth.call(findOrganisation, { params: { organisationSlug: 'globex' } }),
      { organisationSlug: 'globex', cellId: 'eu-fra-1', status: 'active', hostname: 'eu-fra-1.silohq.io' });
    await assert.rejects(auth.call(findOrganisation, { params: { organisationSlug: 'nobody' } }), { code: 'directory.organisation_unknown' });
  });
});

describe('identities', () => {
  const register = (email: string | undefined, cellId: string, hashKeyVersion = 1, emailHash?: string) => (async () =>
    auth.call(registerIdentity, { body: { cellId, emailHash: emailHash ?? await hashOf(email!), hashKeyVersion } }))();

  test('a cell registers the hash of each address it holds; again changes nothing', async () => {
    assert.deepEqual(await register('ada@acme.example', 'uk-lon-1'), { created: true });
    assert.deepEqual(await register('ada@acme.example', 'uk-lon-1'), { created: false });
    await register('bob@acme.example', 'uk-lon-1');
    await register('bob@acme.example', 'us-va-1');
    const { rows } = await reader.query('select email_hash, hash_key_version from directory.identity_routing');
    assert.equal(rows.length, 3);
    assert.ok(rows.every((row) => row.email_hash.length === 32 && row.hash_key_version === 1));
    const stored = Buffer.concat(rows.map((row) => row.email_hash as Buffer)).toString('latin1');
    assert.ok(!stored.includes('acme.example'), 'no address is stored');
  });

  test('refused: an unknown key version, a sovereign cell, a malformed hash', async () => {
    await assert.rejects(register('ada@acme.example', 'uk-lon-1', 2), { code: 'directory.key_version_unknown' });
    await assert.rejects(register('ada@acme.example', 'uk-sov-1'), { code: 'directory.sovereign_elsewhere' });
    const nonCanonical = `${(await hashOf('x@acme.example')).slice(0, 42)}B`;
    await assert.rejects(register(undefined, 'uk-lon-1', 1, nonCanonical), { code: 'contract.request_invalid' });
  });
});

describe('sign-up placement on the public listener (decision 2026-11-14)', () => {
  const place = async (body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${publicPort}/v1/signup/place`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };

  test('the residency chosen, default UK, to a cell open to placement in it; never across residency', async () => {
    const uk = await place({});
    assert.equal(uk.status, 200);
    assert.deepEqual(uk.body, { next: 'cell', cellId: 'uk-lon-1', signupUrl: 'https://app.uk-lon-1.silohq.io/signup' });
    const eu = await place({ residency: 'eu' });
    assert.equal(eu.body['cellId'], 'eu-fra-1');
    assert.equal((await place({ residency: 'mars' })).status, 400);
  });

  test('a cell at a placement limit takes no new organisation: its connections as its agent last reported them (spec 6.3)', async () => {
    const registered = await fleet.call(registerCell, {
      params: { cellId: 'uk-lon-1' }, body: { kind: 'commercial', residency: 'uk', hostname: 'uk-lon-1.silohq.io', status: 'active', connectionCount: 50_000 },
    });
    assert.deepEqual([registered.connectionCount, registered.countsAt !== null], [50_000, true], 'the count is kept with the registration');
    const full = await place({});
    assert.notEqual(full.body['cellId'], 'uk-lon-1', 'not the full cell');
    await fleet.call(registerCell, {
      params: { cellId: 'uk-lon-1' }, body: { kind: 'commercial', residency: 'uk', hostname: 'uk-lon-1.silohq.io', status: 'active', connectionCount: 49_999 },
    });
    assert.equal((await place({})).body['cellId'], 'uk-lon-1', 'room again below the limit');
  });
});

describe('login routing on the public listener', () => {
  const answer = async (body: unknown) => {
    const response = await route(body, { origin: ORIGIN });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
    return response.json();
  };

  test('by slug: to the cell that holds it; closed and unknown slugs route nowhere', async () => {
    assert.deepEqual(await answer({ organisationSlug: 'Globex' }),
      { next: 'cell', cellId: 'eu-fra-1', loginUrl: 'https://app.eu-fra-1.silohq.io/login?organisation=globex' });
    assert.deepEqual(await answer({ organisationSlug: 'acme' }), { next: 'unknown_organisation' });
    assert.deepEqual(await answer({ organisationSlug: 'nobody' }), { next: 'unknown_organisation' });
  });

  test('by address: one cell routes there, several ask for the organisation', async () => {
    assert.deepEqual(await answer({ email: '  Ada@Acme.Example ' }),
      { next: 'cell', cellId: 'uk-lon-1', loginUrl: 'https://app.uk-lon-1.silohq.io/login' });
    assert.deepEqual(await answer({ email: 'bob@acme.example' }), { next: 'organisation' });
  });

  test('an unknown address looks like a known one: a stable decoy among the shared commercial cells', async () => {
    const decoys = new Set<string>();
    for (const email of ['nobody@example.com', 'someone@example.org', 'x1@example.net', 'x2@example.net', 'x3@example.net']) {
      const first = await answer({ email }) as { next: string; cellId: string };
      const again = await answer({ email }) as { next: string; cellId: string };
      assert.equal(first.next, 'cell');
      assert.equal(first.cellId, again.cellId, 'the same address always gets the same decoy');
      decoys.add(first.cellId);
    }
    for (const id of decoys) assert.ok(['uk-lon-1', 'eu-fra-1', 'us-va-1'].includes(id), `${id} is a shared commercial cell`);
  });

  test('refused: a malformed body, another origin; a preflight from the login page passes', async () => {
    assert.equal((await route({ email: 'not an address' }, { origin: ORIGIN })).status, 400);
    assert.equal((await route({ email: 'a@b.example', organisationSlug: 'acme' }, { origin: ORIGIN })).status, 400);
    const foreign = await route({ organisationSlug: 'globex' }, { origin: 'https://evil.example' });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.headers.get('access-control-allow-origin'), null);
    const preflight = await fetch(`http://127.0.0.1:${publicPort}${LOGIN_ROUTE_PATH}`, { method: 'OPTIONS', headers: { origin: ORIGIN } });
    assert.equal(preflight.status, 204);
    assert.equal((await fetch(`http://127.0.0.1:${publicPort}/v1/anything`)).status, 404);
  });

  test('no address, slug or hash reaches a log line', async () => {
    const text = lines.join('\n');
    for (const secret of ['ada@acme.example', 'Ada@Acme', 'bob@acme', 'nobody@example.com', 'globex', await hashOf('ada@acme.example')]) {
      assert.ok(!text.includes(secret), `the logs do not contain ${secret}`);
    }
    assert.ok(lines.some((line) => line.includes('directory.login_route')));
  });

  test('a client address over its limit is told to wait', async () => {
    let limited: Response | undefined;
    for (let i = 0; i < 80 && limited === undefined; i++) {
      const response = await route({ organisationSlug: 'globex' });
      if (response.status === 429) limited = response;
    }
    assert.ok(limited, 'refused within the limit of 60 a minute');
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  });
});

describe('start-up and limits', () => {
  test('the window resets each minute, and a full table sheds load', () => {
    let now = 0;
    const limit = new AddressRateLimit(2, () => now);
    limit.take('a');
    limit.take('a');
    assert.throws(() => limit.take('a'), { code: 'login.rate_limited' });
    now = 60_000;
    limit.take('a');
  });

  test('refuses to start when a directory key is not usable in the KMS', async () => {
    await assert.rejects(runProcess([createDirectoryService()], env({ KMS_DIRECTORY_KEY_URI: 'vault-transit:missing' }), {
      logger: createLogger({ service: 'directory', cell: 'global-uk', release: 'test', level: 'error', write: () => undefined }),
    }), { code: 'directory.keys_missing' });
  });

  test('configuration: previous key versions are distinct and not the current one', () => {
    assert.throws(() => env({ DIRECTORY_PREVIOUS_KEYS: '1=local:old' }), /DIRECTORY_PREVIOUS_KEYS/);
    assert.throws(() => env({ DIRECTORY_KEY_VERSION: '3', DIRECTORY_PREVIOUS_KEYS: '1=local:a,1=local:b' }), /DIRECTORY_PREVIOUS_KEYS/);
    assert.deepEqual(env({ DIRECTORY_KEY_VERSION: '3', DIRECTORY_PREVIOUS_KEYS: '2=local:b,1=local:a' }).globalTier.directory.previousKeys,
      [{ version: 2, keyUri: 'local:b' }, { version: 1, keyUri: 'local:a' }]);
  });
});
