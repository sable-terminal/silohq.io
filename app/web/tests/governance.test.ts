// Governance in a real browser (spec 33.2, 43, 44, 46; W6), on the write-back cell: Contacts in a
// CRM that takes writes. One admin proposes a change; another finds it waiting, sees each field
// before and after, and approves exactly that diff; the change runs and is verified; its receipt
// opens and a revert is proposed as a change of its own. The audit log lists each use of a
// stored credential and walks the hash chain. No script or style is blocked anywhere.

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { Browser, Page } from 'playwright-core';
import { proposeActionType, publishActionTypeVersion } from '../../server/src/contracts/actions/actionType.contract.ts';
import { getMutation, proposeMutation } from '../../server/src/contracts/actions/mutation.contract.ts';
import { createActionsService } from '../../server/src/routes/actions/index.route.ts';
import { service as approvalsService } from '../../server/src/routes/approvals/index.route.ts';
import { createAuditService } from '../../server/src/routes/audit/index.route.ts';
import { createGatewayService } from '../../server/src/routes/gateway/index.route.ts';
import { service as revertService } from '../../server/src/routes/revert/index.route.ts';
import { createSiloesCaptureService } from '../../server/src/routes/siloes-capture/index.route.ts';
import { createWorkspaceService } from '../../server/src/routes/workspace/index.route.ts';
import { uuidv7 } from '../../server/tests/db/harness.helper.ts';
import { LOCAL } from '../../server/tests/infra/services.helper.ts';
import { createWritebackCell, freePort, type WritebackCell } from '../../server/tests/services/writeback.helper.ts';
import { buildExport, gatewayAt, launch, open, shot, signIn, skip } from './browser.helper.ts';

let wb: WritebackCell;
let browser: Browser;
let origin: string;
let page: Page;
let mutationId: string;
const problems: string[] = [];

describe('Governance in a browser (spec 33.2)', { skip }, () => {
  before(async () => {
    await buildExport();
    const gateway = await gatewayAt();
    origin = gateway.origin;
    wb = await createWritebackCell({
      start: async (cell) => {
        const [actionsPort, approvalsPort] = [await freePort(), await freePort()];
        await cell.start(createActionsService(), 'actions', 'test_app', { HTTP_PORT: String(actionsPort), SERVICE_URL_APPROVALS: `http://127.0.0.1:${approvalsPort}` });
        await cell.start(approvalsService, 'approvals', 'test_app', { HTTP_PORT: String(approvalsPort) });
        await cell.start(revertService, 'revert', 'test_app');
        await cell.start(createAuditService({ consumer: `governance-${uuidv7().slice(-8)}` }), 'audit', 'test_audit_service' as never,
          { DURABLE_BUS: 'jetstream', NATS_DURABLE_URL: LOCAL.natsUrl });
        // The shell's rail and preferences; the rail asks whether a Silo is enabled.
        await cell.start(createSiloesCaptureService({ schedule: false }), 'siloes-capture', 'test_app',
          { SILOES_POSTGRES_PRICE_PER_GIB_MONTH: '0.20', SILOES_STORAGE_PRICE_PER_GIB_MONTH: '0.02' });
        await cell.start(createWorkspaceService(), 'workspace', 'test_app');
        await cell.start(createGatewayService(), 'gateway', 'test_app', gateway.env);
      },
    });
    const approver = await wb.cell.member('approver@acme.example', 'Super admin');
    await wb.grant(approver.membershipId, wb.restConnection, 'read');
    await wb.enableWrites(wb.restConnection);
    const keyed = () => ({ ...wb.cell.as(wb.root), idempotencyKey: uuidv7() });
    const type = await wb.gateway.call(proposeActionType, { body: { apiName: 'set_score', displayName: 'Set score', owningScopeId: wb.cell.scopes['engineering']! } }, keyed());
    await wb.gateway.call(publishActionTypeVersion, {
      params: { actionTypeId: type.id },
      body: {
        ontologyVersionId: wb.ontologyVersionId, objectTypeId: wb.contactTypeId, properties: ['score'],
        parameters: [{ name: 'score', type: 'integer', required: true }], rules: [{ kind: 'set_property', property: 'score', value: { parameter: 'score' } }],
        permittedConnections: [wb.restConnection],
      },
    }, keyed());
    const proposed = await wb.gateway.call(proposeMutation, {
      body: { actionTypeId: type.id, parameters: { score: 77 }, objects: [{ connectionId: wb.restConnection, reference: 'c2' }] } as never,
    }, keyed());
    assert.equal(proposed.status, 'awaiting_approval');
    mutationId = proposed.id;

    browser = await launch();
    page = await open(browser, problems);
    await page.goto(`${origin}/governance/`);
    await page.waitForURL(/\/sign-in\//);
    await signIn(page, 'approver@acme.example');
    await page.waitForURL(`${origin}/governance/`);
  });

  beforeEach(() => {
    problems.length = 0;
  });

  after(async () => {
    await browser?.close();
    await wb?.close();
  });

  test('a change waits for this admin: each field before and after, and approving approves exactly what was read', async () => {
    await page.waitForURL(`${origin}/governance/approvals/`);
    const inbox = page.getByRole('table', { name: 'Approvals' });
    const waiting = inbox.getByRole('row').filter({ hasText: 'A change' });
    await waiting.waitFor();
    assert.match(await waiting.innerText(), /0 of 1/);
    await waiting.getByRole('link').first().click();
    const drawer = page.getByRole('dialog', { name: 'A change' });
    const diff = drawer.getByRole('table', { name: 'What it writes' });
    await diff.waitFor();
    const row = diff.getByRole('row').filter({ hasText: 'c2' });
    const cells = await row.getByRole('cell').allInnerTexts();
    assert.deepEqual(cells.slice(-3), ['score', '20', '77'], cells.join(' | '));
    await shot(page, 'governance-approval');
    await drawer.getByRole('button', { name: 'Approve what you read' }).click();
    await page.getByText(/^Approved/).first().waitFor();
    await drawer.getByRole('button', { name: 'Close' }).click();
    await page.getByText('Nothing waits for you').waitFor();
    for (let i = 0; i < 100; i++) {
      const m = await wb.gateway.call(getMutation, { params: { mutationId } }, wb.cell.as(wb.root));
      if (m.completedAt !== null) { assert.equal(m.status, 'completed'); break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(wb.contacts.get('c2')!.properties.score, 77, 'the CRM holds the approved value');
    assert.deepEqual(problems, []);
  });

  test('the change, verified, with its receipt; a revert is prepared as its own change', async () => {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Changes', exact: true }).click();
    await page.waitForURL(/\/governance\/changes\//);
    const done = page.getByRole('table', { name: 'Changes' }).getByRole('row').filter({ hasText: 'Done and verified' });
    await done.waitFor();
    await done.getByRole('link').first().click();
    const change = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: /1 record of/ }) });
    await change.getByText(/1 the same, 0 different, 0 failed/).waitFor();
    await change.getByRole('button', { name: 'Open its receipt' }).click();
    const receipt = page.getByRole('dialog', { name: 'Receipt' });
    await receipt.getByText('Document hash').waitFor();
    await receipt.getByRole('button', { name: 'Revert it' }).click();
    await page.getByRole('dialog', { name: 'Revert this change' }).getByRole('button', { name: 'Prepare the revert' }).click();
    await page.getByText(/^Revert prepared/).first().waitFor();
    await receipt.getByRole('link', { name: 'The revert\'s own change' }).waitFor();
    await shot(page, 'governance-revert');
    assert.deepEqual(problems, []);
  });

  test('the audit log: each use of a stored secret, never the secret; the hash chain walked and stated', async () => {
    await page.goto(`${origin}/governance/audit/?tab=secrets`);
    const unwraps = page.getByRole('table', { name: 'Secrets opened' });
    await unwraps.waitFor();
    assert.ok(await unwraps.getByRole('row').filter({ hasText: 'Connection credential' }).count() >= 1);
    await page.getByRole('tab', { name: 'Integrity' }).click();
    await page.getByText('Intact', { exact: true }).waitFor();
    assert.deepEqual(problems, []);
  });

  test('an old address lands on the section that holds it now', async () => {
    await page.goto(`${origin}/governance/?tab=crons`);
    await page.waitForURL(`${origin}/governance/crons/`);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Crons', exact: true }).waitFor();
    assert.equal(await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Crons', exact: true }).getAttribute('aria-current'), 'page');
    await page.goto(`${origin}/governance/?tab=not-a-tab`);
    await page.waitForURL(`${origin}/governance/approvals/`);
    assert.equal(await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Approvals', exact: true }).getAttribute('aria-current'), 'page');
    assert.deepEqual(problems, []);
  });
});
