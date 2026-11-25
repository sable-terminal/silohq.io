// Shared by the workspace and ask tests: a fresh cell with one provisioned organisation;
// credential, policy and auth as real processes; workspace and ask as real processes on a
// fake query engine (the compile and executor services are built elsewhere). The fake
// compiles to real ontology.compiled_manifests rows, so the keys the views and turns hold
// are real, and records every run with the request context it ran under.

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
import { createAskService } from '../../src/routes/ask/index.route.ts';
import { createLineageService } from '../../src/routes/lineage/index.route.ts';
import { service as simulationService } from '../../src/routes/simulation/index.route.ts';
import { createAuthService } from '../../src/routes/auth/index.route.ts';
import { createGatewayService } from '../../src/routes/gateway/index.route.ts';
import { service as credentialService } from '../../src/routes/credential/index.route.ts';
import { service as policyService } from '../../src/routes/policy/index.route.ts';
import { createSiloesCaptureService } from '../../src/routes/siloes-capture/index.route.ts';
import { createWorkspaceService } from '../../src/routes/workspace/index.route.ts';
import type { CompileOutcome, CompileRequest, EngineCaller, QueryEngine, RunTarget, FailureOutcome } from '../../src/services/workspace/queryEngine.service.ts';
import type { RunOutcomeView } from '../../src/contracts/workspace/view.contract.ts';
import { CELL_ID, createLocalCell } from '../db/fixtures.helper.ts';
import { createHarness, inTx, uuidv7, type Harness } from '../db/harness.helper.ts';
import { LOCAL } from '../infra/services.helper.ts';

export const PASSWORD = 'correct horse battery staple';

export interface Signed { membershipId: string; sessionId: string }

/** A query engine that compiles to real manifest rows and runs by script. */
export class FakeEngine implements QueryEngine {
  readonly compiles: { request: CompileRequest; caller: EngineCaller }[] = [];
  readonly runs: { target: RunTarget; membershipId: string | undefined }[] = [];
  /** The next compile's outcome; a plan is written as a manifest row created by the caller. */
  next: ((request: CompileRequest) => CompileOutcome | 'plan' | 'advanced') = () => 'plan';
  /** Members whose runs drop part of the plan (spec 37.5). */
  readonly reducedFor = new Set<string>();
  runOutcome: ((target: RunTarget) => RunOutcomeView | undefined) = () => undefined;
  /** Compile runs the plan too (as the compile service's answer does): the caller must not run it again. */
  runsAtCompile = false;
  /** Start a scenario's failure statements (36.4), and the next one's outcome. */
  readonly failures: { question: string; objectTypeId: string; chargeKey: string }[] = [];
  nextFailure: () => FailureOutcome = () => ({
    outcome: 'failure', failure: { form: 'unavailable', asWritten: 'unavailable' }, tokensCharged: 1,
  });

  readonly #migrate: pg.Client;
  readonly #org: string;
  readonly #versionId: string;

  constructor(migrate: pg.Client, org: string, versionId: string) {
    this.#migrate = migrate;
    this.#org = org;
    this.#versionId = versionId;
  }

  async manifest(createdBy: string, kind: 'query' | 'analysis' = 'query'): Promise<string> {
    const id = uuidv7();
    await this.#migrate.query(
      `insert into ontology.compiled_manifests (id, organisation_id, kind, manifest, manifest_hash, schema_version, ontology_version_id,
         policy_version, compile_class, created_by_membership_id)
       values ($1, $2, $3, '{"steps": []}', $4, '1', $5, 1, 'standard', $6)`,
      [id, this.#org, kind, randomBytes(32), this.#versionId, createdBy]);
    return id;
  }

  /** Values bound to a plan under a holder's id, as compile keeps them for a turn the member asked (sealed bytes stand in). */
  async binding(id: string, manifestId: string, createdBy: string): Promise<void> {
    await this.#migrate.query(
      `insert into ontology.plan_bindings (id, organisation_id, compiled_manifest_id, parameters, created_by_membership_id) values ($1, $2, $3, $4, $5)`,
      [id, this.#org, manifestId, randomBytes(16), createdBy]);
    this.bound.set(id, manifestId);
  }

  async failure(request: { question: string; objectTypeId: string; chargeKey: string }): Promise<FailureOutcome> {
    this.failures.push(request);
    return this.nextFailure();
  }

  async compile(request: CompileRequest, caller: EngineCaller): Promise<CompileOutcome> {
    this.compiles.push({ request, caller });
    const next = this.next(request);
    if (next !== 'plan' && next !== 'advanced') return next;
    const manifestId = await this.manifest(caller.request.membershipId!);
    this.bound.set(request.turnId, manifestId);
    return {
      outcome: 'plan', manifestId, compileClass: next === 'advanced' ? 'advanced' : 'standard', tokensCharged: next === 'advanced' ? 3 : 1,
      rephraseUncharged: false,
      ...(this.runsAtCompile ? {
        ran: { outcome: 'result' as const, resultRef: `ran-at-compile-${uuidv7()}`, ranAt: new Date().toISOString(), reduced: false, incompleteSources: [] },
      } : {}),
    };
  }

  async run(target: RunTarget, caller: EngineCaller): Promise<RunOutcomeView> {
    this.runs.push({ target, membershipId: caller.request.membershipId });
    return this.runOutcome(target) ?? {
      outcome: 'result', resultRef: uuidv7(), ranAt: new Date().toISOString(),
      reduced: this.reducedFor.has(caller.request.membershipId ?? ''), incompleteSources: [],
    };
  }

  /** Bindings copied (from, to): what a turn's values were kept under, and where they went. */
  readonly bindings: { from: string; to: string }[] = [];
  /** The plan each binding holder's values belong to. */
  readonly bound = new Map<string, string>();

  async bind(fromBindingId: string, toBindingId: string): Promise<{ planId: string }> {
    const planId = this.bound.get(fromBindingId);
    if (planId === undefined) throw Object.assign(new Error('no such binding'), { code: 'compile.binding_not_found' });
    this.bindings.push({ from: fromBindingId, to: toBindingId });
    this.bound.set(toBindingId, planId);
    return { planId };
  }
}

export interface WorkspaceCell {
  h: Harness;
  migrate: pg.Client;
  app: pg.Client;
  org: string;
  root: Signed;
  roles: Record<string, string>;
  engine: FakeEngine;
  gateway: ServiceClient;
  policyClient: ServiceClient;
  /** The public edge, when started with { edge: true }: its base URL. */
  edgeUrl: string | undefined;
  signIn(email: string): Promise<Signed>;
  as(who: Signed, extra?: { idempotencyKey?: string }): { request: { organisationId: string; membershipId: string; sessionId: string }; idempotencyKey?: string };
  call<C extends AnyContract>(contract: C, input: CallInput<C>, who: Signed, extra?: { idempotencyKey?: string }): Promise<CallOutput<C>>;
  /** A scope under the given parent (or a root scope). */
  scope(name: string, parent?: string): Promise<string>;
  /** Invites and accepts: the new member, signed in. */
  join(email: string, role: string, scopeId?: string): Promise<Signed>;
  /** Audit events written to the outbox, oldest first. */
  events(name?: string): Promise<{ event: string; detail: Record<string, unknown>; resource: { type: string; id: string } | null; subjectMembershipId: string | null }[]>;
  close(): Promise<void>;
}

/** The browser origin the edge serves, when started. */
export const ORIGIN = 'https://app.silo.test';

/** A web search provider the Ask tests watch and can break (36.7). */
export const web = {
  queries: [] as string[],
  fail: false,
  async search(query: string) {
    this.queries.push(query);
    if (this.fail) throw new Error('down');
    return [{ title: 'Port strike at Felixstowe', url: 'https://news.example/strike', snippet: 'Dock workers walked out on Monday.' }];
  },
};

export async function startWorkspaceCell(options: { edge?: boolean } = {}): Promise<WorkspaceCell> {
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

  // Main and its first version, as the ontology service creates them: what compiled manifests key to.
  const versionId = uuidv7();
  await migrate.query('begin');
  await migrate.query(
    `insert into ontology.ontology_versions (id, organisation_id, branch_id, sequence, kind, manifest_hash, created_by_membership_id)
     values ($1, $2, $3, 1, 'migration', $4, $5)`, [versionId, org, uuidv7(), randomBytes(32), created.membershipId]);
  await migrate.query(
    `insert into ontology.ontology_branches (id, organisation_id, name, kind, head_version_id)
     select branch_id, organisation_id, 'main', 'main', id from ontology.ontology_versions where id = $1`, [versionId]);
  await migrate.query('commit');
  const engine = new FakeEngine(migrate, org, versionId);

  const quiet = createLogger({ service: 'test', cell: CELL_ID, release: 'test', level: 'error', write: () => undefined });
  const env = (service: string, login: 'test_auth' | 'test_credential' | 'test_app', extra: Record<string, string> = {}): Config => loadConfig({
    SILO_ENV: 'test', SILO_SERVICE: service, SILO_CELL_ID: CELL_ID, SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk', SILO_HOSTING: 'gke',
    SILO_BUILD_TARGET: 'commercial', HTTP_HOST: '127.0.0.1', HTTP_PORT: '0', HTTP_DRAIN_SECONDS: '0', PG_CONTROL_URL: h.url(login),
    REDIS_SESSION_URL: `${LOCAL.redisUrl}/0`, REDIS_DATA_URL: `${LOCAL.redisUrl}/1`, ...extra,
  });
  const processes: RunningProcess[] = [];
  const invitations: { email: string; token: string }[] = [];
  const credential = await runProcess([credentialService], env('credential', 'test_credential', {
    KMS_PROVIDER: 'local', KMS_LOCAL_KEY: randomBytes(32).toString('base64'),
  }), { logger: quiet });
  const policy = await runProcess([policyService], env('policy', 'test_app'), { logger: quiet });
  const policyUrl = `http://127.0.0.1:${policy.port}`;
  const authConfig = env('auth', 'test_auth', {
    IDENTIFIER_HASH_KEY: randomBytes(32).toString('base64'), ARGON2_MEMORY_KIB: '1024', ARGON2_PASSES: '1',
    SERVICE_URL_CREDENTIAL: `http://127.0.0.1:${credential.port}`, SERVICE_URL_POLICY: policyUrl,
  });
  const auth = await runProcess([createAuthService({
    invitationDelivery: { async deliver(invitation) { invitations.push({ email: invitation.email, token: invitation.token }); } },
    resetDelivery: { async deliver() { /* not used */ } },
  })], authConfig, { logger: quiet });
  // Whether a Silo is enabled decides the rail's Siloes item (spec 33.3).
  const siloes = await runProcess([createSiloesCaptureService({ schedule: false })], env('siloes-capture', 'test_app', {
    SERVICE_URL_POLICY: policyUrl, SILOES_POSTGRES_PRICE_PER_GIB_MONTH: '0.20', SILOES_STORAGE_PRICE_PER_GIB_MONTH: '0.02',
  }), { logger: quiet });
  const siloesUrl = `http://127.0.0.1:${siloes.port}`;
  const workspace = await runProcess([createWorkspaceService({ engine })], env('workspace', 'test_app', {
    SERVICE_URL_POLICY: policyUrl, SERVICE_URL_SILOES_CAPTURE: siloesUrl,
  }), { logger: quiet });
  // Simulation, for Ask's start a scenario (36.4).
  const simulation = await runProcess([simulationService], env('simulation', 'test_app', { SERVICE_URL_POLICY: policyUrl }), { logger: quiet });
  // Lineage, for Ask's explain lineage (36.4).
  const lineage = await runProcess([createLineageService({ propagation: { intervalMs: 60_000 } })], env('lineage', 'test_app', {
    SERVICE_URL_POLICY: policyUrl,
  }), { logger: quiet });
  const ask = await runProcess([createAskService({ engine, webSearch: web })], env('ask', 'test_app', {
    SERVICE_URL_POLICY: policyUrl, SERVICE_URL_CREDENTIAL: `http://127.0.0.1:${credential.port}`, SERVICE_URL_LINEAGE: `http://127.0.0.1:${lineage.port}`,
    SERVICE_URL_SIMULATION: `http://127.0.0.1:${simulation.port}`,
  }), { logger: quiet });
  processes.push(ask, lineage, simulation, workspace, siloes, auth, policy, credential);
  const urls = {
    auth: `http://127.0.0.1:${auth.port}`, policy: policyUrl, workspace: `http://127.0.0.1:${workspace.port}`, ask: `http://127.0.0.1:${ask.port}`,
    'siloes-capture': siloesUrl,
  };
  let edgeUrl: string | undefined;
  if (options.edge) {
    let port = 0;
    processes.unshift(await runProcess([createGatewayService({ onListening: (p) => { port = p; } })], env('gateway', 'test_app', {
      NATS_LIVE_URL: LOCAL.natsUrl, IDENTIFIER_HASH_KEY: randomBytes(32).toString('base64'),
      GATEWAY_PUBLIC_ORIGIN: ORIGIN, GATEWAY_PUBLIC_HOST: '127.0.0.1', GATEWAY_PUBLIC_PORT: '0', TRUST_PROXY_HOPS: '1',
      SERVICE_URL_AUTH: urls.auth, SERVICE_URL_POLICY: urls.policy, SERVICE_URL_WORKSPACE: urls.workspace, SERVICE_URL_ASK: urls.ask,
      SERVICE_URL_SILOES_CAPTURE: siloesUrl,
    }), { logger: quiet }));
    edgeUrl = `http://127.0.0.1:${port}`;
  }
  const gateway = createServiceClient({ caller: 'gateway', http: { ...authConfig.http, serviceUrls: urls } });
  const policyClient = createServiceClient({ caller: 'policy', http: { ...authConfig.http, serviceUrls: urls } });

  const signIn = async (email: string): Promise<Signed> => {
    const session = await gateway.call(login, { body: { organisationSlug: 'acme', email, password: PASSWORD } });
    return { membershipId: session.membershipId, sessionId: session.sessionId };
  };
  const as: WorkspaceCell['as'] = (who, extra = {}) => ({
    request: { organisationId: org, membershipId: who.membershipId, sessionId: who.sessionId }, ...extra,
  });
  const root = await signIn('root@acme.example');
  let scopeType: string | undefined;

  return {
    h, migrate, app, org, root, roles, engine, gateway, policyClient, edgeUrl, signIn, as,
    call: (contract, input, who, extra) => gateway.call(contract, input, as(who, extra)),
    async scope(name, parent) {
      if (scopeType === undefined) {
        scopeType = uuidv7();
        await migrate.query('insert into iam.scope_types (id, organisation_id, name) values ($1, $2, $3)', [scopeType, org, 'Department']);
      }
      const id = uuidv7();
      await migrate.query(
        `insert into iam.scopes (id, organisation_id, scope_type_id, name, parent_scope_id, path, depth, created_by)
         values ($1, $2, $3, $4, $5, 'x', 1, $6)`, [id, org, scopeType, name, parent ?? null, created.membershipId]);
      return id;
    },
    async join(email, role, scopeId) {
      await gateway.call(createInvitation, { body: { email, roleId: roles[role]!, ...(scopeId ? { scopeId } : {}) } },
        as(root, { idempotencyKey: uuidv7() }));
      const session = await gateway.call(acceptInvitation, {
        body: { organisationSlug: 'acme', token: invitations.findLast((i) => i.email === email)!.token, password: PASSWORD, firstName: 'New', lastName: 'Person' },
      });
      return { membershipId: session.membershipId, sessionId: session.sessionId };
    },
    async events(name) {
      const { rows: found } = await migrate.query(
        `select payload from platform.outbox where organisation_id = $1 and event = 'audit_event' and ($2::text is null or payload->>'event' = $2)
         order by seq`, [org, name ?? null]);
      return found.map((r) => r.payload as { event: string; detail: Record<string, unknown>; resource: { type: string; id: string } | null;
        subjectMembershipId: string | null });
    },
    async close() {
      gateway.close();
      policyClient.close();
      for (const p of processes) await p.stop('test');
      await h.close();
    },
  };
}
