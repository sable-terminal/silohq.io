// The SOAP protocol engine end to end (spec 14.4): a manifest, not code, connects a SOAP
// service. The engine builds the envelope from the manifest's operation, pages by token,
// pushes filters and limits down as parameters (escaped element text, never structure),
// reads records whether an element repeats or not, treats a Fault by its code (a client
// fault sent with 500 is not retried), refuses a response carrying a DTD, and the registry
// refuses what the engine cannot run.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { XMLParser } from 'fast-xml-parser';
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
import { buildEnvelope, escapeText, faultOf, readEnvelope } from '../../src/services/connect-runtime/protocols/soap/envelope.protocol.ts';
import { uuidv7 } from '../db/harness.helper.ts';
import { createConnectCell, doc, type ConnectCell, type Signed } from './connect.helper.ts';

let cell: ConnectCell;
let gateway: ServiceClient;
let executor: ServiceClient;
let planner: ServiceClient;
let root: Signed;
let api: Server;
let baseUrl: string;
const received: { headers: IncomingHttpHeaders; text: string; params: Record<string, string> }[] = [];

const CONTACTS = Array.from({ length: 9 }, (_, i) => ({
  id: `s${i + 1}`, name: i === 0 ? 'Smith & <Sons>' : `Person ${i + 1}`, stage: i % 2 === 0 ? 'won' : 'open', amount: i + 0.5,
  company: i % 3 === 2 ? null : `Co ${i % 3}`,
}));

const esc = (t: string) => t.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const fault = (code: string, reason: string) =>
  `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultcode>soap:${code}</faultcode><faultstring>${reason}</faultstring></soap:Fault></soap:Body></soap:Envelope>`;
const requestParser = new XMLParser({ removeNSPrefix: true, parseTagValue: false });

/** The UsernameToken the service accepts (WS-Security): this user, this password, as text or the profile's digest. */
const WS_USER = 'svc';
const WS_PASSWORD = 'p&ss<word>';
function tokenAccepted(token: Record<string, string> | undefined): boolean {
  if (token === undefined || token['Username'] !== WS_USER) return false;
  if (token['Nonce'] === undefined) return token['Password'] === WS_PASSWORD;
  const digest = createHash('sha1').update(Buffer.concat([Buffer.from(token['Nonce'], 'base64'), Buffer.from(token['Created']!, 'utf8'), Buffer.from(WS_PASSWORD, 'utf8')])).digest('base64');
  return token['Password'] === digest;
}
const reply = (inner: string) => `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${inner}</soap:Body></soap:Envelope>`;

before(async () => {
  api = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString();
      const parsed = (requestParser.parse(text) as { Envelope: { Header?: { Security?: { UsernameToken?: Record<string, string> } }; Body: Record<string, Record<string, string> | string> } }).Envelope;
      const body = parsed.Body;
      const op = body['GetContacts'];
      const params = typeof op === 'object' ? op : {};
      received.push({ headers: req.headers, text, params });
      res.setHeader('content-type', 'text/xml; charset=utf-8');
      if (req.headers.authorization !== 'Bearer soap_token' && !tokenAccepted(parsed.Header?.Security?.UsernameToken)) { res.statusCode = 401; res.end('unauthorised'); return; }
      // Writes: create answers the new id; update finds the record or faults.
      const create = body['CreateContact'];
      if (typeof create === 'object') {
        const id = `s${CONTACTS.length + 1}`;
        CONTACTS.push({ id, name: create['name']!, stage: create['stage']!, amount: Number(create['amount']), company: null });
        res.end(reply(`<ns:CreateContactResponse xmlns:ns="urn:example:crm"><ns:id>${id}</ns:id></ns:CreateContactResponse>`));
        return;
      }
      const update = body['UpdateContact'];
      if (typeof update === 'object') {
        const found = CONTACTS.find((c) => c.id === update['id']);
        if (found === undefined || update['stage'] === 'bad') { res.statusCode = 500; res.end(fault('Client', 'no such contact, or no such stage')); return; }
        found.stage = update['stage']!;
        res.end(reply('<ns:UpdateContactResponse xmlns:ns="urn:example:crm"><ns:ok>true</ns:ok></ns:UpdateContactResponse>'));
        return;
      }
      if (params['stage'] === 'bad') { res.statusCode = 500; res.end(fault('Client', 'stage is not a stage')); return; }
      if (params['stage'] === 'boom') { res.statusCode = 500; res.end(fault('Server', 'the database is down')); return; }
      if (params['stage'] === 'dtd') { res.end('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><x>&a;</x>'); return; }
      const size = Number(params['pageSize'] ?? 10);
      const start = Number(params['pageToken'] ?? 0);
      const rows = params['stage'] === undefined ? CONTACTS : CONTACTS.filter((c) => c.stage === params['stage']);
      const page = rows.slice(start, start + size);
      const contacts = page.map((c) => `<ns:contact><ns:id>${c.id}</ns:id><ns:name>${esc(c.name)}</ns:name><ns:stage>${c.stage}</ns:stage>`
        + `<ns:amount>${c.amount}</ns:amount>${c.company === null ? '<ns:company xsi:nil="true"/>' : `<ns:company><ns:name>${c.company}</ns:name></ns:company>`}</ns:contact>`);
      const more = start + size < rows.length ? `<ns:nextPageToken>${start + size}</ns:nextPageToken>` : '';
      const envelope = String(req.headers['content-type']).startsWith('application/soap+xml')
        ? 'http://www.w3.org/2003/05/soap-envelope' : 'http://schemas.xmlsoap.org/soap/envelope/';
      res.end(`<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="${envelope}"><soap:Body>`
        + `<ns:GetContactsResponse xmlns:ns="urn:example:crm" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`
        + `<ns:contacts>${contacts.join('')}</ns:contacts>${more}</ns:GetContactsResponse></soap:Body></soap:Envelope>`);
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

const BEARER = { strategy: 'bearer', fields: [{ name: 'token', kind: 'secret', label: 'API token', role: 'token' }] };
const WS_SECURITY = (password: 'text' | 'digest') => ({
  strategy: 'ws_security', wsSecurity: { password },
  fields: [{ name: 'username', kind: 'public', label: 'User', role: 'username' }, { name: 'password', kind: 'secret', label: 'Password', role: 'password' }],
});
const WRITES = {
  create: {
    soap: { action: 'urn:example:crm/CreateContact', operation: 'CreateContact', namespace: 'urn:example:crm', parameters: [{ name: 'name' }, { name: 'stage' }, { name: 'amount' }] },
    result: { jsonata: 'CreateContactResponse.id' },
  },
  update: {
    soap: { action: 'urn:example:crm/UpdateContact', operation: 'UpdateContact', namespace: 'urn:example:crm', parameters: [{ name: 'id' }, { name: 'stage' }] },
    body: { jsonata: '$merge([$, {"id": $identifier}])' },
  },
  bounds: { maxRows: 50 },
};

function manifest(overrides: { fields?: unknown[]; source?: Record<string, unknown>; version?: '1.1' | '1.2'; writes?: unknown; auth?: unknown } = {}) {
  return doc({
    schemaVersion: '1',
    identity: { name: 'Example SOAP CRM', provider: 'Example', version: '1.0.0' },
    transport: { viaAgent: false, baseUrl },
    protocol: { kind: 'soap', version: overrides.version ?? '1.1' },
    auth: overrides.auth ?? BEARER,
    objects: [{
      name: 'contacts', identifier: ['id'],
      fields: overrides.fields ?? [
        { name: 'id', type: 'string' }, { name: 'name', type: 'string' }, { name: 'stage', type: 'string' },
        { name: 'amount', type: 'number' }, { name: 'company', type: 'string', path: 'company.name' },
      ],
      source: {
        kind: 'soap', path: '/soap', action: 'urn:example:crm/GetContacts', operation: 'GetContacts', namespace: 'urn:example:crm',
        parameters: [{ name: 'pageSize' }, { name: 'pageToken' }, { name: 'stage' }], constants: { pageSize: 4 },
        recordPath: 'GetContactsResponse.contacts.contact',
        paging: {
          next: { cel: 'has(response.body.GetContactsResponse.nextPageToken) ? {"variables": {"pageToken": response.body.GetContactsResponse.nextPageToken}} : stop()' },
          maxPages: 10,
        },
        ...overrides.source,
      },
      pushdown: {
        filters: [{ field: 'stage', ops: ['eq'], patch: { cel: '{"variables": {"stage": value}}' } }],
        limit: { patch: { cel: '{"variables": {"pageSize": limit}}' } },
      },
      ...(overrides.writes === undefined ? {} : { writes: overrides.writes }),
    }],
  });
}

async function connection(token: string, version: '1.1' | '1.2' = '1.1', options: { document?: Record<string, never>; secrets?: Record<string, string> } = {}): Promise<string> {
  const connector = await gateway.call(createConnector, { body: { slug: `soap-${uuidv7().slice(-12)}`, name: 'SOAP CRM', provider: 'Example', sourceRoute: 'visual' } },
    { ...cell.as(root), idempotencyKey: uuidv7() });
  await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document: options.document ?? manifest({ version }) } },
    { ...cell.as(root), idempotencyKey: uuidv7() });
  const created = await gateway.call(createConnection, { body: { connectorId: connector.id, name: 'SOAP CRM', owningScopeId: cell.scopes['engineering']! } },
    { ...cell.as(root), idempotencyKey: uuidv7() });
  await gateway.call(setConnectionSecrets, { params: { connectionId: created.id }, body: { values: options.secrets ?? { token } } }, cell.as(root));
  await gateway.call(changeConnectionStatus, { params: { connectionId: created.id }, body: { move: 'probe', version: created.version } }, cell.as(root));
  return created.id;
}

const read = (connectionId: string, step: PlanStepInput) =>
  executor.call(readObject, { body: { connectionId, reason: 'probe', step: step as never } }, cell.as(root));

describe('SOAP envelopes', () => {
  test('values are escaped element text, in the declared order; a character XML cannot carry is refused', () => {
    const text = buildEnvelope('1.1', { operation: 'GetContacts', namespace: 'urn:example:crm', qualified: false, parameters: [{ name: 'stage' }, { name: 'ids' }] },
      { ids: ['a', 'b'], stage: '<won> & "lost"' });
    assert.match(text, /<soap:Envelope xmlns:soap="http:\/\/schemas\.xmlsoap\.org\/soap\/envelope\/">/);
    assert.match(text, /<m:GetContacts xmlns:m="urn:example:crm"><stage>&lt;won&gt; &amp; "lost"<\/stage><ids>a<\/ids><ids>b<\/ids><\/m:GetContacts>/);
    assert.throws(() => escapeText('a\u0001b'), { code: 'soap.value_invalid_character' });
    assert.throws(() => escapeText('a\uD800b'), { code: 'soap.value_invalid_character' });
  });

  test('a response is read without its prefixes, nil as null, entities once; a DTD is refused unread', () => {
    const body = readEnvelope('<s:Envelope xmlns:s="x"><s:Body><r:R xmlns:r="y" xmlns:i="z"><r:a k="v">A &amp;#38; &#233;</r:a><r:n i:nil="true"/><r:e/></r:R></s:Body></s:Envelope>');
    assert.deepEqual(body, { R: { a: 'A &#38; é', n: null, e: '' } });
    assert.throws(() => readEnvelope('<!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>'), { code: 'source.upstream' });
    assert.equal(faultOf({ Fault: { Code: { Value: 'env:Sender' } } }), 'validation');
    assert.equal(faultOf({ Fault: { faultcode: 'soap:Server' } }), 'upstream');
    assert.equal(faultOf({ R: {} }), undefined);
  });
});

describe('the SOAP engine (catalogue and visual builder: envelopes from the manifest)', () => {
  let good: string;

  before(async () => {
    good = await connection('soap_token');
  });

  test('pages by token; an element repeated or not is a record; values decoded, nil empty, nested paths read', async () => {
    const before = received.length;
    const out = await read(good, { object: 'contacts' });
    assert.equal(out.rows.length, 9);
    assert.equal(out.stats.pages, 3, 'four, four, one');
    assert.deepEqual(out.rows[0], { id: 's1', name: 'Smith & <Sons>', stage: 'won', amount: 0.5, company: 'Co 0' });
    assert.equal(out.rows[2]!['company'], null, 'xsi:nil');
    assert.equal(out.rows[8]!['id'], 's9', 'the last page holds one record, not repeated');
    const sent = received.slice(before);
    assert.deepEqual(sent.map((r) => r.params['pageToken'] ?? null), [null, '4', '8']);
    assert.equal(sent[0]!.headers['soapaction'], '"urn:example:crm/GetContacts"');
    assert.equal(sent[0]!.headers['content-type'], 'text/xml; charset=utf-8');
    assert.match(sent[0]!.text, /<m:GetContacts xmlns:m="urn:example:crm"><m:pageSize>4<\/m:pageSize><\/m:GetContacts>/);
  });

  test('filters and limits are parameters, their values escaped text; a filter it cannot push is computed after', async () => {
    let before = received.length;
    const out = await read(good, { object: 'contacts', fields: ['id'], filters: [{ field: 'stage', op: 'eq', value: 'won' }], limit: 2 });
    assert.deepEqual(out.pushdown.residual, { filters: [], sort: [], limit: null, aggregate: null });
    assert.deepEqual(out.rows.map((r) => r['id']), ['s1', 's3']);
    assert.deepEqual([received[before]!.params['stage'], received[before]!.params['pageSize']], ['won', '2']);
    before = received.length;
    const odd = await read(good, { object: 'contacts', filters: [{ field: 'stage', op: 'eq', value: '<won>' }] });
    assert.equal(odd.rows.length, 0);
    assert.match(received[before]!.text, /<m:stage>&lt;won&gt;<\/m:stage>/, 'a value never becomes markup');
    const after = await read(good, { object: 'contacts', filters: [{ field: 'company', op: 'eq', value: 'Co 1' }] });
    assert.deepEqual(after.pushdown.residual.filters, [{ field: 'company', op: 'eq', value: 'Co 1' }]);
    assert.deepEqual(after.rows.map((r) => r['id']), ['s2', 's5', 's8']);
  });

  test('a Fault by its code: the client\'s is not retried though sent with 500, the server\'s is; a DTD is refused; 401 is auth', async () => {
    let before = received.length;
    await assert.rejects(read(good, { object: 'contacts', filters: [{ field: 'stage', op: 'eq', value: 'bad' }] }), { code: 'source.validation' });
    assert.equal(received.length - before, 1, 'not retried');
    before = received.length;
    await assert.rejects(read(good, { object: 'contacts', filters: [{ field: 'stage', op: 'eq', value: 'boom' }] }), { code: 'source.upstream' });
    assert.ok(received.length - before > 1, 'retried');
    await assert.rejects(read(good, { object: 'contacts', filters: [{ field: 'stage', op: 'eq', value: 'dtd' }] }), { code: 'source.upstream' });
    await assert.rejects(read(await connection('wrong'), { object: 'contacts' }), { code: 'source.auth' });
  });

  test('SOAP 1.2: its envelope, and the action in the content type', async () => {
    const twelve = await connection('soap_token', '1.2');
    const before = received.length;
    const out = await read(twelve, { object: 'contacts', limit: 1 });
    assert.equal(out.rows.length, 1);
    const sent = received[before]!;
    assert.equal(sent.headers['content-type'], 'application/soap+xml; charset=utf-8; action="urn:example:crm/GetContacts"');
    assert.equal(sent.headers['soapaction'], undefined);
    assert.match(sent.text, /xmlns:soap="http:\/\/www\.w3\.org\/2003\/05\/soap-envelope"/);
  });

  test('the pushdown compiler explains a SOAP step as its operation and the parameters it sets', async () => {
    const out = await planner.call(explainPushdown, {
      body: { connectionId: good, step: { object: 'contacts', filters: [{ field: 'stage', op: 'eq', value: 'open' }], limit: 2 } },
    }, cell.as(root));
    assert.equal(out.native.protocol, 'soap');
    if (out.native.protocol !== 'soap') return;
    assert.deepEqual([out.native.operation, out.native.parameters], ['GetContacts', ['pageSize', 'stage']]);
  });

  test('the registry refuses what the engine cannot run', async () => {
    const connector = await gateway.call(createConnector, { body: { slug: `soap-bad-${uuidv7().slice(-8)}`, name: 'Bad', provider: 'Example', sourceRoute: 'visual' } },
      { ...cell.as(root), idempotencyKey: uuidv7() });
    const save = (document: Record<string, never>) => gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document } },
      { ...cell.as(root), idempotencyKey: uuidv7() });
    await assert.rejects(save(manifest({ fields: [{ name: 'id', type: 'string' }, { name: 'stage', type: 'string' }, { name: 'label', type: 'string', value: { jsonata: 'name' } }] })),
      { code: 'manifest.protocol_invalid' });
    await assert.rejects(save(manifest({ source: { constants: { nope: 1 } } })), { code: 'manifest.protocol_invalid' });
    await assert.rejects(save(manifest({ source: { operation: 'not an element' } })), { code: 'manifest.invalid' });
    await assert.rejects(save(manifest({ source: { action: 'say "hi"' } })), { code: 'manifest.invalid' });
    // A write speaks SOAP: an operation, not a REST request.
    await assert.rejects(save(manifest({ writes: { create: { request: { method: 'POST', path: '/soap' } }, bounds: { maxRows: 10 } } })), { code: 'manifest.invalid' });
  });
});

const wsdl = (binding: 'soap' | 'soap12' = 'soap', list = true) => `<?xml version="1.0" encoding="utf-8"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" xmlns:${binding}="http://schemas.xmlsoap.org/wsdl/${binding}/" xmlns:tns="urn:example:crm"
  targetNamespace="urn:example:crm">
  <wsdl:types>
    <xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:example:crm" elementFormDefault="qualified">
      <xs:element name="GetContacts"><xs:complexType><xs:sequence>
        <xs:element name="pageSize" type="xs:int" minOccurs="0"/><xs:element name="pageToken" type="xs:string" minOccurs="0"/>
        <xs:element name="stage" type="xs:string" minOccurs="0"/>
      </xs:sequence></xs:complexType></xs:element>
      <xs:element name="GetContactsResponse"><xs:complexType><xs:sequence>
        <xs:element name="contacts" type="tns:ContactList"/><xs:element name="nextPageToken" type="xs:string" minOccurs="0"/>
      </xs:sequence></xs:complexType></xs:element>
      <xs:complexType name="ContactList"><xs:sequence>
        <xs:element name="contact" type="tns:Contact" minOccurs="0" maxOccurs="${list ? 'unbounded' : '1'}"/>
      </xs:sequence></xs:complexType>
      <xs:complexType name="Contact"><xs:sequence>
        <xs:element name="id" type="xs:string"/><xs:element name="name" type="xs:string"/><xs:element name="stage" type="tns:Stage"/>
        <xs:element name="amount" type="xs:decimal"/><xs:element name="company" type="tns:Company" nillable="true"/>
      </xs:sequence></xs:complexType>
      <xs:complexType name="Company"><xs:sequence><xs:element name="name" type="xs:string"/></xs:sequence></xs:complexType>
      <xs:simpleType name="Stage"><xs:restriction base="xs:string"><xs:enumeration value="won"/><xs:enumeration value="open"/></xs:restriction></xs:simpleType>
    </xs:schema>
  </wsdl:types>
  <wsdl:message name="GetContactsIn"><wsdl:part name="parameters" element="tns:GetContacts"/></wsdl:message>
  <wsdl:message name="GetContactsOut"><wsdl:part name="parameters" element="tns:GetContactsResponse"/></wsdl:message>
  <wsdl:portType name="CrmPort"><wsdl:operation name="GetContacts"><wsdl:input message="tns:GetContactsIn"/><wsdl:output message="tns:GetContactsOut"/></wsdl:operation></wsdl:portType>
  <wsdl:binding name="CrmBinding" type="tns:CrmPort"><${binding}:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <wsdl:operation name="GetContacts"><${binding}:operation soapAction="urn:example:crm/GetContacts"/>
      <wsdl:input><${binding}:body use="literal"/></wsdl:input><wsdl:output><${binding}:body use="literal"/></wsdl:output></wsdl:operation>
  </wsdl:binding>
  <wsdl:service name="Crm"><wsdl:port name="CrmSoap" binding="tns:CrmBinding"><${binding}:address location="${baseUrl}/soap"/></wsdl:port></wsdl:service>
</wsdl:definitions>`;

describe('a draft from a WSDL (14.4: SOAP\'s discovery model)', () => {
  const importing = (text: string) => gateway.call(importDraft, { body: { kind: 'wsdl', text, name: 'SOAP CRM', provider: 'Example' } }, cell.as(root));

  test('the operation, its parameters, the records, paging and filters, with no model; the draft reads the service', async () => {
    const out = await importing(wsdl());
    assert.deepEqual(out.issues, [], JSON.stringify(out.issues));
    assert.ok(out.notes.includes('auth_not_described'));
    const doc = out.document as unknown as { transport: { baseUrl: string }; protocol: { version: string }; objects: {
      name: string; identifier: string[]; fields: { name: string; type: string; path?: string }[];
      source: { path: string; action: string; operation: string; namespace: string; qualified: boolean; parameters: { name: string }[]; recordPath: string;
        constants: Record<string, unknown>; paging?: unknown };
      pushdown: { filters: { field: string }[] };
    }[]; auth: unknown };
    assert.deepEqual([doc.transport.baseUrl, doc.protocol.version], [baseUrl, '1.1']);
    const o = doc.objects[0]!;
    assert.deepEqual([o.name, o.identifier, o.source.path, o.source.action, o.source.operation, o.source.namespace, o.source.qualified],
      ['contacts', ['id'], '/soap', 'urn:example:crm/GetContacts', 'GetContacts', 'urn:example:crm', true]);
    assert.deepEqual(o.source.parameters.map((p) => p.name), ['pageSize', 'pageToken', 'stage']);
    assert.equal(o.source.recordPath, 'GetContactsResponse.contacts.contact');
    assert.deepEqual(o.fields.map((f) => [f.name, f.type, f.path ?? null]), [
      ['id', 'string', null], ['name', 'string', null], ['stage', 'string', null], ['amount', 'number', null], ['company_name', 'string', 'company.name'],
    ]);
    assert.deepEqual([o.source.constants, o.pushdown.filters.map((f) => f.field), o.source.paging !== undefined], [{ pageSize: 100 }, ['stage'], true]);

    // Saved with the service's credentials, the draft reads it.
    doc.auth = { strategy: 'bearer', fields: [{ name: 'token', kind: 'secret', label: 'API token', role: 'token' }] };
    o.source.constants = { pageSize: 4 };
    const connector = await gateway.call(createConnector, { body: { slug: `wsdl-${uuidv7().slice(-12)}`, name: 'SOAP CRM', provider: 'Example', sourceRoute: 'visual' } },
      { ...cell.as(root), idempotencyKey: uuidv7() });
    await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document: doc as never } }, { ...cell.as(root), idempotencyKey: uuidv7() });
    const created = await gateway.call(createConnection, { body: { connectorId: connector.id, name: 'SOAP CRM', owningScopeId: cell.scopes['engineering']! } },
      { ...cell.as(root), idempotencyKey: uuidv7() });
    await gateway.call(setConnectionSecrets, { params: { connectionId: created.id }, body: { values: { token: 'soap_token' } } }, cell.as(root));
    await gateway.call(changeConnectionStatus, { params: { connectionId: created.id }, body: { move: 'probe', version: created.version } }, cell.as(root));
    const all = await read(created.id, { object: 'contacts' });
    assert.deepEqual([all.rows.length, all.stats.pages], [9, 3], 'paged by the token the WSDL names');
    const won = await read(created.id, { object: 'contacts', fields: ['id'], filters: [{ field: 'stage', op: 'eq', value: 'won' }] });
    assert.deepEqual([won.rows.length, won.pushdown.residual.filters], [5, []]);
  });

  test('a SOAP 1.2 port; a WSDL with no list of records, or with a DTD, is refused', async () => {
    const twelve = await importing(wsdl('soap12'));
    assert.equal((twelve.document as { protocol: { version: string } }).protocol.version, '1.2');
    await assert.rejects(importing(wsdl('soap', false)), { code: 'visual.import_no_objects' });
    await assert.rejects(importing(`<!DOCTYPE x [<!ENTITY a "b">]>${wsdl()}`), { code: 'visual.wsdl_unreadable' });
    await assert.rejects(importing('<html/>'), { code: 'visual.wsdl_unreadable' });
  });
});

describe('WS-Security and SOAP writes (spec 14.4, 15.1, 42.5)', () => {
  const ws = (password: 'text' | 'digest', writes?: unknown) => connection('', '1.1', {
    document: manifest({ auth: WS_SECURITY(password), ...(writes === undefined ? {} : { writes }) }), secrets: { username: WS_USER, password: WS_PASSWORD },
  });

  test('a UsernameToken in the envelope\'s header, placed by the credential service: the password as text, escaped', async () => {
    const id = await ws('text');
    const out = await read(id, { object: 'contacts', fields: ['id'], limit: 2 });
    assert.equal(out.rows.length, 2);
    const sent = received.at(-1)!;
    assert.equal(sent.headers.authorization, undefined, 'no HTTP credential: it travels in the envelope');
    assert.match(sent.text, /<soap:Header><wsse:Security [^>]*soap:mustUnderstand="1"><wsse:UsernameToken><wsse:Username>svc<\/wsse:Username><wsse:Password Type="[^"]+#PasswordText">p&amp;ss&lt;word&gt;<\/wsse:Password>/);
    assert.ok(sent.text.indexOf('<soap:Header>') < sent.text.indexOf('<soap:Body>'), 'the header before the Body');
  });

  test('or as the profile\'s digest of a fresh nonce, the time and the password: the password itself never sent', async () => {
    const id = await ws('digest');
    await read(id, { object: 'contacts', fields: ['id'], limit: 1 });
    const first = received.at(-1)!.text;
    await read(id, { object: 'contacts', fields: ['id'], limit: 1 });
    const second = received.at(-1)!.text;
    assert.match(first, /#PasswordDigest">[A-Za-z0-9+/=]{28}<\/wsse:Password><wsse:Nonce [^>]+>[A-Za-z0-9+/=]{24}<\/wsse:Nonce><wsu:Created>/);
    assert.ok(!first.includes('p&amp;ss') && !first.includes(WS_PASSWORD), 'never the password');
    const nonce = (text: string) => /<wsse:Nonce [^>]+>([^<]+)</.exec(text)![1];
    assert.notEqual(nonce(first), nonce(second), 'a fresh nonce each time');
  });

  test('SOAP writes call their operations: a create reads its id from the response; an update names the record; a Fault fails it', async () => {
    const id = await ws('text', WRITES);
    const write = (operations: unknown[]) => cell.client('conformance').call(writeRecords, {
      body: { connectionId: id, object: 'contacts', sandbox: true, operations: operations as never },
    }, cell.as(root));
    const created = await write([{ key: 'c', operation: 'create', values: { name: 'Ada & Co', stage: 'open', amount: 3 } }]);
    assert.deepEqual(created.results.map((r) => [r.outcome, r.identifier]), [['applied', 's10']]);
    const sent = received.at(-1)!;
    assert.equal(sent.headers.soapaction, '"urn:example:crm/CreateContact"');
    assert.match(sent.text, /<m:CreateContact xmlns:m="urn:example:crm"><m:name>Ada &amp; Co<\/m:name><m:stage>open<\/m:stage><m:amount>3<\/m:amount><\/m:CreateContact>/);
    const updated = await write([
      { key: 'u1', operation: 'update_partial', identifier: 's10', values: { stage: 'won' } },
      { key: 'u2', operation: 'update_partial', identifier: 's10', values: { stage: 'bad' } },
    ]);
    assert.deepEqual(updated.results.map((r) => [r.outcome, r.error?.meaning ?? null]), [['applied', null], ['failed', 'validation']]);
    assert.equal(CONTACTS.find((c) => c.id === 's10')?.stage, 'won');
  });

  test('WS-Security is SOAP\'s; a UsernameToken needs its user and password fields', async () => {
    const connector = await gateway.call(createConnector, { body: { slug: `soap-ws-${uuidv7().slice(-8)}`, name: 'Bad', provider: 'Example', sourceRoute: 'visual' } },
      { ...cell.as(root), idempotencyKey: uuidv7() });
    const save = (document: Record<string, never>) => gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document } },
      { ...cell.as(root), idempotencyKey: uuidv7() });
    await assert.rejects(save(manifest({ auth: { strategy: 'ws_security', fields: [{ name: 'username', kind: 'public', label: 'User', role: 'username' }] } })),
      { code: 'manifest.invalid' });
  });
});
