// The object view in a real browser (spec 34; W4), over the cell Explorer's test uses: suppliers
// merged from a CRM and an ERP whose names disagree. Opened from Explorer: the object read live
// from each system, a disagreement shown with each system's own value and never resolved, its
// links, and its sections read separately, one that cannot be read saying why while the rest
// stand. No script or style is blocked anywhere.

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { Browser, Page } from 'playwright-core';
import { service as compileService } from '../../server/src/routes/compile/index.route.ts';
import { createGatewayService } from '../../server/src/routes/gateway/index.route.ts';
import { service as searchService } from '../../server/src/routes/search/index.route.ts';
import { createSiloesCaptureService } from '../../server/src/routes/siloes-capture/index.route.ts';
import { createWorkspaceService } from '../../server/src/routes/workspace/index.route.ts';
import { startRecognitionCell, type RecognitionCell } from '../../server/tests/services/recognition.helper.ts';
import { buildExport, gatewayAt, launch, open, shot, signIn, skip } from './browser.helper.ts';

let r: RecognitionCell;
let browser: Browser;
let origin: string;
let page: Page;
const problems: string[] = [];

describe('the object view in a browser (spec 34)', { skip }, () => {
  before(async () => {
    await buildExport();
    const gateway = await gatewayAt();
    origin = gateway.origin;
    r = await startRecognitionCell([
      { definition: compileService, name: 'compile' },
      { definition: searchService, name: 'search' },
      { definition: createSiloesCaptureService({ schedule: false }), name: 'siloes-capture', env: { SILOES_POSTGRES_PRICE_PER_GIB_MONTH: '0.20', SILOES_STORAGE_PRICE_PER_GIB_MONTH: '0.02' } },
      { definition: createWorkspaceService(), name: 'workspace' },
      { definition: createGatewayService(), name: 'gateway', env: gateway.env },
    ]);
    browser = await launch();
    page = await open(browser, problems);
    await page.goto(`${origin}/explorer/types/`);
    await page.waitForURL(/\/sign-in\//);
    await signIn(page, 'root@acme.example');
    await page.waitForURL(`${origin}/explorer/types/`);
  });

  beforeEach(() => {
    problems.length = 0;
  });

  after(async () => {
    await browser?.close();
    await r?.close();
  });

  test('opened from Explorer: read from each system, a disagreement shown with every system\'s value, never resolved; its links', async () => {
    await page.getByRole('navigation', { name: 'Object types' }).getByRole('link', { name: 'Suppliers' }).click();
    const table = page.getByRole('table');
    await table.waitFor();
    // A supplier whose name the two systems hold differently.
    const disputedRow = table.getByRole('row').filter({ hasText: 'Systems disagree' }).first();
    await disputedRow.getByRole('link').first().click();
    await page.waitForURL(/\/explorer\/object\/\?type=/);
    const view = page.getByRole('main');
    await view.getByRole('heading', { level: 2, name: 'Properties' }).waitFor();
    await view.getByText(/Read .* from 2 systems/).waitFor();
    const properties = page.getByRole('region', { name: 'Properties' }).getByRole('table');
    assert.ok(await properties.getByText('Systems disagree').count() >= 1, 'the disagreement is stated');
    const readings = properties.getByRole('listitem');
    assert.ok(await readings.count() >= 2, 'each system\'s own value is shown');
    assert.ok(await readings.filter({ hasText: /in crm|in erp|in suppliers|in vendors/i }).count() >= 1, 'with the system it came from');
    await view.getByRole('heading', { level: 2, name: 'Links' }).waitFor();
    await shot(page, 'object-view');
    assert.deepEqual(problems, []);
  });

  test('its sections read separately: Actions, the timeline from Capture, findings, scenarios; one that cannot be read says why', async () => {
    const view = page.getByRole('main');
    for (const name of ['Actions', 'Timeline', 'Findings', 'Scenarios']) await view.getByRole('heading', { level: 2, name }).waitFor();
    await page.getByRole('region', { name: 'Timeline' }).getByText(/History is not kept for this type|No changes observed/).waitFor();
    // simulation does not run in this cell: its section says why in place, and the others still stand.
    await page.getByRole('region', { name: 'Scenarios' }).getByRole('alert').waitFor();
    await page.getByRole('region', { name: 'Actions' }).getByText(/No Actions you may take on this object|Propose|Not available/).first().waitFor();
    assert.deepEqual(problems, []);
  });

  test('an address that names no object says so', async () => {
    await page.goto(`${origin}/explorer/object/?type=not-a-type`);
    await page.getByText('This address does not name an object', { exact: true }).waitFor();
    assert.deepEqual(problems, []);
  });
});
