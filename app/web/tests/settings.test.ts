// Settings in a real browser (spec 33.4; U15): members by name and address, one suspended and
// reinstated, an invitation with a role and a scope; a scope created beneath another and a member
// added to it; a purpose marking, a purpose that opens it and who may declare it; the sharing
// ceiling changed; Ask's web context off for the organisation and for a scope; the person's own
// account with its second factor. No script or style is blocked anywhere.

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { Browser, Page } from 'playwright-core';
import { createAskService } from '../../server/src/routes/ask/index.route.ts';
import { createGatewayService } from '../../server/src/routes/gateway/index.route.ts';
import { createSiloesCaptureService } from '../../server/src/routes/siloes-capture/index.route.ts';
import { createWorkspaceService } from '../../server/src/routes/workspace/index.route.ts';
import { unavailableEngine } from '../../server/src/services/workspace/queryEngine.service.ts';
import { createConnectCell, type ConnectCell } from '../../server/tests/services/connect.helper.ts';
import { buildExport, gatewayAt, launch, open, signIn, skip } from './browser.helper.ts';

let cell: ConnectCell;
let browser: Browser;
let origin: string;
let page: Page;
const problems: string[] = [];
const nav = () => page.getByRole('navigation', { name: 'Settings' });

describe('Settings in a browser (spec 33.4)', { skip }, () => {
  before(async () => {
    await buildExport();
    const gateway = await gatewayAt();
    origin = gateway.origin;
    cell = await createConnectCell();
    await cell.start(createSiloesCaptureService({ schedule: false }), 'siloes-capture', 'test_app',
      { SILOES_POSTGRES_PRICE_PER_GIB_MONTH: '0.20', SILOES_STORAGE_PRICE_PER_GIB_MONTH: '0.02' });
    await cell.start(createWorkspaceService(), 'workspace', 'test_app');
    await cell.start(createAskService({ engine: unavailableEngine, webSearch: { search: async () => [] } }), 'ask', 'test_app');
    await cell.start(createGatewayService(), 'gateway', 'test_app', gateway.env);
    await cell.signIn('root@acme.example');
    await cell.member('casey@acme.example', 'Member', 'platform');
    browser = await launch();
    page = await open(browser, problems);
    await page.goto(`${origin}/settings/?tab=people`);
    await page.waitForURL(/\/sign-in\//);
    await signIn(page, 'root@acme.example');
    await page.waitForURL(`${origin}/settings/people/`);
  });

  beforeEach(() => {
    problems.length = 0;
  });

  after(async () => {
    await browser?.close();
    await cell?.close();
  });

  test('members by name and address; one suspended, then reinstated; an invitation with a role and a scope', async () => {
    const members = page.getByRole('table', { name: 'Members' });
    const casey = members.getByRole('row').filter({ hasText: 'casey@acme.example' });
    await casey.waitFor();
    assert.match(await casey.innerText(), /casey@acme\.example[\s\S]*Active[\s\S]*platform/);
    await casey.getByRole('button', { name: 'Suspend' }).click();
    await page.getByText(/suspended: their grants are silenced, not revoked/).waitFor();
    await casey.getByRole('button', { name: 'Reinstate' }).click();
    await page.getByText(/reinstated\./).waitFor();
    const invite = page.getByRole('form', { name: 'Invite' });
    await invite.getByLabel('Invite by email').fill('dana@acme.example');
    await invite.getByRole('combobox', { name: /^As/ }).selectOption({ label: 'Member' });
    await invite.getByRole('combobox', { name: /^In/ }).selectOption({ label: 'platform' });
    await invite.getByRole('button', { name: 'Invite' }).click();
    await page.getByText('Invitation sent to dana@acme.example.').waitFor();
    assert.deepEqual(problems, []);
  });

  test('a scope created beneath another, in the tree; a member added to it and listed there', async () => {
    await nav().getByRole('link', { name: 'Scopes' }).click();
    const form = page.getByRole('form', { name: 'New scope', exact: true });
    await form.getByLabel('New scope', { exact: true }).fill('payments');
    await form.getByLabel('Of type').selectOption({ index: 1 });
    await form.getByLabel('Beneath').selectOption({ label: 'platform' });
    await form.getByRole('button', { name: 'Create' }).click();
    await page.getByText('payments created.').waitFor();
    const payments = page.getByRole('listitem').filter({ hasText: /^platform/ }).getByRole('button', { name: 'payments' });
    await payments.click();
    const drawer = page.getByRole('dialog', { name: 'payments' });
    await drawer.getByText('No one is in it directly.').waitFor();
    const add = drawer.getByRole('form', { name: 'Add a member' });
    await add.getByLabel('Add').selectOption({ index: 1 });
    await add.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByText('Added to the scope').waitFor();
    await drawer.getByRole('table', { name: 'Scope members' }).getByRole('row').nth(1).waitFor();
    await page.keyboard.press('Escape');
    assert.deepEqual(problems, []);
  });

  test('a purpose marking; a purpose that opens it; everyone in a scope made eligible to declare it', async () => {
    await nav().getByRole('link', { name: 'Markings and clearances' }).click();
    await page.getByRole('button', { name: 'New marking' }).click();
    const making = page.getByRole('dialog', { name: 'New marking' });
    await making.getByLabel('Name').fill('Payroll');
    await making.getByLabel('Kind').selectOption('purpose');
    await making.getByRole('button', { name: 'Make it' }).click();
    await page.getByText('Marking made').waitFor();
    await nav().getByRole('link', { name: 'Purposes' }).click();
    await page.getByRole('button', { name: 'New purpose' }).click();
    const draft = page.getByRole('dialog', { name: 'New purpose' });
    await draft.getByLabel('Name').fill('Payroll run');
    await draft.getByLabel('What it is for').fill('Paying people each month');
    await draft.getByLabel('It opens').selectOption({ label: 'Payroll' });
    await draft.getByRole('button', { name: 'Make the draft' }).click();
    await page.getByText('A draft: someone else approves it').waitFor();
    await page.getByRole('table', { name: 'Purposes' }).getByRole('link', { name: 'Payroll run' }).click();
    await page.getByText('No one yet.').waitFor();
    const eligible = page.getByRole('form', { name: 'Make someone eligible' });
    await eligible.getByLabel('Make eligible').selectOption({ label: 'Everyone in platform' });
    await eligible.getByRole('button', { name: 'Make eligible' }).click();
    await page.getByText('Eligible', { exact: true }).first().waitFor();
    await page.getByRole('table', { name: 'Eligible' }).getByText('Everyone in platform').waitFor();
    await page.keyboard.press('Escape');
    assert.deepEqual(problems, []);
  });

  test('the sharing ceiling changed; web context off for the organisation, then in one scope', async () => {
    await nav().getByRole('link', { name: 'Sharing policy' }).click();
    await page.getByLabel(/^Sharing saved views/).selectOption('explicit_only');
    await page.getByText('Saved', { exact: true }).waitFor();
    assert.equal(await page.getByLabel(/^Sharing saved views/).inputValue(), 'explicit_only');

    await nav().getByRole('link', { name: 'Ask and the web' }).click();
    const web = page.getByRole('switch', { name: 'Ask may search the web' });
    await web.waitFor();
    const before = await web.getAttribute('aria-checked');
    await web.click();
    await page.getByText(before === 'true' ? 'Ask will not search the web' : 'Ask may search the web', { exact: true }).waitFor();
    await page.getByRole('switch', { name: 'Ask may search the web', checked: before !== 'true' }).waitFor();
    await page.getByRole('button', { name: 'Set for a scope' }).click();
    const scope = page.getByRole('dialog', { name: 'Web search in a scope' });
    await scope.getByLabel('Scope', { exact: true }).selectOption({ index: 1 });
    await scope.getByRole('switch', { name: 'Web search on in this scope' }).click();
    await scope.getByRole('button', { name: 'Save for this scope' }).click();
    await page.getByText('Saved: web search is off in this scope').waitFor();
    await page.getByRole('table', { name: 'Web context in scopes' }).getByText('Off', { exact: true }).waitFor();
    assert.deepEqual(problems, []);
  });

  test('the person\'s own account', async () => {
    await page.getByRole('button', { name: /^Your account/ }).click();
    await page.getByRole('menuitem', { name: 'Profile' }).click();
    await page.waitForURL(/\/account\/profile\//);
    await page.getByText('root@acme.example').first().waitFor();
    await page.goto(`${origin}/account/security/`);
    await page.getByRole('heading', { name: 'Second factors' }).waitFor();
    assert.deepEqual(problems, []);
  });
});
