// The notify service end to end on a fresh cell database, with a local SMTP server in
// place of the cell's relay: auth, policy and notify as real processes. A password reset
// and an invitation each reach the inbox through notify with a working link, the token
// appears in no log, and in-product items are read and acknowledged by their recipient.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fakeSmtp, plainText, type Received } from './smtp.helper.ts';
import { notificationEmail } from '../../src/services/notify/templates.service.ts';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { loadConfig, type Config } from '../../src/config/index.config.ts';
import { acceptInvitation, createInvitation } from '../../src/contracts/auth/invitation.contract.ts';
import { requestPasswordReset, resetPassword } from '../../src/contracts/auth/password.contract.ts';
import { login } from '../../src/contracts/auth/session.contract.ts';
import {
  acknowledgeNotification, listNotifications, listPushDevices, markNotificationRead, raiseNotification, readNotification, registerPushDevice, removePushDevice,
} from '../../src/contracts/notify/notification.contract.ts';
import { DEFAULT_ADMIN_URL, urlFor } from '../../src/db/scripts/bootstrapLocal.script.ts';
import { provisionOrganisation } from '../../src/db/scripts/provision.script.ts';
import { createLogger } from '../../src/infra/logger.infra.ts';
import { withTransaction } from '../../src/infra/postgres.infra.ts';
import { createServiceClient, type ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { runProcess, type RunningProcess } from '../../src/process.ts';
import { createAuthService } from '../../src/routes/auth/index.route.ts';
import { createNotifyService } from '../../src/routes/notify/index.route.ts';
import { service as policyService } from '../../src/routes/policy/index.route.ts';
import { CELL_ID, createLocalCell } from '../db/fixtures.helper.ts';
import { createHarness, inTx, uuidv7, type Harness } from '../db/harness.helper.ts';
import { LOCAL } from '../infra/services.helper.ts';

const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a different long passphrase';

const tokenIn = (text: string, path: string): string => {
  const match = new RegExp(`http://app\\.test/${path}/\\?organisation=acme#token=([A-Za-z0-9_%-]+)`).exec(text);
  assert.ok(match, `the email holds a ${path} link`);
  return decodeURIComponent(match[1]!);
};

// ----------------------------------------------------------------------------- set-up

let h: Harness;
let migrate: pg.Client;
let app: pg.Client;
let relay: Awaited<ReturnType<typeof fakeSmtp>>;
const processes: RunningProcess[] = [];
const logs: string[] = [];
let gateway: ServiceClient;
let scheduler: ServiceClient;
let org: string;
let rootMembership: string;
const roles: Record<string, string> = {};

const env = (service: string, login: 'test_app' | 'test_auth', extra: Record<string, string> = {}): Config => loadConfig({
  SILO_ENV: 'test', SILO_SERVICE: service, SILO_CELL_ID: CELL_ID, SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk', SILO_HOSTING: 'gke',
  SILO_BUILD_TARGET: 'commercial', HTTP_HOST: '127.0.0.1', HTTP_PORT: '0', HTTP_DRAIN_SECONDS: '0', PG_CONTROL_URL: h.url(login),
  REDIS_SESSION_URL: `${LOCAL.redisUrl}/0`, ...extra,
});

async function waitForMail(count: number): Promise<Received> {
  const deadline = Date.now() + 10_000;
  while (relay.inbox.length < count) {
    if (Date.now() > deadline) throw new Error('no email arrived');
    await new Promise((r) => setTimeout(r, 50));
  }
  return relay.inbox[count - 1]!;
}

/** The cell's push provider, faked (decision 2026-11-14): what it was asked to send, and a token it reports gone. */
const pushes: { token: string; message: { title: string; body: string; link: string; badge: number } }[] = [];

const pushSender = {
  platform: 'fcm' as const,
  async send(token: string, message: { title: string; body: string; link: string; badge: number }) {
    pushes.push({ token, message });
    return token.startsWith('gone') ? 'gone' as const : 'sent' as const;
  },
};

before(async () => {
  h = await createHarness();
  migrate = await h.connect('test_migrate');
  app = await h.connect('test_app');
  await createLocalCell(migrate);
  relay = await fakeSmtp();
  const created = await withTransaction(migrate, {}, (db) => provisionOrganisation(db, {
    slug: 'acme', name: 'Acme <Widgets>', email: 'root@acme.example', firstName: 'Root', lastName: 'Admin', password: PASSWORD,
    cellId: CELL_ID, plan: 'business', timeZone: 'Europe/London',
  }, { ARGON2_MEMORY_KIB: '1024', ARGON2_PASSES: '1' }));
  org = created.organisationId;
  rootMembership = created.membershipId;
  const { rows } = await inTx(app, { orgId: org }, () => app.query('select id, name from iam.roles where organisation_id = $1', [org]));
  for (const row of rows) roles[row.name as string] = row.id as string;

  const capture = createLogger({ service: 'notify', cell: CELL_ID, release: 'test', level: 'debug', write: (line) => { logs.push(line); } });
  const notify = await runProcess([createNotifyService({ push: pushSender })], env('notify', 'test_app', {
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String(relay.port), SMTP_TLS: 'none', NOTIFY_LINK_BASE_URL: 'http://app.test/',
    NOTIFY_FROM_ADDRESS: 'no-reply@acme.test',
  }), { logger: capture });
  const policy = await runProcess([policyService], env('policy', 'test_app'), { logger: capture });
  const authConfig = env('auth', 'test_auth', {
    REDIS_DATA_URL: `${LOCAL.redisUrl}/1`, IDENTIFIER_HASH_KEY: randomBytes(32).toString('base64'), ARGON2_MEMORY_KIB: '1024',
    ARGON2_PASSES: '1', SERVICE_URL_POLICY: `http://127.0.0.1:${policy.port}`, SERVICE_URL_NOTIFY: `http://127.0.0.1:${notify.port}`,
  });
  // The default deliveries: through notify.
  const auth = await runProcess([createAuthService()], authConfig, { logger: capture });
  processes.push(auth, policy, notify);
  const urls = { auth: `http://127.0.0.1:${auth.port}`, notify: `http://127.0.0.1:${notify.port}` };
  gateway = createServiceClient({ caller: 'gateway', http: { ...authConfig.http, serviceUrls: urls } });
  scheduler = createServiceClient({ caller: 'scheduler', http: { ...authConfig.http, serviceUrls: urls } });
});

after(async () => {
  gateway?.close();
  scheduler?.close();
  for (const p of processes) await p.stop('test');
  await relay?.close();
  await h?.close();
});

// ----------------------------------------------------------------------------- tests

describe('auth emails go through notify to the relay (spec 55.3, 55.6)', () => {
  const tokens: string[] = [];

  test('a password reset arrives with a link that works once', async () => {
    await gateway.call(requestPasswordReset, { body: { organisationSlug: 'acme', email: 'root@acme.example' } });
    const mail = await waitForMail(1);
    assert.deepEqual(mail.to, ['root@acme.example']);
    assert.match(mail.from, /no-reply@acme\.test/);
    assert.match(mail.data, /Subject: Reset your Silo password for Acme <Widgets>/);
    const text = plainText(mail.data);
    const token = tokenIn(text, 'reset-password');
    tokens.push(token);
    assert.match(mail.data.replace(/=\r\n/g, ''), /Acme &lt;Widgets&gt;/, 'the organisation name is escaped in HTML');

    await gateway.call(resetPassword, { body: { organisationSlug: 'acme', token, newPassword: NEW_PASSWORD } });
    await gateway.call(login, { body: { organisationSlug: 'acme', email: 'root@acme.example', password: NEW_PASSWORD } });
    await assert.rejects(gateway.call(resetPassword, { body: { organisationSlug: 'acme', token, newPassword: PASSWORD } }));
  });

  test('a reset for an unknown address sends nothing and answers the same', async () => {
    await gateway.call(requestPasswordReset, { body: { organisationSlug: 'acme', email: 'nobody@acme.example' } });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(relay.inbox.length, 1);
  });

  test('an invitation arrives with a link that joins the organisation', async () => {
    const root = await gateway.call(login, { body: { organisationSlug: 'acme', email: 'root@acme.example', password: NEW_PASSWORD } });
    await gateway.call(createInvitation, { body: { email: 'new.member@acme.example', roleId: roles['Member']! } },
      { request: { organisationId: org, membershipId: root.membershipId, sessionId: root.sessionId }, idempotencyKey: uuidv7() });
    const mail = await waitForMail(2);
    assert.deepEqual(mail.to, ['new.member@acme.example']);
    const token = tokenIn(plainText(mail.data), 'accept-invitation');
    tokens.push(token);
    const joined = await gateway.call(acceptInvitation, {
      body: { organisationSlug: 'acme', token, password: PASSWORD, firstName: 'New', lastName: 'Member' },
    });
    assert.equal(joined.organisationId, org);
  });

  test('no token and no address appears in any log line', () => {
    assert.ok(logs.some((line) => line.includes('"email.sent"')), 'the send is logged');
    for (const token of tokens) assert.equal(logs.some((line) => line.includes(token)), false);
    assert.equal(logs.some((line) => line.includes('root@acme.example') || line.includes('new.member@acme.example')), false);
  });
});

describe('in-product items (design: workspace.notifications)', () => {
  const ids: Record<string, string> = {};
  let root: { membershipId: string; sessionId: string };
  const as = () => ({ request: { organisationId: org, membershipId: root.membershipId, sessionId: root.sessionId } });

  before(async () => {
    root = await gateway.call(login, { body: { organisationSlug: 'acme', email: 'root@acme.example', password: NEW_PASSWORD } });
    // Items about sources other services own; the sources are not built yet, so the rows
    // are planted with key checks off.
    const admin = new pg.Client({ connectionString: urlFor(process.env['TEST_PG_ADMIN_URL'] ?? DEFAULT_ADMIN_URL, h.cell) });
    await admin.connect();
    try {
      await admin.query('begin');
      await admin.query('set local session_replication_role = replica');
      for (const [name, kind, column, due] of [
        ['finding', 'finding_new', 'finding_id', null],
        ['escalation', 'cron_escalate', 'automation_run_action_id', new Date(Date.now() + 3_600_000).toISOString()],
      ] as const) {
        ids[name] = uuidv7();
        await admin.query(
          `insert into workspace.notifications (id, organisation_id, recipient_membership_id, ${column}, kind, delivered_at, acknowledge_due_at)
           values ($1, $2, $3, $4, $5, now(), $6)`, [ids[name], org, rootMembership, uuidv7(), kind, due]);
      }
      await admin.query('commit');
    } finally {
      await admin.end();
    }
  });

  test('the recipient lists, reads and acknowledges their items', async () => {
    const all = await gateway.call(listNotifications, { query: {} }, as());
    assert.equal(all.notifications.length, 2);
    const read = await gateway.call(markNotificationRead, { params: { notificationId: ids['finding']! } }, as());
    assert.ok(read.notification.readAt);
    const again = await gateway.call(markNotificationRead, { params: { notificationId: ids['finding']! } }, as());
    assert.equal(again.notification.readAt, read.notification.readAt, 'read once');
    const unread = await gateway.call(listNotifications, { query: { unread: 'true' } }, as());
    assert.deepEqual(unread.notifications.map((n) => n.id), [ids['escalation']]);
    await assert.rejects(gateway.call(acknowledgeNotification, { params: { notificationId: ids['finding']! } }, as()),
      (e: { code?: string }) => e.code === 'notify.not_an_escalation');
    const acknowledged = await gateway.call(acknowledgeNotification, { params: { notificationId: ids['escalation']! } }, as());
    assert.ok(acknowledged.notification.acknowledgedAt);
    assert.ok(acknowledged.notification.readAt);
    // One item, as the page an emailed or pushed link opens reads it.
    const one = await gateway.call(readNotification, { params: { notificationId: ids['finding']! } }, as());
    assert.equal(one.notification.kind, 'finding_new');
    await assert.rejects(gateway.call(readNotification, { params: { notificationId: uuidv7() } }, as()), { code: 'notify.notification_not_found' });
  });

  test('an emailed item links to the client\'s notifications page, naming the organisation and the item', () => {
    const mail = notificationEmail('a@acme.example', { baseUrl: 'http://app.test', organisation: { name: 'Acme', slug: 'acme' } }, 'support_replied', ids['finding']!);
    assert.match(mail.text, new RegExp(`http://app\\.test/notifications/\\?organisation=acme&id=${ids['finding']}`));
    assert.match(mail.subject, /^Silo support replied to your ticket in Acme$/);
  });

  test('someone else\'s item is not found; raising refuses an unknown source or a mismatched kind', async () => {
    await assert.rejects(gateway.call(markNotificationRead, { params: { notificationId: uuidv7() } }, as()),
      (e: { code?: string }) => e.code === 'notify.notification_not_found');
    const raise = (body: Parameters<typeof scheduler.call<typeof raiseNotification>>[1]['body']) =>
      scheduler.call(raiseNotification, { body }, { request: { organisationId: org } });
    await assert.rejects(raise({ recipientMembershipId: rootMembership, kind: 'finding_new', source: { findingId: uuidv7() } }),
      (e: { code?: string }) => e.code === 'notify.reference_unknown');
    await assert.rejects(raise({ recipientMembershipId: rootMembership, kind: 'finding_new', source: { approvalChainId: uuidv7() } }),
      (e: { code?: string }) => e.code === 'notify.source_mismatch');
    await assert.rejects(gateway.call(raiseNotification, {
      body: { recipientMembershipId: rootMembership, kind: 'finding_new', source: { findingId: uuidv7() } },
    }, { request: { organisationId: org } }), (e: { code?: string }) => e.code === 'caller.not_listed');
  });
});

describe('mobile push (decision 2026-11-14)', () => {
  let root: { membershipId: string; sessionId: string };
  let layout = '';
  const as = () => ({ request: { organisationId: org, membershipId: root.membershipId, sessionId: root.sessionId } });

  before(async () => {
    root = await gateway.call(login, { body: { organisationSlug: 'acme', email: 'root@acme.example', password: NEW_PASSWORD } });
    // A source for the item, planted with key checks off as above.
    layout = uuidv7();
    const admin = new pg.Client({ connectionString: urlFor(process.env['TEST_PG_ADMIN_URL'] ?? DEFAULT_ADMIN_URL, h.cell) });
    await admin.connect();
    try {
      await admin.query('begin');
      await admin.query('set local session_replication_role = replica');
      await admin.query(`insert into workspace.object_view_layouts (id, organisation_id, object_type_id, ontology_version, generated, status)
        values ($1, $2, $3, 1, true, 'active')`, [layout, org, uuidv7()]);
      await admin.query('commit');
    } finally {
      await admin.end();
    }
  });

  test('a member registers devices; a push item reaches them as a count and a link; a gone device is revoked', async () => {
    const good = await gateway.call(registerPushDevice, { body: { platform: 'fcm', token: 'device-token-good-0001' } }, as());
    await gateway.call(registerPushDevice, { body: { platform: 'fcm', token: 'gone-token-0000000001' } }, as());
    assert.equal((await gateway.call(registerPushDevice, { body: { platform: 'fcm', token: 'device-token-good-0001' } }, as())).id, good.id, 'again: the same device');
    await assert.rejects(gateway.call(registerPushDevice, { body: { platform: 'apns', token: 'apns-token-000000001' } }, as()), { code: 'push.platform_unserved' });
    assert.ok(!JSON.stringify(await gateway.call(listPushDevices, {}, as())).includes('device-token'), 'the token never comes back');

    const raised = await scheduler.call(raiseNotification, {
      body: { recipientMembershipId: rootMembership, kind: 'object_view_layout_invalidated', source: { objectViewLayoutId: layout }, channels: ['mobile_push'] },
    }, { request: { organisationId: org } });
    assert.equal(raised.notification.channel, 'mobile_push');
    assert.deepEqual(pushes.map((p) => p.token).sort(), ['device-token-good-0001', 'gone-token-0000000001']);
    assert.ok(pushes.every((p) => p.message.title === 'Silo' && /^\d+ new in Silo$/.test(p.message.body) && p.message.link === 'http://app.test/notifications/'));
    const devices = await gateway.call(listPushDevices, {}, as());
    assert.equal(devices.devices.length, 1, 'the gone device was revoked');
    await gateway.call(removePushDevice, { params: { deviceId: good.id } }, as());
    assert.equal((await gateway.call(listPushDevices, {}, as())).devices.length, 0);
  });
});
