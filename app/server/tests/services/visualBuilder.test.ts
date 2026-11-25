// visual-builder (spec 16.4): a connector built by hand, block by block, with the YAML view
// as the raw form of the same manifest. Steps are checked as they are built; drafts are
// saved as prerelease versions and tried against a fake API through a sandbox connection;
// the release goes to the real conformance suite and is confirmed.

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, describe, test } from 'node:test';
import { changeConnectionStatus, getConnection } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, getOwnManifestDocument, listManifestVersions } from '../../src/contracts/connect-registry/connector.contract.ts';
import { setDraftConnectionVersion } from '../../src/contracts/connect-registry/draft.contract.ts';
import { getConformanceRun } from '../../src/contracts/conformance/conformance.contract.ts';
import { convertDraft, publishDraft, setBuildSecrets, tryDraft, validateDraft } from '../../src/contracts/visual-builder/builder.contract.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { service as conformanceService } from '../../src/routes/conformance/index.route.ts';
import { service as visualService } from '../../src/routes/visual-builder/index.route.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { createConnectCell, type ConnectCell, type Signed } from './connect.helper.ts';

const CONTACTS = Array.from({ length: 23 }, (_, i) => ({
  id: `k${String(i + 1).padStart(2, '0')}`, name: `Contact ${i + 1}`, stage: ['lead', 'won', 'lost'][i % 3]!, amount: ((i * 13) % 50) + 0.5,
}));
const PAGE = 10;

let api: Server;
let baseUrl: string;
let cell: ConnectCell;
let root: Signed;

before(async () => {
  api = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== 'Bearer tok_good') return send(401, { message: 'bad token' });
    if (url.pathname !== '/v1/contacts') return send(404, {});
    let rows = CONTACTS;
    const stage = url.searchParams.get('stage');
    if (stage !== null) rows = rows.filter((r) => r.stage === stage);
    const page = Number(url.searchParams.get('page') ?? 1);
    return send(200, { results: rows.slice((page - 1) * PAGE, page * PAGE), next: page * PAGE < rows.length ? page + 1 : null });
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  cell = await createConnectCell();
  await cell.start(createConnectRuntimeService(), 'connect-runtime', 'test_app');
  await cell.start(conformanceService, 'conformance', 'test_app');
  await cell.start(visualService, 'visual-builder', 'test_app');
  root = await cell.signIn('root@acme.example');
});

after(async () => {
  await cell?.close();
  api?.close();
});

const draft = (version = '1.0.0', records = 'results') => ({
  schemaVersion: '1', identity: { name: 'Contacts', provider: 'Example', version },
  transport: { viaAgent: false, baseUrl }, protocol: { kind: 'rest' },
  auth: { strategy: 'bearer', fields: [{ name: 'token', kind: 'secret', label: 'API token', role: 'token' }] },
  objects: [{
    name: 'contacts', identifier: ['id'],
    fields: [{ name: 'id', type: 'string' }, { name: 'name', type: 'string' }, { name: 'stage', type: 'string' }, { name: 'amount', type: 'number' }],
    source: {
      kind: 'rest', request: { method: 'GET', path: '/v1/contacts' }, records: { jsonata: records },
      paging: { next: { cel: 'response.body.next != null ? {"query": {"page": string(response.body.next)}} : stop()' }, maxPages: 10 },
    },
    pushdown: { filters: [{ field: 'stage', ops: ['eq'], patch: { cel: '{"query": {"stage": string(value)}}' } }] },
  }],
});

const visual = () => cell.client('gateway');
const keyed = () => ({ ...cell.as(root), idempotencyKey: uuidv7() });

describe('checking a draft as it is built', () => {
  test('each step checks its own block, its expressions and what it can cross-check', async () => {
    const half = { schemaVersion: '1', protocol: { kind: 'rest' }, transport: { viaAgent: false }, auth: { strategy: 'bearer' },
      objects: [{ name: 'contacts', identifier: ['id', 'nope'], source: { kind: 'rest', request: { method: 'GET', path: '/v1/contacts' }, records: { jsonata: 'results[' } },
        fields: [{ name: 'id', type: 'string' }], pushdown: { filters: [{ field: 'ghost', ops: ['eq'], patch: { cel: '{"query": {' } }] } }] };
    const check = (step: string) => visual().call(validateDraft, { body: { document: half, step: step as never } }, cell.as(root));
    const transport = await check('transport');
    assert.deepEqual(transport.issues.map((i) => i.path), ['document.transport.baseUrl']);
    assert.equal(transport.complete, false);
    const records = await check('records');
    assert.deepEqual(records.issues.map((i) => [i.path, i.code]), [['document.objects.0.source.records.jsonata', 'expression.invalid']],
      'the records expression is checked though the rest of the object is unfinished');
    const fields = await check('fields');
    assert.deepEqual(fields.issues.map((i) => i.path), ['document.objects.0.identifier.1']);
    const pushdown = await check('pushdown');
    assert.deepEqual(pushdown.issues.map((i) => i.path).sort(), ['document.objects.0.pushdown.filters.0.field', 'document.objects.0.pushdown.filters.0.patch.cel']);
    const sqlAuth = await visual().call(validateDraft, {
      body: { document: { protocol: { kind: 'sql', dialect: 'postgres' }, auth: { strategy: 'bearer' } }, step: 'auth' },
    }, cell.as(root));
    assert.deepEqual(sqlAuth.issues.map((i) => i.code), ['manifest.strategy_unsupported']);
    const whole = await visual().call(validateDraft, { body: { document: draft() } }, cell.as(root));
    assert.deepEqual(whole, { complete: true, valid: true, issues: [] });
  });

  test('YAML is the raw view of the same document, with errors at their line and column', async () => {
    const yaml = (await visual().call(convertDraft, { body: { to: 'yaml', document: draft() } }, cell.as(root))).yaml!;
    const back = await visual().call(convertDraft, { body: { to: 'json', yaml } }, cell.as(root));
    assert.deepEqual(back.issues, []);
    assert.deepEqual(back.document, JSON.parse(JSON.stringify(draft())));
    const broken = yaml.replace('type: number', 'type: money');
    const placed = await visual().call(convertDraft, { body: { to: 'json', yaml: broken } }, cell.as(root));
    const issue = placed.issues.find((i) => i.path === 'document.objects.0.fields.3.type')!;
    assert.equal(broken.split('\n')[issue.line! - 1]!.includes('money'), true, 'placed on the line that holds the error');
    const aliased = await visual().call(convertDraft, { body: { to: 'json', yaml: 'a: &x {b: 1}\nc: *x\n' } }, cell.as(root));
    assert.equal(aliased.document, null);
    assert.deepEqual(aliased.issues.map((i) => i.code), ['yaml.alias_refused']);
    const twice = await visual().call(convertDraft, { body: { to: 'json', yaml: 'a: 1\na: 2\n' } }, cell.as(root));
    assert.equal(twice.document, null);
    assert.equal(twice.issues[0]!.line, 2);
  });
});

describe('trying, publishing and confirming a draft', () => {
  let connectorId: string;
  let connectionId: string;

  test('the first try saves draft 1 and a sandbox connection; without its secret the read is refused before it is sent', async () => {
    const connector = await visual().call(createConnector, {
      body: { slug: `vb-${uuidv7().slice(-12)}`, name: 'Contacts', provider: 'Example', sourceRoute: 'visual' },
    }, keyed());
    connectorId = connector.id;
    const out = await visual().call(tryDraft, {
      body: { connectorId, document: draft(), connection: { name: 'Contacts sandbox', owningScopeId: cell.scopes['engineering']! }, object: 'contacts' },
    }, keyed());
    connectionId = out.connection.id;
    assert.equal(out.manifest.version, '1.0.0-draft.1');
    assert.equal(out.connection.status, 'draft');
    assert.equal(out.outcome, 'refused');
    assert.deepEqual(out.rows, []);
    assert.deepEqual(out.failure, { code: 'credential.missing', meaning: null });
  });

  test('with its secret the try reads rows to the person, and the probe run keeps counts only', async () => {
    await visual().call(setBuildSecrets, { params: { connectionId }, body: { values: { token: 'tok_good' } } }, cell.as(root));
    const key = uuidv7();
    const out = await visual().call(tryDraft, { body: { connectorId, document: draft(), connectionId, object: 'contacts', limit: 5 } },
      { ...cell.as(root), idempotencyKey: key });
    assert.equal(out.outcome, 'read');
    assert.equal(out.manifest.version, '1.0.0-draft.2');
    assert.equal(out.rows.length, 5);
    assert.equal(out.rows[0]!['name'], 'Contact 1');
    const connection = await visual().call(getConnection, { params: { connectionId } }, cell.as(root));
    assert.equal(connection.manifestId, out.manifest.id, 'the sandbox follows the draft');
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      'select status, findings::text as findings from connect.probe_runs where id = $1', [out.probeRunId]));
    assert.equal(rows[0].status, 'completed');
    assert.equal((rows[0].findings as string).includes('Contact'), false, 'no value is kept');

    const again = await visual().call(tryDraft, { body: { connectorId, document: draft(), connectionId, object: 'contacts', limit: 5 } },
      { ...cell.as(root), idempotencyKey: key });
    assert.equal(again.manifest.id, out.manifest.id, 'a retry saves no other version');
    assert.equal(again.rows.length, 5);
    const versions = await visual().call(listManifestVersions, { params: { connectorId } }, cell.as(root));
    assert.deepEqual(versions.versions.map((v) => v.version).sort(), ['1.0.0-draft.1', '1.0.0-draft.2']);
  });

  test('a draft that is not a manifest is refused with its paths, and nothing is saved', async () => {
    await assert.rejects(visual().call(tryDraft, {
      body: { connectorId, document: { ...draft(), objects: [] }, connectionId, object: 'contacts' },
    }, keyed()), { code: 'visual.draft_invalid' });
    const versions = await visual().call(listManifestVersions, { params: { connectorId } }, cell.as(root));
    assert.equal(versions.versions.length, 2);
  });

  test('publishing saves the release, moves the sandbox to probing and runs conformance; then it is confirmed', async () => {
    await assert.rejects(visual().call(publishDraft, { body: { connectorId, connectionId, document: draft('1.0.0-rc.1') } }, keyed()),
      { code: 'visual.release_version_required' });
    const published = await visual().call(publishDraft, { body: { connectorId, connectionId, document: draft() } }, keyed());
    assert.equal(published.manifest.version, '1.0.0');
    assert.equal(published.connection.status, 'probing');
    let run = await visual().call(getConformanceRun, { params: { runId: published.conformanceRunId } }, cell.as(root));
    for (let i = 0; i < 400 && run.status === 'running'; i++) {
      await sleep(50);
      run = await visual().call(getConformanceRun, { params: { runId: published.conformanceRunId } }, cell.as(root));
    }
    assert.equal(run.manifestId, published.manifest.id);
    assert.equal(run.gate.verified, true, `failed: ${run.gate.failedClasses.join(',')}`);
    const confirmed = await visual().call(changeConnectionStatus, {
      params: { connectionId }, body: { move: 'confirm', version: published.connection.version },
    }, cell.as(root));
    assert.equal(confirmed.status, 'verified');
    // The builder opens what it saved: the release's document, as published (D262).
    const opened = await visual().call(getOwnManifestDocument, { params: { connectorId, versionId: published.manifest.id } }, cell.as(root));
    assert.equal(opened.version, '1.0.0');
    assert.deepEqual((opened.document as { objects: { name: string }[] }).objects.map((o) => o.name), ['contacts']);
    // A verified connection changes version through a reviewed repair, never a build.
    await assert.rejects(cell.client('visual-builder').call(setDraftConnectionVersion, {
      params: { connectionId }, body: { manifestId: published.manifest.id, version: confirmed.version },
    }, cell.as(root)), { code: 'connection.not_building' });
  });
});
