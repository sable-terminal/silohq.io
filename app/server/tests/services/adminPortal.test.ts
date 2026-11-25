// The admin portal end to end (spec 7 catalogue, 13.3, 13.4, 13.5, 63.6): real auth,
// policy, ontology, notify and admin-portal processes, a local staff identity provider that
// signs real ID tokens, and a stand-in billing service that runs the real session check.
//
// What it shows: staff sign in only through the provider, with a hardware key, as an active
// operator; capabilities come from the provider's groups; break-glass goes request, second
// staff approval, customer approval where required, start, use, end, each step in the
// customer's audit log; every use is counted and recorded first, and the serving service
// checks the session again; a running session ends at the customer's revocation or at its
// expiry; an emergency session takes two staff approvers, is disclosed at once and never
// acts; and the operator directory is kept by someone other than the person it is about.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import * as oa from '../../src/contracts/admin-portal/operatorAccess.contract.ts';
import * as st from '../../src/contracts/admin-portal/supportTicket.contract.ts';
import { setBillingStatus } from '../../src/contracts/billing/staff.contract.ts';
import { listNotifications } from '../../src/contracts/notify/notification.contract.ts';
import { getManifest } from '../../src/contracts/ontology/manifest.contract.ts';
import { route } from '../../src/infra/http.infra.ts';
import { inTransaction } from '../../src/infra/postgres.infra.ts';
import { defineService } from '../../src/infra/service.infra.ts';
import { createAdminPortalService } from '../../src/routes/admin-portal/index.route.ts';
import { createNotifyService } from '../../src/routes/notify/index.route.ts';
import { service as ontologyService } from '../../src/routes/ontology/index.route.ts';
import { requireOperatorSession } from '../../src/services/admin-portal/sessionCheck.service.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { createConnectCell, type ConnectCell, type Signed } from './connect.helper.ts';
import { startFakeOidc, type FakeOidc } from './sso.helper.ts';

const ORIGIN = 'https://staff.silo.test';
const CLIENT_ID = 'silo-staff-portal';
const CLIENT_SECRET = randomBytes(24).toString('base64url');
const GROUPS = {
  'silo-support': ['access.request', 'billing.status'],
  'silo-approvers': ['access.approve'],
  'silo-staff-admin': ['staff.manage', 'staff.review'],
  'silo-helpdesk': ['support.tickets'],
};

let cell: ConnectCell;
let idp: FakeOidc;
let root: Signed;
let staffPort = 0;
const billingSeen: (string | undefined)[] = [];
const ops: Record<string, string> = {};

// A stand-in billing with the real check a staff path makes (spec 75.3).
const fakeBilling = defineService({
  name: 'billing',
  needs: { postgres: ['control'] },
  create(deps) {
    return {
      routes: [route(setBillingStatus, {
        async handle(input, ctx) {
          await inTransaction(deps.databases.pool('control'), ctx.request, (db) => requireOperatorSession(db, ctx.request, 'tenant_act'));
          billingSeen.push(ctx.request.operatorSessionId);
          return { billingStatus: input.body.status, changed: true };
        },
      })],
    };
  },
});

before(async () => {
  cell = await createConnectCell();
  root = await cell.signIn('root@acme.example');
  idp = await startFakeOidc(CLIENT_ID, CLIENT_SECRET);
  for (const [name, facts] of [
    ['alice', "'sc', true, false, 'active'"], ['bob', "'sc', true, false, 'active'"], ['carol', "'sc', true, false, 'active'"],
    ['dave', "'bpss', true, false, 'suspended'"], ['admin', "'sc', true, false, 'active'"],
  ] as const) {
    ops[name] = uuidv7();
    await cell.migrate.query(
      `insert into platform.operators (id, idp_subject, display_name, clearance, uk_resident, sovereign_access_listed, status)
       values ($1, $2, $3, ${facts})`, [ops[name], `sub-${name}-${ops[name]}`, name[0]!.toUpperCase() + name.slice(1)]);
  }
  await cell.start(ontologyService, 'ontology', 'test_app');
  await cell.start(createNotifyService(), 'notify', 'test_app', { SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_TLS: 'none', NOTIFY_LINK_BASE_URL: 'http://app.test/' });
  await cell.start(fakeBilling, 'billing', 'test_app', { PAYMENTS_API_KEY: 'sk_test_unused', PAYMENTS_WEBHOOK_SECRET: 'whsec_unused' });
  await cell.start(createAdminPortalService({ onListening: (port) => { staffPort = port; } }), 'admin-portal', 'test_app', {
    IDENTIFIER_HASH_KEY: randomBytes(32).toString('base64'), ADMIN_PORTAL_PUBLIC_ORIGIN: ORIGIN, ADMIN_PORTAL_PUBLIC_HOST: '127.0.0.1',
    ADMIN_PORTAL_PUBLIC_PORT: '0', ADMIN_PORTAL_IDP_ISSUER: idp.issuer, ADMIN_PORTAL_IDP_CLIENT_ID: CLIENT_ID,
    ADMIN_PORTAL_IDP_CLIENT_SECRET: CLIENT_SECRET, ADMIN_PORTAL_IDP_REDIRECT_URI: `${ORIGIN}/sso/callback`, ADMIN_PORTAL_IDP_ALLOW_INSECURE: 'true',
    ADMIN_PORTAL_GROUP_CAPABILITIES: JSON.stringify(GROUPS), ADMIN_PORTAL_SWEEP_SECONDS: '1',
    // The reporting replica: here the same database, as the read-only reporting role.
    PG_REPORT_URL: cell.h.url('test_report'),
  });
});

after(async () => {
  await cell?.close();
  await idp?.close();
});

// ----------------------------------------------------------------------------- a staff browser

interface Browser { cookie: string | undefined; address: string }
let addresses = 0;
const browser = (): Browser => ({ cookie: undefined, address: `203.0.113.${++addresses}` });

interface Reply { status: number; body: any; text: string }

async function staff(who: Browser | undefined, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const h: Record<string, string> = { 'x-forwarded-for': who?.address ?? '203.0.113.250', ...headers };
  if (method !== 'GET' && headers['origin'] === undefined) {
    h['origin'] = ORIGIN;
    h['x-silo-csrf'] = '1';
  }
  if (who?.cookie) h['cookie'] = `__Host-silo_staff=${who.cookie}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${staffPort}/staff/v1${path}`, { method, headers: h, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  for (const cookie of res.headers.getSetCookie()) {
    const match = /^__Host-silo_staff=([^;]*);.*Max-Age=(\d+)$/.exec(cookie);
    if (match && who) who.cookie = match[2] === '0' ? undefined : match[1];
  }
  const text = await res.text();
  return { status: res.status, body: text === '' ? undefined : JSON.parse(text), text };
}

const subject = (name: string): string => `sub-${name}-${ops[name]}`;

async function signIn(name: string, groups: string[], claims: Record<string, unknown> = {}): Promise<{ who: Browser; reply: Reply }> {
  const who = browser();
  const started = await staff(who, 'POST', '/sso/start');
  assert.equal(started.status, 201, started.text);
  idp.next = { claims: { sub: subject(name), amr: ['pwd', 'hwk'], groups, ...claims } };
  const authorise = await fetch(started.body.redirectUrl, { redirect: 'manual' });
  const callback = new URL(authorise.headers.get('location')!);
  assert.equal(`${callback.origin}${callback.pathname}`, `${ORIGIN}/sso/callback`);
  const reply = await staff(who, 'POST', '/sso/complete', { callbackQuery: callback.search.slice(1), binding: started.body.binding });
  return { who, reply };
}

async function signedIn(name: string, groups: string[]): Promise<Browser> {
  const { who, reply } = await signIn(name, groups);
  assert.equal(reply.status, 201, reply.text);
  return who;
}

const expectRefused = (reply: Reply, status: number, code: string): void => {
  assert.equal(reply.status, status, reply.text);
  assert.equal(reply.body.error.code, code, reply.text);
};

const auditEvents = async (sessionId: string): Promise<{ event: string; actor: Record<string, unknown>; detail: Record<string, unknown> }[]> => {
  const { rows } = await cell.migrate.query(
    `select payload from platform.outbox where organisation_id = $1 and payload->>'operatorAccessSessionId' = $2 order by id`, [cell.org, sessionId]);
  return rows.map((r) => r.payload as never);
};

const portalFor = (sessionId: string) => `/organisations/${cell.org}/access-sessions/${sessionId}`;
const gateway = () => cell.client('gateway');

describe('the admin portal (spec 13)', () => {
  test('staff sign in only through the staff provider, with a hardware key, as an active operator; groups give capabilities', async () => {
    expectRefused((await signIn('alice', ['silo-support'], { amr: ['pwd'] })).reply, 401, 'staff.sign_in_refused');
    expectRefused((await signIn('dave', ['silo-support'])).reply, 401, 'staff.sign_in_refused');
    idp.next = { claims: {} };
    const unknown = browser();
    const started = await staff(unknown, 'POST', '/sso/start');
    idp.next = { claims: { sub: 'sub-nobody', amr: ['hwk'], groups: ['silo-support'] } };
    const callback = new URL((await fetch(started.body.redirectUrl, { redirect: 'manual' })).headers.get('location')!);
    const answer = { callbackQuery: callback.search.slice(1), binding: started.body.binding };
    expectRefused(await staff(unknown, 'POST', '/sso/complete', answer), 401, 'staff.sign_in_refused');
    // A flow is used once.
    expectRefused(await staff(unknown, 'POST', '/sso/complete', answer), 401, 'staff.sign_in_invalid');

    const { who, reply } = await signIn('alice', ['silo-support', 'unknown-group']);
    assert.equal(reply.status, 201, reply.text);
    assert.deepEqual([reply.body.operatorId, reply.body.capabilities], [ops['alice'], ['access.request', 'billing.status']]);
    assert.ok(who.cookie, 'the session cookie is set');
    assert.equal((await staff(who, 'GET', '/session')).body.displayName, 'Alice');
    expectRefused(await staff(who, 'GET', '/operators'), 403, 'staff.not_permitted');
    expectRefused(await staff(browser(), 'GET', '/session'), 401, 'staff.session_required');
    // The gateway's cross-site rules: a state change needs this origin and the CSRF header.
    expectRefused(await staff(who, 'POST', '/access-sessions', {}, { origin: 'https://evil.example' }), 403, 'gateway.cross_site');
    const found = await staff(who, 'GET', '/organisations/by-slug/acme');
    assert.deepEqual([found.status, found.body.id], [200, cell.org]);
  });

  test('break-glass: request, second staff approval, then the customer, start, use, end; each step in the customer\'s audit log', async () => {
    const alice = await signedIn('alice', ['silo-support']);
    const bob = await signedIn('bob', ['silo-support', 'silo-approvers']);
    // The customer's ontology, which the session reads.
    await gateway().call(getManifest, { query: {} }, cell.as(root));
    const policy = await gateway().call(oa.setOperatorAccessPolicy, { body: { approvalRequired: true } }, cell.as(root));
    assert.deepEqual(policy, { approvalRequired: true, requiredByCell: false });

    const ask = { organisationId: cell.org, purpose: 'support_request', level: 'metadata_read', ticketReference: 'SUP-1042', minutes: 30 };
    expectRefused(await staff(alice, 'POST', '/access-sessions', { ...ask, reason: 'customer jo@acme.example cannot see their manifest' }),
      400, 'redaction.value_pattern');
    const requested = await staff(alice, 'POST', '/access-sessions', { ...ask, reason: 'the customer cannot see their manifest after merging' });
    assert.equal(requested.status, 201, requested.text);
    const id = requested.body.id as string;
    assert.deepEqual([requested.body.status, requested.body.customerApprovalRequired, requested.body.operatorDisplayName], ['requested', true, 'Alice']);

    expectRefused(await staff(alice, 'POST', `${portalFor(id)}/approval`), 403, 'staff.not_permitted');
    const staffApproved = await staff(bob, 'POST', `${portalFor(id)}/approval`);
    assert.deepEqual([staffApproved.status, staffApproved.body.status, staffApproved.body.staffApproverDisplayName], [200, 'requested', 'Bob']);
    expectRefused(await staff(alice, 'POST', `${portalFor(id)}/start`), 409, 'operator_access.not_approved');

    // The customer is told, sees it, and approves.
    const told = await gateway().call(listNotifications, { query: { limit: 50 } }, cell.as(root));
    assert.ok(told.notifications.some((n) => n.kind === 'operator_access_waiting' && n.operatorAccessSessionId === id));
    const listed = await gateway().call(oa.listOperatorAccessSessions, { query: { limit: 10 } }, cell.as(root));
    assert.ok(listed.sessions.some((s) => s.id === id && s.reason === 'the customer cannot see their manifest after merging'));
    const decided = await gateway().call(oa.decideOperatorAccessSession, { params: { sessionId: id }, body: { decision: 'approve' } }, cell.as(root));
    assert.deepEqual([decided.status, decided.approvedByMembershipId], ['approved', root.membershipId]);
    await assert.rejects(gateway().call(oa.decideOperatorAccessSession, { params: { sessionId: id }, body: { decision: 'approve' } }, cell.as(root)),
      { code: 'operator_access.decided' });

    expectRefused(await staff(alice, 'GET', `${portalFor(id)}/manifest`), 409, 'operator_access.not_running');
    expectRefused(await staff(bob, 'POST', `${portalFor(id)}/start`), 403, 'operator_access.not_requester');
    const started = await staff(alice, 'POST', `${portalFor(id)}/start`);
    assert.equal(started.body.status, 'active', started.text);
    const minutes = (Date.parse(started.body.expiresAt) - Date.parse(started.body.startsAt)) / 60_000;
    assert.equal(minutes, 30);

    // Use: counted and recorded first, then served by the ontology, which checks the session itself.
    expectRefused(await staff(bob, 'GET', `${portalFor(id)}/manifest`), 403, 'operator_access.not_requester');
    const manifest = await staff(alice, 'GET', `${portalFor(id)}/manifest`);
    assert.equal(manifest.status, 200, manifest.text);
    assert.equal(manifest.body.organisationId, cell.org);
    expectRefused(await staff(alice, 'POST', `${portalFor(id)}/billing-status`, { status: 'active', reason: 'correction' }),
      403, 'operator_access.level_too_low');
    await assert.rejects(cell.client('admin-portal').call(getManifest, { query: {} }, { request: { organisationId: cell.org, operatorSessionId: uuidv7() } }),
      { code: 'operator_access.session_required' });

    const ended = await staff(alice, 'POST', `${portalFor(id)}/end`);
    assert.deepEqual([ended.body.status, ended.body.endedReason, ended.body.resourcesTouchedCount], ['ended', 'ended', 1]);
    const kept = (Date.parse(ended.body.recordingRetainedUntil) - Date.parse(ended.body.endedAt)) / 86_400_000;
    assert.ok(kept >= 365 && kept <= 366, `the recording is kept 12 months (${kept} days)`);
    expectRefused(await staff(alice, 'GET', `${portalFor(id)}/manifest`), 409, 'operator_access.not_running');

    const all = await auditEvents(id);
    // The session's first use (63.6) is written with its first touch, in one transaction.
    const used = all.filter((e) => e.event === 'operator_access_used');
    assert.deepEqual(used.map((e) => e.actor), [{ kind: 'operator', operatorId: ops['alice'], operatorAccessSessionId: id }], 'used once');
    const trail = all.filter((e) => e.event !== 'operator_access_used');
    assert.deepEqual(trail.map((e) => e.event), [
      'operator_access_requested', 'operator_access_approved', 'operator_access_approved', 'operator_access_started',
      'operator_access_resource_touched', 'operator_access_ended',
    ]);
    assert.deepEqual(trail[2]!.actor, { kind: 'membership', membershipId: root.membershipId });
    assert.deepEqual(trail[4]!.actor, { kind: 'operator', operatorId: ops['alice'], operatorAccessSessionId: id });
    await gateway().call(oa.setOperatorAccessPolicy, { body: { approvalRequired: false } }, cell.as(root));
  });

  test('a tenant_act session reaches a billing staff path; the customer revokes it and it stops at once', async () => {
    await gateway().call(oa.setOperatorAccessPolicy, { body: { approvalRequired: false } }, cell.as(root));
    const alice = await signedIn('alice', ['silo-support']);
    const bob = await signedIn('bob', ['silo-approvers']);
    const requested = await staff(alice, 'POST', '/access-sessions', {
      organisationId: cell.org, purpose: 'support_request', level: 'tenant_act', reason: 'correct a billing status after a refund',
      ticketReference: 'SUP-2001', minutes: 60,
    });
    const id = requested.body.id as string;
    const approved = await staff(bob, 'POST', `${portalFor(id)}/approval`);
    assert.equal(approved.body.status, 'approved', 'no customer approval is required here');
    await staff(alice, 'POST', `${portalFor(id)}/start`);

    const changed = await staff(alice, 'POST', `${portalFor(id)}/billing-status`, { status: 'active', reason: 'refund applied' });
    assert.deepEqual([changed.status, changed.body], [200, { billingStatus: 'active', changed: true }]);
    assert.equal(billingSeen.at(-1), id, 'the session travels to the serving service');

    const revoked = await gateway().call(oa.revokeOperatorAccessSession, { params: { sessionId: id } }, cell.as(root));
    assert.deepEqual([revoked.status, revoked.endedReason, revoked.endedByMembershipId], ['ended', 'revoked', root.membershipId]);
    expectRefused(await staff(alice, 'POST', `${portalFor(id)}/billing-status`, { status: 'active', reason: 'again' }), 409, 'operator_access.not_running');
    await assert.rejects(cell.client('admin-portal').call(setBillingStatus, { body: { status: 'active', reason: 'again' } },
      { request: { organisationId: cell.org, operatorSessionId: id } }), { code: 'operator_access.session_required' });
  });

  test('a tenant_read session reads the tenant\'s rows through the reporting replica: never a sealed column, never another organisation, each read recorded', async () => {
    await gateway().call(oa.setOperatorAccessPolicy, { body: { approvalRequired: false } }, cell.as(root));
    const alice = await signedIn('alice', ['silo-support']);
    const bob = await signedIn('bob', ['silo-approvers']);
    const session = async (level: string) => {
      const requested = await staff(alice, 'POST', '/access-sessions', {
        organisationId: cell.org, purpose: 'support_request', level, reason: 'a connection will not activate after its secret changed', ticketReference: 'SUP-3100', minutes: 30,
      });
      const id = requested.body.id as string;
      await staff(bob, 'POST', `${portalFor(id)}/approval`);
      await staff(alice, 'POST', `${portalFor(id)}/start`);
      return id;
    };
    const metadata = await session('metadata_read');
    expectRefused(await staff(alice, 'GET', `${portalFor(metadata)}/tenant-tables`), 403, 'operator_access.level_too_low');
    await staff(alice, 'POST', `${portalFor(metadata)}/end`);

    const id = await session('tenant_read');
    const tables = await staff(alice, 'GET', `${portalFor(id)}/tenant-tables`);
    assert.equal(tables.status, 200, tables.text);
    const byName = new Map((tables.body.tables as { table: string; columns: string[] }[]).map((t) => [t.table, t.columns]));
    assert.ok(byName.has('iam.memberships'), 'a tenant table the reporting role reads');
    for (const [table, columns] of byName) assert.ok(!columns.some((c) => /sealed|secret_ciphertext|password_hash/.test(c)), `${table}: no sealed column`);
    const rows = await staff(alice, 'GET', `${portalFor(id)}/tenant-rows?table=iam.memberships&limit=5`);
    assert.equal(rows.status, 200, rows.text);
    assert.ok(rows.body.rows.length > 0);
    assert.ok((rows.body.rows as Record<string, unknown>[]).every((r) => r['organisation_id'] === cell.org), 'the session\'s organisation only');
    expectRefused(await staff(alice, 'GET', `${portalFor(id)}/tenant-rows?table=pg_catalog.pg_authid`), 404, 'staff.table_unknown');
    const touched = (await auditEvents(id)).filter((e) => e.event === 'operator_access_resource_touched').map((e) => e.detail['route']);
    assert.deepEqual(touched, ['tenant_tables', 'tenant_rows:iam.memberships'], 'each read in the customer\'s audit log, naming the table');
    await staff(alice, 'POST', `${portalFor(id)}/end`);
  });

  test('an emergency session takes two staff approvers, is disclosed at once, never acts, and expires on time', async () => {
    const alice = await signedIn('alice', ['silo-support']);
    const bob = await signedIn('bob', ['silo-approvers']);
    const carol = await signedIn('carol', ['silo-approvers']);
    await gateway().call(oa.setOperatorAccessPolicy, { body: { approvalRequired: true } }, cell.as(root));
    const ask = { organisationId: cell.org, purpose: 'incident_response', reason: 'an incident needs the audit trail now', ticketReference: 'INC-77',
      minutes: 15, emergency: true };
    expectRefused(await staff(alice, 'POST', '/access-sessions', { ...ask, level: 'tenant_act' }), 400, 'operator_access.emergency_acts');
    const id = (await staff(alice, 'POST', '/access-sessions', { ...ask, level: 'tenant_read' })).body.id as string;

    assert.equal((await staff(bob, 'POST', `${portalFor(id)}/approval`)).body.status, 'requested');
    expectRefused(await staff(bob, 'POST', `${portalFor(id)}/approval`), 409, 'operator_access.already_approved');
    const second = await staff(carol, 'POST', `${portalFor(id)}/approval`);
    assert.deepEqual([second.body.status, second.body.staffSecondApproverDisplayName, second.body.approvedByMembershipId], ['approved', 'Carol', null]);
    assert.ok((await auditEvents(id)).some((e) => e.event === 'operator_access_emergency'));
    const told = await gateway().call(listNotifications, { query: { limit: 50 } }, cell.as(root));
    assert.ok(told.notifications.some((n) => n.kind === 'operator_access_emergency' && n.operatorAccessSessionId === id));
    await assert.rejects(gateway().call(oa.decideOperatorAccessSession, { params: { sessionId: id }, body: { decision: 'deny', reason: 'not now' } },
      cell.as(root)), { code: 'operator_access.emergency' });

    await staff(alice, 'POST', `${portalFor(id)}/start`);
    // Fifteen minutes pass: the sweep closes it.
    await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `update platform.operator_access_sessions set starts_at = now() - interval '16 minutes', expires_at = now() - interval '1 minute' where id = $1`, [id]));
    expectRefused(await staff(alice, 'GET', `${portalFor(id)}/audit-events`), 409, 'operator_access.not_running');
    const deadline = Date.now() + 10_000;
    let status = '';
    while (Date.now() < deadline && status !== 'expired') {
      status = (await gateway().call(oa.getOperatorAccessSession, { params: { sessionId: id } }, cell.as(root))).status;
      if (status !== 'expired') await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(status, 'expired');
    assert.equal((await auditEvents(id)).at(-1)!.event, 'operator_access_expired');
    await gateway().call(oa.setOperatorAccessPolicy, { body: { approvalRequired: false } }, cell.as(root));
  });

  test('the operator directory is kept by someone else; a suspended operator is signed out at their next request', async () => {
    const admin = await signedIn('admin', ['silo-staff-admin']);
    const carol = await signedIn('carol', ['silo-approvers']);
    expectRefused(await staff(admin, 'POST', '/operators', {
      idpSubject: 'sub-gina', displayName: 'Gina', clearance: 'sc', ukResident: false, sovereignAccessListed: true,
    }), 400, 'staff.sovereign_ineligible');
    const gina = await staff(admin, 'POST', '/operators', { idpSubject: `sub-gina-${uuidv7()}`, displayName: 'Gina', clearance: 'sc', ukResident: true });
    assert.equal(gina.status, 201, gina.text);
    const due = await staff(admin, 'GET', '/operators?reviewDue=true');
    assert.ok(due.body.operators.some((o: { id: string }) => o.id === gina.body.id));

    expectRefused(await staff(admin, 'POST', `/operators/${ops['admin']}/review`), 403, 'staff.not_yourself');
    const reviewed = await staff(admin, 'POST', `/operators/${ops['carol']}/review`);
    assert.equal(reviewed.body.lastReviewedBy, ops['admin']);

    assert.equal((await staff(carol, 'GET', '/session')).status, 200);
    assert.equal((await staff(admin, 'POST', `/operators/${ops['carol']}/status`, { status: 'suspended' })).body.status, 'suspended');
    expectRefused(await staff(carol, 'GET', '/session'), 401, 'staff.session_revoked');
    assert.equal(carol.cookie, undefined, 'the cookie is cleared');
    await staff(admin, 'POST', `/operators/${ops['carol']}/status`, { status: 'active' });
  });
});

describe('support tickets (U4, D254)', () => {
  test('a member raises a ticket with references; support answers it from the queue; the raiser is told; each step is in the audit log', async () => {
    const pat = await cell.member('pat@acme.example', 'Member');
    const correlation = uuidv7();
    const raised = await gateway().call(st.raiseSupportTicket, {
      body: {
        subject: 'A connection will not test', category: 'problem', severity: 'high', body: 'Testing the CRM connection fails each time since this morning.',
        place: '/connect/connections/', correlationIds: [correlation], refs: [{ kind: 'connection', id: uuidv7() }],
      },
    }, cell.as(pat));
    assert.match(raised.ticket.reference, st.SUPPORT_REFERENCE);
    assert.equal(raised.ticket.status, 'waiting_on_silo');
    assert.deepEqual(raised.ticket.correlationIds, [correlation]);
    assert.equal(raised.messages.length, 1);
    assert.equal(raised.messages[0]!.authorMembershipId, pat.membershipId);

    // Values never: an address or an account number in a ticket is refused, naming the kind, never the text.
    await assert.rejects(gateway().call(st.raiseSupportTicket, {
      body: { subject: 'Customer jo.bloggs@example.com cannot see orders', category: 'problem', body: 'See subject.' },
    }, cell.as(pat)), (e: { code?: string; message?: string }) => e.code === 'support.value_pattern' && !(e.message ?? '').includes('bloggs'));
    await assert.rejects(gateway().call(st.raiseSupportTicket, {
      body: { subject: 'Wrong total', category: 'billing', body: 'Card 4111 1111 1111 1111 was charged twice' },
    }, cell.as(pat)), { code: 'support.value_pattern' });

    // The raiser sees their own; another member does not; a holder of org.operator_access.view sees all.
    const mine = await gateway().call(st.listSupportTickets, { query: {} }, cell.as(pat));
    assert.deepEqual(mine.tickets.map((t) => t.id), [raised.ticket.id]);
    assert.equal(mine.seesAll, false);
    const other = await cell.member('olly@acme.example', 'Member');
    assert.deepEqual((await gateway().call(st.listSupportTickets, { query: {} }, cell.as(other))).tickets, []);
    await assert.rejects(gateway().call(st.readSupportTicket, { params: { ticketId: raised.ticket.id } }, cell.as(other)), { code: 'support.ticket_not_found' });
    const all = await gateway().call(st.listSupportTickets, { query: {} }, cell.as(root));
    assert.equal(all.seesAll, true);
    assert.ok(all.tickets.some((t) => t.id === raised.ticket.id));

    // Support: the queue, the ticket by its reference, a reply that waits on the customer.
    const helpdesk = await signedIn('carol', ['silo-helpdesk']);
    expectRefused(await staff(await signedIn('bob', ['silo-approvers']), 'GET', '/support-tickets'), 403, 'staff.not_permitted');
    const queue = await staff(helpdesk, 'GET', '/support-tickets');
    assert.equal(queue.status, 200, queue.text);
    const queued = queue.body.tickets.find((t: { ticket: { id: string } }) => t.ticket.id === raised.ticket.id);
    assert.ok(queued, 'in the queue');
    assert.equal(queued.organisation.slug, 'acme');
    assert.equal(queued.raisedByName, 'New Member');
    const opened = await staff(helpdesk, 'GET', `/support-tickets/${raised.ticket.reference}`);
    assert.equal(opened.body.messages.length, 1);
    expectRefused(await staff(helpdesk, 'POST', `/support-tickets/${raised.ticket.reference}/messages`, { body: 'Please send 4111 1111 1111 1111' }), 400, 'support.value_pattern');
    const answered = await staff(helpdesk, 'POST', `/support-tickets/${raised.ticket.reference}/messages`, { body: 'Which test fails: the read or the write class?' });
    assert.equal(answered.status, 201, answered.text);
    assert.equal(answered.body.ticket.status, 'waiting_on_customer');
    assert.equal(answered.body.ticket.assignedTo, 'Carol', 'whoever answers first takes it');
    assert.equal(answered.body.messages.at(-1).authorName, 'Carol');

    const told = await gateway().call(listNotifications, { query: { limit: 10 } }, cell.as(pat));
    const note = told.notifications.find((n) => n.kind === 'support_replied');
    assert.ok(note, 'the raiser is told');
    assert.equal(note.supportTicketId, raised.ticket.id);
    assert.equal((await gateway().call(st.listSupportTickets, { query: {} }, cell.as(pat))).waitingOnYou, 1);

    // The member answers (stale versions refused), then closes it for good.
    const read = await gateway().call(st.readSupportTicket, { params: { ticketId: raised.ticket.id } }, cell.as(pat));
    await assert.rejects(gateway().call(st.replyToSupportTicket, { params: { ticketId: raised.ticket.id }, body: { body: 'The read class.', version: 1 } }, cell.as(pat)),
      { code: 'support.ticket_stale' });
    const replied = await gateway().call(st.replyToSupportTicket, { params: { ticketId: raised.ticket.id }, body: { body: 'The read class.', version: read.ticket.version } }, cell.as(pat));
    assert.equal(replied.ticket.status, 'waiting_on_silo');
    const resolved = await staff(helpdesk, 'PATCH', `/support-tickets/${raised.ticket.reference}`, { status: 'resolved' });
    assert.equal(resolved.body.ticket.status, 'resolved');
    const closed = await gateway().call(st.closeSupportTicket, { params: { ticketId: raised.ticket.id }, body: { version: resolved.body.ticket.version } }, cell.as(pat));
    assert.equal(closed.ticket.status, 'closed');
    await assert.rejects(gateway().call(st.replyToSupportTicket, { params: { ticketId: raised.ticket.id }, body: { body: 'One more thing', version: closed.ticket.version } }, cell.as(pat)),
      { code: 'support.ticket_closed' });
    expectRefused(await staff(helpdesk, 'POST', `/support-tickets/${raised.ticket.reference}/messages`, { body: 'Anything else?' }), 409, 'support.ticket_closed');

    const { rows } = await cell.migrate.query(
      `select payload from platform.outbox where organisation_id = $1 and payload->'resource'->>'id' = $2 order by id`, [cell.org, raised.ticket.id]);
    const events = rows.map((r) => (r.payload as { event: string; actor: { kind: string }; detail: Record<string, unknown> }));
    assert.deepEqual(events.map((e) => e.event), ['support_ticket_raised', 'support_ticket_replied', 'support_ticket_replied', 'support_ticket_updated', 'support_ticket_updated']);
    assert.equal(events[1]!.actor.kind, 'service', 'staff act as admin-portal in the customer\'s log');
    assert.equal(events[1]!.detail['operator_id'], ops['carol'], 'naming the member of staff');
    assert.ok(!JSON.stringify(events).includes('read class'), 'no words in the audit log');
  });
});
