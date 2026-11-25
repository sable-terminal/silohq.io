// The web client in a real browser (spec 33): the static export built and served by the
// gateway at its public origin, beside the API, in a cell of real services; Chrome (headless,
// the one installed here) signs in and works the shell. Every page runs under its strict
// policy, so any script or style the policy blocks fails the test as a console error. Runs
// where the local stack (npm run db:up, infra:up in app/server) and Chrome are present.

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { Browser } from 'playwright-core';
import { service as approvalsService } from '../../server/src/routes/approvals/index.route.ts';
import { createAdminPortalService } from '../../server/src/routes/admin-portal/index.route.ts';
import { createGatewayService } from '../../server/src/routes/gateway/index.route.ts';
import { createNotifyService } from '../../server/src/routes/notify/index.route.ts';
import { createSchedulerService } from '../../server/src/routes/scheduler/index.route.ts';
import { createSiloesCaptureService } from '../../server/src/routes/siloes-capture/index.route.ts';
import { createTenantMigrationsService } from '../../server/src/routes/tenant-migrations/index.route.ts';
import { createWorkspaceService } from '../../server/src/routes/workspace/index.route.ts';
import { createConnectCell, type ConnectCell } from '../../server/tests/services/connect.helper.ts';
import { createMemoryStore } from '../../server/tests/services/memoryStore.helper.ts';
import { randomBytes } from 'node:crypto';
import { link } from '../../server/src/services/notify/templates.service.ts';
import { PASSWORD } from '../../server/tests/services/connect.helper.ts';
import { buildExport, gatewayAt, launch, open as openPage, shot, signIn, skip } from './browser.helper.ts';

let cell: ConnectCell;
let browser: Browser;
let origin: string;
const problems: string[] = [];
const open = () => openPage(browser, problems);

describe('the web client in a browser', { skip }, () => {
  beforeEach(() => {
    problems.length = 0;
  });

  before(async () => {
    await buildExport();

    cell = await createConnectCell();
    await cell.start(createSiloesCaptureService({ schedule: false }), 'siloes-capture', 'test_app', {
      SILOES_POSTGRES_PRICE_PER_GIB_MONTH: '0.20', SILOES_STORAGE_PRICE_PER_GIB_MONTH: '0.02',
    });
    // What Home's briefing reads: Crons that fired, approvals waiting.
    await cell.start(createSchedulerService(), 'scheduler', 'test_app', { SCHEDULER_TICK_MS: '600000' });
    await cell.start(approvalsService, 'approvals', 'test_app');
    await cell.start(createWorkspaceService(), 'workspace', 'test_app');
    await cell.start(createNotifyService({ sweep: false }), 'notify', 'test_app', {
      SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_TLS: 'none', NOTIFY_LINK_BASE_URL: 'http://localhost/',
    });
    await cell.start(createTenantMigrationsService({ objects: createMemoryStore() }), 'tenant-migrations', 'test_app', {
      MAINTENANCE_DATABASE_URL: cell.h.url('test_migrate'), TENANT_MIGRATIONS_TICK_SECONDS: '3600',
      // Named only: the objects live in memory here.
      OBJECT_STORE: 's3', OBJECT_BUCKET_BACKUP: 'silo-test-backup', OBJECT_BUCKET_FILES: 'silo-test-files', S3_ENDPOINT: 'http://127.0.0.1:1',
      S3_REGION: 'eu-west-2', S3_FORCE_PATH_STYLE: 'true',
    });
    // Support tickets (U4) live in admin-portal; its staff listener is not used here.
    await cell.start(createAdminPortalService({ sweep: false }), 'admin-portal', 'test_app', {
      IDENTIFIER_HASH_KEY: randomBytes(32).toString('base64'), ADMIN_PORTAL_PUBLIC_ORIGIN: 'https://staff.silo.test', ADMIN_PORTAL_PUBLIC_HOST: '127.0.0.1',
      ADMIN_PORTAL_PUBLIC_PORT: '0', PG_REPORT_URL: cell.h.url('test_report'),
      // Contacted only when a member of staff signs in, which no test here does.
      ADMIN_PORTAL_IDP_ISSUER: 'https://idp.silo.test', ADMIN_PORTAL_IDP_CLIENT_ID: 'silo-staff-portal',
      ADMIN_PORTAL_IDP_CLIENT_SECRET: randomBytes(24).toString('base64url'), ADMIN_PORTAL_IDP_REDIRECT_URI: 'https://staff.silo.test/sso/callback',
      ADMIN_PORTAL_GROUP_CAPABILITIES: '{}',
    });
    const gateway = await gatewayAt();
    origin = gateway.origin;
    await cell.start(createGatewayService(), 'gateway', 'test_app', gateway.env);
    browser = await launch();
  });

  after(async () => {
    await browser?.close();
    await cell?.close();
  });

  test('a page under a strict policy: its own scripts by hash, nothing inline besides', async () => {
    const page = await open();
    const response = await page.goto(`${origin}/sign-in/`);
    const csp = response!.headers()['content-security-policy'] ?? '';
    assert.match(csp, /script-src 'self' 'sha256-/);
    assert.ok(!csp.includes('unsafe-inline') && !csp.includes("'unsafe-eval'"), csp);
    await page.getByRole('heading', { name: 'Sign in' }).waitFor();
    assert.deepEqual(problems, [], 'the page ran with nothing blocked');
    await page.context().close();
  });

  test('signing in returns to the page asked for; the workspace opens on it, in the designed order', async () => {
    const page = await open();
    await page.goto(`${origin}/connect/connections/`);
    await page.waitForURL(/\/sign-in\/\?next=/);
    await signIn(page, 'root@acme.example');
    await page.waitForURL(`${origin}/connect/connections/`);
    const nav = page.getByRole('navigation', { name: 'Main' });
    await nav.getByRole('link', { name: 'Home', exact: true }).waitFor();
    for (const item of ['Home', 'Explorer', 'Clones', 'Studio', 'Ask', 'Scenarios', 'Governance', 'Connect', 'Ontology', 'Files']) {
      assert.equal(await nav.getByRole('link', { name: item, exact: true }).count(), 1, item);
    }
    assert.equal(await nav.getByText('Siloes', { exact: true }).count(), 0, 'Siloes is absent until a Silo is enabled');
    assert.equal(await nav.getByRole('link', { name: 'Connections', exact: true }).getAttribute('aria-current'), 'page', 'the section is marked');
    await nav.getByRole('button', { name: /Acme/ }).waitFor();

    // The header: search, + and the Lens on the left; Settings, Notifications, Help, Tickets, then Profile at the right edge.
    const header = page.getByRole('banner');
    const controls = await header.locator('button, a').evaluateAll((all) => all.map((el) => el.getAttribute('aria-label') ?? el.textContent?.trim() ?? ''));
    const at = (name: RegExp) => controls.findIndex((label) => name.test(label));
    const order = [/^Search/, /^Create$/, /^Lens/, /^Settings$/, /^Notifications/, /^Help centre$/, /^Support tickets$/, /^Your account/].map(at);
    assert.ok(order.every((i) => i >= 0), `every control is there: ${JSON.stringify(controls)}`);
    assert.deepEqual([...order].sort((a, b) => a - b), order, `in order: ${JSON.stringify(controls)}`);
    await shot(page, 'workspace');

    // "/" opens search; it finds settings by name and goes to them on Enter.
    await page.locator('main').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('/');
    const palette = page.getByRole('dialog', { name: 'Search' });
    await palette.getByRole('combobox').fill('seats');
    await palette.getByRole('option', { name: /Settings › People › Seats/ }).waitFor();
    await shot(page, 'search');
    await palette.getByRole('combobox').press('Enter');
    await page.waitForURL(`${origin}/settings/seats/`);
    assert.equal(await palette.isVisible(), false);
    await page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Seats' }).waitFor();

    // The + menu: everything that can be made, grouped.
    await page.getByRole('button', { name: 'Create' }).click();
    const create = page.getByRole('dialog', { name: 'Create' });
    for (const group of ['Connect', 'Model', 'Analyse', 'Build and operate', 'Files and storage', 'People and help']) {
      await create.getByRole('heading', { name: group }).waitFor();
    }
    await shot(page, 'create');
    await create.getByRole('link', { name: /Invitation/ }).click();
    await page.waitForURL(`${origin}/settings/people/?new=1`);

    // Notifications and help open from the header.
    await page.getByRole('button', { name: /^Notifications/ }).click();
    await page.getByRole('dialog', { name: 'Notifications' }).getByText('You are up to date').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Help centre' }).click();
    const help = page.getByRole('dialog', { name: 'Help centre' });
    await help.getByRole('heading', { name: /About this page: Settings › People › Members and invitations/ }).waitFor();
    await help.getByRole('heading', { name: 'Keyboard shortcuts' }).waitFor();
    await shot(page, 'help');
    await page.keyboard.press('Escape');

    // An old address goes to the section that holds it now.
    await page.goto(`${origin}/governance/?tab=crons`);
    await page.waitForURL(`${origin}/governance/crons/`);

    // The sidebar's collapsed state is the person's, kept across visits.
    await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/v1/workspace/preferences') && r.request().method() === 'PATCH'),
      page.getByRole('button', { name: 'Collapse the sidebar' }).click(),
    ]);
    await page.reload();
    await page.getByRole('button', { name: 'Expand the sidebar' }).waitFor();
    await shot(page, 'collapsed');
    await page.getByRole('button', { name: 'Expand the sidebar' }).click();

    // The profile menu names the person; signing out ends the session.
    await page.getByRole('button', { name: /Your account: Root Admin/ }).click();
    await page.getByText('root@acme.example').waitFor();
    await shot(page, 'profile');
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await page.waitForURL(`${origin}/sign-in/`);
    await page.goto(`${origin}/`);
    await page.waitForURL(/\/sign-in\/$/);
    assert.deepEqual(problems, [], 'no script or style blocked, no error thrown');
    await page.context().close();
  });

  test('Home is the briefing, five sections in fixed order; the account pages say who the person is and how they sign in', async () => {
    const page = await open();
    await page.goto(`${origin}/`);
    await page.waitForURL(/\/sign-in\//);
    await signIn(page, 'root@acme.example');
    await page.getByRole('heading', { name: /^Good (morning|afternoon|evening), Root$/ }).waitFor();
    await page.getByText('nothing waits for you').waitFor();
    const sections = await page.locator('main section[aria-labelledby]').evaluateAll((all) => all.map((s) => s.querySelector('h2')?.textContent?.trim()));
    assert.deepEqual(sections, ['Approvals waiting', 'Crons that fired', 'Findings', 'Favourited clones', 'Favourited apps', 'Your dashboard']);
    assert.equal(await page.getByText('could not be read').count(), 0, 'every source answered');
    await shot(page, 'home');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, 'home-dark');
    await page.emulateMedia({ colorScheme: 'light' });

    await page.getByRole('button', { name: /^Your account/ }).click();
    await page.getByRole('menuitem', { name: 'Security' }).click();
    await page.waitForURL(`${origin}/account/security/`);
    await page.getByRole('heading', { name: 'Second factors' }).waitFor();
    await page.getByRole('heading', { name: 'Linked identities' }).waitFor();
    await shot(page, 'account-security');
    await page.getByRole('navigation', { name: 'Account' }).getByRole('link', { name: 'Profile' }).click();
    await page.getByText('root@acme.example').waitFor();
    await page.getByRole('navigation', { name: 'Account' }).getByRole('link', { name: 'Organisations' }).click();
    const acme = page.getByRole('table', { name: 'Organisations' }).getByRole('row').filter({ hasText: 'acme' });
    assert.match(await acme.innerText(), /Signed in/);
    await page.getByRole('navigation', { name: 'Account' }).getByRole('link', { name: 'Allowance' }).click();
    // This cell runs no metering service: the page states the failure rather than showing nothing.
    await page.getByRole('heading', { name: 'Allowance', level: 1 }).waitFor();
    await page.getByText(/This period runs from|could not be loaded|could not be reached|went wrong/).first().waitFor();
    assert.deepEqual(problems, [], 'no script or style blocked, no error thrown');
    await page.context().close();
  });

  test('support: a ticket raised from the header, values warned of before sending, answered and closed by its raiser', async () => {
    const page = await open();
    await page.goto(`${origin}/connect/connections/`);
    await page.waitForURL(/\/sign-in\//);
    await signIn(page, 'root@acme.example');
    await page.waitForURL(`${origin}/connect/connections/`);
    await page.getByRole('button', { name: /^Support tickets/ }).click();
    const panel = page.getByRole('dialog', { name: 'Support tickets' });
    await panel.getByRole('button', { name: 'New ticket' }).click();
    await panel.getByLabel('Subject').fill('The CRM connection will not test');
    const body = panel.getByLabel('What happened, and what did you expect?');
    await body.fill('It fails for jo.bloggs@example.com since this morning');
    await panel.getByText(/This looks like it holds an email address/).waitFor();
    assert.equal(await panel.getByRole('button', { name: 'Send to Silo support' }).getAttribute('aria-disabled'), 'true', 'nothing that looks like a value is sent');
    await body.fill('Testing the CRM connection fails each time since this morning; I expected it to pass as it did yesterday.');
    await panel.getByText('Say it was raised from Connect › Connections').waitFor();
    await shot(page, 'ticket-new');
    await panel.getByRole('button', { name: 'Send to Silo support' }).click();
    await panel.getByRole('heading', { name: 'The CRM connection will not test' }).waitFor();
    await panel.getByText('With Silo support').waitFor();
    await panel.getByLabel('Add to the ticket').fill('It also fails for the write class.');
    await panel.getByRole('button', { name: 'Send', exact: true }).click();
    await panel.getByText('It also fails for the write class.').waitFor();
    await shot(page, 'ticket-thread');
    await panel.getByRole('link', { name: 'Open full page' }).click();
    await page.waitForURL(/\/support\/\?ticket=/);
    await page.getByRole('button', { name: 'Close the ticket' }).click();
    await page.getByRole('dialog', { name: 'Close this ticket?' }).getByRole('button', { name: 'Close it' }).click();
    await page.getByText('This ticket is closed.').waitFor();
    await page.getByRole('tab', { name: 'Resolved and closed' }).click();
    await page.getByRole('button', { name: /The CRM connection will not test/ }).waitFor();
    assert.deepEqual(problems, [], 'no script or style blocked, no error thrown');
    await page.context().close();
  });

  test('before sign-in: a password reset from its emailed link; an invitation accepted from its link; sign-up names the organisation', async () => {
    await cell.member('pat@acme.example', 'Member');
    const page = await open();
    const target = { baseUrl: origin, organisation: { name: 'Acme', slug: 'acme' } };

    // Asking for a reset says the same whoever asks; the link it emails changes the password once.
    await page.goto(`${origin}/sign-in/`);
    await page.getByRole('link', { name: 'Forgot your password?' }).click();
    await page.waitForURL(`${origin}/reset-password/`);
    await page.getByLabel('Organisation').fill('acme');
    await page.getByLabel('Email').fill('pat@acme.example');
    await page.getByRole('button', { name: 'Email me a link' }).click();
    await page.getByRole('heading', { name: 'Check your email' }).waitFor();
    const reset = cell.emailed.resets.findLast((r) => r.email === 'pat@acme.example');
    assert.ok(reset, 'a reset was sent');
    await page.goto(link(target, 'reset-password', reset.token));
    await page.getByRole('heading', { name: 'Choose a new password' }).waitFor();
    assert.equal(new URL(page.url()).hash, '', 'the token is cleared from the address once read');
    await page.getByLabel('New password', { exact: true }).fill('a much longer passphrase 2026');
    await page.getByLabel('The same again', { exact: true }).fill('a much longer passphrase 2026');
    await shot(page, 'entry-reset');
    await page.getByRole('button', { name: 'Change my password' }).click();
    await page.getByRole('heading', { name: 'Your password is changed' }).waitFor();
    await page.getByRole('link', { name: 'Sign in' }).first().click();
    await page.getByLabel('Organisation').waitFor();
    assert.equal(await page.getByLabel('Organisation').inputValue(), 'acme', 'the organisation is carried over');
    await signIn(page, 'pat@acme.example', 'a much longer passphrase 2026');
    await page.getByRole('heading', { name: /^Good (morning|afternoon|evening), New$/ }).waitFor();
    await page.getByRole('button', { name: /^Your account/ }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await page.waitForURL(`${origin}/sign-in/`);

    // An invitation's link: a name and a password, and the person is in.
    const token = await cell.invite('ivy@acme.example', 'Member');
    await page.goto(link(target, 'accept-invitation', token));
    await page.getByRole('heading', { name: 'Join acme on Silo' }).waitFor();
    await page.getByLabel('First name').fill('Ivy');
    await page.getByLabel('Last name').fill('Invited');
    await page.getByLabel('Password').fill(PASSWORD);
    await shot(page, 'entry-invitation');
    await page.getByRole('button', { name: 'Join' }).click();
    await page.getByRole('heading', { name: /^Good (morning|afternoon|evening), Ivy$/ }).waitFor();
    await page.getByRole('button', { name: /^Your account/ }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await page.waitForURL(`${origin}/sign-in/`);

    // A link without its token says so, rather than failing later.
    await page.goto(`${origin}/accept-invitation/?organisation=acme`);
    await page.getByRole('heading', { name: 'This invitation link is incomplete' }).waitFor();

    // Sign-up: the short name follows the organisation's name until the person edits it.
    await page.goto(`${origin}/sign-up/`);
    await page.getByLabel('Organisation name').fill('Northwind Water Ltd');
    assert.equal(await page.getByLabel('Short name').inputValue(), 'northwind-water-ltd');
    await shot(page, 'entry-sign-up');
    assert.deepEqual(problems, [], 'no script or style blocked, no error thrown');
    await page.context().close();
  });

  test('what the person may not use is shown disabled, naming the permission it needs', async () => {
    await cell.member('mia@acme.example', 'Member');
    const page = await open();
    await page.goto(`${origin}/`);
    await page.waitForURL(/\/sign-in\//);
    await signIn(page, 'mia@acme.example');
    await page.getByRole('heading', { name: /^Good (morning|afternoon|evening), New$/ }).waitFor({ timeout: 10_000 }).catch(async (error: unknown) => {
      await shot(page, 'member-failed');
      throw new Error(`${String(error)}\n${problems.join('\n')}\n${(await page.locator('main').textContent()) ?? ''}`);
    });
    const nav = page.getByRole('navigation', { name: 'Main' });
    const scenarios = nav.locator('[aria-disabled="true"]', { hasText: 'Scenarios' });
    await shot(page, 'member-sidebar');
    assert.equal(await scenarios.count(), 1);
    assert.match((await scenarios.textContent())!, /Needs the simulation permission class/);
    await page.getByRole('button', { name: 'Create' }).click();
    const create = page.getByRole('dialog', { name: 'Create' });
    const invitation = create.locator('[aria-disabled="true"]', { hasText: 'Invitation' });
    await invitation.waitFor();
    assert.match((await invitation.textContent())!, /Needs /);
    await shot(page, 'member-create');
    assert.deepEqual(problems, []);
    await page.context().close();
  });
});
