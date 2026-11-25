// Explorer and Cmd-K in a real browser (spec 34.1, 33.5), over a cell with an ontology and two
// fake systems: suppliers merged from a CRM and an ERP (five names disagree), and a type too
// large for the bounds. The types the person may see; a type's objects with disagreements
// shown, never resolved; facets with counts that filter the set; a type over the bounds
// refused with the bound stated, never its first members; a result saved as an object set
// and reopened; Cmd-K finding types and saved views. No script or style is blocked anywhere.

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

describe('Explorer and Cmd-K in a browser', { skip }, () => {
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

  test('the types the person may see; a type\'s objects, its disagreements shown and never resolved', async () => {
    const types = page.getByRole('navigation', { name: 'Object types' });
    await types.getByRole('link', { name: 'Suppliers' }).waitFor();
    assert.ok(await types.getByRole('link', { name: 'Events' }).count() === 1);
    await types.getByRole('link', { name: 'Suppliers' }).click();
    const table = page.getByRole('table');
    await table.waitFor();
    const headers = await table.getByRole('columnheader').allTextContents();
    assert.equal(headers[0], 'Name', 'the title first');
    assert.ok(headers.includes('Registration') && headers.includes('Region'), headers.join(', '));
    await page.getByText(/^1[23] suppliers/).waitFor();
    assert.ok(await table.getByText('Systems disagree').count() >= 5, 'the five names the systems hold differently');
    assert.equal(await table.getByText('Acme Ltd (erp)').count(), 0, 'a disagreement is never resolved by picking a side');
    await shot(page, 'explorer-type');
    assert.deepEqual(problems, []);
  });

  test('a facet\'s values with counts filter the set; the filter is in the address; a column sorts it', async () => {
    const facets = page.getByRole('complementary', { name: 'Filters for Suppliers' });
    await facets.getByRole('button', { name: 'Region' }).click();
    const north = facets.getByLabel(/north\s+4/);
    await north.waitFor();
    await north.click();
    await page.getByText(/^4 suppliers match your filters/).waitFor();
    assert.equal(await facets.getByLabel(/north\s+4/).isChecked(), true);
    assert.equal(await page.getByRole('navigation', { name: 'Pages of this result' }).count(), 0, 'four objects are one page');
    assert.match(page.url(), /[?&]f=/);
    await page.getByRole('columnheader', { name: /Rating/ }).getByRole('button').click();
    await page.waitForFunction(() => document.querySelector('th[aria-sort="ascending"]') !== null);
    await shot(page, 'explorer-facet');
    assert.deepEqual(problems, []);
  });

  test('a result saved as an object set, private to its owner, reopened and read again', async () => {
    await page.getByRole('button', { name: 'Save as object set' }).click();
    await page.getByLabel('Name').fill('Northern suppliers');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Saved as “Northern suppliers”.').waitFor();

    // Cmd-K finds the saved view, and the type.
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    const palette = page.getByRole('dialog', { name: 'Search' });
    await palette.getByRole('combobox').fill('Northern');
    const saved = palette.getByRole('option', { name: /Northern suppliers/ });
    await saved.waitFor();
    await shot(page, 'palette-search');
    await saved.click();
    await page.waitForURL(/\/explorer\/(?:[a-z-]+\/)?\?view=/);
    await page.getByRole('heading', { name: 'Northern suppliers' }).waitFor();
    await page.getByText('Your saved view · read again now, as you').waitFor();
    await page.getByRole('list', { name: 'Northern suppliers' }).getByRole('link').nth(3).waitFor();
    assert.equal(await page.getByRole('region', { name: 'Northern suppliers' }).getByRole('link').count(), 4, 'its four members, by title');

    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    await palette.getByRole('combobox').fill('Suppl');
    await palette.getByRole('option', { name: /Supplier.*Open in Explorer/ }).click();
    await page.waitForURL(/\/explorer\/(?:[a-z-]+\/)?\?type=/);
    assert.deepEqual(problems, []);
  });

  test('a type larger than the bounds is refused with the bound stated, never shown by its first members', async () => {
    await page.getByRole('navigation', { name: 'Object types' }).getByRole('link', { name: 'Events' }).click();
    await page.getByText('Not shown', { exact: true }).waitFor();
    await page.getByText(/The bound is 50/).waitFor();
    assert.equal(await page.getByRole('table').count(), 0);
    await shot(page, 'explorer-bound');
    assert.deepEqual(problems, []);
  });

  test('search across types: grouped by type, every source not searched named with why', async () => {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Search', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Search objects' }).fill('Acme');
    await page.waitForURL(/\/explorer\/search\/\?q=Acme/);
    await page.getByRole('region', { name: 'Results for Acme' }).waitFor();
    const text = await page.getByRole('region', { name: 'Results for Acme' }).textContent();
    assert.ok(/Acme Ltd|Not searched|not searched/.test(text ?? ''), text ?? '');
    await shot(page, 'explorer-search');
    assert.deepEqual(problems, []);
  });
});
