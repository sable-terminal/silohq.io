// Concept templates through Fleet (spec 22.7; D210): Silo staff author a template in the global
// tier and a second person reviews it (template_reviewed in Fleet's own log); Fleet signs the
// set of reviewed and withdrawn templates; a cell's Fleet agent carries the set to its catalogue,
// which verifies Silo's signature before writing a row and tells every organisation; a draft
// never leaves the global tier; a withdrawal follows; a set signed by another key, or changed
// after signing, writes nothing.

import assert from 'node:assert/strict';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { loadConfig } from '../../src/config/index.config.ts';
import { installConceptTemplates } from '../../src/contracts/catalogue/catalogue.contract.ts';
import type { AnyContract } from '../../src/contracts/endpoint.contract.ts';
import { createLogger } from '../../src/infra/logger.infra.ts';
import { openDatabases, type Databases } from '../../src/infra/postgres.infra.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { service as catalogueService } from '../../src/routes/catalogue/index.route.ts';
import { createCellReports } from '../../src/services/fleet-control/cellReports.service.ts';
import { createSignalStore } from '../../src/services/fleet-control/cellSignals.service.ts';
import { openFleetControl } from '../../src/services/fleet-control/control.service.ts';
import type { Fleet } from '../../src/services/fleet-control/fleet.service.ts';
import { createHarness, inTx, uuidv7, type Harness } from '../db/harness.helper.ts';
import { createConnectCell, type ConnectCell } from './connect.helper.ts';

const quiet = createLogger({ service: 'fleet-control', cell: 'test', release: 'test', level: 'error', write: () => undefined });
const pem = (key: KeyObject): string => key.export({ type: 'pkcs8', format: 'pem' }).toString();
const hosts = { app: 'uk-lon-1.silohq.io', oauthCallbackUrl: 'https://uk-lon-1.silohq.io/oauth', hooks: 'hooks.uk-lon-1.silohq.io', agent: 'agent.uk-lon-1.silohq.io' };
const releaseKeys = generateKeyPairSync('ed25519');
const dir = mkdtempSync(path.join(tmpdir(), 'silo-templates-'));
const [author, reviewer] = [uuidv7(), uuidv7()];

let global: { h: Harness; databases: Databases; fleet: Fleet };
let cell: ConnectCell;

before(async () => {
  const h = await createHarness();
  const config = loadConfig({
    SILO_ENV: 'test', SILO_SERVICE: 'fleet-control', SILO_CELL_ID: 'global-uk', SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk',
    SILO_HOSTING: 'gke', SILO_BUILD_TARGET: 'commercial', HTTP_HOST: '127.0.0.1', HTTP_PORT: '0', HTTP_DRAIN_SECONDS: '0',
    PG_DIRECTORY_URL: h.url('test_fleet', 'directory'), FLEET_ARTEFACT_DIR: path.join(dir, 'artefacts'), FLEET_SIGNING_KEY: pem(releaseKeys.privateKey),
  });
  const databases = openDatabases(config.postgres, 'fleet-control', ['directory']);
  global = { h, databases, fleet: (await openFleetControl(config, databases, quiet)).fleet };
  writeFileSync(path.join(dir, 'release.pub'), releaseKeys.publicKey.export({ type: 'spki', format: 'pem' }));
  cell = await createConnectCell();
  await cell.start(catalogueService, 'catalogue', 'test_app', {
    CATALOGUE_DATABASE_URL: cell.h.url('test_migrate'), CATALOGUE_RELEASE_PUBLIC_KEY_FILE: path.join(dir, 'release.pub'),
  });
});

after(async () => {
  await global?.databases.close(1_000);
  await global?.h.close();
  await cell?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The cell's Fleet agent: the set from the global fleet-control, the install through the cell's catalogue. */
function agent() {
  const catalogue = cell.client('fleet-control');
  const client: ServiceClient = {
    async call<C extends AnyContract>(contract: C, input: unknown) {
      if (contract.id === 'fleet-control.getConceptTemplateSet') return global.fleet.templateSet() as never;
      return catalogue.call(contract, input as never) as never;
    },
    close() {},
  };
  return createCellReports({ services: client, logger: quiet, signals: createSignalStore(), cell: { id: 'uk-lon-1', kind: 'commercial', residency: 'uk', hosts }, status: 'active' });
}

const cellTemplates = async () => (await cell.migrate.query('select id, name, status, reviewed_by from ontology.concept_templates order by name')).rows;
const tenantEvents = async (event: string) => (await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
  `select payload->'resource'->>'id' as id, payload->'detail' as detail from platform.outbox where organisation_id = $1 and payload->>'event' = $2`, [cell.org, event]))).rows;

describe('concept templates through Fleet (spec 22.7; D210)', () => {
  let invoice = '';

  test('authored and reviewed by two people in the global tier; a draft never leaves it', async () => {
    const draft = await global.fleet.authorTemplate({ operatorId: author, name: 'Invoice', fieldNames: ['invoice_number', 'amount', 'due_date'] });
    invoice = draft.id;
    await global.fleet.authorTemplate({ operatorId: author, name: 'Purchase order', fieldNames: ['po_number', 'supplier'] });
    await assert.rejects(global.fleet.authorTemplate({ operatorId: author, name: 'invoice', fieldNames: ['x'] }), { code: 'fleet.template_name_taken' });
    await assert.rejects(global.fleet.reviewTemplate(invoice, author), { code: 'fleet.two_person' });
    const reviewed = await global.fleet.reviewTemplate(invoice, reviewer);
    assert.deepEqual([reviewed.status, reviewed.reviewedBy], ['reviewed', reviewer]);
    const { set } = await global.fleet.templateSet();
    assert.deepEqual(set.templates.map((t) => t.name), ['Invoice'], 'drafts stay in the global tier');
    const { events } = await global.fleet.listEvents({ after: 0, limit: 100 });
    assert.deepEqual(events.filter((e) => e.event === 'template_reviewed').map((e) => [e.operatorId, e.detail['template_id']]), [[reviewer, invoice]]);
  });

  test('the cell\'s Fleet agent carries the signed set; the catalogue verifies it, installs it and tells every organisation; once', async () => {
    const reports = agent();
    assert.deepEqual(await reports.carryTemplates(uuidv7()), { installed: 1, withdrawn: 0 });
    assert.equal(await reports.carryTemplates(uuidv7()), undefined, 'the same set is not carried again');
    assert.deepEqual((await cellTemplates()).map((t) => [t.name, t.status, t.reviewed_by]), [['Invoice', 'reviewed', reviewer]]);
    assert.deepEqual((await tenantEvents('template_reviewed')).map((e) => [e.id, e.detail.name, e.detail.fields]), [[invoice, 'Invoice', 3]]);
  });

  test('a set changed after signing, or signed by another key, writes nothing', async () => {
    const signed = await global.fleet.templateSet();
    const fleetClient = cell.client('fleet-control');
    const tampered = { ...signed.set, templates: signed.set.templates.map((t) => ({ ...t, fieldNames: [...t.fieldNames, 'bank_account'] })) };
    await assert.rejects(fleetClient.call(installConceptTemplates, { body: { set: tampered, signatures: signed.signatures } }), { code: 'fleet.signature_invalid' });
    const other = generateKeyPairSync('ed25519');
    const { keyFileSigner, signDocument } = await import('../../src/services/fleet-control/signing.service.ts');
    const forged = [await signDocument(keyFileSigner(other.privateKey, 'release', other.publicKey), 'templates', tampered)];
    await assert.rejects(fleetClient.call(installConceptTemplates, { body: { set: tampered, signatures: forged } }), (e: { code?: string }) => /signature|missing|unsigned|untrusted/.test(String(e.code)));
    assert.deepEqual((await cellTemplates()).map((t) => t.name), ['Invoice']);
  });

  test('a withdrawal in the global tier follows into the cell, recorded in Fleet\'s log and every organisation\'s', async () => {
    await global.fleet.withdrawTemplate(invoice, reviewer);
    const { events } = await global.fleet.listEvents({ after: 0, limit: 100 });
    assert.equal(events.filter((e) => e.event === 'template_withdrawn').length, 1);
    assert.deepEqual(await agent().carryTemplates(uuidv7()), { installed: 0, withdrawn: 1 });
    assert.deepEqual((await cellTemplates()).map((t) => [t.name, t.status]), [['Invoice', 'withdrawn']]);
    assert.deepEqual((await tenantEvents('template_withdrawn')).map((e) => e.id), [invoice]);
  });
});
