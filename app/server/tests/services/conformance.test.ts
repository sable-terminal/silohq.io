// The conformance suite end to end (spec 17.1, 17.2): real conformance, connect-runtime,
// credential, policy and registry processes, against a local fake source. The fake honours
// paging, its identifier and stage filters and its sort, but silently ignores its owner
// filter, which is exactly the superset-that-looks-like-an-answer the filter class exists
// to catch. A second base path accepts any credential, which the error class must fail.

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { getConformanceRun, listConformanceRuns, startConformanceRun, type ConformanceRunView } from '../../src/contracts/conformance/conformance.contract.ts';
import { readObject } from '../../src/contracts/connect-runtime/read.contract.ts';
import { changeConnectionStatus, createConnection, setConnectionSecrets } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { service as conformanceService } from '../../src/routes/conformance/index.route.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { sleep } from '../../src/utils/time.util.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { createConnectCell, restManifest, type ConnectCell, type Signed } from './connect.helper.ts';

let cell: ConnectCell;
let gateway: ServiceClient;
let executor: ServiceClient;
let root: Signed;
let member: Signed;
let api: Server;
let baseUrl: string;

const CONTACTS = Array.from({ length: 25 }, (_, i) => ({
  id: `k${String(i + 1).padStart(2, '0')}`, name: `Contact ${i + 1}`, stage: ['lead', 'won', 'lost'][i % 3]!, owner: ['ann', 'bob'][i % 2]!,
  amount: ((i * 13) % 50) + 0.5,
}));
const PAGE = 10;

before(async () => {
  api = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const send = (status: number, body: unknown) => {
      // A little latency, so a run is still going when a second one is asked for.
      setTimeout(() => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
      }, 5);
    };
    const strict = url.pathname.startsWith('/strict/');
    if (strict && req.headers.authorization !== 'Bearer tok_good') return send(401, { message: 'bad token' });
    if (!url.pathname.endsWith('/contacts')) return send(404, {});
    let rows = CONTACTS;
    const id = url.searchParams.get('id');
    if (id !== null) rows = rows.filter((r) => r.id === id);
    const stage = url.searchParams.get('stage');
    if (stage !== null) rows = rows.filter((r) => r.stage === stage);
    // url.searchParams.get('owner') is accepted and ignored.
    if (url.searchParams.get('sort') === 'amount') rows = [...rows].sort((a, b) => a.amount - b.amount);
    const page = Number(url.searchParams.get('page') ?? 1);
    return send(200, { results: rows.slice((page - 1) * PAGE, page * PAGE), next: page * PAGE < rows.length ? page + 1 : null });
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  cell = await createConnectCell();
  await cell.start(createConnectRuntimeService(), 'connect-runtime', 'test_app');
  await cell.start(conformanceService, 'conformance', 'test_app');
  gateway = cell.client('gateway');
  executor = cell.client('executor');
  root = await cell.signIn('root@acme.example');
  member = await cell.member('mo@acme.example', 'Member', 'platform');
});

after(async () => {
  await cell?.close();
  api?.close();
});

const filter = (field: string) => ({ field, ops: ['eq'], patch: { cel: `{"query": {"${field}": string(value)}}` } });

function manifest(path: '/strict' | '/lenient') {
  return restManifest({
    baseUrl: `${baseUrl}${path}`,
    objects: [{
      name: 'contacts', identifier: ['id'],
      fields: [
        { name: 'id', type: 'string' }, { name: 'name', type: 'string' }, { name: 'stage', type: 'string' },
        { name: 'owner', type: 'string' }, { name: 'amount', type: 'number' },
      ],
      source: {
        kind: 'rest', request: { method: 'GET', path: '/contacts' }, records: { jsonata: 'results' },
        paging: { next: { cel: 'response.body.next != null ? {"query": {"page": string(response.body.next)}} : stop()' }, maxPages: 10 },
      },
      pushdown: { filters: [filter('id'), filter('stage'), filter('owner')], sort: [{ field: 'amount', patch: { cel: '{"query": {"sort": field}}' } }] },
    }],
  });
}

async function probingConnection(path: '/strict' | '/lenient'): Promise<{ id: string; version: number }> {
  const connector = await gateway.call(createConnector, {
    body: { slug: `conf-${uuidv7().slice(-12)}`, name: 'Contacts', provider: 'Example', sourceRoute: 'ai' },
  }, { ...cell.as(root), idempotencyKey: uuidv7() });
  await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document: manifest(path) } },
    { ...cell.as(root), idempotencyKey: uuidv7() });
  const connection = await gateway.call(createConnection, {
    body: { connectorId: connector.id, name: 'Contacts', owningScopeId: cell.scopes['engineering']! },
  }, { ...cell.as(root), idempotencyKey: uuidv7() });
  await gateway.call(setConnectionSecrets, { params: { connectionId: connection.id }, body: { values: { token: 'tok_good' } } }, cell.as(root));
  const probing = await gateway.call(changeConnectionStatus, { params: { connectionId: connection.id }, body: { move: 'probe', version: connection.version } },
    cell.as(root));
  return { id: probing.id, version: probing.version };
}

const start = (connectionId: string, who: Signed = root) => gateway.call(startConformanceRun, { body: { connectionId } }, { ...cell.as(who), idempotencyKey: uuidv7() });

async function finished(runId: string): Promise<ConformanceRunView> {
  for (let i = 0; i < 400; i++) {
    const run = await gateway.call(getConformanceRun, { params: { runId } }, cell.as(root));
    if (run.status !== 'running') return run;
    await sleep(50);
  }
  throw new Error('the run did not finish');
}

const outcome = (run: ConformanceRunView, id: string) => run.tests.find((t) => t.id === id)?.outcome;

describe('the conformance suite (spec 17.2)', () => {
  let strict: { id: string; version: number };
  let run: ConformanceRunView;

  before(async () => {
    strict = await probingConnection('/strict');
  });

  test('a draft is not tested, and someone who neither owns it nor holds connector.verify may not start a run', async () => {
    const connector = await gateway.call(createConnector, { body: { slug: `draft-${uuidv7().slice(-12)}`, name: 'D', provider: 'Example', sourceRoute: 'ai' } },
      { ...cell.as(root), idempotencyKey: uuidv7() });
    await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document: manifest('/strict') } },
      { ...cell.as(root), idempotencyKey: uuidv7() });
    const draft = await gateway.call(createConnection, { body: { connectorId: connector.id, name: 'D', owningScopeId: cell.scopes['engineering']! } },
      { ...cell.as(root), idempotencyKey: uuidv7() });
    await assert.rejects(start(draft.id), { code: 'conformance.connection_not_testable' });
    await assert.rejects(start(strict.id, member), { code: 'connect.not_permitted' });
  });

  test('confirmation waits for a passing run', async () => {
    await assert.rejects(gateway.call(changeConnectionStatus, { params: { connectionId: strict.id }, body: { move: 'confirm', version: strict.version } },
      cell.as(root)), { code: 'connection.conformance_required' });
  });

  test('a run answers at once and continues; one at a time per connection', async () => {
    const started = await start(strict.id);
    assert.equal(started.status, 'running');
    assert.deepEqual(started.classesRun, ['read', 'pagination', 'filter_pushdown', 'error']);
    await assert.rejects(start(strict.id), { code: 'conformance.run_in_progress' });
    run = await finished(started.id);
    assert.equal(run.status, 'completed');
  });

  test('read, pagination and error classes pass against an honest source', () => {
    for (const id of ['read.list.contacts', 'read.field_selection.contacts', 'read.types.contacts', 'read.identifier_unique.contacts', 'read.get.contacts',
      'pagination.terminates.contacts', 'pagination.traverse.contacts', 'pagination.no_duplicates.contacts',
      'error.invalid_credential', 'error.not_found.contacts']) {
      assert.equal(outcome(run, id), 'passed', id);
    }
    assert.equal(run.tests.find((t) => t.id === 'pagination.traverse.contacts')!.reason, 'pages:3');
    assert.equal(outcome(run, 'pagination.no_gap.contacts'), 'not_applicable', 'not applicable is recorded, never passed');
    assert.equal(outcome(run, 'error.rate_limit.contacts'), 'not_applicable');
    assert.equal(run.gate.verified, true);
  });

  test('a filter the source ignores fails and is named; honoured ones and the sort pass', () => {
    assert.equal(outcome(run, 'filter_pushdown.filter.contacts.id.eq'), 'passed');
    assert.equal(outcome(run, 'filter_pushdown.filter.contacts.stage.eq'), 'passed');
    assert.equal(outcome(run, 'filter_pushdown.sort.contacts.amount'), 'passed');
    const owner = run.tests.find((t) => t.id === 'filter_pushdown.filter.contacts.owner.eq')!;
    assert.equal(owner.outcome, 'failed');
    assert.equal(owner.reason, 'rows:25/expected:13', 'counts, never values');
    assert.deepEqual(run.gate.failingOperators, [{ object: 'contacts', field: 'owner', op: 'eq' }]);
    assert.equal(run.failedCount, 1);
  });

  test('the failing operator is computed after the source from then on, so the answer is right', async () => {
    const out = await executor.call(readObject, {
      body: { connectionId: strict.id, reason: 'probe', step: { object: 'contacts', filters: [{ field: 'owner', op: 'eq', value: 'bob' }] } },
    }, cell.as(root));
    assert.deepEqual(out.pushdown.residual.filters, [{ field: 'owner', op: 'eq', value: 'bob' }]);
    assert.equal(out.rows.length, 12);
    assert.ok(out.rows.every((r) => r['owner'] === 'bob'));
    await assert.rejects(executor.call(readObject, {
      body: { connectionId: strict.id, reason: 'probe', step: { object: 'contacts' }, declaredPushdown: true },
    }, cell.as(root)), { code: 'read.declared_pushdown_refused' });
    await assert.rejects(executor.call(readObject, {
      body: { connectionId: strict.id, reason: 'probe', step: { object: 'contacts' }, invalidCredentials: true },
    }, cell.as(root)), { code: 'read.invalid_credentials_refused' });
  });

  test('with a passing run, an authorised person confirms; the trail names the run and each failure', async () => {
    const confirmed = await gateway.call(changeConnectionStatus, { params: { connectionId: strict.id }, body: { move: 'confirm', version: strict.version } },
      cell.as(root));
    assert.equal(confirmed.status, 'verified');
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select payload->>'event' as event, payload->'detail' as detail from platform.outbox
       where organisation_id = $1 and payload->>'event' like 'conformance_%' order by created_at, id`, [cell.org]));
    // The completion and its failures are written in one transaction, in no fixed order.
    assert.equal(rows[0].event, 'conformance_run_started');
    assert.deepEqual(rows.slice(1).map((r) => r.event).sort(), ['conformance_run_completed', 'conformance_test_failed']);
    assert.equal(rows.find((r) => r.event === 'conformance_run_completed').detail.verified, true);
    assert.equal(rows.find((r) => r.event === 'conformance_test_failed').detail.test, 'filter_pushdown.filter.contacts.owner.eq');
    const listed = await gateway.call(listConformanceRuns, { params: { connectionId: strict.id }, query: {} }, cell.as(root));
    assert.equal(listed.runs[0]!.id, run.id);
  });

  test('a source that accepts any credential fails the error class, which verified status requires', async () => {
    const lenient = await probingConnection('/lenient');
    const failed = await finished((await start(lenient.id)).id);
    assert.equal(outcome(failed, 'error.invalid_credential'), 'failed');
    assert.equal(failed.tests.find((t) => t.id === 'error.invalid_credential')!.reason, 'wrong_credentials_accepted');
    assert.equal(failed.gate.verified, false);
    assert.deepEqual(failed.gate.failedClasses, ['error']);
    await assert.rejects(gateway.call(changeConnectionStatus, { params: { connectionId: lenient.id }, body: { move: 'confirm', version: lenient.version } },
      cell.as(root)), { code: 'connection.conformance_required' });

    // A run whose process died is closed as abandoned when next read, and verifies nothing.
    const orphan = uuidv7();
    await inTx(cell.app, { orgId: cell.org }, async () => {
      const { rows } = await cell.app.query('select manifest_id from connect.connections where id = $1', [lenient.id]);
      await cell.app.query(
        `insert into connect.conformance_runs (id, organisation_id, connection_id, manifest_id, suite_version, trigger, route, classes_run, results, started_at)
         values ($1, $2, $3, $4, 'x', 'manual', 'ai', '{read}', '[]', now() - interval '2 hours')`, [orphan, cell.org, lenient.id, rows[0].manifest_id]);
    });
    const abandoned = await gateway.call(getConformanceRun, { params: { runId: orphan } }, cell.as(root));
    assert.equal(abandoned.status, 'abandoned');
    assert.equal(abandoned.gate.verified, false);
  });
});
