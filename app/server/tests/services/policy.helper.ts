// Shared by the policy and governance tests: a fresh cell with one provisioned
// organisation, credential, auth and policy as real processes, and helpers to sign in,
// invite and call as a member.

import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { loadConfig, type Config } from '../../src/config/index.config.ts';
import { acceptInvitation, createInvitation } from '../../src/contracts/auth/invitation.contract.ts';
import { login } from '../../src/contracts/auth/session.contract.ts';
import type { AnyContract, CallInput, CallOutput } from '../../src/contracts/endpoint.contract.ts';
import { provisionOrganisation } from '../../src/db/scripts/provision.script.ts';
import { createLogger } from '../../src/infra/logger.infra.ts';
import { withTransaction } from '../../src/infra/postgres.infra.ts';
import { createServiceClient, type ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { runProcess, type RunningProcess } from '../../src/process.ts';
import { createAuthService } from '../../src/routes/auth/index.route.ts';
import { service as credentialService } from '../../src/routes/credential/index.route.ts';
import { service as policyService } from '../../src/routes/policy/index.route.ts';
import { CELL_ID, createLocalCell } from '../db/fixtures.helper.ts';
import { createHarness, inTx, uuidv7, type Harness } from '../db/harness.helper.ts';
import { LOCAL } from '../infra/services.helper.ts';

export const PASSWORD = 'correct horse battery staple';

export interface Signed { membershipId: string; sessionId: string; mfa: string }

export interface PolicyCell {
  h: Harness;
  migrate: pg.Client;
  app: pg.Client;
  org: string;
  root: { membershipId: string };
  roles: Record<string, string>;
  gateway: ServiceClient;
  invitations: { email: string; token: string }[];
  signIn(email: string): Promise<Signed>;
  as(who: Signed, extra?: { idempotencyKey?: string }): { request: { organisationId: string; membershipId: string; sessionId: string } };
  call<C extends AnyContract>(contract: C, input: CallInput<C>, who: Signed): Promise<CallOutput<C>>;
  /** Invites and accepts: the new member, signed in. */
  join(by: Signed, email: string, role: string, scopeId?: string): Promise<Signed>;
  /** A client calling policy as another service would (the cell's Fleet agent runs as fleet-control). */
  policyAs(caller: 'fleet-control' | 'admin-portal'): ServiceClient;
  /** Audit events written to the outbox for the organisation, newest last. */
  events(name?: string): Promise<{ event: string; detail: Record<string, unknown>; subjectMembershipId: string | null; scopeId: string | null;
    resource: { type: string; id: string } | null }[]>;
  close(): Promise<void>;
}

export async function startPolicyCell(options: { cellKind?: 'commercial' | 'dedicated' | 'sovereign' | 'self_managed' } = {}): Promise<PolicyCell> {
  const h = await createHarness();
  const migrate = await h.connect('test_migrate');
  const app = await h.connect('test_app');
  await createLocalCell(migrate);
  await migrate.query(`insert into iam.kms_key_versions (id, provider, key_uri, version, status, activated_at) values ($1, 'local', 'local:t', 1, 'active', now())`, [uuidv7()]);
  const created = await withTransaction(migrate, {}, (db) => provisionOrganisation(db, {
    slug: 'acme', name: 'Acme', email: 'root@acme.example', firstName: 'Root', lastName: 'Admin', password: PASSWORD, cellId: CELL_ID,
    plan: 'business', timeZone: 'Europe/London',
  }, { ARGON2_MEMORY_KIB: '1024', ARGON2_PASSES: '1' }));
  const org = created.organisationId;
  const roles: Record<string, string> = {};
  const { rows } = await inTx(app, { orgId: org }, () => app.query('select id, name from iam.roles where organisation_id = $1', [org]));
  for (const row of rows) roles[row.name as string] = row.id as string;

  const quiet = createLogger({ service: 'test', cell: CELL_ID, release: 'test', level: 'error', write: () => undefined });
  const env = (service: string, login: 'test_auth' | 'test_credential' | 'test_app', extra: Record<string, string> = {}): Config => loadConfig({
    SILO_ENV: 'test', SILO_SERVICE: service, SILO_CELL_ID: CELL_ID, SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk', SILO_HOSTING: 'gke',
    SILO_BUILD_TARGET: 'commercial', HTTP_HOST: '127.0.0.1', HTTP_PORT: '0', HTTP_DRAIN_SECONDS: '0', PG_CONTROL_URL: h.url(login),
    REDIS_SESSION_URL: `${LOCAL.redisUrl}/0`, ...extra,
  });
  const processes: RunningProcess[] = [];
  const clients: ServiceClient[] = [];
  const invitations: { email: string; token: string }[] = [];
  const credential = await runProcess([credentialService], env('credential', 'test_credential', {
    KMS_PROVIDER: 'local', KMS_LOCAL_KEY: randomBytes(32).toString('base64'),
  }), { logger: quiet });
  const policy = await runProcess([policyService], env('policy', 'test_app', options.cellKind ? { SILO_CELL_KIND: options.cellKind } : {}), { logger: quiet });
  const authConfig = env('auth', 'test_auth', {
    REDIS_DATA_URL: `${LOCAL.redisUrl}/1`, IDENTIFIER_HASH_KEY: randomBytes(32).toString('base64'), ARGON2_MEMORY_KIB: '1024',
    ARGON2_PASSES: '1', SERVICE_URL_CREDENTIAL: `http://127.0.0.1:${credential.port}`, SERVICE_URL_POLICY: `http://127.0.0.1:${policy.port}`,
  });
  const auth = await runProcess([createAuthService({
    invitationDelivery: { async deliver(invitation) { invitations.push({ email: invitation.email, token: invitation.token }); } },
    resetDelivery: { async deliver() { /* not used */ } },
  })], authConfig, { logger: quiet });
  processes.push(auth, policy, credential);
  const gateway = createServiceClient({
    caller: 'gateway',
    http: { ...authConfig.http, serviceUrls: { auth: `http://127.0.0.1:${auth.port}`, policy: `http://127.0.0.1:${policy.port}` } },
  });

  const as: PolicyCell['as'] = (who) => ({ request: { organisationId: org, membershipId: who.membershipId, sessionId: who.sessionId } });
  const signIn: PolicyCell['signIn'] = (email) => gateway.call(login, { body: { organisationSlug: 'acme', email, password: PASSWORD } });
  return {
    h, migrate, app, org, root: { membershipId: created.membershipId }, roles, gateway, invitations, signIn, as,
    call: (contract, input, who) => gateway.call(contract, input, as(who)),
    policyAs(caller) {
      const client = createServiceClient({ caller, http: { ...authConfig.http, serviceUrls: { policy: `http://127.0.0.1:${policy.port}` } } });
      clients.push(client);
      return client;
    },
    async join(by, email, role, scopeId) {
      await gateway.call(createInvitation, { body: { email, roleId: roles[role]!, ...(scopeId ? { scopeId } : {}) } },
        { ...as(by), idempotencyKey: uuidv7() });
      return gateway.call(acceptInvitation, {
        body: { organisationSlug: 'acme', token: invitations.findLast((i) => i.email === email)!.token, password: PASSWORD, firstName: 'New', lastName: 'Person' },
      });
    },
    async events(name) {
      const { rows: found } = await migrate.query(
        `select payload from platform.outbox where organisation_id = $1 and event = 'audit_event' and ($2::text is null or payload->>'event' = $2)
         order by seq`, [org, name ?? null]);
      return found.map((r) => r.payload as { event: string; detail: Record<string, unknown>; subjectMembershipId: string | null;
        scopeId: string | null; resource: { type: string; id: string } | null });
    },
    async close() {
      gateway.close();
      for (const c of clients) c.close();
      for (const p of processes) await p.stop('test');
      await h.close();
    },
  };
}
