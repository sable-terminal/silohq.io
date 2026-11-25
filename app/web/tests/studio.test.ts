// Studio in a real browser (spec 35; W9), on the recognition cell (suppliers in a CRM and an
// ERP). An admin makes an app from a blank page: an object set of suppliers filtered by a region
// parameter, a selection, a table that picks into it, a metric and a property list shown only once
// something is picked. Saved, it validates. Previewed, it runs under their own access: choosing a
// region narrows the table and the count from the same whole answer; picking a row shows its
// rating; the property list appears only then, as Studio evaluates its rule. A Clone Canvas widget
// draws the same set with the canvas's own layouts, saying it is the app's run and not live.
// Published, it is branched (D229): a widget added on the branch, compared with main, merged into
// main's next draft. Another member's version is approved in stages and rolled back (D230). No
// It is exported as a package into Files and imported back as a new app, every element found by
// name (D231). A workbook is made beside the apps: a heading typed, a live range of suppliers inserted,
// a formula over it computed as the server computes it, exported into Files (D232). No script or
// style is blocked anywhere. A report then quotes the workbook's figures beside a table of suppliers
// and is exported as a PDF (D233). The suppliers are mined as a process (D234) and grouped by region in a
// pipeline's preview (D235). An AI agent is made with a brief and a type, a brief holding an email
// refused, and talked to in Ask, where its brief is shown and goes with the question (D236). A
// notebook reads suppliers, groups them by region, summarises and draws them (D239). A model to
// predict their region is made and trained, and says why twelve objects are too few (D240). A chart
// in the app, previewed, is continued as an analysis: the set as the chosen region keeps it, then
// how many by region (37.8).

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { Browser, Page } from 'playwright-core';
import { service as canvasLayoutService } from '../../server/src/routes/canvas-layout/index.route.ts';
import { approveVersion, getApp, getAppVersion, returnVersion, saveDraft, shareApp, submitForReview } from '../../server/src/contracts/studio/app.contract.ts';
import { downloadFile } from '../../server/src/contracts/files/file.contract.ts';
import { saveObjectSet } from '../../server/src/contracts/ontology/objectSet.contract.ts';
import { readWorkbookRanges } from '../../server/src/contracts/workspace/workbook.contract.ts';
import { createFilesService } from '../../server/src/routes/files/index.route.ts';
import { createMemoryStore } from '../../server/tests/services/memoryStore.helper.ts';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { service as compileService } from '../../server/src/routes/compile/index.route.ts';
import { createGatewayService } from '../../server/src/routes/gateway/index.route.ts';
import { createSiloesCaptureService } from '../../server/src/routes/siloes-capture/index.route.ts';
import { service as studioService } from '../../server/src/routes/studio/index.route.ts';
import { createWorkspaceService } from '../../server/src/routes/workspace/index.route.ts';
import { createAskService } from '../../server/src/routes/ask/index.route.ts';
import { unavailableEngine, type CompileOutcome, type CompileRequest, type QueryEngine } from '../../server/src/services/workspace/queryEngine.service.ts';
import { createAnalysis, runAnalysis } from '../../server/src/contracts/workspace/analysis.contract.ts';
import { createThread } from '../../server/src/contracts/ask/thread.contract.ts';
import { LOCAL } from '../../server/tests/infra/services.helper.ts';
import { startRecognitionCell, type RecognitionCell } from '../../server/tests/services/recognition.helper.ts';
import { buildExport, gatewayAt, launch, open, shot, signIn, skip } from './browser.helper.ts';

let r: RecognitionCell;
let browser: Browser;
let origin: string;
let page: Page;
const problems: string[] = [];
// Ask's questions, as compile would be sent them: refused here, since no model runs in this cell.
const asked: CompileRequest[] = [];
// A harder question's answer in steps (37.8), as compile would return it once a test has made the chain.
let chainAnswer: Extract<CompileOutcome, { outcome: 'plan' }> | undefined;
const engine: QueryEngine = {
  ...unavailableEngine,
  async compile(request) {
    asked.push(request);
    if (request.advanced && chainAnswer !== undefined) return chainAnswer;
    return { outcome: 'refusal', reason: 'no_plan', narrowing: 'name the suppliers you mean' };
  },
};

describe('Studio in a browser (spec 35)', { skip }, () => {
  before(async () => {
    await buildExport();
    const gateway = await gatewayAt();
    origin = gateway.origin;
    r = await startRecognitionCell([
      // The vocabulary the editor and widgets name things by.
      { definition: compileService, name: 'compile' },
      // Files, where an app package is exported (D231).
      { definition: createFilesService({ store: createMemoryStore() }), name: 'files', env: { OBJECT_STORE: 's3', OBJECT_BUCKET_FILES: 'silo-test-files', S3_ENDPOINT: 'http://127.0.0.1:1', S3_REGION: 'eu-west-2', S3_FORCE_PATH_STYLE: 'true' } },
      { definition: studioService, name: 'studio', env: { REDIS_STATE_URL: `${LOCAL.redisUrl}/2` } },
      { definition: createSiloesCaptureService({ schedule: false }), name: 'siloes-capture', env: { SILOES_POSTGRES_PRICE_PER_GIB_MONTH: '0.20', SILOES_STORAGE_PRICE_PER_GIB_MONTH: '0.02' } },
      { definition: createWorkspaceService(), name: 'workspace' },
      // The Clone Canvas widget's layouts and states.
      { definition: canvasLayoutService, name: 'canvas-layout', env: { REDIS_STATE_URL: `${LOCAL.redisUrl}/2` } },
      // Ask, for a thread with an AI agent (D236).
      { definition: createAskService({ engine }), name: 'ask' },
      { definition: createGatewayService(), name: 'gateway', env: gateway.env },
    ]);
    browser = await launch();
    page = await open(browser, problems);
    await page.goto(`${origin}/studio/apps/`);
    await page.waitForURL(/\/sign-in\//);
    await signIn(page, 'root@acme.example');
    await page.waitForURL(`${origin}/studio/apps/`);
  });

  beforeEach(() => {
    problems.length = 0;
  });

  after(async () => {
    await browser?.close();
    await r?.close();
  });

  /** A section of the page, found by its heading. */
  const section = (title: string) => page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).first();
  const toast = (text: string | RegExp) => page.getByRole('status').filter({ hasText: text }).first();
  const menu = async (trigger: string, item: string) => {
    await page.getByRole('button', { name: trigger, exact: true }).click();
    await page.getByRole('menuitem', { name: item }).click();
  };
  const newThing = async (button: string, name: string, make: string) => {
    // An empty directory offers the same action again in its empty state.
    await page.getByRole('button', { name: button }).first().click();
    const dialog = page.getByRole('dialog', { name: button });
    await dialog.getByLabel('Name', { exact: true }).fill(name);
    await dialog.getByRole('button', { name: make }).click();
  };

  test('an app made in the editor from a blank page: variables, widgets on the grid; saved, it validates', async () => {
    await page.goto(`${origin}/studio/apps/`);
    await newThing('New app', 'Supplier desk', 'Create the app');
    await page.waitForURL(/\/studio\/apps\/\?edit=/);

    const variables = section('Variables');
    const addVariable = async (name: string, kind: string) => {
      await variables.getByLabel('New variable').fill(name);
      await variables.getByLabel('Kind').selectOption({ label: kind });
      await variables.getByRole('button', { name: 'Add', exact: true }).click();
    };
    await addVariable('suppliers', 'Object set');
    await addVariable('picked', 'Selection');
    await addVariable('region', 'Parameter');
    const item = (name: string) => variables.getByRole('group', { name: `Variable ${name}` });
    await item('suppliers').getByLabel('Of').selectOption({ label: 'Suppliers' });
    await item('picked').getByLabel('Of').selectOption({ label: 'Suppliers' });
    await item('region').getByLabel('Type').selectOption('enumeration');
    await item('region').getByLabel('Choices').fill('north, south, east, west');
    await item('suppliers').getByLabel(/^Filter/).fill('region == null || object.region == region');
    await item('suppliers').getByText(/Reads: Region\./).waitFor();

    const pages = section('Pages');
    const addWidget = async (label: string) => {
      await pages.getByLabel('Widget', { exact: true }).selectOption({ label });
      await pages.getByRole('button', { name: 'Add the widget' }).click();
    };
    const widget = (kind: string) => pages.getByRole('group', { name: new RegExp(`^${kind} `) });
    await addWidget('Object table');
    const table = widget('Object table');
    await table.getByLabel('Shows').selectOption('suppliers');
    await table.getByLabel('Region', { exact: true }).check();
    await table.getByLabel('Rating', { exact: true }).check();
    await table.getByLabel('Selecting a row picks it into').selectOption('picked');
    await addWidget('Metric');
    await widget('Metric').getByLabel('Shows').selectOption('suppliers');
    await addWidget('Property list');
    const detail = widget('Property list');
    await detail.getByLabel('Shows the object picked into').selectOption('picked');
    await detail.getByLabel('Rating', { exact: true }).check();
    await detail.getByLabel('Shown when (optional)').fill('size(picked) > 0');

    await addWidget('Clone Canvas');
    const embed = widget('Clone Canvas');
    await embed.getByLabel('Shows').selectOption('suppliers');
    await embed.getByLabel('Layout').selectOption({ label: 'Graph' });
    await embed.getByLabel('Selecting a clone picks it into').selectOption('picked');
    // A chart of the same set: how many by region, continued as an analysis in the preview (37.8).
    await addWidget('Chart');
    const chart = widget('Chart');
    await chart.getByLabel('Shows').selectOption('suppliers');
    await chart.getByLabel('By').selectOption({ label: 'Region' });
    // Filter controls over it: a search box, which an analysis cannot keep, and says so.
    await addWidget('Filter controls');
    await widget('Filter controls').getByLabel('Narrows').selectOption('suppliers');

    await page.getByRole('button', { name: 'Save the draft' }).click();
    await toast('Saved. It validates.').waitFor();
    await shot(page, 'studio-editor');
    assert.deepEqual(problems, []);
  });

  test('previewed, it runs under the viewer\'s access: a region narrows table and count from one whole answer; a pick shows its rating', async () => {
    await page.getByRole('link', { name: 'Preview draft 1' }).click();
    await page.waitForURL(/\/studio\/apps\/\?app=.*&version=1/);
    await page.getByRole('heading', { name: 'Supplier desk', exact: true }).waitFor();
    await page.getByText('Preview of draft 1').waitFor();
    const table = page.getByRole('table').filter({ hasText: 'Rating' });
    await table.getByRole('caption').filter({ hasText: /^1[2-9] objects|^[2-9]\d objects/ }).waitFor();
    const metric = page.getByRole('region', { name: 'metric 1' }).getByRole('figure');
    assert.ok(Number((await metric.getByRole('paragraph').innerText()).replaceAll(',', '')) >= 12, 'the count is the whole set');
    assert.equal(await page.getByText('Choose an object to see its properties.').count(), 0, 'the property list is hidden until something is picked');

    await page.getByLabel('Region', { exact: true }).selectOption('north');
    await table.getByRole('caption').filter({ hasText: /^4 objects/ }).waitFor();
    await metric.getByText('4', { exact: true }).waitFor();
    assert.equal(await table.getByRole('row').filter({ hasText: 'north' }).count(), 4);

    await table.getByRole('row').filter({ hasText: 'north' }).first().getByRole('button').click();
    const ratingShown = page.getByRole('region').filter({ has: page.getByRole('term').filter({ hasText: 'Rating' }) });
    await ratingShown.getByRole('definition').waitFor();
    assert.match(await ratingShown.getByRole('definition').innerText(), /^\d+$/);
    // The Clone Canvas widget: the canvas's own drawing over the app's run, which says it is not live.
    await page.getByRole('img', { name: /^Canvas of \d+ clones/ }).locator('canvas').waitFor();
    await page.getByText(/as read for you just now, not live/).waitFor();
    await shot(page, 'studio-runtime');

    // The chart continued as an analysis (37.8): the set as the chosen region keeps it, then how many by region.
    const preview = page.url();
    const chart = page.getByRole('region', { name: /^chart \d+$/ });
    await chart.getByRole('rowheader', { name: 'north' }).waitFor();
    await chart.getByRole('button', { name: 'Analyse', exact: true }).click();
    await page.waitForURL(/\/explorer\/analyses\/\?manifest=.+&analysis=/);
    const steps = page.getByRole('list', { name: 'Steps' });
    await steps.getByRole('listitem', { name: 'Step 1' }).getByText(/whose region is north$/).waitFor();
    await steps.getByRole('listitem', { name: 'Step 1' }).getByText(/^4 suppliers match\.$/).waitFor();
    await steps.getByRole('listitem', { name: 'Step 2' }).getByText(/by region: highest north \(4\); 1 group in all\./).waitFor();
    await page.goto(preview);
    await page.getByText('Preview of draft 1').waitFor();

    // Searched in the app's filter controls: the analysis says first that the search is not kept, then opens.
    await page.getByLabel('Region', { exact: true }).selectOption('north');
    // The search reads the values the chart has, its regions.
    await page.getByRole('form', { name: 'Filters' }).getByLabel('Search').fill('nor');
    await chart.getByRole('cell', { name: '4', exact: true }).last().waitFor();
    await chart.getByRole('button', { name: 'Analyse', exact: true }).click();
    const ready = chart.getByRole('status').filter({ hasText: 'The analysis is ready, with these differences' });
    await ready.getByText(/^The search in the app's filter controls is not kept/).waitFor();
    await ready.getByRole('link', { name: 'Open the analysis' }).click();
    await page.waitForURL(/\/explorer\/analyses\/\?manifest=.+&analysis=/);
    await steps.getByRole('listitem', { name: 'Step 1' }).getByText(/^4 suppliers match\.$/).waitFor();
    await page.goto(preview);
    await page.getByText('Preview of draft 1').waitFor();
    assert.deepEqual(problems, []);
  });

  test('branched (D229): published, a branch opened, a widget added on it, compared with main, merged into main\'s next draft', async () => {
    const appId = new URL(page.url()).searchParams.get('app')!;
    await page.goto(`${origin}/studio/apps/?edit=${appId}`);
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await toast('Submitted for review').waitFor();
    // Another holder of app.publish approves: an author never reviews their own version.
    const review = (await r.gateway.call(getApp, { params: { appId } }, r.cell.as(r.root))).versions.find((v) => v.state === 'review')!;
    await r.gateway.call(approveVersion, { params: { appId, version: review.version }, body: { lockVersion: review.lockVersion } }, r.cell.as(r.editor));
    await page.reload();
    await page.getByText(`Version ${review.version} published`).waitFor();

    await page.getByRole('tab', { name: 'Branches' }).click();
    await page.getByRole('button', { name: 'New branch' }).click();
    const opening = page.getByRole('dialog', { name: 'New branch' });
    await opening.getByLabel('Name', { exact: true }).fill('ratings');
    await opening.getByRole('button', { name: 'Open the branch' }).click();
    await page.getByText('On a branch').waitFor();
    const pages = section('Pages');
    await pages.getByLabel('Widget', { exact: true }).selectOption({ label: 'Text' });
    await pages.getByRole('button', { name: 'Add the widget' }).click();
    await page.getByRole('button', { name: 'Save the draft' }).click();
    await toast(/^Saved/).waitFor();

    await page.getByRole('tab', { name: 'Branches' }).click();
    await menu('ratings actions', 'Compare with main');
    const changes = page.getByRole('dialog', { name: 'ratings against main' });
    await changes.getByRole('listitem').first().waitFor();
    assert.equal(await changes.getByRole('listitem').count(), 1);
    assert.match(await changes.getByRole('listitem').innerText(), /^pages\.[a-z0-9-]+\.widgets\.[\w-]+\s+added$/);
    await shot(page, 'studio-branch');
    await page.keyboard.press('Escape');

    await menu('ratings actions', 'Merge into main');
    await toast(/^Merged: main's draft \d+ holds it$/).waitFor();
    await page.getByText(/^Merged as version \d+$/).waitFor();
    await page.getByRole('tab', { name: 'Versions' }).click();
    await page.getByRole('table', { name: 'Versions' }).getByRole('row').filter({ hasText: /Draft/ }).first().waitFor();
    assert.deepEqual(problems, []);
  });

  test('released in stages (D230): another member\'s version approved for one scope first, shown rolling out, then rolled back', async () => {
    const appId = new URL(page.url()).searchParams.get('edit')!;
    await page.getByRole('tab', { name: 'Design' }).click();
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await toast('Submitted for review').waitFor();
    // The editor returns the merged draft and writes their own version, so the owner may review it.
    await r.gateway.call(shareApp, { params: { appId }, body: { grantee: { kind: 'membership', membershipId: r.editor.membershipId }, access: 'edit' } }, r.cell.as(r.root));
    const inReview = (await r.gateway.call(getApp, { params: { appId } }, r.cell.as(r.root))).versions.find((v) => v.state === 'review')!;
    await r.gateway.call(returnVersion, { params: { appId, version: inReview.version }, body: { lockVersion: inReview.lockVersion } }, r.cell.as(r.editor));
    const definition = (await r.gateway.call(getAppVersion, { params: { appId, version: inReview.version } }, r.cell.as(r.editor))).definition;
    const theirs = await r.gateway.call(saveDraft, { params: { appId }, body: { definition } }, r.cell.as(r.editor));
    await r.gateway.call(submitForReview, { params: { appId, version: theirs.version }, body: { lockVersion: theirs.lockVersion } }, r.cell.as(r.editor));

    await page.reload();
    await page.getByRole('tab', { name: 'Versions' }).click();
    await menu(`Version ${theirs.version} actions`, 'Approve in stages');
    const stages = page.getByRole('dialog', { name: 'Approve in stages' });
    await stages.getByRole('group', { name: 'Stage 1' }).getByLabel('sales', { exact: true }).check();
    await stages.getByRole('button', { name: 'Add a stage' }).click();
    await stages.getByRole('group', { name: 'Stage 2' }).getByLabel('engineering', { exact: true }).check();
    await stages.getByRole('button', { name: 'Approve and release stage 1' }).click();
    await toast(`Version ${theirs.version} approved; stage 1 has it now`).waitFor();
    await page.getByRole('tab', { name: 'Release' }).click();
    const rollout = section('Rollout');
    await rollout.getByText(new RegExp(`^Version ${theirs.version} is rolling out`)).waitFor();
    await rollout.getByRole('listitem').filter({ hasText: /^sales: released/ }).waitFor();
    await rollout.getByRole('listitem').filter({ hasText: /^engineering: Waiting/ }).waitFor();
    await shot(page, 'studio-rollout');
    await rollout.getByRole('button', { name: 'Roll back' }).click();
    await rollout.getByText(new RegExp(`^Version ${theirs.version} was rolled back: everyone opens version \\d+\\.$`)).waitFor();
    assert.deepEqual(problems, []);
  });

  test('packaged (D231): exported into Files, imported back from the file as a new app with every element found', async () => {
    const appId = new URL(page.url()).searchParams.get('edit')!;
    await page.getByRole('button', { name: 'Export as a package' }).click();
    await toast('Saved to Files as Supplier desk.silo-app.json').waitFor();
    const { files } = await r.gateway.call((await import('../../server/src/contracts/files/file.contract.ts')).listFiles, { query: {} }, r.cell.as(r.root));
    const file = files.find((f) => f.name === 'Supplier desk.silo-app.json')!;
    assert.equal(file.provenance?.sourceKind, 'app_package');
    const bytes = Buffer.from((await r.gateway.call(downloadFile, { params: { fileId: file.id } }, r.cell.as(r.root))).content, 'base64');
    const local = path.join(await mkdtemp(path.join(tmpdir(), 'silo-package-')), 'supplier-desk.silo-app.json');
    await writeFile(local, bytes);

    await page.goto(`${origin}/studio/apps/`);
    await page.getByRole('button', { name: 'Import a package' }).click();
    const importer = page.getByRole('dialog', { name: 'Import a package' });
    await importer.getByLabel('Package file').setInputFiles(local);
    await importer.getByRole('button', { name: 'Import', exact: true }).click();
    await importer.getByText('Supplier desk is a new draft').waitFor();
    await importer.getByText(/^Every element it uses was found here \(\d+\)\.$/).waitFor();
    await importer.getByRole('button', { name: 'Open it in the editor' }).click();
    await page.waitForURL(/\/studio\/apps\/\?edit=/);
    assert.notEqual(new URL(page.url()).searchParams.get('edit'), appId);
    await page.getByRole('button', { name: 'Open a new draft' }).or(page.getByRole('button', { name: 'Save the draft' })).first().waitFor();
    assert.deepEqual(problems, []);
  });

  test('a workbook (D232): typed cells, a live range of suppliers read for its owner, a formula over it, exported into Files', async () => {
    const { randomUUID } = await import('node:crypto');
    await r.gateway.call(saveObjectSet, {
      body: { name: 'All suppliers', definition: { kind: 'filter', base: { objectTypeId: r.type('supplier').id }, predicate: { cel: 'true', properties: [] } } },
    }, { ...r.cell.as(r.root), idempotencyKey: randomUUID() });
    await page.goto(`${origin}/studio/workbooks/`);
    await newThing('New workbook', 'Supplier ratings', 'Make the workbook');
    await page.waitForURL(/\/studio\/workbooks\/\?workbook=/);
    const workbookId = new URL(page.url()).searchParams.get('workbook')!;
    const sheet = page.getByRole('grid', { name: 'Sheet Sheet1' });
    const cell = (col: number, row: number) => sheet.getByRole('row').nth(row).getByRole('gridcell').nth(col);

    // A heading in A1 and a formula in B1, typed as a person types into a sheet.
    await cell(0, 1).click();
    await page.keyboard.type('Total rating');
    await page.keyboard.press('Enter');
    await cell(1, 1).click();
    await page.keyboard.type('=SUM(B4:B103)');
    await page.keyboard.press('Enter');
    // A live range at A3: name and rating of every supplier.
    await cell(0, 3).click();
    await page.getByRole('button', { name: 'Live range at A3' }).click();
    const insert = page.getByRole('dialog', { name: 'A live range at A3' });
    await insert.getByLabel('Object set').selectOption({ label: 'All suppliers' });
    await insert.getByLabel('Name', { exact: true }).check();
    await insert.getByLabel('Rating', { exact: true }).check();
    await insert.getByRole('button', { name: 'Place it' }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await toast('Saved').waitFor();
    await expectCell(cell(0, 3), 'Name');
    await expectCell(cell(1, 3), 'Rating');
    const { ranges } = await r.gateway.call(readWorkbookRanges, { params: { workbookId } }, r.cell.as(r.root));
    const sum = ranges[0]!.rows.reduce((n, row) => n + Number(row[1] ?? 0), 0);
    assert.ok(ranges[0]!.rows.length >= 12, 'every supplier read for the owner');
    await expectCell(cell(1, 1), String(sum));
    await expectCell(cell(0, 1), 'Total rating');
    await shot(page, 'workbook');

    await menu('More', 'Export to Files');
    await toast('Saved to Files as Supplier ratings.xlsx').waitFor();
    assert.deepEqual(problems, []);
  });

  test('a report (D233): text, the workbook\'s figures and a table of suppliers, read for its owner, exported as a PDF', async () => {
    await page.goto(`${origin}/studio/reports/`);
    await newThing('New report', 'Supplier review', 'Make the report');
    await page.waitForURL(/\/studio\/reports\/\?report=/);
    const reportId = new URL(page.url()).searchParams.get('report')!;
    const add = page.getByRole('group', { name: 'Add a block' });
    await add.waitFor();
    const blocks = page.getByRole('region', { name: /^Block \d+$/ });
    const before = await blocks.count();
    const block = (n: number) => page.getByRole('region', { name: `Block ${before + n}` });
    await add.getByRole('button', { name: 'Text', exact: true }).click();
    await block(1).getByLabel('Text').fill('How suppliers rate this month.');
    await add.getByRole('button', { name: 'Workbook figures' }).click();
    const figures = block(2);
    await figures.getByLabel('Figures from').selectOption({ label: 'Supplier ratings' });
    await figures.getByLabel('Cells').fill('A1:B1');
    await figures.getByLabel('First row is the header').uncheck();
    await figures.getByLabel('Caption (optional)').fill('Totals');
    await add.getByRole('button', { name: 'Objects', exact: true }).click();
    const objects = block(3);
    await objects.getByLabel('Objects of').selectOption({ label: 'All suppliers' });
    await objects.getByLabel('Name', { exact: true }).check();
    await objects.getByLabel('Rating', { exact: true }).check();
    await objects.getByLabel('At most').fill('5');
    await objects.getByLabel('Caption (optional)').fill('Five suppliers');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await toast('Saved').waitFor();

    const { readReportBlocks } = await import('../../server/src/contracts/workspace/report.contract.ts');
    const { blocks: read } = await r.gateway.call(readReportBlocks, { params: { reportId } }, r.cell.as(r.root));
    const totals = read.find((b) => b.rows[0]?.[0] === 'Total rating')!;
    const table = page.getByRole('table', { name: 'Totals' });
    await table.getByRole('cell', { name: String(totals.rows[0]![1]) }).waitFor();
    const five = page.getByRole('table', { name: 'Five suppliers' });
    await five.getByRole('columnheader', { name: 'Rating' }).waitFor();
    assert.equal(await five.getByRole('row').count(), 6, 'a header and five suppliers');
    await shot(page, 'report');

    await menu('More', 'Export as PDF to Files');
    await toast('Saved to Files as Supplier review.pdf').waitFor();
    assert.deepEqual(problems, []);
  });

  test('a process analysis and a pipeline (D234, D235): suppliers mined into a map, then grouped by region in a pipeline preview', async () => {
    await page.goto(`${origin}/studio/processes/`);
    await page.getByRole('button', { name: 'New analysis' }).first().click();
    const made = page.getByRole('dialog', { name: 'New analysis' });
    await made.getByLabel('Name', { exact: true }).fill('Supplier flow');
    await made.getByLabel('Object set').selectOption({ label: 'All suppliers' });
    await made.getByLabel('Case', { exact: true }).selectOption({ label: 'Region' });
    await made.getByLabel('Activity', { exact: true }).selectOption({ label: 'Name' });
    await made.getByLabel('Time', { exact: true }).selectOption({ label: 'Rating' });
    await made.getByRole('button', { name: 'Make the analysis' }).click();
    await page.waitForURL(/\/studio\/processes\/\?process=/);
    await page.getByRole('img', { name: /^Process map: \d+ activities, \d+ steps$/ }).waitFor();
    await page.getByRole('status').filter({ hasText: /^\d+ cases, \d+ events/ }).waitFor();
    await page.getByRole('table', { name: 'Variants' }).waitFor();
    await shot(page, 'process');

    await page.goto(`${origin}/studio/pipelines/`);
    await page.getByRole('button', { name: 'New pipeline' }).first().click();
    const pipe = page.getByRole('dialog', { name: 'New pipeline' });
    await pipe.getByLabel('Name', { exact: true }).first().fill('Suppliers by region');
    await pipe.getByLabel('Object set').selectOption({ label: 'All suppliers' });
    await pipe.getByLabel('Region region').check();
    await pipe.getByLabel('Rating rating').check();
    await pipe.getByRole('button', { name: 'Make the pipeline' }).click();
    await page.waitForURL(/\/studio\/pipelines\/\?pipeline=/);
    const steps = section('Steps');
    await steps.getByLabel('Step', { exact: true }).selectOption({ label: 'Group and measure' });
    await steps.getByRole('button', { name: 'Add the step' }).click();
    const step = steps.getByRole('listitem', { name: 'Step 1: Group and measure' });
    await step.getByLabel('Group by').fill('region');
    await step.getByLabel('Measures').fill('suppliers = count(), average = avg(rating)');
    await page.getByRole('tab', { name: 'Preview' }).click();
    await page.getByRole('button', { name: 'Preview it' }).click();
    await page.getByRole('columnheader', { name: 'average' }).waitFor();
    assert.ok(await page.getByRole('table').last().getByRole('row').count() >= 3, 'a row per region');
    // Its schedule (D241) waits for it to be saved, and for an output to write into.
    await page.getByRole('tab', { name: 'Schedule' }).click();
    assert.equal(await page.getByRole('button', { name: 'Schedule it' }).getAttribute('aria-disabled'), 'true');
    await shot(page, 'pipeline');
    assert.deepEqual(problems, []);
  });

  test('a notebook (D239): suppliers read, grouped by region in a transform, summarised and drawn, saved and run', async () => {
    await page.goto(`${origin}/studio/notebooks/`);
    await newThing('New notebook', 'Supplier review', 'Make the notebook');
    await page.waitForURL(/\/studio\/notebooks\/\?notebook=/);
    const cell = (n: number) => page.getByRole('listitem', { name: new RegExp(`^Cell ${n}:`) });
    const add = async (kind: string) => {
      await page.getByLabel('Cell', { exact: true }).selectOption({ label: kind });
      await page.getByRole('button', { name: 'Add the cell' }).click();
    };
    await cell(1).getByLabel('Text').fill('How suppliers are rated across regions.');
    await add('Objects');
    await cell(2).getByLabel('Object set').selectOption({ label: 'All suppliers' });
    await cell(2).getByLabel('Region', { exact: true }).check();
    await cell(2).getByLabel('Rating', { exact: true }).check();
    await add('Transform');
    const first = cell(3).getByRole('listitem', { name: 'Step 1: Keep rows where' });
    await first.getByLabel('Condition').fill('rating > 0');
    await cell(3).getByLabel('Step', { exact: true }).selectOption({ label: 'Group and measure' });
    await cell(3).getByRole('button', { name: 'Add the step' }).click();
    const group = cell(3).getByRole('listitem', { name: 'Step 2: Group and measure' });
    await group.getByLabel('Group by').fill('region');
    await group.getByLabel('Measures').fill('suppliers = count(), average = avg(rating)');
    await add('Statistics');
    await cell(4).getByLabel('Of', { exact: true }).selectOption('objects_1');
    await add('Chart');
    await cell(5).getByLabel('Of', { exact: true }).selectOption('table_1');
    await cell(5).getByLabel('Category column').fill('region');
    await cell(5).getByLabel('Summed column (blank: count)').fill('suppliers');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await toast('Saved').waitFor();
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await cell(3).getByRole('columnheader', { name: 'average' }).waitFor();
    assert.ok(await cell(3).getByRole('row').count() >= 3, 'a row per region');
    await cell(4).getByRole('table', { name: 'Statistics' }).getByRole('rowheader', { name: 'rating' }).waitFor();
    await cell(5).getByRole('img', { name: /^Bars: \d+ categories$/ }).waitFor();
    await cell(4).scrollIntoViewIfNeeded();
    await shot(page, 'notebook');
    assert.deepEqual(problems, []);
  });

  test('a model (D240): made over suppliers to predict their region, trained, and its version saying why twelve objects are too few', async () => {
    await page.goto(`${origin}/studio/models/`);
    await page.getByRole('button', { name: 'New model' }).first().click();
    const made = page.getByRole('dialog', { name: 'New model' });
    await made.getByLabel('Name', { exact: true }).fill('Region from rating');
    await made.getByLabel('Learning from').selectOption({ label: 'All suppliers' });
    await made.getByLabel('The property it predicts').selectOption({ label: 'Region' });
    await made.getByLabel('Rating', { exact: true }).check();
    await made.getByRole('button', { name: 'Make the model' }).click();
    await page.waitForURL(/\/studio\/models\/\?model=/);
    await page.getByRole('button', { name: 'Train a version' }).click();
    await page.getByRole('table', { name: 'Versions' }).getByText(/Did not train: only 12 objects have a label you may see; at least 20 are needed/).waitFor();
    await shot(page, 'model');
    assert.deepEqual(problems, []);
  });

  test('an AI agent (D236): made with a brief and a type, a brief with an email refused, talked to in Ask with its brief shown and sent', async () => {
    await page.goto(`${origin}/studio/agents/`);
    await newThing('New AI agent', 'Supplier scout', 'Make the AI agent');
    await page.waitForURL(/\/studio\/agents\/\?agent=/);
    await page.getByLabel('Brief').fill('Escalate disputes to buyer@acme.example.');
    await page.getByText(/This looks like it holds a record value/).waitFor();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'looks like a record value' }).waitFor();
    const brief = 'Preferred suppliers are rated 4 or more.';
    await page.getByLabel('Brief').fill(brief);
    await page.getByRole('checkbox', { name: 'Suppliers' }).check();
    await page.getByRole('checkbox', { name: 'Find objects' }).uncheck();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await toast(/^Saved/).waitFor();
    await shot(page, 'ai-agent');

    await page.getByRole('button', { name: 'Talk to it' }).click();
    await page.waitForURL(/\/ask\/(?:[a-z-]+\/)?\?thread=/);
    const banner = page.getByRole('complementary', { name: 'AI agent' });
    await banner.getByText('Asking Supplier scout').waitFor();
    await banner.getByText('Its brief').click();
    await banner.getByText(brief).waitFor();
    await page.getByLabel('Your question').fill('Which suppliers are preferred?');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await page.getByText('Silo could not turn that into a question over your data.').first().waitFor();
    const sent = asked.at(-1)!;
    assert.deepEqual([sent.aiAgent?.name, sent.aiAgent?.brief, sent.aiAgent?.objectTypeIds.length, sent.aiAgent?.tools], ['Supplier scout', brief, 1, ['answer']]);
    await shot(page, 'ai-agent-ask');
    assert.deepEqual(problems, []);
  });

  test('a harder question answered in steps (37.8): the answer, what each step did, and the chain opened in Analysis', async () => {
    // The chain compile would make: every supplier, then how many by region.
    const made = await r.gateway.call(createAnalysis, { body: { steps: [
      { operation: 'filter', base: { objectTypeId: r.type('supplier').id } },
      { operation: 'group', input: 1, groupBy: [{ property: r.prop('supplier', 'region') }], measures: [{ fn: 'count', as: 'suppliers' }] },
    ] } }, r.cell.as(r.root));
    assert.equal(made.outcome, 'analysis');
    if (made.outcome !== 'analysis') return;
    const ran = await r.gateway.call(runAnalysis, { params: { manifestId: made.manifestId }, body: { analysisId: made.analysisId } }, r.cell.as(r.root));
    const last = ran.steps.at(-1)!;
    assert.equal(last.outcome, 'result');
    if (last.outcome !== 'result') return;
    chainAnswer = {
      outcome: 'plan', manifestId: made.manifestId, compileClass: 'advanced', tokensCharged: 3, rephraseUncharged: false, chain: made.steps,
      ran: { outcome: 'result', resultRef: last.results[0]!.queryId, ranAt: last.results[0]!.computedAt, reduced: false, incompleteSources: [] },
    };
    const thread = await r.gateway.call(createThread, { body: {} }, r.keyed(r.root));
    await page.goto(`${origin}/ask/threads/?thread=${thread.id}`);
    await page.getByLabel('Your question').fill('How many suppliers are in each region, step by step?');
    await page.getByLabel('A harder question').check();
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await page.getByText('Answered in 2 steps: filter, then group.').waitFor();
    // Several regions: drawn as a ranking, north's bar first.
    await page.getByRole('button', { name: /^north: 4$/ }).first().waitFor();
    await page.getByText('3 tokens', { exact: true }).waitFor();
    assert.equal(asked.at(-1)!.advanced, true, 'asked as a harder question');
    await page.getByRole('link', { name: 'Open in Analysis' }).click();
    await page.waitForURL(/\/explorer\/analyses\/\?manifest=.+&analysis=/);
    await page.getByRole('list', { name: 'Steps' }).getByRole('listitem', { name: 'Step 2' }).waitFor();
    chainAnswer = undefined;
    assert.deepEqual(problems, []);
  });

  test('object view layouts (34.6): a layout made for suppliers from the generated one, checked first; the type shows what it opens with', async () => {
    await page.goto(`${origin}/studio/layouts/`);
    await page.getByRole('heading', { name: 'In force' }).waitFor();
    await section('What a type opens with').getByLabel('Type').selectOption({ label: 'Supplier' });
    await page.getByText('Generated', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'New layout' }).first().click();
    const made = page.getByRole('dialog', { name: 'New layout' });
    await made.getByLabel('For').selectOption({ label: 'Supplier' });
    await made.getByRole('button', { name: 'Check it first' }).click();
    await made.getByText('It validates').waitFor();
    await made.getByRole('button', { name: 'Make the layout' }).click();
    await page.waitForURL(/\/studio\/layouts\/\?edit=/);
    await page.getByRole('heading', { name: 'Supplier layout' }).waitFor();
    await section('The layout').waitFor();
    assert.equal(await page.getByRole('tab', { name: 'Branches' }).count(), 0, 'a layout has no branches');
    assert.deepEqual(problems, []);
  });
});

async function expectCell(cell: import('playwright-core').Locator, text: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if ((await cell.innerText()).trim() === text) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal((await cell.innerText()).trim(), text);
}
