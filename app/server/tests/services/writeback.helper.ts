// A cell for the write-back tests: the Connect cell (credential, policy, auth,
// connect-registry) plus connect-runtime with a fake Silo Agent, the ontology, and the
// write-back services as real processes; a fake CRM over REST that keeps its records in
// memory; and a throwaway Postgres database standing in for a customer's, reached only
// through the agent, which runs the engine's generated statements (in a transaction for
// writes).

import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import pg from 'pg';
import { changeConnectionStatus, createConnection, setConnectionSecrets } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import { putLinkType, putObjectType } from '../../src/contracts/ontology/element.contract.ts';
import { grantConnection } from '../../src/contracts/policy/governance.contract.ts';
import { approveProposal, mergeProposal, openBranch, submitProposal } from '../../src/contracts/ontology/proposal.contract.ts';
import { DEFAULT_ADMIN_URL, urlFor } from '../../src/db/scripts/bootstrapLocal.script.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { service as ontologyService } from '../../src/routes/ontology/index.route.ts';
import { RowCountMismatch, SourceSqlError, type AgentChannel } from '../../src/services/connect-runtime/agent.service.ts';
import { AppError } from '../../src/utils/errors.util.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { createConnectCell, doc, type ConnectCell, type Signed } from './connect.helper.ts';

/** A port free now, for services that must know each other's address before they start. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

export interface Contact { id: string; properties: { email: string; name: string; score: number; status?: string; manager?: string | null; reason?: string; due?: string } }

export interface WritebackCell {
  cell: ConnectCell;
  gateway: ServiceClient;
  root: Signed;
  /** The fake CRM's records, by id; tests change them to stand for edits made outside Silo. */
  contacts: Map<string, Contact>;
  /** Requests the fake CRM received: method and path. */
  crmRequests: string[];
  customer: pg.Client;
  restConnection: string;
  sqlConnection: string;
  /** The active ontology version holding the Contact (CRM) and Order (database) types (and, with `custom`, the manager link). */
  ontologyVersionId: string;
  contactTypeId: string;
  orderTypeId: string;
  /** Runs once before the agent's next write transaction: an edit committed outside Silo just before the write. */
  hooks: { beforeTransaction?: (() => Promise<void>) | undefined };
  /** Webhooks the fake agent sent (connect-runtime checked their grants first), and the answers it gives next. */
  agentHttp: {
    sent: { method: string; url: string; headers: Record<string, string>; body: string; granted: boolean; physical?: { action: string; maxPerMinute: number } }[];
    /** What the agent answers next: a status, or its allow-list's refusal of a physical target (47.4). */
    replies: ({ status: number; state: 'applied' | 'pending' | 'failed' | null } | { refused: 'not_listed' | 'kind' | 'interval' | 'rate' })[];
  };
  enableWrites(connectionId: string): Promise<void>;
  /** Grants a member access to a connection, as its owner (root) would. */
  grant(membershipId: string, connectionId: string, access: 'read' | 'write'): Promise<void>;
  close(): Promise<void>;
}

const BEARER = 'Bearer tok_valid';

/** With `replace`: a CRM that takes only a full replacement (PUT), which also creates, and a delete. */
const REPLACING_WRITES = {
  updateFull: { request: { method: 'PUT', path: '/v1/contacts/{identifier}' }, body: { jsonata: '{"properties": $}' } },
  upsert: { request: { method: 'PUT', path: '/v1/contacts/{identifier}' }, body: { jsonata: '{"properties": $}' } },
  delete: { request: { method: 'DELETE', path: '/v1/contacts/{identifier}' } },
  bounds: { maxRows: 50 },
};

/**
 * With `custom`: a contact's status and manager, the custom actions archive_contact (undone by
 * restore_contact) and send_survey (changes the status, and nothing undoes it).
 */
export function contactsManifest(baseUrl: string, extra: { physical?: boolean; custom?: boolean; dated?: boolean; replace?: boolean } = {}) {
  return doc({
    schemaVersion: '1',
    identity: { name: 'Example CRM', provider: 'Example', version: '1.0.0' },
    transport: { viaAgent: false, baseUrl },
    protocol: { kind: 'rest' },
    auth: { strategy: 'bearer', fields: [{ name: 'token', kind: 'secret', label: 'API token', role: 'token' }] },
    objects: [{
      name: 'contacts', identifier: ['id'],
      fields: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'email', type: 'string', path: 'properties.email' },
        { name: 'name', type: 'string', path: 'properties.name' },
        { name: 'score', type: 'integer', path: 'properties.score' },
        ...(extra.custom ? [{ name: 'status', type: 'string', path: 'properties.status' }, { name: 'manager', type: 'string', path: 'properties.manager' }] : []),
        ...(extra.dated ? [{ name: 'due', type: 'date', path: 'properties.due' }] : []),
      ],
      source: { kind: 'rest', request: { method: 'GET', path: '/v1/contacts', query: {} }, records: { jsonata: 'results' } },
      pushdown: { filters: [{ field: 'id', ops: ['eq'], patch: { cel: '{"query": {"id": string(value)}}' } }] },
      writes: extra.replace ? REPLACING_WRITES : {
        create: { request: { method: 'POST', path: '/v1/contacts' }, body: { jsonata: '{"properties": $}' }, result: { jsonata: 'id' } },
        update: { request: { method: 'PATCH', path: '/v1/contacts/{identifier}' }, body: { jsonata: '{"properties": $}' } },
        delete: { request: { method: 'DELETE', path: '/v1/contacts/{identifier}' } },
        ...(extra.custom ? { custom: [
          { name: 'archive_contact', request: { method: 'POST', path: '/v1/contacts/{identifier}/archive' }, changes: ['status'], compensatedBy: 'restore_contact' },
          { name: 'restore_contact', request: { method: 'POST', path: '/v1/contacts/{identifier}/restore' }, body: { jsonata: '{"status": status}' }, changes: ['status'] },
          { name: 'send_survey', request: { method: 'POST', path: '/v1/contacts/{identifier}/survey' }, changes: ['status'] },
        ] } : {}),
        ...(extra.physical ? { risk: 'physical' } : {}),
        bounds: { maxRows: 50, valueCheck: { cel: '!has(values.score) || values.score <= 100' } },
      },
    }],
  });
}

/**
 * With `blast`, the records that reference an order: lines (deleted with it), their notes
 * (likewise), and shipments (kept). With `upsert`, orders are created by upsert only.
 */
export const ordersManifest = (options: { blast?: boolean; upsert?: boolean; across?: boolean } = {}) => doc({
  schemaVersion: '1', identity: { name: 'Orders database', provider: 'Example', version: '1.0.0' },
  transport: { viaAgent: true }, protocol: { kind: 'sql', dialect: 'postgres' },
  auth: { strategy: 'username_password', fields: [{ name: 'username', kind: 'public', label: 'User', role: 'username' }, { name: 'password', kind: 'secret', label: 'Password', role: 'password' }] },
  objects: [{
    name: 'orders', identifier: ['id'],
    fields: [{ name: 'id', type: 'integer', nullable: false }, { name: 'customer', type: 'string' }, { name: 'status', type: 'string' }, { name: 'amount', type: 'number' }],
    source: { kind: 'sql', schema: 'sales', table: 'orders' },
    pushdown: { filters: [{ field: 'id', ops: ['eq', 'in'] }] },
    writes: options.upsert ? { upsert: {}, update: {}, delete: {}, bounds: { maxRows: 100 } } : { create: {}, update: {}, delete: {}, bounds: { maxRows: 100 } },
  }, ...(options.across ? [{
    name: 'customers', identifier: ['id'],
    fields: [{ name: 'id', type: 'integer', nullable: false }, { name: 'email', type: 'string' }],
    source: { kind: 'sql', schema: 'sales', table: 'customers' },
    pushdown: { filters: [{ field: 'id', ops: ['eq', 'in'] }, { field: 'email', ops: ['eq'] }] },
  }, {
    name: 'tickets', identifier: ['id'],
    fields: [{ name: 'id', type: 'integer', nullable: false }, { name: 'customer_id', type: 'integer' }, { name: 'subject', type: 'string' }],
    source: { kind: 'sql', schema: 'sales', table: 'tickets' },
    pushdown: { filters: [{ field: 'id', ops: ['eq', 'in'] }, { field: 'customer_id', ops: ['eq'] }] },
    writes: { update: {}, bounds: { maxRows: 100 } },
  }, {
    // Complaints name the CRM's contact by its own id: a key into another system (D248).
    name: 'complaints', identifier: ['id'],
    fields: [{ name: 'id', type: 'integer', nullable: false }, { name: 'contact_ref', type: 'string' }],
    source: { kind: 'sql', schema: 'sales', table: 'complaints' },
    pushdown: { filters: [{ field: 'id', ops: ['eq', 'in'] }, { field: 'contact_ref', ops: ['eq', 'in'] }] },
    writes: { update: {}, bounds: { maxRows: 100 } },
  }] : []), ...(options.blast ? [{
    name: 'order_lines', identifier: ['id'],
    fields: [{ name: 'id', type: 'integer', nullable: false }, { name: 'order_id', type: 'integer' }, { name: 'sku', type: 'string' }],
    source: { kind: 'sql', schema: 'sales', table: 'order_lines' },
    pushdown: { filters: [{ field: 'order_id', ops: ['eq', 'in'] }] },
    relationships: [{ field: 'order_id', targetObject: 'orders', targetField: 'id', kind: 'foreign_key', onDelete: 'cascade' }],
  }, {
    name: 'line_notes', identifier: ['id'],
    fields: [{ name: 'id', type: 'integer', nullable: false }, { name: 'line_id', type: 'integer' }],
    source: { kind: 'sql', schema: 'sales', table: 'line_notes' },
    pushdown: { filters: [{ field: 'line_id', ops: ['eq', 'in'] }] },
    relationships: [{ field: 'line_id', targetObject: 'order_lines', targetField: 'id', kind: 'foreign_key', onDelete: 'cascade' }],
  }, {
    name: 'shipments', identifier: ['id'],
    fields: [{ name: 'id', type: 'integer', nullable: false }, { name: 'order_id', type: 'integer' }],
    source: { kind: 'sql', schema: 'sales', table: 'shipments' },
    pushdown: { filters: [{ field: 'order_id', ops: ['eq', 'in'] }] },
    relationships: [{ field: 'order_id', targetObject: 'orders', targetField: 'id', kind: 'foreign_key', onDelete: 'set_null' }],
    writes: { update: {}, bounds: { maxRows: 100 } },
  }] : [])],
});

export async function createWritebackCell(options: {
  start?: (cell: ConnectCell) => Promise<void>; blast?: boolean; custom?: boolean; dated?: boolean;
  /** Sources that take only full updates and upserts (spec 42.5, 48.1). */
  replace?: boolean;
  /**
   * Contacts in both systems, matched by email: customers in the database too, and their
   * tickets, linked to the contact by a key only the database holds (spec 43.7).
   */
  across?: boolean;
} = {}): Promise<WritebackCell> {
  const contacts = new Map<string, Contact>();
  const crmRequests: string[] = [];
  let nextId = 100;
  for (let i = 1; i <= 5; i++) {
    contacts.set(`c${i}`, {
      id: `c${i}`, properties: {
        email: `p${i}@example.com`, name: `Person ${i}`, score: i * 10, ...(options.custom ? { status: 'active', manager: null } : {}),
        ...(options.dated ? { due: '2026-12-01' } : {}),
      },
    });
  }

  const api: Server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    crmRequests.push(`${req.method} ${url.pathname}`);
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    if (req.headers.authorization !== BEARER) return send(401, { message: 'bad token' });
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); });
    req.on('end', () => {
      const body = raw === '' ? {} : JSON.parse(raw) as { properties?: Partial<Contact['properties']>; reason?: string; status?: string };
      const match = /^\/v1\/contacts\/([^/]+)$/.exec(url.pathname);
      const action = /^\/v1\/contacts\/([^/]+)\/(archive|restore|survey)$/.exec(url.pathname);
      if (req.method === 'POST' && action !== null) {
        const found = contacts.get(decodeURIComponent(action[1]!));
        if (found === undefined) return send(404, { message: 'no such contact' });
        if (action[2] === 'archive') found.properties = { ...found.properties, status: 'archived', ...(body.reason === undefined ? {} : { reason: body.reason }) };
        if (action[2] === 'restore') found.properties = { ...found.properties, status: body.status ?? 'active' };
        if (action[2] === 'survey') found.properties = { ...found.properties, status: 'surveyed' };
        return send(200, found);
      }
      if (req.method === 'GET' && url.pathname === '/v1/contacts') {
        const id = url.searchParams.get('id');
        const rows = [...contacts.values()].filter((c) => id === null || c.id === id);
        return send(200, { results: rows });
      }
      if (req.method === 'POST' && url.pathname === '/v1/contacts') {
        const id = `c${nextId++}`;
        const props = body.properties ?? {};
        contacts.set(id, { id, properties: { email: props.email ?? '', name: props.name ?? '', score: props.score ?? 0 } });
        return send(201, { id });
      }
      if (match !== null) {
        const id = decodeURIComponent(match[1]!);
        if (req.method === 'PUT') {
          // A full replacement, creating the contact if it is new: a field left out is cleared.
          const props = body.properties ?? {};
          const existed = contacts.has(id);
          contacts.set(id, { id, properties: { email: props.email ?? null, name: props.name ?? null, score: props.score ?? null } as never });
          return send(existed ? 200 : 201, contacts.get(id));
        }
        const found = contacts.get(id);
        if (found === undefined) return send(404, { message: 'no such contact' });
        if (req.method === 'PATCH') {
          // The CRM truncates names to 12 characters: a source-side transform (spec 45.6).
          const props = { ...body.properties };
          if (typeof props.name === 'string') props.name = props.name.slice(0, 12);
          found.properties = { ...found.properties, ...props } as Contact['properties'];
          return send(200, found);
        }
        if (req.method === 'DELETE') {
          contacts.delete(id);
          return send(204, undefined);
        }
      }
      return send(404, {});
    });
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`;

  const customerDb = `wb_customer_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new pg.Client({ connectionString: DEFAULT_ADMIN_URL });
  await admin.connect();
  await admin.query(`create database ${customerDb}`);
  await admin.end();
  const customer = new pg.Client({ connectionString: urlFor(DEFAULT_ADMIN_URL, customerDb) });
  await customer.connect();
  await customer.query(`
    create schema sales;
    create table sales.orders (id integer primary key, customer text not null, status text not null, amount numeric(12,2) not null);
    insert into sales.orders select g, 'customer ' || g, 'open', (g * 10)::numeric(12,2) from generate_series(1, 10) g;`);
  if (options.across) {
    await customer.query(`
      create table sales.customers (id integer primary key, email text not null);
      create table sales.tickets (id integer primary key, customer_id integer references sales.customers (id), subject text);
      insert into sales.customers values (7, 'p1@example.com'), (8, 'p2@example.com');
      insert into sales.tickets values (1, 7, 'a'), (2, 7, 'b'), (3, 8, 'c');
      create table sales.complaints (id integer primary key, contact_ref text);
      insert into sales.complaints values (1, 'c1'), (2, 'c2'), (3, 'c1'), (4, 'c1');`);
  }
  if (options.blast) {
    await customer.query(`
      create table sales.order_lines (id integer primary key, order_id integer references sales.orders (id) on delete cascade, sku text);
      create table sales.line_notes (id integer primary key, line_id integer references sales.order_lines (id) on delete cascade);
      create table sales.shipments (id integer primary key, order_id integer references sales.orders (id) on delete set null);
      insert into sales.order_lines values (1, 1, 'a'), (2, 1, 'b');
      insert into sales.line_notes values (1, 1), (2, 2);
      insert into sales.shipments values (1, 1);
      insert into sales.order_lines select 100 + g, 2, 'bulk' from generate_series(1, 101) g;`);
  }

  const hooks: WritebackCell['hooks'] = {};
  const agentHttp: WritebackCell['agentHttp'] = { sent: [], replies: [] };
  const agent: AgentChannel = {
    async http(input) {
      agentHttp.sent.push({ ...input.statements[0], granted: input.grant !== undefined });
      const reply = agentHttp.replies.shift() ?? { status: 200, state: null };
      if ('refused' in reply) {
        throw new AppError('forbidden', 'the agent refused the physical write', { code: 'actuation.refused_by_agent', details: { reason: reply.refused } });
      }
      return reply;
    },
    async query(input) {
      try {
        const result = await customer.query({ text: input.statement.text, values: input.statement.values });
        return { rows: result.rows.slice(0, input.maxRows) };
      } catch (error) {
        throw new SourceSqlError(String((error as { code?: string }).code ?? 'XX000'));
      }
    },
    async transaction(input) {
      const hook = hooks.beforeTransaction;
      hooks.beforeTransaction = undefined;
      await hook?.();
      await customer.query('begin');
      const rowCounts: number[] = [];
      try {
        for (const [i, statement] of input.statements.entries()) {
          const result = await customer.query({ text: statement.text, values: statement.values });
          const rows = result.rowCount ?? 0;
          if (statement.expectRows !== undefined && rows !== statement.expectRows) throw new RowCountMismatch(i, rows);
          rowCounts.push(rows);
        }
        await customer.query('commit');
        return { rowCounts };
      } catch (error) {
        await customer.query('rollback');
        if (error instanceof RowCountMismatch) throw error;
        throw new SourceSqlError(String((error as { code?: string }).code ?? 'XX000'));
      }
    },
  };

  const cell = await createConnectCell();
  try {
    await cell.start(createConnectRuntimeService({ agent }), 'connect-runtime', 'test_app');
    await cell.start(ontologyService, 'ontology', 'test_app');
    await options.start?.(cell);
  } catch (error) {
    await cell.close();
    throw error;
  }
  const gateway = cell.client('gateway');
  const root = await cell.signIn('root@acme.example');
  const keyed = () => ({ ...cell.as(root), idempotencyKey: uuidv7() });

  async function activeConnection(document: Record<string, never>, secrets: Record<string, string>, extra: { agentPoolId?: string } = {}): Promise<string> {
    const connector = await gateway.call(createConnector, { body: { slug: `c-${uuidv7().slice(-12)}`, name: 'Source', provider: 'Example', sourceRoute: 'visual' } }, keyed());
    await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document } }, keyed());
    let connection = await gateway.call(createConnection, {
      body: { connectorId: connector.id, name: 'Source', owningScopeId: cell.scopes['engineering']!, ...extra },
    }, keyed());
    if (Object.keys(secrets).length > 0) await gateway.call(setConnectionSecrets, { params: { connectionId: connection.id }, body: { values: secrets } }, cell.as(root));
    for (const move of ['probe', 'confirm', 'activate'] as const) {
      if (move === 'confirm') await cell.passConformance(connection.id);
      connection = await gateway.call(changeConnectionStatus, { params: { connectionId: connection.id }, body: { move, version: connection.version } }, cell.as(root));
    }
    return connection.id;
  }

  const restConnection = await activeConnection(contactsManifest(baseUrl, {
    custom: options.custom ?? false, dated: options.dated ?? false, replace: options.replace ?? false,
  }), { token: 'tok_valid' });
  const pool = uuidv7();
  await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
    `insert into connect.agent_pools (id, organisation_id, name, created_by) values ($1, $2, 'Office', $3)`, [pool, cell.org, root.membershipId]));
  const sqlConnection = await activeConnection(ordersManifest({ blast: options.blast ?? false, upsert: options.replace ?? false, across: options.across ?? false }), {},
    { agentPoolId: pool });

  // The ontology: a Contact over the CRM and an Order over the database, merged into main.
  const editor = await cell.member('editor@acme.example', 'Super admin');
  const branch = await gateway.call(openBranch, { body: { name: 'write-back model' } }, { ...cell.as(editor), idempotencyKey: uuidv7() });
  await gateway.call(putObjectType, { params: { branchId: branch.id, apiName: 'contact' }, body: {
    displayName: 'Contact', pluralName: 'Contacts',
    contributingObjects: [
      { connectionId: restConnection, sourceObject: 'contacts', identifierFieldPath: 'id' },
      ...(options.across ? [{ connectionId: sqlConnection, sourceObject: 'customers', identifierFieldPath: 'id' }] : []),
    ],
    properties: [
      { apiName: 'contact_id', displayName: 'Contact id', dataType: 'string', nullable: false, mappings: [{ connectionId: restConnection, sourceObject: 'contacts', fieldPath: 'id' }] },
      { apiName: 'email', displayName: 'Email', dataType: 'string', mappings: [
        { connectionId: restConnection, sourceObject: 'contacts', fieldPath: 'email' },
        ...(options.across ? [{ connectionId: sqlConnection, sourceObject: 'customers', fieldPath: 'email' }] : []),
      ] },
      { apiName: 'name', displayName: 'Name', dataType: 'string', mappings: [{ connectionId: restConnection, sourceObject: 'contacts', fieldPath: 'name' }] },
      { apiName: 'score', displayName: 'Score', dataType: 'integer', mappings: [{ connectionId: restConnection, sourceObject: 'contacts', fieldPath: 'score' }] },
      ...(options.dated ? [{ apiName: 'due', displayName: 'Due', dataType: 'date', mappings: [{ connectionId: restConnection, sourceObject: 'contacts', fieldPath: 'due' }] }] : []),
    ],
    ...(options.across ? { matchKeys: [{ property: 'email' }] } : { primaryKey: 'contact_id' }), title: 'email',
  } as never }, { ...cell.as(editor), idempotencyKey: uuidv7() });
  if (options.across) {
    await gateway.call(putObjectType, { params: { branchId: branch.id, apiName: 'ticket' }, body: {
      displayName: 'Ticket', pluralName: 'Tickets',
      contributingObjects: [{ connectionId: sqlConnection, sourceObject: 'tickets', identifierFieldPath: 'id' }],
      properties: [
        { apiName: 'ticket_id', displayName: 'Ticket id', dataType: 'integer', nullable: false, mappings: [{ connectionId: sqlConnection, sourceObject: 'tickets', fieldPath: 'id' }] },
        { apiName: 'subject', displayName: 'Subject', dataType: 'string', mappings: [{ connectionId: sqlConnection, sourceObject: 'tickets', fieldPath: 'subject' }] },
      ],
      primaryKey: 'ticket_id', title: 'subject',
    } as never }, { ...cell.as(editor), idempotencyKey: uuidv7() });
    await gateway.call(putLinkType, { params: { branchId: branch.id, apiName: 'raised' }, body: {
      forwardName: 'raised', reverseName: 'raised by', from: 'contact', to: 'ticket', cardinality: 'one_to_many',
      routes: [{ connectionId: sqlConnection, sourceObject: 'tickets', foreignKeyField: 'customer_id', referencedField: 'id' }], defaultRoute: 0,
    } }, { ...cell.as(editor), idempotencyKey: uuidv7() });
    await gateway.call(putObjectType, { params: { branchId: branch.id, apiName: 'complaint' }, body: {
      displayName: 'Complaint', pluralName: 'Complaints',
      contributingObjects: [{ connectionId: sqlConnection, sourceObject: 'complaints', identifierFieldPath: 'id' }],
      properties: [
        { apiName: 'complaint_id', displayName: 'Complaint id', dataType: 'integer', nullable: false, mappings: [{ connectionId: sqlConnection, sourceObject: 'complaints', fieldPath: 'id' }] },
        { apiName: 'contact_ref', displayName: 'Contact', dataType: 'string', mappings: [{ connectionId: sqlConnection, sourceObject: 'complaints', fieldPath: 'contact_ref' }] },
      ],
      primaryKey: 'complaint_id', title: 'contact_ref',
    } as never }, { ...cell.as(editor), idempotencyKey: uuidv7() });
    // The key is held in the database; what it names is read in the CRM (D248).
    await gateway.call(putLinkType, { params: { branchId: branch.id, apiName: 'complained' }, body: {
      forwardName: 'complained', reverseName: 'complaint of', from: 'contact', to: 'complaint', cardinality: 'one_to_many',
      routes: [{ connectionId: sqlConnection, sourceObject: 'complaints', foreignKeyField: 'contact_ref', referencedField: 'id', referencedConnectionId: restConnection,
        referencedObject: 'contacts', origin: 'person_declared' }], defaultRoute: 0,
    } }, { ...cell.as(editor), idempotencyKey: uuidv7() });
  }
  await gateway.call(putObjectType, { params: { branchId: branch.id, apiName: 'order' }, body: {
    displayName: 'Order', pluralName: 'Orders',
    contributingObjects: [{ connectionId: sqlConnection, sourceObject: 'orders', identifierFieldPath: 'id' }],
    properties: [
      { apiName: 'order_id', displayName: 'Order id', dataType: 'integer', nullable: false, mappings: [{ connectionId: sqlConnection, sourceObject: 'orders', fieldPath: 'id' }] },
      { apiName: 'customer', displayName: 'Customer', dataType: 'string', nullable: false, mappings: [{ connectionId: sqlConnection, sourceObject: 'orders', fieldPath: 'customer' }] },
      { apiName: 'status', displayName: 'Status', dataType: 'string', nullable: false, mappings: [{ connectionId: sqlConnection, sourceObject: 'orders', fieldPath: 'status' }] },
      { apiName: 'amount', displayName: 'Amount', dataType: 'decimal', nullable: false, mappings: [{ connectionId: sqlConnection, sourceObject: 'orders', fieldPath: 'amount' }] },
    ],
    primaryKey: 'order_id', title: 'customer',
  } as never }, { ...cell.as(editor), idempotencyKey: uuidv7() });
  if (options.custom) {
    // A contact's manager: a foreign key the contact holds, referencing another contact's identifier.
    await gateway.call(putLinkType, { params: { branchId: branch.id, apiName: 'manager' }, body: {
      forwardName: 'reports to', reverseName: 'manages', from: 'contact', to: 'contact', cardinality: 'one_to_many',
      routes: [{ connectionId: restConnection, sourceObject: 'contacts', foreignKeyField: 'manager', referencedField: 'id' }], defaultRoute: 0,
    } }, { ...cell.as(editor), idempotencyKey: uuidv7() });
  }
  const proposal = await gateway.call(submitProposal, { params: { branchId: branch.id }, body: { title: 'Write-back model' } }, { ...cell.as(editor), idempotencyKey: uuidv7() });
  await gateway.call(approveProposal, { params: { proposalId: proposal.id }, body: { permission: 'ontology.confirm' } }, cell.as(root));
  const merged = await gateway.call(mergeProposal, { params: { proposalId: proposal.id } }, keyed());
  const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
    'select id, api_name from ontology.object_types where organisation_id = $1', [cell.org]));
  const typeId = (name: string) => rows.find((r) => r.api_name === name)!.id as string;

  return {
    cell, gateway, root, contacts, crmRequests, customer, restConnection, sqlConnection, hooks, agentHttp,
    ontologyVersionId: merged.version.id, contactTypeId: typeId('contact'), orderTypeId: typeId('order'),
    async enableWrites(connectionId) {
      // As the write-verify-undo class would, once passed (tests/services/writebackConformance.test.ts runs the real one).
      await inTx(cell.app, { orgId: cell.org }, () => cell.app.query('update connect.connections set writes_enabled = true where id = $1', [connectionId]));
    },
    async grant(membershipId, connectionId, access) {
      await gateway.call(grantConnection, { body: { connectionId, grantee: { kind: 'membership', id: membershipId }, access } }, cell.as(root));
    },
    async close() {
      await cell.close();
      api.close();
      await customer.end();
      const cleanup = new pg.Client({ connectionString: DEFAULT_ADMIN_URL });
      await cleanup.connect();
      await cleanup.query(`drop database if exists ${customerDb} with (force)`);
      await cleanup.end();
    },
  };
}
