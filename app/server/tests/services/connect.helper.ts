// A cell for the Connect tests: a fresh database with a provisioned organisation (a super
// admin) and a scope tree, and the services as real processes: credential, policy, auth,
// connect-registry, and connect-runtime and oauth when a test asks. A member is invited
// through auth, as a person would be.

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import type pg from 'pg';
import { loadConfig, type Config } from '../../src/config/index.config.ts';
import type { ServiceName } from '../../src/config/service.config.ts';
import { acceptInvitation, createInvitation } from '../../src/contracts/auth/invitation.contract.ts';
import { login } from '../../src/contracts/auth/session.contract.ts';
import { provisionOrganisation } from '../../src/db/scripts/provision.script.ts';
import { createLogger } from '../../src/infra/logger.infra.ts';
import { withTransaction } from '../../src/infra/postgres.infra.ts';
import { createServiceClient, type CallOptions, type ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import type { ServiceDefinition } from '../../src/infra/service.infra.ts';
import { runProcess, type RunningProcess } from '../../src/process.ts';
import { createAuthService } from '../../src/routes/auth/index.route.ts';
import { service as registryService } from '../../src/routes/connect-registry/index.route.ts';
import { service as credentialService } from '../../src/routes/credential/index.route.ts';
import { service as policyService } from '../../src/routes/policy/index.route.ts';
import { CELL_ID, createLocalCell } from '../db/fixtures.helper.ts';
import { createHarness, inTx, uuidv7, type Harness } from '../db/harness.helper.ts';
import { LOCAL } from '../infra/services.helper.ts';

export const PASSWORD = 'correct horse battery staple';
// CONNECT_TEST_LOG=<file> keeps the services' error logs, for debugging a failing test
// (CONNECT_TEST_LOG_LEVEL=info for more).
const logFile = process.env['CONNECT_TEST_LOG'];
export const quiet = createLogger({
  service: 'test', cell: CELL_ID, release: 'test', level: process.env['CONNECT_TEST_LOG_LEVEL'] === 'info' ? 'info' : 'error',
  write: logFile === undefined ? () => undefined : (line: string) => appendFileSync(logFile, `${line}\n`),
});

export interface Signed { membershipId: string; sessionId: string; mfa: string }

const keyPair = () => {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
};

/** The execution grant key pair of every test cell (spec 10.4): actions signs, connect-runtime and agents check. */
export const TEST_GRANT_KEYS = keyPair();
/** The discovery scan key pair of every test cell (spec 10.5): discovery signs, connect-runtime and agents check. */
export const TEST_SCAN_KEYS = keyPair();

export interface ConnectCell {
  h: Harness;
  migrate: pg.Client;
  app: pg.Client;
  credential: pg.Client;
  org: string;
  roles: Record<string, string>;
  scopes: Record<string, string>;
  ports: Partial<Record<ServiceName, number>>;
  /** A client for any service, calling as the given service. */
  client(caller: ServiceName): ServiceClient;
  signIn(email: string): Promise<Signed>;
  /** Invites and signs in a member with a role, organisation-wide or at a scope. */
  member(email: string, role: string, scope?: string): Promise<Signed>;
  /** Invites someone with a role and leaves the invitation open: its token, as its email would carry it. */
  invite(email: string, role: string): Promise<string>;
  /** The tokens auth would have emailed, newest last: password resets and invitations. */
  emailed: { resets: { email: string; token: string }[]; invitations: { email: string; token: string }[] };
  as(who: Signed, extra?: Partial<CallOptions>): CallOptions;
  /**
   * Records a completed conformance run on the connection's version that passed the classes
   * the confirm gate needs, as the suite would (tests/services/conformance.test.ts runs the
   * real one).
   */
  passConformance(connectionId: string): Promise<void>;
  /** Starts another service in this cell. */
  start(definition: ServiceDefinition, service: ServiceName, login: 'test_app' | 'test_credential' | 'test_billing', extra?: Record<string, string>): Promise<RunningProcess>;
  close(): Promise<void>;
}

/** early: services auth calls, started before it so auth knows where they are (a service learns addresses as it starts). */
export async function createConnectCell(options: { early?: { definition: ServiceDefinition; name: ServiceName; extra?: Record<string, string> }[] } = {})
  : Promise<ConnectCell> {
  const h = await createHarness();
  const migrate = await h.connect('test_migrate');
  const app = await h.connect('test_app');
  const credentialDb = await h.connect('test_credential');
  await createLocalCell(migrate);
  await migrate.query(`insert into iam.kms_key_versions (id, provider, key_uri, version, status, activated_at) values ($1, 'local', 'local:t', 1, 'active', now())`, [uuidv7()]);
  const created = await withTransaction(migrate, {}, (db) => provisionOrganisation(db, {
    slug: 'acme', name: 'Acme', email: 'root@acme.example', firstName: 'Root', lastName: 'Admin', password: PASSWORD, cellId: CELL_ID,
    plan: 'business', timeZone: 'Europe/London',
  }, { ARGON2_MEMORY_KIB: '1024', ARGON2_PASSES: '1' }));
  const org = created.organisationId;
  const roles: Record<string, string> = {};
  const scopes: Record<string, string> = {};
  const { rows } = await inTx(app, { orgId: org }, () => app.query('select id, name from iam.roles where organisation_id = $1', [org]));
  for (const row of rows) roles[row.name as string] = row.id as string;
  const type = uuidv7();
  await inTx(app, { orgId: org }, async () => {
    await app.query('insert into iam.scope_types (id, organisation_id, name) values ($1, $2, $3)', [type, org, 'Department']);
    for (const [name, parent] of [['engineering', null], ['platform', 'engineering'], ['sales', null]] as const) {
      scopes[name] = uuidv7();
      await app.query(
        'insert into iam.scopes (id, organisation_id, scope_type_id, name, parent_scope_id, path, depth, created_by) values ($1, $2, $3, $4, $5, $6, 1, $7)',
        [scopes[name], org, type, name, parent ? scopes[parent] : null, 'x', created.membershipId]);
    }
  });

  const processes: RunningProcess[] = [];
  const ports: Partial<Record<ServiceName, number>> = {};
  const invitations: { email: string; token: string }[] = [];
  const resets: { email: string; token: string }[] = [];
  const serviceUrls = (): Record<string, string> =>
    Object.fromEntries(Object.entries(ports).map(([name, port]) => [`SERVICE_URL_${name.toUpperCase().replaceAll('-', '_')}`, `http://127.0.0.1:${port}`]));
  const env = (service: ServiceName, login: string, extra: Record<string, string> = {}): Config => loadConfig({
    SILO_ENV: 'test', SILO_SERVICE: service, SILO_CELL_ID: CELL_ID, SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk', SILO_HOSTING: 'gke',
    SILO_BUILD_TARGET: 'commercial', HTTP_HOST: '127.0.0.1', HTTP_PORT: '0', HTTP_DRAIN_SECONDS: '0', PG_CONTROL_URL: h.url(login as never),
    REDIS_SESSION_URL: `${LOCAL.redisUrl}/0`, REDIS_DATA_URL: `${LOCAL.redisUrl}/1`,
    CONNECT_EGRESS_ALLOW_PRIVATE: 'true', CONNECT_EGRESS_ALLOW_HTTP: 'true',
    EXECUTION_GRANT_KEY: TEST_GRANT_KEYS.privateKey, EXECUTION_GRANT_PUBLIC_KEY: TEST_GRANT_KEYS.publicKey,
    DISCOVERY_SCAN_KEY: TEST_SCAN_KEYS.privateKey, DISCOVERY_SCAN_PUBLIC_KEY: TEST_SCAN_KEYS.publicKey, ...serviceUrls(), ...extra,
  });
  const start = async (definition: ServiceDefinition, service: ServiceName, login: string, extra: Record<string, string> = {}) => {
    const running = await runProcess([definition], env(service, login, extra), { logger: quiet });
    processes.push(running);
    ports[service] = running.port;
    return running;
  };

  try {
    await start(credentialService, 'credential', 'test_credential', { KMS_PROVIDER: 'local', KMS_LOCAL_KEY: randomBytes(32).toString('base64') });
    await start(policyService, 'policy', 'test_app');
    for (const e of options.early ?? []) await start(e.definition, e.name, 'test_app', e.extra);
    await start(createAuthService({
      invitationDelivery: { async deliver(invitation) { invitations.push({ email: invitation.email, token: invitation.token }); } },
      resetDelivery: { async deliver(reset) { resets.push({ email: reset.email, token: reset.token }); } },
    }), 'auth', 'test_auth', {
      IDENTIFIER_HASH_KEY: randomBytes(32).toString('base64'), ARGON2_MEMORY_KIB: '1024', ARGON2_PASSES: '1',
    });
    await start(registryService, 'connect-registry', 'test_app');
  } catch (error) {
    for (const p of processes.reverse()) await p.stop('test');
    await h.close();
    throw error;
  }

  const clients: ServiceClient[] = [];
  const client = (caller: ServiceName): ServiceClient => {
    const config = env('connect-registry', 'test_app');
    const c = createServiceClient({ caller, http: { ...config.http, serviceUrls: Object.fromEntries(Object.entries(ports).map(([n, p]) => [n, `http://127.0.0.1:${p}`])) } });
    clients.push(c);
    return c;
  };
  const gateway = () => client('gateway');
  const signIn = async (email: string): Promise<Signed> => gateway().call(login, { body: { organisationSlug: 'acme', email, password: PASSWORD } });
  const as = (who: Signed, extra: Partial<CallOptions> = {}): CallOptions =>
    ({ request: { organisationId: org, membershipId: who.membershipId, sessionId: who.sessionId }, ...extra });

  return {
    h, migrate, app, credential: credentialDb, org, roles, scopes, ports, client, signIn, as, start: start as ConnectCell['start'],
    async passConformance(connectionId) {
      await inTx(app, { orgId: org }, async () => {
        const { rows } = await app.query('select manifest_id from connect.connections where id = $1', [connectionId]);
        const passed = [{ id: 'read.list.fixture', class: 'read', object: 'fixture', outcome: 'passed', durationMs: 0, reason: null, operator: null }];
        await app.query(
          `insert into connect.conformance_runs (id, organisation_id, connection_id, manifest_id, suite_version, trigger, route, classes_run,
             results, passed_count, completed_at)
           values ($1, $2, $3, $4, 'fixture', 'manual', 'ai', '{read,pagination,error}', $5, 1, now())`,
          [uuidv7(), org, connectionId, rows[0].manifest_id, JSON.stringify(passed)]);
      });
    },
    async member(email, role, scope) {
      const root = await signIn('root@acme.example');
      await gateway().call(createInvitation, { body: { email, roleId: roles[role]!, ...(scope ? { scopeId: scopes[scope] } : {}) } },
        { ...as(root), idempotencyKey: uuidv7() });
      return gateway().call(acceptInvitation, {
        body: { organisationSlug: 'acme', token: invitations.findLast((i) => i.email === email)!.token, password: PASSWORD, firstName: 'New', lastName: 'Member' },
      });
    },
    async invite(email, role) {
      const root = await signIn('root@acme.example');
      await gateway().call(createInvitation, { body: { email, roleId: roles[role]! } }, { ...as(root), idempotencyKey: uuidv7() });
      return invitations.findLast((i) => i.email === email)!.token;
    },
    emailed: { resets, invitations },
    async close() {
      for (const c of clients) c.close();
      for (const p of processes.reverse()) await p.stop('test');
      await h.close();
    },
  };
}

/** A REST manifest for a fake CRM, varied by the caller. */
export function restManifest(overrides: { baseUrl: string; version?: string; auth?: Record<string, unknown>; params?: unknown[]; objects?: unknown[]; errors?: unknown }): Document {
  return doc({
    schemaVersion: '1',
    identity: { name: 'Example CRM', provider: 'Example', version: overrides.version ?? '1.0.0' },
    transport: { viaAgent: false, baseUrl: overrides.baseUrl },
    protocol: { kind: 'rest' },
    params: overrides.params ?? [],
    auth: overrides.auth ?? { strategy: 'bearer', fields: [{ name: 'token', kind: 'secret', label: 'API token', role: 'token' }] },
    ...(overrides.errors ? { errors: overrides.errors } : {}),
    objects: overrides.objects ?? [{
      name: 'contacts', identifier: ['id'],
      fields: [
        { name: 'id', type: 'string' },
        { name: 'email', type: 'string', path: 'properties.email' },
        { name: 'name', type: 'string', value: { jsonata: 'properties.first & " " & properties.last' } },
        { name: 'score', type: 'integer', path: 'properties.score' },
      ],
      source: {
        kind: 'rest', request: { method: 'GET', path: '/v1/contacts', query: { limit: '2' } }, records: { jsonata: 'results' },
        paging: { next: { cel: 'has(response.body.next) && response.body.next != null ? {"query": {"after": response.body.next}} : stop()' }, maxPages: 50 },
      },
      pushdown: {
        filters: [{ field: 'email', ops: ['eq'], patch: { cel: '{"query": {"email": string(value)}}' } }],
        sort: [{ field: 'score', patch: { cel: '{"query": {"sort": (direction == "desc" ? "-" : "") + field}}' } }],
        limit: { patch: { cel: '{"query": {"limit": string(limit)}}' } },
      },
    }],
  });
}

/** A manifest document as the registry's contract takes it. */
export type Document = Record<string, never>;
export const doc = (value: object): Document => value as Document;
