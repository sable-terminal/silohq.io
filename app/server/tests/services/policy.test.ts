// The policy service and invitations end to end: credential, auth and policy as real
// processes on a fresh cell database. A provisioned super admin invites an admin for
// Engineering, who invites a member for Platform; decisions follow the tree, the MFA
// rule and every change of policy version.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type pg from 'pg';
import { loadConfig, type Config } from '../../src/config/index.config.ts';
import { acceptInvitation, createInvitation } from '../../src/contracts/auth/invitation.contract.ts';
import { login } from '../../src/contracts/auth/session.contract.ts';
import { authorise } from '../../src/contracts/policy/decision.contract.ts';
import { provisionOrganisation } from '../../src/db/scripts/provision.script.ts';
import { withTransaction } from '../../src/infra/postgres.infra.ts';
import { createLogger } from '../../src/infra/logger.infra.ts';
import { createServiceClient, type ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { runProcess, type RunningProcess } from '../../src/process.ts';
import { createAuthService } from '../../src/routes/auth/index.route.ts';
import { service as credentialService } from '../../src/routes/credential/index.route.ts';
import { service as policyService } from '../../src/routes/policy/index.route.ts';
import { decide, policyApplies, satisfiesAll, stricter, type Authority } from '../../src/services/policy/policy.service.ts';
import { CELL_ID, createLocalCell } from '../db/fixtures.helper.ts';
import { createHarness, inTx, uuidv7, type Harness } from '../db/harness.helper.ts';
import { LOCAL } from '../infra/services.helper.ts';

const PASSWORD = 'correct horse battery staple';

describe('decisions over resolved grants (spec 57.6)', () => {
  const grant = (permissions: string[], scopePath: string | null) => ({ permissions, scopePath, resourceType: null, resourceId: null });
  const authority = (grants: Authority['grants'], memberScopePaths: string[] = [], membershipActive = true): Authority =>
    ({ membershipActive, grants, memberScopePaths, obligations: [] });

  test('organisation-wide grants apply everywhere; scope grants within their subtree only', () => {
    const a = authority([grant(['member.invite'], 'eng'), grant(['query.compile'], null)]);
    assert.equal(decide(a, 'member.invite', 'eng.platform', undefined), 'allowed');
    assert.equal(decide(a, 'member.invite', 'eng', undefined), 'allowed');
    assert.equal(decide(a, 'member.invite', 'sales', undefined), 'not_granted');
    assert.equal(decide(a, 'member.invite', 'engineering', undefined), 'not_granted', 'a prefix is not a parent');
    assert.equal(decide(a, 'query.compile', 'sales', undefined), 'allowed');
  });

  test('with no scope named, a scope grant applies where the membership sits; multiple scopes union', () => {
    const a = authority([grant(['query.compile'], 'eng'), grant(['file.export'], 'sales')], ['eng.platform', 'sales']);
    assert.equal(decide(a, 'query.compile', null, undefined), 'allowed');
    assert.equal(decide(a, 'file.export', null, undefined), 'allowed');
    assert.equal(decide(authority([grant(['query.compile'], 'eng')], ['sales']), 'query.compile', null, undefined), 'not_granted');
  });

  test('a resource grant applies to that resource only; an inactive membership is denied everything', () => {
    const id = uuidv7();
    const a = authority([{ permissions: ['connection.manage'], scopePath: null, resourceType: 'connection', resourceId: id }]);
    assert.equal(decide(a, 'connection.manage', null, { type: 'connection', id }), 'allowed');
    assert.equal(decide(a, 'connection.manage', null, { type: 'connection', id: uuidv7() }), 'not_granted');
    assert.equal(decide(authority([grant(['query.compile'], null)], [], false), 'query.compile', null, undefined), 'membership_inactive');
  });
});

describe('organisation-wide decisions, the mandatory gate and field policies, as pure rules (spec 57.4 to 57.6)', () => {
  const grant = (permissions: string[], scopePath: string | null) => ({ permissions, scopePath, resourceType: null, resourceId: null });

  test('organisation-wide counts only a grant held across the organisation', () => {
    const a: Authority = { membershipActive: true, grants: [grant(['audit.read'], 'eng'), grant(['query.compile'], null)], memberScopePaths: ['eng'],
      obligations: [] };
    assert.equal(decide(a, 'audit.read', null, undefined, true), 'not_granted');
    assert.equal(decide(a, 'audit.read', null, undefined), 'allowed');
    assert.equal(decide(a, 'query.compile', null, undefined, true), 'allowed');
  });

  test('every marking must be satisfied; one missing denies', () => {
    assert.equal(satisfiesAll([], new Set()), true);
    assert.equal(satisfiesAll(['a', 'b'], new Set(['a', 'b', 'c'])), true);
    assert.equal(satisfiesAll(['a', 'b'], new Set(['a'])), false);
  });

  test('a field policy\'s audience narrows by every condition set; the strictest effect wins', () => {
    const reader = { roleIds: new Set(['member']), scopePaths: ['eng.platform'], satisfied: new Set(['hr']) };
    const policy = { appliesToRoleId: null, appliesToMarkingId: null, appliesToScopePath: null, includeDescendants: false };
    assert.equal(policyApplies(policy, reader), true, 'no condition: everyone');
    assert.equal(policyApplies({ ...policy, appliesToRoleId: 'member' }, reader), true);
    assert.equal(policyApplies({ ...policy, appliesToRoleId: 'admin' }, reader), false);
    assert.equal(policyApplies({ ...policy, appliesToMarkingId: 'hr' }, reader), false, 'a cleared reader is outside a marking audience');
    assert.equal(policyApplies({ ...policy, appliesToScopePath: 'eng' }, reader), false, 'without descendants: that node only');
    assert.equal(policyApplies({ ...policy, appliesToScopePath: 'eng', includeDescendants: true }, reader), true);
    assert.equal(policyApplies({ ...policy, appliesToRoleId: 'member', appliesToScopePath: 'sales', includeDescendants: true }, reader), false, 'AND');
    assert.equal(stricter('mask', 'redact'), 'redact');
    assert.equal(stricter('deny', 'mask'), 'deny');
    assert.equal(stricter('allow', 'allow'), 'allow');
  });
});

let h: Harness;
let migrate: pg.Client;
let app: pg.Client;
const processes: RunningProcess[] = [];
let gateway: ServiceClient;
const invitations: { email: string; token: string }[] = [];
const quiet = createLogger({ service: 'test', cell: CELL_ID, release: 'test', level: 'error', write: () => undefined });

let org: string;
let superAdmin: { membershipId: string };
const roles: Record<string, string> = {};
const scopes: Record<string, string> = {};

const env = (service: string, login: 'test_auth' | 'test_credential' | 'test_app', extra: Record<string, string> = {}): Config => loadConfig({
  SILO_ENV: 'test', SILO_SERVICE: service, SILO_CELL_ID: CELL_ID, SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk', SILO_HOSTING: 'gke',
  SILO_BUILD_TARGET: 'commercial', HTTP_HOST: '127.0.0.1', HTTP_PORT: '0', HTTP_DRAIN_SECONDS: '0', PG_CONTROL_URL: h.url(login),
  REDIS_SESSION_URL: `${LOCAL.redisUrl}/0`, ...extra,
});

before(async () => {
  h = await createHarness();
  migrate = await h.connect('test_migrate');
  app = await h.connect('test_app');
  await createLocalCell(migrate);
  await migrate.query(`insert into iam.kms_key_versions (id, provider, key_uri, version, status, activated_at) values ($1, 'local', 'local:t', 1, 'active', now())`, [uuidv7()]);
  const created = await withTransaction(migrate, {}, (db) => provisionOrganisation(db, {
    slug: 'acme', name: 'Acme', email: 'root@acme.example', firstName: 'Root', lastName: 'Admin', password: PASSWORD, cellId: CELL_ID,
    plan: 'business', timeZone: 'Europe/London',
  }, { ARGON2_MEMORY_KIB: '1024', ARGON2_PASSES: '1' }));
  org = created.organisationId;
  superAdmin = { membershipId: created.membershipId };
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

  const credential = await runProcess([credentialService], env('credential', 'test_credential', {
    KMS_PROVIDER: 'local', KMS_LOCAL_KEY: randomBytes(32).toString('base64'),
  }), { logger: quiet });
  const policy = await runProcess([policyService], env('policy', 'test_app'), { logger: quiet });
  const authConfig = env('auth', 'test_auth', {
    REDIS_DATA_URL: `${LOCAL.redisUrl}/1`, IDENTIFIER_HASH_KEY: randomBytes(32).toString('base64'), ARGON2_MEMORY_KIB: '1024',
    ARGON2_PASSES: '1', SERVICE_URL_CREDENTIAL: `http://127.0.0.1:${credential.port}`, SERVICE_URL_POLICY: `http://127.0.0.1:${policy.port}`,
  });
  const auth = await runProcess([createAuthService({
    invitationDelivery: { async deliver(invitation) { invitations.push({ email: invitation.email, token: invitation.token }); } },
  })], authConfig, { logger: quiet });
  processes.push(auth, policy, credential);
  gateway = createServiceClient({
    caller: 'gateway',
    http: { ...authConfig.http, serviceUrls: { auth: `http://127.0.0.1:${auth.port}`, policy: `http://127.0.0.1:${policy.port}` } },
  });
});

after(async () => {
  gateway?.close();
  for (const p of processes) await p.stop('test');
  await h?.close();
});

interface Signed { membershipId: string; sessionId: string; mfa: string }
const signIn = async (email: string): Promise<Signed> =>
  gateway.call(login, { body: { organisationSlug: 'acme', email, password: PASSWORD } });
const as = (who: Signed) => ({ request: { organisationId: org, membershipId: who.membershipId, sessionId: who.sessionId } });
const may = async (who: Signed, permission: string, scope?: string) =>
  gateway.call(authorise, { body: { permission, ...(scope ? { scopeId: scopes[scope] } : {}) } }, as(who));

async function invite(by: Signed, email: string, role: string, scope?: string, idempotencyKey = uuidv7()) {
  return gateway.call(createInvitation, { body: { email, roleId: roles[role]!, ...(scope ? { scopeId: scopes[scope] } : {}) } },
    { ...as(by), idempotencyKey });
}
const accept = (email: string, first = 'New', last = 'Person') => gateway.call(acceptInvitation, {
  body: { organisationSlug: 'acme', token: invitations.findLast((i) => i.email === email)!.token, password: PASSWORD, firstName: first, lastName: last },
});

describe('invitations and decisions (spec 55.6, 56.7, 57)', () => {
  let root: Signed;
  let admin: Signed;
  let member: Signed;

  before(async () => {
    root = await signIn('root@acme.example');
  });

  test('a super admin invites an admin for Engineering; acceptance signs them in', async () => {
    assert.equal((await may(root, 'member.invite')).decision, 'allow');
    const key = uuidv7();
    const first = await invite(root, 'eve@acme.example', 'Admin', 'engineering', key);
    const again = await invite(root, 'eve@acme.example', 'Admin', 'engineering', key);
    assert.deepEqual(again, first, 'a retried request returns the first invitation');
    assert.equal(invitations.filter((i) => i.email === 'eve@acme.example').length, 1, 'and sends one email');
    admin = await accept('eve@acme.example', 'Eve', 'Engineer');
    assert.equal(admin.mfa, 'not_required');
  });

  test('the admin administers their subtree and nothing outside it', async () => {
    assert.deepEqual(await may(admin, 'member.invite', 'platform'), { decision: 'allow', reason: 'allowed' });
    assert.deepEqual(await may(admin, 'member.invite', 'sales'), { decision: 'deny', reason: 'not_granted' });
    assert.equal((await may(admin, 'clearance.grant')).decision, 'deny');
    await assert.rejects(invite(admin, 'sam@acme.example', 'Member', 'sales'), { category: 'forbidden', code: 'auth.not_permitted' });
    await assert.rejects(invite(admin, 'sam@acme.example', 'Billing', 'platform'), { category: 'forbidden', code: 'auth.grant_refused' });
    await assert.rejects(invite(admin, 'sam@acme.example', 'Member'), { category: 'forbidden', code: 'auth.grant_refused' },
      'only a super admin invites organisation-wide');
  });

  test('the admin invites a member for Platform, who may query but not invite', async () => {
    await invite(admin, 'max@acme.example', 'Member', 'platform');
    await assert.rejects(invite(admin, 'max@acme.example', 'Member', 'platform'), { code: 'invitation.already_open' });
    member = await accept('max@acme.example');
    assert.equal((await may(member, 'query.compile')).decision, 'allow');
    assert.equal((await may(member, 'query.compile', 'platform')).decision, 'allow');
    assert.equal((await may(member, 'query.compile', 'sales')).decision, 'deny');
    assert.equal((await may(member, 'member.invite', 'platform')).decision, 'deny');
    await assert.rejects(invite(member, 'zoe@acme.example', 'Member', 'platform'), { code: 'auth.not_permitted' });
  });

  test('a decision needs the membership\'s own live session', async () => {
    const forged = { ...member, membershipId: admin.membershipId };
    assert.deepEqual(await may(forged, 'query.compile'), { decision: 'deny', reason: 'session_unknown' });
    assert.deepEqual(await may({ ...member, sessionId: uuidv7() }, 'query.compile'), { decision: 'deny', reason: 'session_unknown' });
    assert.equal((await may(member, 'ontology.nonsense')).reason, 'unknown_permission');
  });

  test('a change of policy version applies on the next request', async () => {
    assert.equal((await may(member, 'query.compile', 'platform')).decision, 'allow');
    await inTx(app, { orgId: org }, () => app.query(
      `update iam.role_assignments set revoked_at = now(), revoked_by = $2 where membership_id = $1 and revoked_at is null`,
      [member.membershipId, superAdmin.membershipId]));
    assert.deepEqual(await may(member, 'query.compile', 'platform'), { decision: 'deny', reason: 'not_granted' });
  });

  test('an invitation fails cleanly once its inviter has lost the authority to give it', async () => {
    await invite(admin, 'lou@acme.example', 'Member', 'platform');
    await inTx(app, { orgId: org }, () => app.query(
      `update iam.role_assignments set revoked_at = now(), revoked_by = $2 where membership_id = $1 and revoked_at is null`,
      [admin.membershipId, superAdmin.membershipId]));
    await assert.rejects(accept('lou@acme.example'), { category: 'forbidden', code: 'invitation.inviter_lacks_authority' });
  });

  test('where the organisation requires MFA, an unsatisfied session is authorised for nothing', async () => {
    await migrate.query('update iam.organisations set mfa_required = true where id = $1', [org]);
    try {
      const session = await signIn('root@acme.example');
      assert.equal(session.mfa, 'enrolment_required');
      assert.deepEqual(await may(session, 'query.compile'), { decision: 'deny', reason: 'mfa_required' });
    } finally {
      await migrate.query('update iam.organisations set mfa_required = false where id = $1', [org]);
    }
  });
});
