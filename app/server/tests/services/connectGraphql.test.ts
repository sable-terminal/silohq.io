// The GraphQL protocol engine end to end: a manifest, not code, connects a real graphql-js
// server. The engine builds the query from the plan, pages by cursor, pushes filters, sort
// and limit down as typed variables (never as text in the query), classifies a 200 that
// carries errors, and the registry refuses what the engine cannot run.

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { buildSchema, getIntrospectionQuery, graphql, graphqlSync, GraphQLError, printSchema } from 'graphql';
import { readObject } from '../../src/contracts/connect-runtime/read.contract.ts';
import { writeRecords } from '../../src/contracts/connect-runtime/write.contract.ts';
import { changeConnectionStatus, createConnection, setConnectionSecrets } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import type { PlanStepInput } from '../../src/contracts/connect/step.contract.ts';
import { explainPushdown } from '../../src/contracts/pushdown-compiler/pushdown.contract.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { service as pushdownService } from '../../src/routes/pushdown-compiler/index.route.ts';
import { importDraft } from '../../src/contracts/visual-builder/builder.contract.ts';
import { service as visualService } from '../../src/routes/visual-builder/index.route.ts';
import { uuidv7 } from '../db/harness.helper.ts';
import { createConnectCell, doc, type ConnectCell, type Signed } from './connect.helper.ts';

let cell: ConnectCell;
let gateway: ServiceClient;
let executor: ServiceClient;
let planner: ServiceClient;
let root: Signed;
let api: Server;
let baseUrl: string;
const received: { query: string; variables: Record<string, unknown> }[] = [];

const CONTACTS = Array.from({ length: 10 }, (_, i) => ({
  id: `g${i + 1}`, name: `Person ${i + 1}`, stage: i % 2 === 0 ? 'won' : 'open', amount: ((i * 7) % 10) + 0.25, company: { name: `Co ${i % 3}` },
}));

const schema = buildSchema(`
  type Query { contacts(first: Int, after: String, stage: String, orderBy: String): ContactConnection! }
  type ContactConnection { edges: [Edge!]!, pageInfo: PageInfo! }
  type Edge { node: Contact! }
  type PageInfo { hasNextPage: Boolean!, endCursor: String }
  type Contact { id: ID!, name: String!, stage: String!, amount: Float!, company: Company }
  type Company { name: String! }
`);

// The same service with mutations, for the write tests (the draft tests read the schema without them).
const writable = buildSchema(`${printSchema(schema)}
  type Mutation {
    createContact(name: String!, stage: String!, amount: Float!): Contact!
    updateContact(id: ID!, stage: String, amount: Float): Contact
    deleteContact(id: ID!): Contact
  }
`);

const rootValue = {
  createContact: (args: { name: string; stage: string; amount: number }, context: { authorised: boolean }) => {
    if (!context.authorised) throw new GraphQLError('not signed in', { extensions: { code: 'UNAUTHENTICATED' } });
    const created = { id: `g${CONTACTS.length + 1}`, ...args, company: { name: 'Co new' } };
    CONTACTS.push(created);
    return created;
  },
  updateContact: (args: { id: string; stage?: string; amount?: number }) => {
    const found = CONTACTS.find((c) => c.id === args.id);
    if (found === undefined) return null;
    if (args.stage !== undefined) found.stage = args.stage;
    if (args.amount !== undefined) found.amount = args.amount;
    return found;
  },
  deleteContact: (args: { id: string }) => {
    const at = CONTACTS.findIndex((c) => c.id === args.id);
    return at < 0 ? null : CONTACTS.splice(at, 1)[0];
  },
  contacts: (args: { first?: number; after?: string; stage?: string; orderBy?: string }, context: { authorised: boolean }) => {
    if (!context.authorised) throw new GraphQLError('not signed in', { extensions: { code: 'UNAUTHENTICATED' } });
    const first = args.first ?? 10;
    if (first > 50) throw new GraphQLError('too complex', { extensions: { code: 'MAX_COMPLEXITY' } });
    let rows = CONTACTS;
    if (args.stage !== undefined) rows = rows.filter((r) => r.stage === args.stage);
    if (args.orderBy === 'amount') rows = [...rows].sort((a, b) => a.amount - b.amount);
    const start = args.after === undefined ? 0 : Number(args.after);
    const page = rows.slice(start, start + first);
    return {
      edges: page.map((node) => ({ node })),
      pageInfo: { hasNextPage: start + first < rows.length, endCursor: String(start + first) },
    };
  },
};

before(async () => {
  api = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const { query, variables } = JSON.parse(Buffer.concat(chunks).toString()) as { query: string; variables: Record<string, unknown> };
      received.push({ query, variables });
      const result = await graphql({
        schema: writable, source: query, rootValue, variableValues: variables, contextValue: { authorised: req.headers.authorization === 'Bearer gql_token' },
      });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(result));
    });
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  cell = await createConnectCell();
  await cell.start(createConnectRuntimeService(), 'connect-runtime', 'test_app');
  await cell.start(pushdownService, 'pushdown-compiler', 'test_app');
  await cell.start(visualService, 'visual-builder', 'test_app');
  gateway = cell.client('gateway');
  executor = cell.client('executor');
  planner = cell.client('planner');
  root = await cell.signIn('root@acme.example');
});

after(async () => {
  await cell?.close();
  api?.close();
});

const WRITES = {
  create: {
    mutation: { field: 'createContact', variables: [{ name: 'name', type: 'String!' }, { name: 'stage', type: 'String!' }, { name: 'amount', type: 'Float!' }], select: ['id'] },
    result: { jsonata: 'id' },
  },
  update: {
    mutation: { field: 'updateContact', variables: [{ name: 'id', type: 'ID!' }, { name: 'stage', type: 'String' }, { name: 'amount', type: 'Float' }], select: ['id'] },
    body: { jsonata: '$merge([$, {"id": $identifier}])' },
  },
  delete: { mutation: { field: 'deleteContact', variables: [{ name: 'id', type: 'ID!' }], select: ['id'] }, body: { jsonata: '{"id": $identifier}' } },
  bounds: { maxRows: 50 },
};

function manifest(overrides: { fields?: unknown[]; source?: Record<string, unknown>; writes?: unknown } = {}) {
  return doc({
    schemaVersion: '1',
    identity: { name: 'Example GraphQL CRM', provider: 'Example', version: '1.0.0' },
    transport: { viaAgent: false, baseUrl },
    protocol: { kind: 'graphql' },
    auth: { strategy: 'bearer', fields: [{ name: 'token', kind: 'secret', label: 'API token', role: 'token' }] },
    objects: [{
      name: 'contacts', identifier: ['id'],
      fields: overrides.fields ?? [
        { name: 'id', type: 'string' }, { name: 'name', type: 'string' }, { name: 'stage', type: 'string' },
        { name: 'amount', type: 'number' }, { name: 'company', type: 'string', path: 'company.name' },
      ],
      source: {
        kind: 'graphql', root: 'contacts',
        variables: [{ name: 'first', type: 'Int' }, { name: 'after', type: 'String' }, { name: 'stage', type: 'String' }, { name: 'orderBy', type: 'String' }],
        constants: { first: 4 }, recordPath: 'edges.node', select: ['pageInfo.hasNextPage', 'pageInfo.endCursor'],
        paging: {
          next: { cel: 'response.body.data.contacts.pageInfo.hasNextPage ? {"variables": {"after": response.body.data.contacts.pageInfo.endCursor}} : stop()' },
          maxPages: 10,
        },
        ...overrides.source,
      },
      pushdown: {
        filters: [{ field: 'stage', ops: ['eq'], patch: { cel: '{"variables": {"stage": value}}' } }],
        sort: [{ field: 'amount', patch: { cel: '{"variables": {"orderBy": field}}' } }],
        limit: { patch: { cel: '{"variables": {"first": limit}}' } },
      },
      ...(overrides.writes === undefined ? {} : { writes: overrides.writes }),
    }],
  });
}

async function connection(token: string, document: Record<string, never> = manifest()): Promise<string> {
  const connector = await gateway.call(createConnector, { body: { slug: `gql-${uuidv7().slice(-12)}`, name: 'GraphQL CRM', provider: 'Example', sourceRoute: 'visual' } },
    { ...cell.as(root), idempotencyKey: uuidv7() });
  await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document } }, { ...cell.as(root), idempotencyKey: uuidv7() });
  const created = await gateway.call(createConnection, { body: { connectorId: connector.id, name: 'GraphQL CRM', owningScopeId: cell.scopes['engineering']! } },
    { ...cell.as(root), idempotencyKey: uuidv7() });
  await gateway.call(setConnectionSecrets, { params: { connectionId: created.id }, body: { values: { token } } }, cell.as(root));
  await gateway.call(changeConnectionStatus, { params: { connectionId: created.id }, body: { move: 'probe', version: created.version } }, cell.as(root));
  return created.id;
}

const read = (connectionId: string, step: PlanStepInput) =>
  executor.call(readObject, { body: { connectionId, reason: 'probe', step: step as never } }, cell.as(root));

describe('the GraphQL engine (catalogue: query building from the plan)', () => {
  let good: string;

  before(async () => {
    good = await connection('gql_token');
  });

  test('pages by cursor; the selection is built from the fields; nested paths are read', async () => {
    const before = received.length;
    const out = await read(good, { object: 'contacts' });
    assert.equal(out.rows.length, 10);
    assert.equal(out.stats.pages, 3, 'four, four, two');
    assert.deepEqual(out.rows[0], { id: 'g1', name: 'Person 1', stage: 'won', amount: 0.25, company: 'Co 0' });
    const sent = received.slice(before);
    assert.deepEqual(sent.map((r) => r.variables['after'] ?? null), [null, '4', '8']);
    assert.match(sent[0]!.query, /query SiloRead\(\$first: Int, \$after: String, \$stage: String, \$orderBy: String\)/);
    assert.match(sent[0]!.query, /contacts\(first: \$first, after: \$after, stage: \$stage, orderBy: \$orderBy\)/);
    assert.match(sent[0]!.query, /company \{\s*name\s*\}/);
  });

  test('filters, sort and limit are variables; the query text never carries a value', async () => {
    const before = received.length;
    const out = await read(good, {
      object: 'contacts', fields: ['id', 'amount'], filters: [{ field: 'stage', op: 'eq', value: 'won' }], sort: [{ field: 'amount' }], limit: 3,
    });
    assert.deepEqual(out.pushdown.residual, { filters: [], sort: [], limit: null, aggregate: null });
    assert.deepEqual(out.rows.map((r) => r['id']), ['g1', 'g7', 'g3']);
    const sent = received[before]!;
    assert.deepEqual([sent.variables['stage'], sent.variables['orderBy'], sent.variables['first']], ['won', 'amount', 3]);
    assert.ok(!sent.query.includes('won'), 'no value in the query text');
    assert.ok(!/company|name\b/.test(sent.query.replace('SiloRead', '')), 'only the fields asked for are selected');
  });

  test('a filter it cannot push down is computed after, bounded', async () => {
    const out = await read(good, { object: 'contacts', filters: [{ field: 'company', op: 'eq', value: 'Co 1' }] });
    assert.deepEqual(out.pushdown.residual.filters, [{ field: 'company', op: 'eq', value: 'Co 1' }]);
    assert.deepEqual(out.rows.map((r) => r['id']), ['g2', 'g5', 'g8']);
  });

  test('a 200 carrying errors is an error, by its extensions code, never an empty answer', async () => {
    const bad = await connection('wrong');
    await assert.rejects(read(bad, { object: 'contacts' }), { code: 'source.auth' });
    await assert.rejects(read(good, { object: 'contacts', limit: 60 }), { code: 'source.bounds' });
  });

  test('the pushdown compiler explains a GraphQL step as its query and the variables it sets', async () => {
    const out = await planner.call(explainPushdown, {
      body: { connectionId: good, step: { object: 'contacts', filters: [{ field: 'stage', op: 'eq', value: 'open' }], limit: 2 } },
    }, cell.as(root));
    assert.equal(out.native.protocol, 'graphql');
    if (out.native.protocol !== 'graphql') return;
    assert.deepEqual(out.native.variables, ['first', 'stage']);
    assert.ok(!out.native.query.includes('open'));
  });

  test('the registry refuses what the engine cannot run', async () => {
    const connector = await gateway.call(createConnector, { body: { slug: `gql-bad-${uuidv7().slice(-8)}`, name: 'Bad', provider: 'Example', sourceRoute: 'visual' } },
      { ...cell.as(root), idempotencyKey: uuidv7() });
    const save = (document: Record<string, never>) => gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document } },
      { ...cell.as(root), idempotencyKey: uuidv7() });
    await assert.rejects(save(manifest({ fields: [{ name: 'id', type: 'string' }, { name: 'stage', type: 'string' }, { name: 'amount', type: 'number' }, { name: 'label', type: 'string', value: { jsonata: 'name' } }] })),
      { code: 'manifest.protocol_invalid' });
    await assert.rejects(save(manifest({ source: { variables: [{ name: 'first', type: 'Int!!' }], constants: {} } })), { code: 'manifest.protocol_invalid' });
    await assert.rejects(save(manifest({ source: { constants: { nope: 1 } } })), { code: 'manifest.protocol_invalid' });
    await assert.rejects(save(manifest({ source: { root: 'not a name' } })), { code: 'manifest.invalid' });
  });
});

describe('a draft from introspection or SDL (14.4: GraphQL\'s discovery model)', () => {
  const importing = (text: string, withBase = true) => gateway.call(importDraft, {
    body: { kind: 'graphql', text, name: 'GraphQL CRM', provider: 'Example', ...(withBase ? { baseUrl } : {}) },
  }, cell.as(root));

  test('the connection\'s records, variables, cursor paging, filters and limit, with no model; the draft reads the service', async () => {
    const out = await importing(printSchema(schema));
    assert.deepEqual(out.issues, [], JSON.stringify(out.issues));
    const doc = out.document as unknown as { objects: {
      name: string; identifier: string[]; fields: { name: string; path?: string }[];
      source: { root: string; recordPath: string; variables: { name: string; type: string }[]; constants: Record<string, unknown>; paging?: unknown };
      pushdown: { filters: { field: string }[]; limit?: unknown };
    }[]; auth: unknown };
    const o = doc.objects[0]!;
    assert.deepEqual([o.name, o.identifier, o.source.root, o.source.recordPath], ['contacts', ['id'], 'contacts', 'edges.node']);
    assert.deepEqual(o.source.variables, [{ name: 'first', type: 'Int' }, { name: 'after', type: 'String' }, { name: 'stage', type: 'String' }, { name: 'orderBy', type: 'String' }]);
    assert.deepEqual(o.fields.map((f) => [f.name, f.path ?? null]), [['id', null], ['name', null], ['stage', null], ['amount', null], ['company_name', 'company.name']]);
    assert.deepEqual([o.pushdown.filters.map((f) => f.field), o.pushdown.limit !== undefined, o.source.paging !== undefined], [['stage'], true, true]);

    // An introspection result gives the same draft.
    const introspected = await importing(JSON.stringify(graphqlSync({ schema, source: getIntrospectionQuery() })));
    assert.deepEqual((introspected.document as unknown as typeof doc).objects, doc.objects);

    doc.auth = { strategy: 'bearer', fields: [{ name: 'token', kind: 'secret', label: 'API token', role: 'token' }] };
    o.source.constants = { first: 4 };
    const connector = await gateway.call(createConnector, { body: { slug: `gqli-${uuidv7().slice(-12)}`, name: 'GraphQL CRM', provider: 'Example', sourceRoute: 'visual' } },
      { ...cell.as(root), idempotencyKey: uuidv7() });
    await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document: doc as never } }, { ...cell.as(root), idempotencyKey: uuidv7() });
    const created = await gateway.call(createConnection, { body: { connectorId: connector.id, name: 'GraphQL CRM', owningScopeId: cell.scopes['engineering']! } },
      { ...cell.as(root), idempotencyKey: uuidv7() });
    await gateway.call(setConnectionSecrets, { params: { connectionId: created.id }, body: { values: { token: 'gql_token' } } }, cell.as(root));
    await gateway.call(changeConnectionStatus, { params: { connectionId: created.id }, body: { move: 'probe', version: created.version } }, cell.as(root));
    const all = await read(created.id, { object: 'contacts' });
    assert.deepEqual([all.rows.length, all.stats.pages], [10, 3]);
    const won = await read(created.id, { object: 'contacts', fields: ['id'], filters: [{ field: 'stage', op: 'eq', value: 'won' }], limit: 2 });
    assert.deepEqual([won.rows.map((r) => r['id']), won.pushdown.residual], [['g1', 'g3'], { filters: [], sort: [], limit: null, aggregate: null }]);
  });

  test('a schema with nothing to list, or text that is neither, is refused; no base URL is a note', async () => {
    await assert.rejects(importing('type Query { me: String }'), { code: 'visual.import_no_objects' });
    await assert.rejects(importing('not graphql at all {'), { code: 'visual.graphql_unreadable' });
    const bare = await importing(printSchema(schema), false);
    assert.ok(bare.notes.includes('base_url_not_described') && bare.issues.length > 0, 'a draft still, to complete in the builder');
  });
});

describe('GraphQL mutations (spec 14.4, 42.5)', () => {
  let writer: string;
  const write = (connectionId: string, operations: unknown[]) => cell.client('conformance').call(writeRecords, {
    body: { connectionId, object: 'contacts', sandbox: true, operations: operations as never },
  }, cell.as(root));

  before(async () => {
    writer = await connection('gql_token', manifest({ writes: WRITES }));
  });

  test('a create calls its mutation: the document holds no value, the values travel as declared variables', async () => {
    const out = await write(writer, [{ key: 'k1', operation: 'create', values: { name: 'Ada New', stage: 'open', amount: 12.5 } }]);
    assert.deepEqual(out.results.map((r) => [r.outcome, r.identifier]), [['applied', 'g11']]);
    const sent = received.at(-1)!;
    assert.match(sent.query, /^mutation SiloWrite\(\$name: String!, \$stage: String!, \$amount: Float!\)/);
    assert.ok(!sent.query.includes('Ada New'), 'no value in the document');
    assert.deepEqual(sent.variables, { name: 'Ada New', stage: 'open', amount: 12.5 });
  });

  test('an update and a delete name the record; one that finds none fails as not found, never applied', async () => {
    const out = await write(writer, [
      { key: 'u1', operation: 'update_partial', identifier: 'g11', values: { stage: 'won' } },
      { key: 'u2', operation: 'update_partial', identifier: 'g999', values: { stage: 'won' } },
    ]);
    assert.deepEqual(out.results.map((r) => [r.outcome, r.error?.meaning ?? null]), [['applied', null], ['failed', 'not_found']]);
    assert.equal(CONTACTS.find((c) => c.id === 'g11')?.stage, 'won');
    const gone = await write(writer, [{ key: 'd1', operation: 'delete', identifier: 'g11', values: {} }]);
    assert.equal(gone.results[0]!.outcome, 'applied');
    assert.equal(CONTACTS.some((c) => c.id === 'g11'), false);
  });

  test('a 200 carrying an auth error fails the write and stops the plan', async () => {
    const refused = await connection('wrong_token', manifest({ writes: WRITES }));
    const out = await write(refused, [
      { key: 'a', operation: 'create', values: { name: 'X', stage: 'open', amount: 1 } },
      { key: 'b', operation: 'create', values: { name: 'Y', stage: 'open', amount: 1 } },
    ]);
    assert.deepEqual(out.results.map((r) => [r.outcome, r.error?.meaning ?? null]), [['failed', 'auth'], ['not_attempted', null]]);
  });

  test('the registry refuses a GraphQL write that is not a mutation, or one whose variable type does not parse', async () => {
    const connector = await gateway.call(createConnector, { body: { slug: `gql-w-${uuidv7().slice(-8)}`, name: 'Bad writes', provider: 'Example', sourceRoute: 'visual' } },
      { ...cell.as(root), idempotencyKey: uuidv7() });
    const save = (writes: unknown) => gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document: manifest({ writes }) } },
      { ...cell.as(root), idempotencyKey: uuidv7() });
    await assert.rejects(save({ create: { request: { method: 'POST', path: '/graphql' } }, bounds: { maxRows: 5 } }), { code: 'manifest.invalid' });
    await assert.rejects(save({ ...WRITES, create: { mutation: { field: 'createContact', variables: [{ name: 'name', type: 'String!!' }] } } }),
      { code: 'manifest.protocol_invalid' });
  });
});
