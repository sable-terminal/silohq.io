// Connect in a real browser (spec 14, 15, 33.3; U8): an admin finds the organisation's own
// connector in the catalogue, creates a connection owned by a scope they may create in, gives
// it its token on the connection's Settings and credentials tab (never shown back, only its
// last four) and sends it for testing from its Overview. The list shows
// it; a Silo Agent pool is created and an enrolment token shown once; an Action webhook is added
// and its signing secret shown once. No script or style is blocked anywhere.

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { Browser, Page } from 'playwright-core';
import { createConnector, createManifestVersion } from '../../server/src/contracts/connect-registry/connector.contract.ts';
import { createActionsService } from '../../server/src/routes/actions/index.route.ts';
import { service as catalogueService } from '../../server/src/routes/catalogue/index.route.ts';
import { service as conformanceService } from '../../server/src/routes/conformance/index.route.ts';
import { createConnectRuntimeService } from '../../server/src/routes/connect-runtime/index.route.ts';
import { createGatewayService } from '../../server/src/routes/gateway/index.route.ts';
import { createSiloesCaptureService } from '../../server/src/routes/siloes-capture/index.route.ts';
import { createWorkspaceService } from '../../server/src/routes/workspace/index.route.ts';
import { uuidv7 } from '../../server/tests/db/harness.helper.ts';
import { createConnectCell, restManifest, type ConnectCell } from '../../server/tests/services/connect.helper.ts';
import { buildExport, gatewayAt, launch, open, shot, signIn, skip } from './browser.helper.ts';

let cell: ConnectCell;
let api: Server;
let browser: Browser;
let origin: string;
let page: Page;
const seen: string[] = [];
const problems: string[] = [];

describe('Connect in a browser (spec 33.3)', { skip }, () => {
  before(async () => {
    await buildExport();
    const gateway = await gatewayAt();
    origin = gateway.origin;
    api = createServer((req, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''}`);
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== 'Bearer tok_browser_5678') { res.statusCode = 401; res.end('{}'); return; }
      res.end(JSON.stringify({ results: [{ id: 'c1', properties: { email: 'a@x.test', first: 'Ada', last: 'L', score: 3 } }], next: null }));
    });
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`;

    cell = await createConnectCell();
    await cell.start(createConnectRuntimeService(), 'connect-runtime', 'test_app');
    await cell.start(conformanceService, 'conformance', 'test_app');
    await cell.start(catalogueService, 'catalogue', 'test_app', { CATALOGUE_DATABASE_URL: cell.h.url('test_migrate') });
    await cell.start(createActionsService({ sweep: false }), 'actions', 'test_app');
    await cell.start(createSiloesCaptureService({ schedule: false }), 'siloes-capture', 'test_app',
      { SILOES_POSTGRES_PRICE_PER_GIB_MONTH: '0.20', SILOES_STORAGE_PRICE_PER_GIB_MONTH: '0.02' });
    await cell.start(createWorkspaceService(), 'workspace', 'test_app');
    await cell.start(createGatewayService(), 'gateway', 'test_app', gateway.env);
    const root = await cell.signIn('root@acme.example');
    const connector = await cell.client('gateway').call(createConnector, { body: { slug: 'browser-crm', name: 'Browser CRM', provider: 'Example', sourceRoute: 'visual' } },
      { ...cell.as(root), idempotencyKey: uuidv7() });
    await cell.client('gateway').call(createManifestVersion, { params: { connectorId: connector.id }, body: { document: restManifest({ baseUrl }) } },
      { ...cell.as(root), idempotencyKey: uuidv7() });

    browser = await launch();
    page = await open(browser, problems);
    await page.goto(`${origin}/connect/connections/?new=1`);
    await page.waitForURL(/\/sign-in\//);
    await signIn(page, 'root@acme.example');
    await page.waitForURL(`${origin}/connect/connections/?new=1`);
  });

  beforeEach(() => {
    problems.length = 0;
  });

  after(async () => {
    await browser?.close();
    await cell?.close();
    await new Promise((resolve) => api?.close(resolve));
  });

  test('from the catalogue to a connection owned by a scope the admin may create in; its token sealed, never shown back', async () => {
    const row = page.getByRole('table', { name: 'Connectors' }).getByRole('row').filter({ hasText: 'Browser CRM' });
    await row.waitFor();
    assert.match(await row.innerText(), /Your organisation's/);
    await row.getByRole('button', { name: 'Choose' }).click();
    await page.getByRole('heading', { level: 1, name: 'Connect Browser CRM' }).waitFor();
    await page.getByText(/It reads 1 object: contacts/i).waitFor();
    const name = page.getByLabel('Name', { exact: true });
    assert.equal(await name.inputValue(), 'Browser CRM', 'named after its connector until the person names it');
    await name.fill('Sales CRM');
    const owner = page.getByLabel('Owned by');
    await owner.locator('option', { hasText: 'engineering' }).waitFor({ state: 'attached' });
    await owner.selectOption({ label: 'engineering' });
    await page.getByRole('button', { name: 'Create the connection' }).click();
    await page.waitForURL(/\/connect\/connections\/\?connection=[0-9a-f-]{36}&tab=setup/);
    await page.getByRole('heading', { level: 1, name: 'Sales CRM' }).waitFor();
    assert.equal(await page.getByRole('tab', { name: 'Settings and credentials' }).getAttribute('aria-selected'), 'true');

    const token = page.getByLabel('API token');
    assert.equal(await token.getAttribute('type'), 'password');
    await token.fill('tok_browser_5678');
    await page.getByRole('button', { name: 'Save credentials' }).click();
    await page.getByText('Sealed; ends 5678').waitFor();
    assert.equal(await token.inputValue(), '', 'the field is emptied once sealed');
    await shot(page, 'connect-connection');

    await page.getByRole('tab', { name: 'Overview' }).click();
    await page.getByRole('button', { name: 'Test it' }).click();
    await page.getByRole('button', { name: 'Confirm it' }).waitFor();
    assert.match(await page.locator('header').filter({ has: page.getByRole('heading', { level: 1 }) }).innerText(), /Being tested/);
    assert.deepEqual(problems, []);
  });

  test('the list shows it with where it stands', async () => {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Connections', exact: true }).click();
    const row = page.getByRole('table', { name: 'Connections' }).getByRole('row').filter({ hasText: 'Sales CRM' });
    await row.waitFor();
    assert.match(await row.innerText(), /Being tested/);
    assert.match(await row.innerText(), /Read only/);
    assert.deepEqual(problems, []);
  });

  test('a Silo Agent pool, and an enrolment token shown once', async () => {
    await page.goto(`${origin}/connect/?tab=agents`);
    await page.waitForURL(`${origin}/connect/agents/`);
    await page.getByRole('button', { name: 'New pool' }).click();
    const dialog = page.getByRole('dialog', { name: 'New agent pool' });
    await dialog.getByLabel('Name', { exact: true }).fill('Factory floor');
    await dialog.getByRole('button', { name: 'Create the pool' }).click();
    await page.waitForURL(/\/connect\/agents\/\?pool=[0-9a-f-]{36}/);
    const pool = page.getByRole('dialog', { name: 'Factory floor' });
    await pool.getByText(/at least two/).waitFor();
    await pool.getByRole('button', { name: 'Enrol an agent' }).click();
    const enrol = page.getByRole('dialog', { name: 'Enrol an agent in Factory floor' });
    await enrol.getByRole('button', { name: 'Make a token' }).click();
    await enrol.getByText(/Shown once; valid until/).waitFor();
    assert.match(await enrol.getByText('Enrolment token', { exact: true }).locator('..').innerText(), /silo_enr_\S{20,}/);
    await shot(page, 'connect-agents');
    await enrol.getByRole('button', { name: 'Done' }).click();
    await pool.getByRole('button', { name: 'Close' }).click();
    const row = page.getByRole('table', { name: 'Agent pools' }).getByRole('row').filter({ hasText: 'Factory floor' });
    assert.match(await row.innerText(), /Too few/);
    assert.deepEqual(problems, []);
  });

  test('an endpoint told of governed changes, its signing secret shown once', async () => {
    await page.goto(`${origin}/connect/?tab=webhooks`);
    await page.waitForURL(`${origin}/connect/webhooks/`);
    await page.getByRole('button', { name: 'Add an endpoint' }).click();
    const dialog = page.getByRole('dialog', { name: 'Send governed changes to an endpoint' });
    await dialog.getByLabel('Endpoint (https)').fill('https://hooks.example.test/silo');
    await dialog.getByLabel('Physical').check();
    await dialog.getByRole('button', { name: 'Subscribe' }).click();
    await dialog.getByText('Signing secret', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Done' }).click();
    const row = page.getByRole('table', { name: 'Endpoints' }).getByRole('row').filter({ hasText: 'https://hooks.example.test/silo' });
    await row.waitFor();
    assert.match(await row.innerText(), /Active/);
    assert.match(await row.innerText(), /physical risk/);
    assert.deepEqual(problems, []);
  });
});
