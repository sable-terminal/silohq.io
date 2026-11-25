// Ontology in a real browser (spec 21, 25, 33.3; U9), on the recognition cell: suppliers held in
// a CRM and an ERP. The model shows a type's systems, each property's mapping per system and its
// match key, and its links. An editor proposes a change on a branch; an admin who is not its
// author reviews its diff and impact, approves and merges it, and main has a new version. An
// element is deprecated with a replacement date at least thirty days ahead. No script or style is
// blocked anywhere.

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { Browser, Page } from 'playwright-core';
import { putSharedProperty } from '../../server/src/contracts/ontology/element.contract.ts';
import { openBranch, submitProposal } from '../../server/src/contracts/ontology/proposal.contract.ts';
import { createGatewayService } from '../../server/src/routes/gateway/index.route.ts';
import { createSiloesCaptureService } from '../../server/src/routes/siloes-capture/index.route.ts';
import { createWorkspaceService } from '../../server/src/routes/workspace/index.route.ts';
import { startRecognitionCell, type RecognitionCell } from '../../server/tests/services/recognition.helper.ts';
import { buildExport, gatewayAt, launch, open, shot, signIn, skip } from './browser.helper.ts';

let r: RecognitionCell;
let browser: Browser;
let origin: string;
let page: Page;
const problems: string[] = [];

describe('Ontology in a browser (spec 33.3)', { skip }, () => {
  before(async () => {
    await buildExport();
    const gateway = await gatewayAt();
    origin = gateway.origin;
    r = await startRecognitionCell([
      { definition: createSiloesCaptureService({ schedule: false }), name: 'siloes-capture', env: { SILOES_POSTGRES_PRICE_PER_GIB_MONTH: '0.20', SILOES_STORAGE_PRICE_PER_GIB_MONTH: '0.02' } },
      { definition: createWorkspaceService(), name: 'workspace' },
      { definition: createGatewayService(), name: 'gateway', env: gateway.env },
    ]);
    // The editor proposes an additive change on a branch of their own.
    const branch = await r.gateway.call(openBranch, { body: { name: 'regions' } }, r.keyed(r.editor));
    await r.gateway.call(putSharedProperty, { params: { branchId: branch.id, apiName: 'sales_region' }, body: { displayName: 'Sales region', dataType: 'string', typeParams: {} } }, r.keyed(r.editor));
    await r.gateway.call(submitProposal, { params: { branchId: branch.id }, body: { title: 'Add a sales region', description: 'One region property every type can share.' } }, r.keyed(r.editor));

    browser = await launch();
    page = await open(browser, problems);
    await page.goto(`${origin}/ontology/model/`);
    await page.waitForURL(/\/sign-in\//);
    await signIn(page, 'root@acme.example');
    await page.waitForURL(`${origin}/ontology/model/`);
  });

  beforeEach(() => {
    problems.length = 0;
  });

  after(async () => {
    await browser?.close();
    await r?.close();
  });

  test('a type held in two systems: each property\'s mapping per system, its match key, its links', async () => {
    await page.getByRole('navigation', { name: 'Elements' }).getByRole('link', { name: 'Supplier', exact: true }).click();
    await page.getByRole('heading', { level: 2, name: /^Supplier/ }).waitFor();
    await page.getByText(/Across systems, matched on Registration/).waitFor();
    const properties = page.getByRole('table', { name: 'Properties of Supplier' });
    const name = properties.getByRole('row').filter({ hasText: /^Name/ });
    assert.match(await name.innerText(), /suppliers\.name/);
    assert.match(await name.innerText(), /vendors\.vendor_name/);
    assert.match(await properties.getByRole('row').filter({ hasText: 'Registration' }).innerText(), /match key/i);
    await page.getByText(/supplier_orders → order/i).waitFor();
    await shot(page, 'ontology-model');
    assert.deepEqual(problems, []);
  });

  test('a proposal reviewed by an admin who is not its author: its changes and impact; approved and merged into a new main version', async () => {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Proposals', exact: true }).click();
    await page.getByRole('table', { name: 'Proposals' }).getByRole('link', { name: 'Add a sales region' }).click();
    await page.getByRole('heading', { level: 1, name: 'Add a sales region' }).waitFor();
    const changes = page.getByRole('table', { name: 'Changes' });
    await changes.waitFor();
    assert.match(await changes.getByRole('row').filter({ hasText: 'sales_region' }).innerText(), /New[\s\S]*Adds only/);
    await page.getByRole('heading', { level: 2, name: 'Impact' }).waitFor();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('button', { name: 'Merge into main' }).click();
    await page.getByText(/^Merged: main is now version \d+/).waitFor();
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Versions', exact: true }).click();
    await page.getByRole('table', { name: 'Versions' }).getByRole('row').filter({ hasText: 'Current' }).filter({ hasText: 'A merged proposal' }).waitFor();
    assert.deepEqual(problems, []);
  });

  test('the shared property is in the model, and is deprecated no earlier than thirty days ahead', async () => {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Types and links', exact: true }).click();
    await page.getByRole('navigation', { name: 'Elements' }).getByRole('link', { name: 'Sales region' }).click();
    await page.getByRole('button', { name: 'Deprecate', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Deprecate Sales region' });
    const date = dialog.getByLabel('Retire no earlier than');
    const min = await date.getAttribute('min');
    assert.ok(min !== null && Date.parse(min) - Date.now() > 29 * 86_400_000, 'the earliest retirement is thirty days ahead');
    await dialog.getByRole('button', { name: 'Deprecate', exact: true }).click();
    await page.getByRole('navigation', { name: 'Elements' }).getByText('Deprecated').waitFor();
    assert.deepEqual(problems, []);
  });
});
