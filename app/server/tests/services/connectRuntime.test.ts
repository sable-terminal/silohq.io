// connect-runtime end to end: the generic engine executing manifests, with no code for any
// provider. REST against a local fake API (paging, pushdown patches, residual work, error
// meanings, retries, bounds); SQL against a throwaway Postgres database standing in for a
// customer's, reached through a fake Silo Agent that runs the generated statements.

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { readObject } from '../../src/contracts/connect-runtime/read.contract.ts';
import { changeConnectionStatus, createConnection, setConnectionSecrets } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import type { PlanStepInput } from '../../src/contracts/connect/step.contract.ts';
import { DEFAULT_ADMIN_URL, urlFor } from '../../src/db/scripts/bootstrapLocal.script.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { evaluateExpression, validateExpression } from '../../src/contracts/expression-evaluator/expression.contract.ts';
import { explainPushdown } from '../../src/contracts/pushdown-compiler/pushdown.contract.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { service as evaluatorService } from '../../src/routes/expression-evaluator/index.route.ts';
import { service as pushdownService } from '../../src/routes/pushdown-compiler/index.route.ts';
import { SourceSqlError, type AgentChannel, type AgentQuery } from '../../src/services/connect-runtime/agent.service.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { createConnectCell, doc, restManifest, type ConnectCell, type Signed } from './connect.helper.ts';

const MAX_ROWS = 25;

let cell: ConnectCell;
let gateway: ServiceClient;
let executor: ServiceClient;
let root: Signed;
let api: Server;
let baseUrl: string;
const requests: URL[] = [];
const statements: AgentQuery[] = [];
let customer: pg.Client;
const customerDb = `customer_${process.pid}_${Math.floor(Math.random() * 1e6)}`;

const CONTACTS = Array.from({ length: 7 }, (_, i) => ({
  id: `c${i + 1}`, properties: { email: `p${i + 1}@example.com`, first: `First${i + 1}`, last: `Last${i + 1}`, score: (i * 37) % 10 },
}));

let flaky = 0;

before(async () => {
  api = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    requests.push(url);
    res.setHeader('content-type', 'application/json');
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.statusCode = status;
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== 'Bearer tok_valid') return send(401, { message: 'bad token' });
    if (url.pathname === '/v1/contacts') {
      let rows = CONTACTS;
      const email = url.searchParams.get('email');
      if (email !== null) rows = rows.filter((r) => r.properties.email === email);
      const sort = url.searchParams.get('sort');
      if (sort === 'score' || sort === '-score') {
        rows = [...rows].sort((a, b) => (a.properties.score - b.properties.score) * (sort === '-score' ? -1 : 1));
      }
      const limit = Number(url.searchParams.get('limit') ?? 100);
      const after = Number(url.searchParams.get('after') ?? 0);
      const page = rows.slice(after, after + limit);
      return send(200, { results: page, next: after + limit < rows.length ? String(after + limit) : null });
    }
    if (url.pathname === '/v1/flaky') {
      flaky += 1;
      if (flaky % 2 === 1) return send(400, { error: { type: 'RATE_LIMIT' } }, { 'retry-after': '0' });
      return send(200, { results: [CONTACTS[0]] });
    }
    if (url.pathname === '/v1/broken') return send(503, { message: 'down' });
    if (url.pathname === '/v1/endless') return send(200, { results: [CONTACTS[0]], next: 'again' });
    if (url.pathname === '/v1/many') return send(200, { results: Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, properties: {} })) });
    return send(404, {});
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`;

  // The customer's database, which Silo never reaches directly.
  const admin = new pg.Client({ connectionString: DEFAULT_ADMIN_URL });
  await admin.connect();
  await admin.query(`create database ${customerDb}`);
  await admin.end();
  customer = new pg.Client({ connectionString: urlFor(DEFAULT_ADMIN_URL, customerDb) });
  await customer.connect();
  await customer.query(`
    create schema sales;
    create table sales.orders (id integer primary key, customer text not null, region text not null, amount numeric(12,2) not null, note text);
    insert into sales.orders select g, 'customer ' || g, case when g % 3 = 0 then 'north' when g % 3 = 1 then 'south' else 'east' end,
      (g * 10.5)::numeric(12,2), case when g = 4 then '100% sure' when g = 5 then '100 sure' else null end
    from generate_series(1, 40) g;
    revoke all on schema sales from public;`);

  cell = await createConnectCell();
  const agent: AgentChannel = {
    async query(input) {
      statements.push(input);
      try {
        const result = await customer.query({ text: input.statement.text, values: input.statement.values });
        return { rows: result.rows.slice(0, input.maxRows) };
      } catch (error) {
        throw new SourceSqlError(String((error as { code?: string }).code ?? 'XX000'));
      }
    },
  };
  await cell.start(createConnectRuntimeService({ agent }), 'connect-runtime', 'test_app', { EXECUTOR_MAX_ROWS_PER_SOURCE_STEP: String(MAX_ROWS) });
  await cell.start(pushdownService, 'pushdown-compiler', 'test_app');
  await cell.start(evaluatorService, 'expression-evaluator', 'test_app');
  gateway = cell.client('gateway');
  executor = cell.client('executor');
  root = await cell.signIn('root@acme.example');
});

after(async () => {
  await cell?.close();
  api?.close();
  await customer?.end();
  const admin = new pg.Client({ connectionString: DEFAULT_ADMIN_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${customerDb} with (force)`);
  await admin.end();
});

async function activeConnection(document: Record<string, never>, values: Record<string, string>, extra: { agentPoolId?: string; credentialCustody?: 'cell' | 'agent' } = {}) {
  const connector = await gateway.call(createConnector, { body: { slug: `c-${uuidv7().slice(-12)}`, name: 'Source', provider: 'Example', sourceRoute: 'visual' } },
    { ...cell.as(root), idempotencyKey: uuidv7() });
  await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document } }, { ...cell.as(root), idempotencyKey: uuidv7() });
  let connection = await gateway.call(createConnection, {
    body: { connectorId: connector.id, name: 'Source', owningScopeId: cell.scopes['engineering']!, ...extra },
  }, { ...cell.as(root), idempotencyKey: uuidv7() });
  if (Object.keys(values).length > 0) await gateway.call(setConnectionSecrets, { params: { connectionId: connection.id }, body: { values } }, cell.as(root));
  for (const move of ['probe', 'confirm', 'activate'] as const) {
    if (move === 'confirm') await cell.passConformance(connection.id);
    connection = await gateway.call(changeConnectionStatus, { params: { connectionId: connection.id }, body: { move, version: connection.version } }, cell.as(root));
  }
  return { connectionId: connection.id, manifestConnector: connector.id };
}

const read = (connectionId: string, step: PlanStepInput, reason: 'query' | 'probe' = 'query') =>
  executor.call(readObject, { body: { connectionId, reason, step } }, cell.as(root));

describe('REST (spec 14.4, 14.5)', () => {
  let crm: string;

  before(async () => {
    const extraObjects = (['flaky', 'broken', 'endless', 'many'] as const).map((name) => ({
      name, identifier: ['id'], fields: [{ name: 'id', type: 'string' }],
      source: {
        kind: 'rest', request: { method: 'GET', path: `/v1/${name}` }, records: { jsonata: 'results' },
        ...(name === 'endless' ? { paging: { next: { cel: '{"query": {"after": response.body.next}}' }, maxPages: 5 } } : {}),
      },
    }));
    const base = restManifest({ baseUrl }) as unknown as { objects: unknown[] };
    const document = doc({
      ...restManifest({ baseUrl, errors: { classify: [{ when: { cel: 'status == 400 && has(body.error) && body.error.type == "RATE_LIMIT"' }, meaning: 'rate_limit' }] } }),
      objects: [...base.objects, ...extraObjects],
    });
    ({ connectionId: crm } = await activeConnection(document, { token: 'tok_valid' }));
  });

  test('pages until the expression stops; fields by path and by expression, typed', async () => {
    const before = requests.length;
    const out = await read(crm, { object: 'contacts' });
    assert.equal(out.rows.length, 7);
    assert.equal(out.stats.pages, 4, 'two per page, seven contacts');
    assert.deepEqual(out.rows[0], { id: 'c1', email: 'p1@example.com', name: 'First1 Last1', score: 0 });
    assert.deepEqual(requests.slice(before).map((u) => u.searchParams.get('after')), [null, '2', '4', '6']);
  });

  test('declared filters, sort and limit are pushed down as request patches; the rest is computed after', async () => {
    let before = requests.length;
    let out = await read(crm, { object: 'contacts', filters: [{ field: 'email', op: 'eq', value: 'p3@example.com' }] });
    assert.deepEqual(out.rows.map((r) => r['id']), ['c3']);
    assert.equal(requests[before]!.searchParams.get('email'), 'p3@example.com');
    assert.equal(out.pushdown.native.filters.length, 1);

    out = await read(crm, { object: 'contacts', filters: [{ field: 'score', op: 'gte', value: 7 }], fields: ['id', 'score'] });
    assert.deepEqual(out.pushdown.residual.filters, [{ field: 'score', op: 'gte', value: 7 }], 'gte on score is not declared');
    assert.deepEqual(out.rows, [{ id: 'c2', score: 7 }, { id: 'c5', score: 8 }]);

    before = requests.length;
    out = await read(crm, { object: 'contacts', sort: [{ field: 'score', direction: 'desc' }], limit: 3 });
    assert.equal(out.pushdown.native.limit, 3);
    assert.deepEqual(out.rows.map((r) => r['score']), [8, 7, 5]);
    assert.equal(requests[before]!.searchParams.get('sort'), '-score');
    assert.equal(requests[before]!.searchParams.get('limit'), '3');
    assert.equal(out.stats.pages, 1, 'stops once the limit is met');

    out = await read(crm, { object: 'contacts', aggregate: { groupBy: [], measures: [{ fn: 'count', as: 'contacts' }, { fn: 'sum', field: 'score', as: 'total' }] } });
    assert.equal(out.pushdown.residual.aggregate?.measures.length, 2, 'REST aggregates are computed after');
    assert.deepEqual(out.rows, [{ contacts: 7, total: 0 + 7 + 4 + 1 + 8 + 5 + 2 }]);
  });

  test('error meanings: the manifest\'s rules first, then HTTP\'s; retryable meanings are retried', async () => {
    const out = await read(crm, { object: 'flaky' });
    assert.equal(out.rows.length, 1);
    assert.ok(out.stats.retries >= 1, 'a 400 the manifest calls rate_limit was retried');
    await assert.rejects(read(crm, { object: 'broken' }), { category: 'upstream', code: 'source.upstream' });
  });

  test('bounds refuse rather than truncate: rows per step, pages per read', async () => {
    await assert.rejects(read(crm, { object: 'many' }), { category: 'bounds', code: 'connect.rows_per_source_step' });
    const limited = await read(crm, { object: 'many', limit: 10 });
    assert.equal(limited.rows.length, 10, 'a limit the step asks for is not a truncation');
    await assert.rejects(read(crm, { object: 'endless' }), { category: 'bounds', code: 'connect.max_pages' });
  });

  test('a credential the source refuses is an auth error, never an empty result', async () => {
    const document = restManifest({ baseUrl, version: '1.0.0' });
    const { connectionId } = await activeConnection(document, { token: 'tok_revoked_at_source' });
    await assert.rejects(read(connectionId, { object: 'contacts' }), { category: 'unauthenticated', code: 'source.auth' });
  });

  test('a step naming an unknown field or object is refused; a query needs an active connection', async () => {
    await assert.rejects(read(crm, { object: 'contacts', filters: [{ field: 'nope', op: 'eq', value: 1 }] }), { code: 'step.field_unknown' });
    await assert.rejects(read(crm, { object: 'deals' }), { code: 'step.object_unknown' });
    const connector = await gateway.call(createConnector, { body: { slug: `d-${uuidv7().slice(-12)}`, name: 'Draft', provider: 'Example', sourceRoute: 'visual' } },
      { ...cell.as(root), idempotencyKey: uuidv7() });
    await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document: restManifest({ baseUrl }) } },
      { ...cell.as(root), idempotencyKey: uuidv7() });
    const draft = await gateway.call(createConnection, { body: { connectorId: connector.id, name: 'Draft', owningScopeId: cell.scopes['engineering']! } },
      { ...cell.as(root), idempotencyKey: uuidv7() });
    await gateway.call(setConnectionSecrets, { params: { connectionId: draft.id }, body: { values: { token: 'tok_valid' } } }, cell.as(root));
    await assert.rejects(read(draft.id, { object: 'contacts' }), { code: 'connection.not_active' });
    assert.equal((await read(draft.id, { object: 'contacts', limit: 1 }, 'probe')).rows.length, 1, 'a probe reads a connection being built');
  });

  test('the pushdown compiler explains a REST step as the manifest\'s patches', async () => {
    const out = await cell.client('planner').call(explainPushdown, {
      body: { connectionId: crm, step: { object: 'contacts', filters: [{ field: 'email', op: 'eq', value: 'p1@example.com' }], sort: [{ field: 'score', direction: 'asc' }] } },
    }, cell.as(root));
    assert.deepEqual(out.native, { protocol: 'rest', patches: [{ query: { email: 'p1@example.com' } }, { query: { sort: 'score' } }] });
  });

  test('the expression evaluator service checks and evaluates for builders, never auth.sign', async () => {
    const builder = cell.client('visual-builder');
    assert.deepEqual(await builder.call(validateExpression, { body: { block: 'paging.next', language: 'cel', source: 'secret.x' } }),
      { valid: false, code: 'expression.invalid', stage: 'type', reason: 'unknown_variable' });
    const out = await builder.call(evaluateExpression, {
      body: { block: 'records', language: 'jsonata', source: 'data.items', scope: { input: { data: { items: [1, 2] } } }, now: new Date().toISOString() },
    });
    assert.deepEqual(out.value, [1, 2]);
    await assert.rejects(builder.call(evaluateExpression, {
      body: { block: 'auth.sign', language: 'cel', source: '{}', scope: {}, now: new Date().toISOString() },
    }), { category: 'validation' });
  });

  test('a manifest version that has served a read is frozen', async () => {
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select m.first_used_at is not null as used from connect.connections c join connect.connector_manifests m on m.id = c.manifest_id where c.id = $1`, [crm]));
    assert.equal(rows[0]!.used, true);
    await assert.rejects(inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `update connect.connector_manifests set document = document || '{"x": 1}', document_hash = '\\x00' where id = (select manifest_id from connect.connections where id = $1)`, [crm])),
    /immutable/);
  });
});

describe('SQL through the agent (spec 14.4)', () => {
  let warehouse: string;

  const sqlManifest = (aggregates: boolean) => doc({
    schemaVersion: '1', identity: { name: 'Orders database', provider: 'Example', version: '1.0.0' },
    transport: { viaAgent: true }, protocol: { kind: 'sql', dialect: 'postgres' },
    auth: { strategy: 'username_password', fields: [{ name: 'username', kind: 'public', label: 'User', role: 'username' }, { name: 'password', kind: 'secret', label: 'Password', role: 'password' }] },
    objects: [{
      name: 'orders', identifier: ['id'],
      fields: [
        { name: 'id', type: 'integer' }, { name: 'customer', type: 'string' }, { name: 'region', type: 'string' },
        { name: 'amount', type: 'number' }, { name: 'note', type: 'string' },
      ],
      source: { kind: 'sql', schema: 'sales', table: 'orders' },
      pushdown: {
        filters: [
          { field: 'id', ops: ['eq', 'gt', 'lte', 'in'] }, { field: 'region', ops: ['eq', 'in'] }, { field: 'note', ops: ['contains', 'is_null'] },
        ],
        sort: [{ field: 'amount' }, { field: 'id' }],
        ...(aggregates ? { aggregates: { functions: ['count', 'sum'], groupBy: true } } : {}),
      },
    }, {
      name: 'missing', identifier: ['id'], fields: [{ name: 'id', type: 'integer' }], source: { kind: 'sql', schema: 'sales', table: 'nowhere' },
    }],
  });

  before(async () => {
    const pool = uuidv7();
    await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `insert into connect.agent_pools (id, organisation_id, name, created_by) values ($1, $2, 'Office', $3)`, [pool, cell.org, root.membershipId]));
    ({ connectionId: warehouse } = await activeConnection(sqlManifest(true), {}, { agentPoolId: pool, credentialCustody: 'agent' }));
  });

  test('the native part is one generated, parameterised statement; values never appear in its text', async () => {
    const out = await read(warehouse, {
      object: 'orders', fields: ['id', 'region', 'amount'],
      filters: [{ field: 'id', op: 'gt', value: 30 }, { field: 'region', op: 'in', value: ['north', 'east'] }],
      sort: [{ field: 'amount', direction: 'desc' }], limit: 3,
    });
    assert.deepEqual(out.rows, [{ id: 39, region: 'north', amount: 409.5 }, { id: 38, region: 'east', amount: 399 }, { id: 36, region: 'north', amount: 378 }]);
    const statement = statements.at(-1)!;
    assert.match(statement.statement.text, /^select "id" as "id", "region" as "region", "amount" as "amount" from "sales"\."orders" where "id" > \$1 and "region" in \(\$2, \$3\) order by "amount" desc limit \$4$/);
    assert.deepEqual(statement.statement.values, [30, 'north', 'east', 3]);
    assert.equal(statement.dialect, 'postgres');
  });

  test('a contains filter matches its value literally, wildcards included', async () => {
    const out = await read(warehouse, { object: 'orders', fields: ['id'], filters: [{ field: 'note', op: 'contains', value: '100%' }] });
    assert.deepEqual(out.rows, [{ id: 4 }], '"100 sure" does not match 100%');
    assert.ok(!statements.at(-1)!.statement.text.includes('100'));
  });

  test('declared aggregates run in the database; undeclared ones after, over bounded rows', async () => {
    let out = await read(warehouse, {
      object: 'orders', filters: [{ field: 'id', op: 'lte', value: 9 }],
      aggregate: { groupBy: ['region'], measures: [{ fn: 'count', as: 'orders' }, { fn: 'sum', field: 'amount', as: 'total' }] },
      sort: [{ field: 'region', direction: 'asc' }],
    });
    assert.ok(out.pushdown.native.aggregate !== null);
    assert.match(statements.at(-1)!.statement.text, /count\(\*\) as "orders", sum\("amount"\) as "total" .* group by "region" order by "region" asc/);
    assert.deepEqual(out.rows, [
      { region: 'east', orders: 3, total: 21 + 52.5 + 84 }, { region: 'north', orders: 3, total: 31.5 + 63 + 94.5 }, { region: 'south', orders: 3, total: 10.5 + 42 + 73.5 },
    ]);
    out = await read(warehouse, { object: 'orders', filters: [{ field: 'id', op: 'lte', value: 9 }], aggregate: { groupBy: [], measures: [{ fn: 'avg', field: 'amount', as: 'mean' }] } });
    assert.equal(out.pushdown.residual.aggregate?.measures[0]?.fn, 'avg', 'avg is not declared');
    assert.deepEqual(out.rows, [{ mean: 52.5 }]);
  });

  test('without a limit, more rows than the bound are refused; the statement asks for one more than the bound', async () => {
    await assert.rejects(read(warehouse, { object: 'orders' }), { category: 'bounds', code: 'connect.rows_per_source_step' });
    assert.equal(statements.at(-1)!.statement.values.at(-1), MAX_ROWS + 1);
    const out = await read(warehouse, { object: 'orders', filters: [{ field: 'customer', op: 'starts_with', value: 'customer 1' }], fields: ['id'] }).catch((e) => e);
    assert.equal(out.code, 'connect.rows_per_source_step', 'an undeclared filter reads the whole table, which is over the bound');
  });

  test('database errors are classified by SQLSTATE: a missing table is not_found', async () => {
    await assert.rejects(read(warehouse, { object: 'missing' }), { category: 'not_found', code: 'source.not_found' });
  });

  test('the pushdown compiler explains a step: the split and the generated statement, without its values', async () => {
    const planner = cell.client('planner');
    const out = await planner.call(explainPushdown, {
      body: { connectionId: warehouse, step: { object: 'orders', filters: [{ field: 'region', op: 'eq', value: 'north' }, { field: 'amount', op: 'gt', value: 5 }], limit: 5 } },
    }, cell.as(root));
    assert.equal(out.split.native.filters.length, 1);
    assert.equal(out.split.residual.limit, 5, 'a residual filter keeps the limit residual');
    assert.equal(out.native.protocol, 'sql');
    if (out.native.protocol === 'sql') {
      assert.match(out.native.statement, /where "region" = \$1 limit \$2$/);
      assert.ok(!out.native.statement.includes('north'));
    }
  });

  test('the cell keeps no secret for a connection whose login the agent holds', async () => {
    await assert.rejects(gateway.call(setConnectionSecrets, { params: { connectionId: warehouse }, body: { values: { password: 'x' } } }, cell.as(root)),
      { code: 'credential.agent_custody' });
  });
});
