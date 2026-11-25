// connect-registry and the credential service's connection credentials, end to end:
// connectors and immutable manifest versions refused or saved by schema, expression and
// protocol checks; connections owned by a scope and a membership, moved through their
// statuses under the policy service; secrets sealed, placed in requests by the mediator,
// every unwrap in the ledger, and revoked with the connection.

import assert from 'node:assert/strict';
import { setConnectionPolicyAuthority } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import {
  changeConnectionStatus, createConnection, getConnection, listConnections, renameConnection, setConnectionSecrets, setConnectionParameters,
} from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion, getConnector, getConnectorSetup, getManifestVersion, getOwnManifestDocument, listConnectors, listManifestVersions } from '../../src/contracts/connect-registry/connector.contract.ts';
import { sendAuthorisedRequest } from '../../src/contracts/credential/connectionCredential.contract.ts';
import { createEgress } from '../../src/infra/egress.infra.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { hex, hmacSha256 } from '../../src/services/expression-evaluator/library.service.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { createConnectCell, doc, restManifest, type ConnectCell, type Signed } from './connect.helper.ts';

let cell: ConnectCell;
let gateway: ServiceClient;
let runtime: ServiceClient;
let root: Signed;
let member: Signed;
let api: Server;
let baseUrl: string;
const seen: { method: string; url: string; headers: IncomingMessage['headers'] }[] = [];

before(async () => {
  api = createServer((req, res) => {
    seen.push({ method: req.method!, url: req.url!, headers: req.headers });
    res.setHeader('content-type', 'application/json');
    res.setHeader('set-cookie', 'session=abc');
    if (req.url?.startsWith('/redirect')) {
      res.statusCode = 302;
      res.setHeader('location', 'https://elsewhere.example/');
      res.end('{}');
      return;
    }
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  cell = await createConnectCell();
  gateway = cell.client('gateway');
  runtime = cell.client('connect-runtime');
  root = await cell.signIn('root@acme.example');
  member = await cell.member('max@acme.example', 'Member', 'platform');
});

after(async () => {
  await cell?.close();
  api?.close();
});

const outboxEvents = async (): Promise<string[]> => {
  const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
    `select payload->>'event' as event from platform.outbox where organisation_id = $1 and event = 'audit_event' order by created_at, id`, [cell.org]));
  return rows.map((r) => r.event as string);
};

async function newConnector(who: Signed, slug: string): Promise<string> {
  const connector = await gateway.call(createConnector, { body: { slug, name: 'Example CRM', provider: 'Example', sourceRoute: 'ai' } },
    { ...cell.as(who), idempotencyKey: uuidv7() });
  return connector.id;
}

describe('connectors and manifest versions (spec 14.3, 14.8)', () => {
  let connectorId: string;

  test('a member builds a private connector; a retried request returns the first', async () => {
    const key = uuidv7();
    const body = { slug: 'example-crm', name: 'Example CRM', provider: 'Example', sourceRoute: 'ai' as const };
    const first = await gateway.call(createConnector, { body }, { ...cell.as(member), idempotencyKey: key });
    const again = await gateway.call(createConnector, { body }, { ...cell.as(member), idempotencyKey: key });
    assert.deepEqual(again, first);
    assert.equal(first.kind, 'private');
    assert.equal(first.trustTier, 'private');
    assert.equal(first.status, 'draft');
    assert.equal(first.currentManifestId, null);
    connectorId = first.id;
    await assert.rejects(gateway.call(createConnector, { body }, { ...cell.as(member), idempotencyKey: uuidv7() }), { code: 'connector.slug_taken' });
  });

  test('a manifest that fails the schema is refused with the paths at fault', async () => {
    const broken = doc({ ...restManifest({ baseUrl }), objects: [] });
    await assert.rejects(gateway.call(createManifestVersion, { params: { connectorId }, body: { document: broken } },
      { ...cell.as(member), idempotencyKey: uuidv7() }), { category: 'validation', code: 'manifest.invalid' });
    const unknownParam = restManifest({ baseUrl: 'https://{params.tenant}.example.com' });
    await assert.rejects(gateway.call(createManifestVersion, { params: { connectorId }, body: { document: unknownParam } },
      { ...cell.as(member), idempotencyKey: uuidv7() }), { code: 'manifest.invalid' });
  });

  test('a manifest with an expression that fails is refused, and the rejection is audited', async () => {
    const document = restManifest({ baseUrl, errors: { classify: [{ when: { cel: 'secret.token == "x"' }, meaning: 'auth' }] } });
    await assert.rejects(gateway.call(createManifestVersion, { params: { connectorId }, body: { document } },
      { ...cell.as(member), idempotencyKey: uuidv7() }), { code: 'manifest.expression_invalid' });
    assert.ok((await outboxEvents()).includes('manifest_expression_rejected'));
  });

  test('a strategy or grammar the engine does not run is refused by the protocol engine', async () => {
    const jwt = restManifest({ baseUrl, auth: { strategy: 'jwt_bearer', fields: [] } });
    await assert.rejects(gateway.call(createManifestVersion, { params: { connectorId }, body: { document: jwt } },
      { ...cell.as(member), idempotencyKey: uuidv7() }), { code: 'manifest.protocol_invalid' });
    const sql = doc({
      schemaVersion: '1', identity: { name: 'Warehouse', provider: 'Example', version: '1.0.0' }, transport: { viaAgent: true },
      protocol: { kind: 'sql', dialect: 'cobol' }, auth: { strategy: 'username_password' },
      objects: [{ name: 'orders', identifier: ['id'], fields: [{ name: 'id', type: 'integer' }], source: { kind: 'sql', table: 'orders' } }],
    });
    await assert.rejects(gateway.call(createManifestVersion, { params: { connectorId }, body: { document: sql } },
      { ...cell.as(member), idempotencyKey: uuidv7() }), { code: 'manifest.protocol_invalid' });
  });

  test('a valid manifest is saved, hashed and made current; versions never repeat; a new one supersedes', async () => {
    const v1 = await gateway.call(createManifestVersion, { params: { connectorId }, body: { document: restManifest({ baseUrl }) } },
      { ...cell.as(member), idempotencyKey: uuidv7() });
    assert.match(v1.documentHash, /^[0-9a-f]{64}$/);
    assert.equal(v1.version, '1.0.0');
    const connector = await gateway.call(getConnector, { params: { connectorId } }, cell.as(member));
    assert.equal(connector.status, 'active');
    assert.equal(connector.currentManifestId, v1.id);
    await assert.rejects(gateway.call(createManifestVersion, { params: { connectorId }, body: { document: restManifest({ baseUrl }) } },
      { ...cell.as(root), idempotencyKey: uuidv7() }), { code: 'manifest.version_exists' });
    // After the first version, a new one is an edit (spec 16.6): connector.edit is held by the
    // connector's author and by admins, so another member is refused.
    const other = await cell.member('not-the-author@acme.example', 'Member');
    await assert.rejects(gateway.call(createManifestVersion, { params: { connectorId }, body: { document: restManifest({ baseUrl, version: '1.1.0' }) } },
      { ...cell.as(other), idempotencyKey: uuidv7() }), { code: 'connect.not_permitted' });
    const v2 = await gateway.call(createManifestVersion, { params: { connectorId }, body: { document: restManifest({ baseUrl, version: '1.1.0' }) } },
      { ...cell.as(root), idempotencyKey: uuidv7() });
    assert.equal(v2.parentVersionId, v1.id);
    const { versions } = await gateway.call(listManifestVersions, { params: { connectorId } }, cell.as(member));
    assert.deepEqual(versions.map((v) => [v.version, v.supersededAt === null]), [['1.1.0', true], ['1.0.0', false]]);
    const read = await gateway.call(getManifestVersion, { params: { connectorId, versionId: v1.id } }, cell.as(member));
    assert.equal((read.document['identity'] as { version: string }).version, '1.0.0');
    // The setup form a person fills in to connect (W7): names, kinds and labels, never the manifest; the current version unless one is named.
    const setup = await gateway.call(getConnectorSetup, { params: { connectorId }, query: {} }, cell.as(member));
    assert.deepEqual(setup, {
      connectorId, manifestId: v2.id, version: '1.1.0', protocol: 'rest', viaAgent: false, params: [],
      auth: { strategy: 'bearer', fields: [{ name: 'token', kind: 'secret', label: 'API token', role: 'token' }] },
      objects: [{ name: 'contacts', label: null }],
    });
    assert.equal((await gateway.call(getConnectorSetup, { params: { connectorId }, query: { manifestId: v1.id } }, cell.as(member))).version, '1.0.0');
    await assert.rejects(gateway.call(getConnectorSetup, { params: { connectorId }, query: { manifestId: uuidv7() } }, cell.as(member)), { code: 'connector.no_version' });
  });

  test('a catalogue connector is listed beside private ones, and is never edited by a tenant', async () => {
    const id = uuidv7();
    await cell.migrate.query(`insert into connect.connectors (id, kind, slug, name, provider, trust_tier, source_route, status)
      values ($1, 'prebuilt', 'catalogue-crm', 'Catalogue CRM', 'Example', 'certified', 'catalogue', 'active')`, [id]);
    const { connectors } = await gateway.call(listConnectors, { query: {} }, cell.as(member));
    assert.ok(connectors.some((c) => c.id === id && c.organisationId === null));
    assert.ok(connectors.some((c) => c.id === connectorId && c.organisationId === cell.org));
    await assert.rejects(gateway.call(createManifestVersion, { params: { connectorId: id }, body: { document: restManifest({ baseUrl }) } },
      { ...cell.as(root), idempotencyKey: uuidv7() }), { code: 'connector.catalogue_immutable' });
    // Its manifest stays with the services: the builder opens only the organisation's own (D262).
    await assert.rejects(gateway.call(getOwnManifestDocument, { params: { connectorId: id, versionId: uuidv7() } }, cell.as(root)), { code: 'connector.not_own' });
  });
});

describe('connections (spec 14.7)', () => {
  let connectorId: string;
  let connectionId: string;

  before(async () => {
    connectorId = await newConnector(root, 'crm-for-connections');
    await gateway.call(createManifestVersion, {
      params: { connectorId },
      body: { document: restManifest({ baseUrl, params: [{ name: 'region', label: 'Region' }] }) },
    }, { ...cell.as(root), idempotencyKey: uuidv7() });
  });

  test('a member creates a connection in their scope, which they own; not outside it', async () => {
    await assert.rejects(gateway.call(createConnection, { body: { connectorId, name: 'CRM', owningScopeId: cell.scopes['sales']! } },
      { ...cell.as(member), idempotencyKey: uuidv7() }), { code: 'connect.not_permitted' });
    const connection = await gateway.call(createConnection, {
      body: { connectorId, name: 'CRM', owningScopeId: cell.scopes['platform']!, parameters: { region: 'eu' } },
    }, { ...cell.as(member), idempotencyKey: uuidv7() });
    assert.equal(connection.status, 'draft');
    assert.deepEqual(connection.parameters, { region: 'eu' }, 'parameters are public data on the connection');
    assert.equal(connection.owningMembershipId, member.membershipId);
    assert.equal(connection.provider, 'Example');
    connectionId = connection.id;
    const { connections } = await gateway.call(listConnections, { query: {} }, cell.as(root));
    assert.ok(connections.some((c) => c.id === connectionId));
  });

  test('secrets are sealed by the credential service; only a secret gets a last four; unknown names are refused', async () => {
    await assert.rejects(gateway.call(setConnectionSecrets, { params: { connectionId }, body: { values: { nonsense: 'x' } } }, cell.as(member)),
      { code: 'credential.field_unknown' });
    await assert.rejects(gateway.call(setConnectionSecrets, { params: { connectionId }, body: { values: { region: 'eu' } } }, cell.as(member)),
      { code: 'credential.is_parameter' }, 'a parameter is never sealed as a credential');
    const stored = await gateway.call(setConnectionSecrets, {
      params: { connectionId }, body: { values: { token: 'tok_live_1234567890abcd' } },
    }, cell.as(member));
    assert.deepEqual(stored.fields, [{ name: 'token', kind: 'secret', lastFour: 'abcd' }]);
    const { rows } = await inTx(cell.credential, { orgId: cell.org }, () => cell.credential.query(
      'select field_name, ciphertext, nonce, last_four, auth_strategy from connect.connection_credentials where connection_id = $1 and revoked_at is null', [connectionId]));
    assert.equal(rows.length, 1);
    for (const row of rows) {
      assert.ok(!(row.ciphertext as Buffer).toString('latin1').includes('tok_live'), 'ciphertext, never plaintext');
      assert.equal((row.nonce as Buffer).length, 12);
      assert.equal(row.auth_strategy, 'bearer');
    }
    await assert.rejects(inTx(cell.app, { orgId: cell.org }, () => cell.app.query('select ciphertext from connect.connection_credentials')),
      /permission denied/, 'only the credential service reads sealed columns');
    const safe = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      'select field_name, last_four from connect.connection_credentials_safe where connection_id = $1 order by field_name', [connectionId]));
    assert.deepEqual(safe.rows, [{ field_name: 'token', last_four: 'abcd' }]);
    // A second value for a field replaces the first, which is crypto-shredded.
    await gateway.call(setConnectionSecrets, { params: { connectionId }, body: { values: { token: 'tok_live_second_value_wxyz' } } }, cell.as(member));
    const all = await inTx(cell.credential, { orgId: cell.org }, () => cell.credential.query(
      `select revoked_at is not null as revoked, ciphertext is null as shredded from connect.connection_credentials
       where connection_id = $1 and field_name = 'token' order by created_at`, [connectionId]));
    assert.deepEqual(all.rows, [{ revoked: true, shredded: true }, { revoked: false, shredded: false }]);
  });

  test('statuses move under the policy service: the owner probes; an admin confirms and activates', async () => {
    let connection = await gateway.call(getConnection, { params: { connectionId } }, cell.as(member));
    connection = await gateway.call(changeConnectionStatus, { params: { connectionId }, body: { move: 'probe', version: connection.version } }, cell.as(member));
    assert.equal(connection.status, 'probing');
    await assert.rejects(gateway.call(changeConnectionStatus, { params: { connectionId }, body: { move: 'confirm', version: connection.version } },
      cell.as(member)), { code: 'connect.not_permitted' }, 'connector.verify is an authorising permission');
    await assert.rejects(gateway.call(changeConnectionStatus, { params: { connectionId }, body: { move: 'confirm', version: connection.version } },
      cell.as(root)), { code: 'connection.conformance_required' }, 'confirmation follows a passing conformance run');
    await cell.passConformance(connectionId);
    connection = await gateway.call(changeConnectionStatus, { params: { connectionId }, body: { move: 'confirm', version: connection.version } }, cell.as(root));
    await assert.rejects(gateway.call(changeConnectionStatus, { params: { connectionId }, body: { move: 'activate', version: connection.version - 1 } },
      cell.as(root)), { code: 'connection.version_stale' });
    connection = await gateway.call(changeConnectionStatus, { params: { connectionId }, body: { move: 'activate', version: connection.version } }, cell.as(root));
    assert.equal(connection.status, 'active');
    await assert.rejects(gateway.call(changeConnectionStatus, { params: { connectionId }, body: { move: 'probe', version: connection.version } },
      cell.as(member)), { code: 'connection.status_move' });
    await assert.rejects(gateway.call(changeConnectionStatus, { params: { connectionId }, body: { move: 'halt', version: connection.version } },
      cell.as(member)), { code: 'connection.halt_reason_required' });
    connection = await gateway.call(renameConnection, { params: { connectionId }, body: { name: 'Sales CRM', version: connection.version } }, cell.as(member));
    assert.equal(connection.name, 'Sales CRM');
  });

  test('the mediator places the secret, sends to the manifest\'s host only, and logs each unwrap', async () => {
    const before = seen.length;
    const response = await runtime.call(sendAuthorisedRequest, {
      body: { connectionId, reason: 'query', request: { method: 'GET', path: '/v1/contacts', query: { limit: '2' }, headers: {} } },
    }, cell.as(member));
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { ok: true, path: '/v1/contacts?limit=2' });
    assert.equal(response.headers['set-cookie'], undefined, 'cookies never return');
    assert.equal(seen[before]!.headers.authorization, 'Bearer tok_live_second_value_wxyz');
    const ledger = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select u.reason, u.calling_service, u.outcome, u.membership_id from iam.credential_unwraps u
       join connect.connection_credentials_safe c on c.id = u.connection_credential_id where c.connection_id = $1`, [connectionId]));
    assert.ok(ledger.rows.length >= 1);
    assert.ok(ledger.rows.every((r) => r.reason === 'query' && r.calling_service === 'connect-runtime' && r.outcome === 'ok'));
    assert.equal(ledger.rows[0]!.membership_id, member.membershipId);
    const used = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select last_used_at is not null as used from connect.connection_credentials_safe where connection_id = $1 and revoked_at is null and field_name = 'token'`,
      [connectionId]));
    assert.equal(used.rows[0]!.used, true, 'last_used_at is set with the unwrap');

    const smuggled = seen.length;
    await runtime.call(sendAuthorisedRequest, {
      body: { connectionId, reason: 'query', request: { method: 'GET', path: '/v1/contacts', query: {}, headers: { host: 'evil.example', authorization: 'Bearer forged', 'x-trace': 't1' } } },
    }, cell.as(member));
    assert.equal(seen[smuggled]!.headers.host, new URL(baseUrl).host, 'a caller cannot choose the virtual host');
    assert.equal(seen[smuggled]!.headers.authorization, 'Bearer tok_live_second_value_wxyz', 'only the strategy places credentials');
    assert.equal(seen[smuggled]!.headers['x-trace'], 't1');
    for (const path of ['//evil.example/x', '/v1/../admin', '/a/./b', '/v1/%2e%2e/admin', '/v1/%2E./x', '/v1\\..\\x']) {
      await assert.rejects(runtime.call(sendAuthorisedRequest, {
        body: { connectionId, reason: 'query', request: { method: 'GET', path, query: {}, headers: {} } },
      }, cell.as(member)), { category: 'validation' }, path);
    }
    const redirect = await runtime.call(sendAuthorisedRequest, {
      body: { connectionId, reason: 'query', request: { method: 'GET', path: '/redirect', query: {}, headers: {} } },
    }, cell.as(member));
    assert.equal(redirect.status, 302, 'a redirect is returned, never followed with the secret');
    const read = await gateway.call(getConnection, { params: { connectionId } }, cell.as(member));
    assert.deepEqual(read.parameters, { region: 'eu' }, 'parameters read back as data; the token never leaves');
  });

  test('a halted connection serves nothing; resumed, it serves again', async () => {
    let connection = await gateway.call(getConnection, { params: { connectionId } }, cell.as(member));
    connection = await gateway.call(changeConnectionStatus, {
      params: { connectionId }, body: { move: 'halt', version: connection.version, reason: 'field meaning changed' },
    }, cell.as(member));
    await assert.rejects(runtime.call(sendAuthorisedRequest, {
      body: { connectionId, reason: 'query', request: { method: 'GET', path: '/v1/contacts', query: {}, headers: {} } },
    }, cell.as(member)), { code: 'connection.halted' });
    connection = await gateway.call(changeConnectionStatus, { params: { connectionId }, body: { move: 'resume', version: connection.version } }, cell.as(member));
    assert.equal(connection.status, 'active');
  });

  test('revoking a connection revokes and shreds its credentials; a revoked connection serves nothing', async () => {
    let connection = await gateway.call(getConnection, { params: { connectionId } }, cell.as(member));
    connection = await gateway.call(changeConnectionStatus, { params: { connectionId }, body: { move: 'revoke', version: connection.version } }, cell.as(member));
    assert.equal(connection.status, 'revoked');
    const { rows } = await inTx(cell.credential, { orgId: cell.org }, () => cell.credential.query(
      'select count(*)::int as live, count(*) filter (where ciphertext is not null)::int as sealed from connect.connection_credentials where connection_id = $1 and revoked_at is null',
      [connectionId]));
    assert.deepEqual(rows[0], { live: 0, sealed: 0 });
    await assert.rejects(runtime.call(sendAuthorisedRequest, {
      body: { connectionId, reason: 'probe', request: { method: 'GET', path: '/v1/contacts', query: {}, headers: {} } },
    }, cell.as(member)), { code: 'connection.revoked' });
    const events = await outboxEvents();
    for (const event of ['connector_created', 'connector_manifest_versioned', 'connection_created', 'credential_sealed', 'connection_activated',
      'connection_halted', 'connection_resumed', 'connection_revoked', 'credential_revoked']) {
      assert.ok(events.includes(event), event);
    }
  });
});

describe('connection parameters (spec 14.3)', () => {
  let connectorId: string;
  const document = (pattern = '[a-z][a-z0-9-]{0,30}') => restManifest({
    baseUrl: 'https://{params.tenant}.crm.example', version: '1.0.0',
    params: [{ name: 'tenant', label: 'Tenant', pattern }, { name: 'region', label: 'Region', required: false }],
  });

  before(async () => {
    connectorId = await newConnector(root, 'crm-with-tenants');
    await gateway.call(createManifestVersion, { params: { connectorId }, body: { document: document() } }, { ...cell.as(root), idempotencyKey: uuidv7() });
  });

  test('a pattern that could backtrack without bound is refused when the manifest is saved', async () => {
    const other = await newConnector(root, 'crm-with-bad-pattern');
    for (const pattern of ['(a+)+', '(a|aa)*', '\\1', '(?=a)a', 'a*b*c*d*']) {
      await assert.rejects(gateway.call(createManifestVersion, { params: { connectorId: other }, body: { document: document(pattern) } },
        { ...cell.as(root), idempotencyKey: uuidv7() }), { code: 'manifest.pattern_unsafe' }, pattern);
    }
  });

  test('values are checked against the manifest: declared names, the pattern, one DNS label for a host part', async () => {
    const create = (parameters: Record<string, string>) => gateway.call(createConnection, {
      body: { connectorId, name: 'Tenant CRM', owningScopeId: cell.scopes['engineering']!, parameters },
    }, { ...cell.as(root), idempotencyKey: uuidv7() });
    await assert.rejects(create({ nonsense: 'x' }), { code: 'connection.parameter_unknown' });
    await assert.rejects(create({ tenant: 'Not.A.Label' }), { code: 'connection.parameter_invalid' });
    await assert.rejects(create({ tenant: 'acme', region: 'line\nbreak' }), { category: 'validation' });
    assert.deepEqual((await create({ tenant: 'acme', region: 'eu' })).parameters, { tenant: 'acme', region: 'eu' });
  });

  test('probing needs every required parameter; a change is at the version read, and audited by name only', async () => {
    let connection = await gateway.call(createConnection, {
      body: { connectorId, name: 'Draft CRM', owningScopeId: cell.scopes['engineering']! },
    }, { ...cell.as(root), idempotencyKey: uuidv7() });
    await assert.rejects(gateway.call(changeConnectionStatus, { params: { connectionId: connection.id }, body: { move: 'probe', version: connection.version } },
      cell.as(root)), { code: 'connection.parameter_missing' });
    connection = await gateway.call(setConnectionParameters, {
      params: { connectionId: connection.id }, body: { parameters: { tenant: 'globex' }, version: connection.version },
    }, cell.as(root));
    assert.deepEqual(connection.parameters, { tenant: 'globex' });
    const same = await gateway.call(setConnectionParameters, {
      params: { connectionId: connection.id }, body: { parameters: { tenant: 'globex' }, version: connection.version },
    }, cell.as(root));
    assert.equal(same.version, connection.version, 'the same set changes nothing');
    await assert.rejects(gateway.call(setConnectionParameters, {
      params: { connectionId: connection.id }, body: { parameters: { tenant: 'initech' }, version: connection.version - 1 },
    }, cell.as(root)), { code: 'connection.version_stale' });
    connection = await gateway.call(changeConnectionStatus, { params: { connectionId: connection.id }, body: { move: 'probe', version: connection.version } },
      cell.as(root));
    assert.equal(connection.status, 'probing');
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select payload->'detail' as detail from platform.outbox where organisation_id = $1 and payload->>'event' = 'connection_parameters_changed'`, [cell.org]));
    assert.deepEqual(rows.map((r) => r.detail), [{ changed: 1, names: 'tenant' }], 'names and counts, never values');
  });
});

describe('auth strategies, placed by the mediator (spec 15.1)', () => {
  async function connectionWith(auth: Record<string, unknown>, values: Record<string, string>): Promise<string> {
    const connectorId = await newConnector(root, `crm-${uuidv7().slice(-12)}`);
    await gateway.call(createManifestVersion, { params: { connectorId }, body: { document: restManifest({ baseUrl, auth }) } },
      { ...cell.as(root), idempotencyKey: uuidv7() });
    const connection = await gateway.call(createConnection, { body: { connectorId, name: 'CRM', owningScopeId: cell.scopes['engineering']! } },
      { ...cell.as(root), idempotencyKey: uuidv7() });
    await gateway.call(setConnectionSecrets, { params: { connectionId: connection.id }, body: { values } }, cell.as(root));
    return connection.id;
  }
  const probe = async (connectionId: string) => {
    const before = seen.length;
    await runtime.call(sendAuthorisedRequest, {
      body: { connectionId, reason: 'probe', request: { method: 'GET', path: '/v1/x', query: { b: '2', a: '1' }, headers: {} } },
    }, cell.as(root));
    return seen[before]!;
  };

  test('api_key in a header and a query parameter, with a prefix', async () => {
    const id = await connectionWith({
      strategy: 'api_key', fields: [
        { name: 'key', kind: 'secret', label: 'Key', location: 'header', key: 'X-Api-Key', prefix: 'Token ' },
        { name: 'account', kind: 'public', label: 'Account', location: 'query', key: 'account' },
      ],
    }, { key: 'k_secret', account: 'acc-1' });
    const request = await probe(id);
    assert.equal(request.headers['x-api-key'], 'Token k_secret');
    assert.match(request.url, /account=acc-1/);
  });

  test('basic, from the fields with the username and password roles', async () => {
    const id = await connectionWith({
      strategy: 'basic', fields: [
        { name: 'user', kind: 'public', label: 'User', role: 'username' }, { name: 'pass', kind: 'secret', label: 'Password', role: 'password' },
      ],
    }, { user: 'ada', pass: 'p@ss' });
    assert.equal((await probe(id)).headers.authorization, `Basic ${Buffer.from('ada:p@ss').toString('base64')}`);
  });

  test('an expression signature, computed with secret.<field> inside the mediator', async () => {
    const id = await connectionWith({
      strategy: 'expression',
      fields: [{ name: 'key_id', kind: 'public', label: 'Key id' }, { name: 'signing_key', kind: 'secret', label: 'Signing key' }],
      sign: { cel: String.raw`{"headers": {"X-Key-Id": public.key_id, "X-Signature": hex(hmac_sha256(secret.signing_key, request.method + "\n" + request.path + "\n" + canonical_query(request.query)))}}` },
    }, { key_id: 'kid-7', signing_key: 'sk_shh' });
    const request = await probe(id);
    assert.equal(request.headers['x-key-id'], 'kid-7');
    assert.equal(request.headers['x-signature'], hex(hmacSha256('sk_shh', 'GET\n/v1/x\na=1&b=2')));
  });
});

describe('egress', () => {
  test('the cell refuses private addresses unless development allows them, and never sends a URL with credentials', async () => {
    const strict = createEgress({ egressAllowPrivate: false, egressAllowHttp: true, egressTimeoutMs: 2_000, egressMaxResponseBytes: 1_000 });
    await assert.rejects(strict.send({ url: new URL(`${baseUrl}/x`), method: 'GET', headers: {} }), { code: 'egress.private_address' });
    await assert.rejects(strict.send({ url: new URL('http://localhost:1/x'), method: 'GET', headers: {} }), { code: 'egress.private_address' });
    await assert.rejects(strict.send({ url: new URL('http://169.254.169.254/latest'), method: 'GET', headers: {} }), { code: 'egress.private_address' });
    const https = createEgress({ egressAllowPrivate: true, egressAllowHttp: false, egressTimeoutMs: 2_000, egressMaxResponseBytes: 1_000 });
    await assert.rejects(https.send({ url: new URL(`${baseUrl}/x`), method: 'GET', headers: {} }), { code: 'egress.https_required' });
    const open = createEgress({ egressAllowPrivate: true, egressAllowHttp: true, egressTimeoutMs: 2_000, egressMaxResponseBytes: 10 });
    await assert.rejects(open.send({ url: new URL(`${baseUrl}/x`), method: 'GET', headers: {} }), { code: 'egress.response_too_large' });
    await assert.rejects(open.send({ url: new URL(`http://u:p@127.0.0.1:1/x`), method: 'GET', headers: {} }), { code: 'egress.url_credentials' });
  });
});

describe('policy authority (spec 14.7, 44.4)', () => {
  test('a super admin delegates a connection\'s policy authority to one admin, or locks it; each change audited, from and to', async () => {
    const connectorId = await newConnector(root, 'crm-for-authority');
    await gateway.call(createManifestVersion, { params: { connectorId }, body: { document: restManifest({ baseUrl }) } }, { ...cell.as(root), idempotencyKey: uuidv7() });
    let connection = await gateway.call(createConnection, { body: { connectorId, name: 'CRM authority', owningScopeId: cell.scopes['platform']! } },
      { ...cell.as(root), idempotencyKey: uuidv7() });
    const set = (body: { mode: 'owner_set' | 'delegated' | 'locked'; delegateMembershipId?: string }, who: Signed = root) =>
      gateway.call(setConnectionPolicyAuthority, { params: { connectionId: connection.id }, body: { ...body, version: connection.version } }, cell.as(who));
    await assert.rejects(set({ mode: 'locked' }, member), { code: 'connect.not_permitted' }, 'a super admin\'s decision');
    await assert.rejects(set({ mode: 'delegated' }), { code: 'connection.delegate_required' });
    await assert.rejects(set({ mode: 'locked', delegateMembershipId: member.membershipId }), { code: 'connection.delegate_required' });
    await assert.rejects(set({ mode: 'delegated', delegateMembershipId: uuidv7() }), { code: 'connection.delegate_unknown' });
    connection = await set({ mode: 'delegated', delegateMembershipId: member.membershipId });
    assert.equal(connection.policyAuthority, 'delegated');
    connection = await set({ mode: 'locked' });
    assert.equal(connection.policyAuthority, 'locked');
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select payload->>'event' as event, payload->'detail' as detail from platform.outbox
        where organisation_id = $1 and payload->>'event' like 'policy_authority_%' and payload->'resource'->>'id' = $2 order by seq`, [cell.org, connection.id]));
    assert.deepEqual(rows.map((r) => [r.event, r.detail.from ?? r.detail.delegate_membership_id, r.detail.to ?? null]), [
      ['policy_authority_changed', 'owner_set', 'delegated'], ['policy_authority_delegated', member.membershipId, null],
      ['policy_authority_changed', 'delegated', 'locked'], ['policy_authority_revoked', member.membershipId, null],
    ]);
  });
});
