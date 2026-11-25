// The organisation export end to end (spec 2.6): a super admin asks, the worker runs it as
// them, and the bundle, manifest and receipt come back through the export's own routes.
//
// What it shows: an export is never withheld (it runs with billing suspended, and says so);
// one runs at a time; an artefact carrying a marking the requester is not cleared for is
// omitted and named, never written; every file in the bundle is listed in the manifest with
// its hash; the parts download in pieces and reassemble to their recorded hashes.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { loadConfig } from '../../src/config/index.config.ts';
import * as e from '../../src/contracts/org-export/export.contract.ts';
import { applyMarking, createMarking, grantClearance } from '../../src/contracts/policy/governance.contract.ts';
import { openDatabases, type Databases } from '../../src/infra/postgres.infra.ts';
import { createServiceClient, type ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { createOrgExportService } from '../../src/routes/org-export/index.route.ts';
import { createExports } from '../../src/services/org-export/exports.service.ts';
import { readTar } from '../../src/utils/tar.util.ts';
import { CELL_ID } from '../db/fixtures.helper.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { createConnectCell, quiet, type ConnectCell, type Signed } from './connect.helper.ts';
import { createMemoryStore } from './memoryStore.helper.ts';

let cell: ConnectCell;
let root: Signed;
let databases: Databases;
let services: ServiceClient;
let exports: ReturnType<typeof createExports>;
const store = createMemoryStore();
const apps = { open: uuidv7(), marked: uuidv7(), cleared: uuidv7() };
let marking: string;

const sql = (text: string, values: unknown[] = []) => inTx(cell.app, { orgId: cell.org }, () => cell.app.query(text, values));

before(async () => {
  cell = await createConnectCell();
  root = await cell.signIn('root@acme.example');
  await cell.start(createOrgExportService({ objects: store }), 'org-export', 'test_app', {
    ORG_EXPORT_TICK_SECONDS: '3600', OBJECT_STORE: 's3', OBJECT_BUCKET_FILES: 'silo-test-files', S3_ENDPOINT: 'http://127.0.0.1:1',
    S3_REGION: 'eu-west-2', S3_FORCE_PATH_STYLE: 'true',
  });
  // The worker's run, driven here: the same store, as org-export.
  const config = loadConfig({
    SILO_ENV: 'test', SILO_SERVICE: 'expression-evaluator', SILO_CELL_ID: CELL_ID, SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk',
    SILO_HOSTING: 'gke', SILO_BUILD_TARGET: 'commercial', HTTP_HOST: '127.0.0.1', HTTP_PORT: '0', PG_CONTROL_URL: cell.h.url('test_app'),
  });
  databases = openDatabases(config.postgres, 'org-export', ['control']);
  services = createServiceClient({ caller: 'org-export', http: { ...config.http,
    serviceUrls: Object.fromEntries(Object.entries(cell.ports).map(([n, p]) => [n, `http://127.0.0.1:${p}`])) } });
  exports = createExports({ databases, services, objects: store, logger: quiet, maxArtefactBytes: 64 * 1024 * 1024 });

  // A connector of the organisation's own, and two apps, one of them marked.
  const [connector, manifest] = [uuidv7(), uuidv7()];
  await sql(`insert into connect.connectors (id, organisation_id, kind, slug, name, provider, trust_tier, source_route, author_organisation_id,
    created_by_membership_id) values ($1, $2, 'private', 'ledger', 'Ledger', 'example', 'private', 'ai', $2, $3)`, [connector, cell.org, root.membershipId]);
  await sql(`insert into connect.connector_manifests (id, organisation_id, connector_id, version, document, document_hash, schema_version,
    source_route, created_by_membership_id) values ($1, $2, $3, '1.0.0', $4, $5, '1', 'ai', $6)`,
  [manifest, cell.org, connector, JSON.stringify({ name: 'Ledger', protocol: 'rest' }), Buffer.alloc(32), root.membershipId]);
  for (const [id, name] of [[apps.open, 'Depot board'], [apps.marked, 'Payroll board'], [apps.cleared, 'Fleet board']] as const) {
    await sql(`insert into workspace.apps (id, organisation_id, owner_membership_id, name, kind) values ($1, $2, $3, $4, 'app')`,
      [id, cell.org, root.membershipId, name]);
  }
  const gateway = cell.client('gateway');
  marking = (await gateway.call(createMarking, { body: { name: 'Payroll', kind: 'compartment' } }, cell.as(root))).id;
  await gateway.call(applyMarking, { body: { markingId: marking, resource: { type: 'app', id: apps.marked } } }, cell.as(root));
  // A second marking the super admin is cleared for: what it marks is exported.
  const fleet = (await gateway.call(createMarking, { body: { name: 'Fleet', kind: 'compartment' } }, cell.as(root))).id;
  await gateway.call(applyMarking, { body: { markingId: fleet, resource: { type: 'app', id: apps.cleared } } }, cell.as(root));
  await gateway.call(grantClearance, { body: { markingId: fleet, holder: { kind: 'membership', id: root.membershipId } } }, cell.as(root));
  // Never withheld: billing is suspended, and the export still runs.
  await cell.migrate.query(`update iam.organisations set billing_status = 'suspended' where id = $1`, [cell.org]);
});

after(async () => {
  services?.close();
  await databases?.close();
  await cell?.close();
});

async function download(exportId: string, part: 'bundle' | 'manifest' | 'receipt'): Promise<Buffer> {
  const gateway = cell.client('gateway');
  const pieces: Buffer[] = [];
  let offset = 0;
  let total = 0;
  let sha = '';
  do {
    const got = await gateway.call(e.downloadOrgExport, { params: { exportId }, query: { part, offset, length: 4_096 } }, cell.as(root));
    pieces.push(Buffer.from(got.content, 'base64'));
    offset += Buffer.from(got.content, 'base64').length;
    total = got.totalBytes;
    sha = got.sha256;
  } while (offset < total);
  const whole = Buffer.concat(pieces);
  assert.equal(createHash('sha256').update(whole).digest('hex'), sha, `${part} reassembles to its recorded hash`);
  return whole;
}

describe('the organisation export (spec 2.6)', () => {
  test('runs whatever the billing status, omits and names what the requester is not cleared for, and issues a receipt', async () => {
    const gateway = cell.client('gateway');
    const asked = await gateway.call(e.requestOrgExport, {}, cell.as(root));
    assert.deepEqual([asked.status, asked.billingStatusAtRequest, asked.formatVersion], ['requested', 'suspended', e.EXPORT_FORMAT_VERSION]);
    await assert.rejects(gateway.call(e.requestOrgExport, {}, cell.as(root)), { code: 'org_export.already_running' });

    assert.equal(await exports.sweep(), 1);
    const done = await gateway.call(e.getOrgExport, { params: { exportId: asked.id } }, cell.as(root));
    assert.equal(done.status, 'completed', done.failureCategory ?? '');
    const omitted = done.items.filter((i) => i.status === 'omitted_marking');
    assert.deepEqual(omitted.map((i) => [i.family, i.artefact, i.omittedMarkingId]), [['applications', `app:${apps.marked}`, marking]]);
    const included = new Map(done.items.filter((i) => i.status === 'included').map((i) => [i.path!, i]));
    for (const path of ['connectors/ledger/1.0.0.yaml', `applications/${apps.open}.json`, `applications/${apps.cleared}.json`,
      'schemas/connector-manifest.schema.json',
      'schemas/tables/workspace.apps.schema.json']) assert.ok(included.has(path), path);
    assert.equal(done.omittedItemCount, 1);

    const files = new Map(readTar(gunzipSync(await download(asked.id, 'bundle'))).map((f) => [f.path, f.body]));
    assert.ok(!files.has(`applications/${apps.marked}.json`), 'an omitted artefact has no file');
    assert.match(files.get('connectors/ledger/1.0.0.yaml')!.toString(), /name: Ledger/);
    for (const [path, item] of included) assert.equal(createHash('sha256').update(files.get(path)!).digest('hex'), item.sha256, path);
    const manifest = JSON.parse((await download(asked.id, 'manifest')).toString()) as { omitted: { artefact: string; marking_id: string }[] };
    assert.deepEqual(manifest.omitted, [{ artefact: `app:${apps.marked}`, family: 'applications', marking_id: marking }]);
    assert.deepEqual(JSON.parse(files.get('manifest.json')!.toString()), manifest);
    const receipt = JSON.parse((await download(asked.id, 'receipt')).toString()) as Record<string, unknown>;
    assert.equal(receipt['billing_status_at_request'], 'suspended');
    assert.equal(receipt['bundle_sha256'], done.bundleSha256);
    assert.equal(receipt['omitted_item_count'], 1);

    const { rows } = await sql(`select payload ->> 'event' as event from platform.outbox where organisation_id = $1 and payload ->> 'event' like 'org_export_%'`,
      [cell.org]);
    assert.deepEqual(rows.map((r) => r.event).sort(), ['org_export_completed', 'org_export_requested']);
    // Finished, another may be asked for.
    assert.equal((await gateway.call(e.requestOrgExport, {}, cell.as(root))).status, 'requested');
  });
});
