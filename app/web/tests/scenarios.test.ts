// Scenarios in a real browser (spec 39; W10), on the recognition cell (suppliers, their orders,
// deliveries and notes). An admin proposes edges from the model's links and confirms one with a
// kind, a lead time and a reason; saves a failure scenario on named suppliers; runs it: the orders
// are reached through the confirmed edge, and where a path meets an edge nobody confirmed, the
// walk stops there and says so rather than routing around it. A branch opens with its label. No
// script or style is blocked anywhere.

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { Browser, Page } from 'playwright-core';
import { service as compileService } from '../../server/src/routes/compile/index.route.ts';
import { createGatewayService } from '../../server/src/routes/gateway/index.route.ts';
import { createSiloesCaptureService } from '../../server/src/routes/siloes-capture/index.route.ts';
import { service as simulationService } from '../../server/src/routes/simulation/index.route.ts';
import { createWorkspaceService } from '../../server/src/routes/workspace/index.route.ts';
import { startRecognitionCell, type RecognitionCell } from '../../server/tests/services/recognition.helper.ts';
import { buildExport, gatewayAt, launch, open, shot, signIn, skip } from './browser.helper.ts';

let r: RecognitionCell;
let browser: Browser;
let origin: string;
let page: Page;
const problems: string[] = [];

describe('Scenarios in a browser (spec 39)', { skip }, () => {
  before(async () => {
    await buildExport();
    const gateway = await gatewayAt();
    origin = gateway.origin;
    r = await startRecognitionCell([
      { definition: compileService, name: 'compile' },
      { definition: simulationService, name: 'simulation' },
      { definition: createSiloesCaptureService({ schedule: false }), name: 'siloes-capture', env: { SILOES_POSTGRES_PRICE_PER_GIB_MONTH: '0.20', SILOES_STORAGE_PRICE_PER_GIB_MONTH: '0.02' } },
      { definition: createWorkspaceService(), name: 'workspace' },
      { definition: createGatewayService(), name: 'gateway', env: gateway.env },
    ]);
    browser = await launch();
    page = await open(browser, problems);
    await page.goto(`${origin}/scenarios/?tab=graph`);
    await page.waitForURL(/\/sign-in\//);
    await signIn(page, 'root@acme.example');
    await page.waitForURL(`${origin}/scenarios/graph/`);
  });

  beforeEach(() => {
    problems.length = 0;
  });

  after(async () => {
    await browser?.close();
    await r?.close();
  });

  const toast = (text: string | RegExp) => page.getByRole('status').filter({ hasText: text }).first();

  test('edges proposed from the model are never live until a person confirms one with a kind, a lead time and a reason', async () => {
    await page.getByRole('button', { name: 'Propose edges from the model\'s links' }).click();
    await toast(/^3 edges proposed from the model's links/).waitFor();
    const edge = page.getByRole('list', { name: 'Edges' }).getByRole('listitem').filter({ hasText: /order depends on Supplier/ });
    const confirm = edge.getByRole('form', { name: 'Confirm the edge' });
    await confirm.getByLabel('Lead time', { exact: true }).fill('5');
    await confirm.getByLabel('Why', { exact: true }).fill('as we run it');
    await confirm.getByRole('button', { name: 'Confirm' }).click();
    await toast('Confirmed: it is now walked.').waitFor();
    await page.getByRole('tab', { name: 'Confirmed' }).click();
    await page.getByText('Graph version 1.').waitFor();
    await page.getByRole('list', { name: 'Edges' }).getByRole('listitem').filter({ hasText: /order depends on Supplier/ }).getByRole('button', { name: 'Revise' }).waitFor();
    assert.deepEqual(problems, []);
  });

  test('a failure scenario on named suppliers, run: orders reached through the confirmed edge; the walk stops at edges nobody confirmed', async () => {
    await page.goto(`${origin}/scenarios/?tab=new`);
    const dialog = page.getByRole('dialog', { name: 'New scenario' });
    await dialog.getByLabel('Name', { exact: true }).fill('Suppliers fail');
    await dialog.getByLabel('What fails').selectOption({ label: 'Suppliers' });
    const which = dialog.getByRole('group', { name: /^Which/ });
    await which.getByRole('checkbox').first().waitFor();
    for (const box of await which.getByRole('checkbox').all()) await box.check();
    await dialog.getByRole('button', { name: 'Save the scenario' }).click();
    await page.waitForURL(/\/scenarios\/list\/\?scenario=/);
    await page.getByRole('button', { name: 'Run it', exact: true }).click();
    const scenario = page.getByRole('article', { name: 'Suppliers fail' });
    const reached = scenario.getByRole('table', { name: 'Reached through hard edges only' });
    await reached.waitFor();
    assert.equal(await reached.getByRole('row').filter({ hasText: /^order/ }).count(), 4, 'every order of a failing supplier');
    const stopped = scenario.getByRole('table', { name: 'Where the walk stopped' });
    assert.ok(await stopped.getByRole('row').filter({ hasText: 'an edge on the path is not confirmed' }).count() >= 1, 'stopped and said so, never routed around');
    await scenario.getByRole('table', { name: 'Runs' }).getByRole('row').nth(1).waitFor();
    await shot(page, 'scenarios-run');
    assert.deepEqual(problems, []);
  });

  test('run again, the two runs compare; a branch opens with the label every overlay and export carries, nothing staged until an Action is', async () => {
    await page.getByRole('button', { name: 'Run it again' }).click();
    await toast(/^Reached \d+ objects?$/).waitFor();
    const runs = page.getByRole('table', { name: 'Runs' });
    await runs.getByRole('row').nth(2).waitFor();
    const options = await page.getByLabel('Compare', { exact: true }).locator('option').allInnerTexts();
    assert.equal(options.length, 3, 'a placeholder and both runs');
    await page.getByLabel('Compare', { exact: true }).selectOption({ index: 2 });
    await page.getByLabel('With', { exact: true }).selectOption({ index: 1 });
    await page.getByRole('status').filter({ hasText: /entered the affected set and \d+ left it, because the data moved/ }).waitFor();

    await page.getByRole('button', { name: 'Open a branch' }).click();
    const opening = page.getByRole('dialog', { name: 'Open a branch' });
    await opening.getByLabel('Name', { exact: true }).fill('Switch suppliers');
    await opening.getByRole('button', { name: 'Open the branch' }).click();
    await page.waitForURL(/\/scenarios\/branches\/\?branch=/);
    await page.getByRole('heading', { name: 'Switch suppliers' }).waitFor();
    await page.getByText(/^0 clean, 0 conflicted/).waitFor();
    await page.getByText(/Nothing staged yet/).waitFor();
    await page.getByRole('button', { name: 'Stage an Action' }).waitFor();
    await shot(page, 'scenarios-branch');
    assert.deepEqual(problems, []);
  });
});
