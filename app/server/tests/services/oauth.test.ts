// The OAuth engine end to end (spec 15.3, 15.4) against a fake authorisation server: a
// bring-your-own client, state bound to the session and single use, PKCE, the scope check,
// tokens sealed by the credential service and never returned, transparent refresh on
// expiry mid-read, refreshes serialised by the lock against a provider that rotates
// refresh tokens, and a refused refresh surfacing as reconnect.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { readObject } from '../../src/contracts/connect-runtime/read.contract.ts';
import { changeConnectionStatus, createConnection, setConnectionSecrets } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import { completeOAuthFlow, discoverOAuthProvider, listOAuthClients, refreshConnectionToken, registerOAuthClient, registerSiloOAuthClient, revokeOAuthClient, startOAuthFlow } from '../../src/contracts/oauth/oauth.contract.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { createOAuthService } from '../../src/routes/oauth/index.route.ts';
import { canonicalJsonBytes } from '../../src/utils/canonicalJson.util.ts';
import { CELL_ID } from '../db/fixtures.helper.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { createConnectCell, doc, restManifest, type ConnectCell, type Signed } from './connect.helper.ts';

let cell: ConnectCell;
let gateway: ServiceClient;
let runtime: ServiceClient;
let executor: ServiceClient;
let root: Signed;
let rootUser: string;
let server: Server;
let baseUrl: string;

// The fake authorisation server and API.
const CLIENT = { id: 'silo-client', secret: 'client-secret-xyz' };
/** Silo's own application at the provider, registered by a Silo operator (spec 15.4). */
const SILO_CLIENT = { id: 'silo-registered-app', secret: 'silo-app-secret-0042' };
/** What the fake provider issues to a client that registers itself (RFC 7591). */
const DYNAMIC_CLIENT = { id: 'dyn-client-0007', secret: 'dyn-secret-0007', registration: 'reg-token-0007' };
const registrations: Record<string, unknown>[] = [];
let lastClient: string | undefined;
const as = {
  grantedScope: 'contacts.read contacts.write',
  refreshDelayMs: 0,
  codes: new Map<string, { challenge: string | null }>(),
  liveRefresh: new Set<string>(),
  liveAccess: new Set<string>(),
  refreshGrants: 0,
  clientCredentialGrants: 0,
  n: 0,
};
const issue = (withRefresh: boolean) => {
  as.n += 1;
  const access = `at-${as.n}`;
  as.liveAccess.add(access);
  const out: Record<string, unknown> = { access_token: access, token_type: 'Bearer', expires_in: 3600, scope: as.grantedScope };
  if (withRefresh) {
    out['refresh_token'] = `rt-${as.n}`;
    as.liveRefresh.add(`rt-${as.n}`);
  }
  return out;
};

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const url = new URL(req.url!, 'http://x');
      const json = (status: number, body: unknown) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
      };
      if (url.pathname === '/token') {
        const form = new URLSearchParams(Buffer.concat(chunks).toString());
        const basic = req.headers.authorization?.replace(/^Basic /, '') ?? '';
        const [id, secret] = Buffer.from(basic, 'base64').toString().split(':').map(decodeURIComponent);
        const grant = form.get('grant_type');
        if (grant === 'client_credentials') {
          if (form.get('client_id') !== 'cc-id' || form.get('client_secret') !== 'cc-secret') return json(401, { error: 'invalid_client' });
          as.clientCredentialGrants += 1;
          return json(200, issue(false));
        }
        if (![CLIENT, SILO_CLIENT, DYNAMIC_CLIENT].some((c) => c.id === id && c.secret === secret)) return json(401, { error: 'invalid_client' });
        lastClient = id;
        if (grant === 'authorization_code') {
          const code = as.codes.get(form.get('code') ?? '');
          if (!code || form.get('redirect_uri') !== 'https://cell.example/oauth/callback') return json(400, { error: 'invalid_grant' });
          as.codes.delete(form.get('code')!);
          const verifier = form.get('code_verifier');
          if (code.challenge !== null && (verifier === null || createHash('sha256').update(verifier).digest('base64url') !== code.challenge)) {
            return json(400, { error: 'invalid_grant' });
          }
          return json(200, issue(true));
        }
        if (grant === 'refresh_token') {
          as.refreshGrants += 1;
          await new Promise((r) => setTimeout(r, as.refreshDelayMs));
          const presented = form.get('refresh_token') ?? '';
          if (!as.liveRefresh.has(presented)) return json(400, { error: 'invalid_grant' });
          as.liveRefresh.delete(presented); // the provider rotates: the old one stops working
          return json(200, issue(true));
        }
        return json(400, { error: 'unsupported_grant_type' });
      }
      // Discovery (RFC 8414) and dynamic registration (RFC 7591), as a provider with no catalogue connector offers them.
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        return json(200, { issuer: baseUrl, authorization_endpoint: 'http://idp.example/authorize'.replace('http://idp.example', baseUrl), token_endpoint: `${baseUrl}/token`,
          registration_endpoint: `${baseUrl}/register`, scopes_supported: ['contacts.read', 'contacts.write'], grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'] });
      }
      if (url.pathname === '/register' && req.method === 'POST') {
        registrations.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
        return json(201, { client_id: DYNAMIC_CLIENT.id, client_secret: DYNAMIC_CLIENT.secret, registration_access_token: DYNAMIC_CLIENT.registration });
      }
      if (url.pathname === '/v1/contacts') {
        const token = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
        if (!as.liveAccess.has(token)) return json(401, { message: 'expired' });
        return json(200, { results: [{ id: 'c1', properties: { email: 'a@example.com', first: 'A', last: 'B', score: 1 } }], next: null });
      }
      return json(404, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cell = await createConnectCell();
  await cell.start(createOAuthService({ sweepMs: 200 }), 'oauth', 'test_app', { OAUTH_REDIRECT_URI: 'https://cell.example/oauth/callback' });
  await cell.start(createConnectRuntimeService(), 'connect-runtime', 'test_app');
  gateway = cell.client('gateway');
  runtime = cell.client('connect-runtime');
  executor = cell.client('executor');
  root = await cell.signIn('root@acme.example');
  const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query('select user_id from iam.memberships where id = $1', [root.membershipId]));
  rootUser = rows[0]!.user_id as string;
});

after(async () => {
  await cell?.close();
  server?.close();
});

const oauthManifest = (strategy = 'oauth2_code_pkce', fields: unknown[] = []) => restManifest({
  baseUrl,
  auth: {
    strategy, fields, scopes: ['contacts.read', 'contacts.write'],
    endpoints: { authorise: 'https://idp.example/authorize', token: `${baseUrl}/token` },
    ...(strategy === 'oauth2_client_credentials' ? { clientAuthentication: 'client_secret_post' } : {}),
  },
});

async function draftConnection(document = oauthManifest()): Promise<{ connectionId: string; connectorId: string }> {
  const connector = await gateway.call(createConnector, { body: { slug: `o-${uuidv7().slice(-12)}`, name: 'OAuth CRM', provider: 'Example', sourceRoute: 'ai' } },
    { ...cell.as(root), idempotencyKey: uuidv7() });
  await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document } }, { ...cell.as(root), idempotencyKey: uuidv7() });
  const connection = await gateway.call(createConnection, { body: { connectorId: connector.id, name: 'CRM', owningScopeId: cell.scopes['engineering']! } },
    { ...cell.as(root), idempotencyKey: uuidv7() });
  return { connectionId: connection.id, connectorId: connector.id };
}

async function activate(connectionId: string): Promise<void> {
  let version = 1;
  for (const move of ['probe', 'confirm', 'activate'] as const) {
    if (move === 'confirm') await cell.passConformance(connectionId);
    version = (await gateway.call(changeConnectionStatus, { params: { connectionId }, body: { move, version } }, cell.as(root))).version;
  }
}

const register = (connectorId: string) => gateway.call(registerOAuthClient, { body: { connectorId, clientId: CLIENT.id, clientSecret: CLIENT.secret } },
  { ...cell.as(root), idempotencyKey: uuidv7() });

/** Starts a flow and plays the provider's side: the person consents, the provider issues a code. */
async function consent(connectionId: string): Promise<{ state: string; code: string; url: URL }> {
  const { authorisationUrl } = await gateway.call(startOAuthFlow, { body: { connectionId } }, cell.as(root));
  const url = new URL(authorisationUrl);
  const code = `code-${uuidv7()}`;
  as.codes.set(code, { challenge: url.searchParams.get('code_challenge') });
  return { state: url.searchParams.get('state')!, code, url };
}

const callback = (state: string, code: string, sessionId = root.sessionId) => gateway.call(completeOAuthFlow, { body: { state, code } },
  { request: { userId: rootUser, sessionId } });

const liveFields = async (connectionId: string) => (await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
  `select field_name, expires_at, granted_scopes, refresh_failure_count from connect.connection_credentials_safe
   where connection_id = $1 and revoked_at is null order by field_name`, [connectionId]))).rows;

describe('the authorisation code flow (spec 15.3)', () => {
  let connectionId: string;
  let connectorId: string;

  before(async () => {
    ({ connectionId, connectorId } = await draftConnection());
  });

  test('a flow needs a registered client; a bring-your-own client\'s secret is sealed', async () => {
    await assert.rejects(gateway.call(startOAuthFlow, { body: { connectionId } }, cell.as(root)), { code: 'oauth.client_missing' });
    const key = uuidv7();
    const client = await gateway.call(registerOAuthClient, { body: { connectorId, clientId: CLIENT.id, clientSecret: CLIENT.secret } },
      { ...cell.as(root), idempotencyKey: key });
    assert.deepEqual(await gateway.call(registerOAuthClient, { body: { connectorId, clientId: CLIENT.id, clientSecret: CLIENT.secret } },
      { ...cell.as(root), idempotencyKey: key }), client);
    assert.equal(client.redirectUri, 'https://cell.example/oauth/callback');
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select purpose, last_four, connection_id from connect.connection_credentials_safe where id = (select client_secret_credential_id from connect.oauth_clients where id = $1)`, [client.id]));
    assert.deepEqual(rows[0], { purpose: 'oauth_client_secret', last_four: '-xyz', connection_id: null });
  });

  test('the authorisation URL carries an opaque state and a PKCE challenge; only hashes and seals are stored', async () => {
    const { state, url } = await consent(connectionId);
    assert.equal(url.origin + url.pathname, 'https://idp.example/authorize');
    assert.equal(url.searchParams.get('client_id'), CLIENT.id);
    assert.equal(url.searchParams.get('redirect_uri'), 'https://cell.example/oauth/callback');
    assert.equal(url.searchParams.get('scope'), 'contacts.read contacts.write');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.match(state, /^[A-Za-z0-9_-]{43}$/);
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      'select state_hash, pkce_verifier_sealed, session_id from connect.oauth_pending_flows where connection_id = $1', [connectionId]));
    const row = rows.find((r) => (r.state_hash as Buffer).equals(createHash('sha256').update(state).digest()));
    assert.ok(row, 'the state is stored as its hash');
    assert.equal(row.session_id, root.sessionId);
    assert.ok((row.pkce_verifier_sealed as Buffer).length > 40);
  });

  test('the callback is bound to the session that started the flow, and the state is single use', async () => {
    const other = await cell.signIn('root@acme.example');
    const { state, code } = await consent(connectionId);
    await assert.rejects(callback(state, code, other.sessionId), { code: 'oauth.session_mismatch' });
    await assert.rejects(callback(state, code), { code: 'oauth.state_invalid' }, 'consumed by the first attempt');
    await assert.rejects(callback('x'.repeat(43), code), { code: 'oauth.state_invalid' });
  });

  test('the code is exchanged inside the credential service: PKCE verified, scopes checked, tokens sealed and never returned', async () => {
    const { state, code } = await consent(connectionId);
    const result = await callback(state, code);
    assert.deepEqual(result, { organisationId: cell.org, connectionId, grantedScopes: ['contacts.read', 'contacts.write'] });
    assert.ok(!JSON.stringify(result).includes('at-'), 'no token in the response');
    const fields = await liveFields(connectionId);
    assert.deepEqual(fields.map((f) => f.field_name), ['access_token', 'refresh_token']);
    assert.ok(fields[0]!.expires_at !== null);
    assert.deepEqual(fields[0]!.granted_scopes, ['contacts.read', 'contacts.write']);
    await assert.rejects(callback(state, code), { code: 'oauth.state_invalid' });
  });

  test('a missing scope is refused by name at connect time, and nothing is stored', async () => {
    const { connectionId: other, connectorId: otherConnector } = await draftConnection();
    await register(otherConnector);
    as.grantedScope = 'contacts.read';
    try {
      const { state, code } = await consent(other);
      await assert.rejects(callback(state, code), (error: { code: string; details: Record<string, string> }) =>
        error.code === 'oauth.scope_missing' && error.details['missing'] === 'contacts.write');
      assert.deepEqual(await liveFields(other), []);
    } finally {
      as.grantedScope = 'contacts.read contacts.write';
    }
  });

  test('a provider error on the callback is refused, not stored', async () => {
    const { state } = await consent(connectionId);
    await assert.rejects(gateway.call(completeOAuthFlow, { body: { state, error: 'access_denied' } }, { request: { userId: rootUser, sessionId: root.sessionId } }),
      { code: 'oauth.provider_error' });
  });
});

describe('Silo-registered clients (spec 15.4, 15.5)', () => {
  let catalogueConnector: string;
  let systemOrg: string;

  before(async () => {
    // As Fleet provisions them: the cell's system organisation, and a catalogue connector.
    systemOrg = uuidv7();
    await cell.migrate.query(
      `insert into iam.organisations (id, name, slug, plan, cell_id, calendar_time_zone, is_system)
       values ($1, 'Silo', 'silo-system', 'enterprise', $2, 'Europe/London', true)`, [systemOrg, CELL_ID]);
    catalogueConnector = uuidv7();
    const document = oauthManifest('oauth2_code');
    await cell.migrate.query(
      `insert into connect.connectors (id, organisation_id, kind, slug, name, provider, trust_tier, source_route, status)
       values ($1, null, 'prebuilt', 'example-oauth-crm', 'Example CRM', 'Example', 'certified', 'catalogue', 'active')`, [catalogueConnector]);
    await cell.migrate.query(
      `insert into connect.connector_manifests (id, organisation_id, connector_id, version, document, document_hash, schema_version, source_route)
       values ($1, null, $2, '1.0.0', $3, $4, '1', 'catalogue')`,
      [uuidv7(), catalogueConnector, JSON.stringify(document), createHash('sha256').update(canonicalJsonBytes(document)).digest()]);
  });

  test('a Silo operator registers Silo\'s client for a catalogue connector, in the system organisation, never a tenant\'s', async () => {
    const portal = cell.client('admin-portal');
    const operatorId = uuidv7();
    const registered = await portal.call(registerSiloOAuthClient, {
      body: { operatorId, connectorId: catalogueConnector, clientId: SILO_CLIENT.id, clientSecret: SILO_CLIENT.secret },
    });
    assert.equal(registered.origin, 'silo_registered');
    const { rows } = await inTx(cell.app, { orgId: systemOrg }, () => cell.app.query(
      `select c.organisation_id, s.purpose, s.last_four from connect.oauth_clients c
       join connect.connection_credentials_safe s on s.id = c.client_secret_credential_id where c.id = $1`, [registered.id]));
    assert.deepEqual(rows[0], { organisation_id: systemOrg, purpose: 'oauth_client_secret', last_four: '0042' });
    const { connectorId: privateOne } = await draftConnection();
    await assert.rejects(portal.call(registerSiloOAuthClient, { body: { operatorId, connectorId: privateOne, clientId: 'x' } }),
      { code: 'oauth.catalogue_connector_required' });
  });

  test('an organisation with no client of its own connects through Silo\'s; its own client, once registered, comes first', async () => {
    const connection = await gateway.call(createConnection, {
      body: { connectorId: catalogueConnector, name: 'Catalogue CRM', owningScopeId: cell.scopes['engineering']! },
    }, { ...cell.as(root), idempotencyKey: uuidv7() });
    const first = await consent(connection.id);
    assert.equal(first.url.searchParams.get('client_id'), SILO_CLIENT.id);
    await callback(first.state, first.code);
    assert.equal(lastClient, SILO_CLIENT.id, 'the code was exchanged with Silo\'s secret, opened in the system organisation');
    const unwraps = await inTx(cell.app, { orgId: systemOrg }, () => cell.app.query(
      `select reason from iam.credential_unwraps where organisation_id = $1`, [systemOrg]));
    assert.deepEqual(unwraps.rows.map((r) => r.reason), ['connect']);

    await gateway.call(registerOAuthClient, { body: { connectorId: catalogueConnector, clientId: CLIENT.id, clientSecret: CLIENT.secret } },
      { ...cell.as(root), idempotencyKey: uuidv7() });
    const second = await consent(connection.id);
    assert.equal(second.url.searchParams.get('client_id'), CLIENT.id, 'bring your own comes before Silo\'s');
  });
});

describe('refresh (spec 15.3)', () => {
  let connectionId: string;

  before(async () => {
    let connectorId: string;
    ({ connectionId, connectorId } = await draftConnection());
    await register(connectorId);
    const { state, code } = await consent(connectionId);
    await callback(state, code);
    await activate(connectionId);
  });

  const expire = () => inTx(cell.credential, { orgId: cell.org }, () => cell.credential.query(
    `update connect.connection_credentials set expires_at = now() - interval '1 minute' where connection_id = $1 and field_name = 'access_token' and revoked_at is null`,
    [connectionId]));

  test('an expired token mid-read is refreshed transparently, and the provider\'s rotated refresh token sealed', async () => {
    const before = as.refreshGrants;
    await expire();
    const out = await executor.call(readObject, { body: { connectionId, reason: 'query', step: { object: 'contacts' } } }, cell.as(root));
    assert.equal(out.rows.length, 1);
    assert.equal(as.refreshGrants, before + 1);
    const fields = await liveFields(connectionId);
    assert.ok(Date.parse(fields[0]!.expires_at as string) > Date.now());
  });

  test('a token the provider rejects before its recorded expiry is refreshed once, then the read retried', async () => {
    as.liveAccess.clear();
    const before = as.refreshGrants;
    const out = await executor.call(readObject, { body: { connectionId, reason: 'query', step: { object: 'contacts' } } }, cell.as(root));
    assert.equal(out.rows.length, 1);
    assert.equal(as.refreshGrants, before + 1);
  });

  test('concurrent refreshes are serialised by the lock: one grant, so a rotated refresh token is never reused', async () => {
    as.refreshDelayMs = 300;
    try {
      const before = as.refreshGrants;
      const results = await Promise.all(Array.from({ length: 4 }, () => runtime.call(refreshConnectionToken, { body: { connectionId } }, cell.as(root))));
      assert.equal(as.refreshGrants, before + 1, 'the waiting callers used the refresh in flight');
      assert.ok(results.every((r) => r.expiresAt === results[0]!.expiresAt));
    } finally {
      as.refreshDelayMs = 0;
    }
  });

  test('a refused refresh surfaces as reconnect, counts a failure and is audited, never an empty result', async () => {
    as.liveRefresh.clear();
    as.liveAccess.clear();
    await expire();
    await assert.rejects(executor.call(readObject, { body: { connectionId, reason: 'query', step: { object: 'contacts' } } }, cell.as(root)),
      { category: 'unauthenticated', code: 'oauth.grant_refused' });
    const fields = await liveFields(connectionId);
    assert.equal(fields.find((f) => f.field_name === 'refresh_token')!.refresh_failure_count, 1);
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select count(*)::int as n from platform.outbox where organisation_id = $1 and payload->>'event' = 'token_refresh_failed'`, [cell.org]));
    assert.ok(rows[0]!.n >= 1);
    const ledger = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select count(*)::int as n from iam.credential_unwraps where organisation_id = $1 and reason = 'refresh'`, [cell.org]));
    assert.ok(ledger.rows[0]!.n >= 2, 'every refresh opened the refresh token and the client secret, each logged');
  });
});

describe('client credentials (spec 15.1)', () => {
  test('a connection obtains its token with its own client credentials on first use', async () => {
    const document = oauthManifest('oauth2_client_credentials', [
      { name: 'client_id', kind: 'public', label: 'Client id', role: 'client_id' },
      { name: 'client_secret', kind: 'secret', label: 'Client secret', role: 'client_secret' },
    ]);
    const { connectionId } = await draftConnection(doc(document));
    await gateway.call(setConnectionSecrets, { params: { connectionId }, body: { values: { client_id: 'cc-id', client_secret: 'cc-secret' } } }, cell.as(root));
    await activate(connectionId);
    const before = as.clientCredentialGrants;
    const out = await executor.call(readObject, { body: { connectionId, reason: 'query', step: { object: 'contacts' } } }, cell.as(root));
    assert.equal(out.rows.length, 1);
    assert.equal(as.clientCredentialGrants, before + 1);
    await executor.call(readObject, { body: { connectionId, reason: 'query', step: { object: 'contacts' } } }, cell.as(root));
    assert.equal(as.clientCredentialGrants, before + 1, 'the token is reused until it expires');
  });
});

describe('unfinished sign-ins and withdrawn clients (spec 15.3, 15.6)', () => {
  test('a sign-in left unfinished past its expiry is marked expired once, audited, and can no longer complete', async () => {
    const { connectionId, connectorId } = await draftConnection();
    await register(connectorId);
    const { state, code } = await consent(connectionId);
    const hash = createHash('sha256').update(state).digest();
    await cell.migrate.query(`update connect.oauth_pending_flows set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where state_hash = $1`, [hash]);
    let expiredAt: string | null = null;
    for (let i = 0; i < 40 && expiredAt === null; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expiredAt = (await cell.migrate.query('select expired_at from connect.oauth_pending_flows where state_hash = $1', [hash])).rows[0].expired_at;
    }
    assert.ok(expiredAt !== null, 'the sweep marks it');
    await assert.rejects(callback(state, code), { code: 'oauth.state_invalid' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const { rows } = await cell.migrate.query(
      `select payload->'detail' as detail from platform.outbox where organisation_id = $1 and payload->>'event' = 'oauth_flow_expired' and payload->'resource'->>'id' = $2`,
      [cell.org, connectionId]);
    assert.equal(rows.length, 1, 'once, whatever the sweeps after');
    assert.equal(rows[0].detail.started_by, root.membershipId);
  });

  test('an organisation lists its clients and withdraws one: its secret shredded, recorded, and withdrawing again changes nothing', async () => {
    const live = (await gateway.call(listOAuthClients, { query: {} }, cell.as(root))).clients;
    const listed = live.find((c) => c.origin === 'bring_your_own' && c.confidential)!;
    assert.ok(listed !== undefined, 'its own confidential client is listed');
    assert.equal(listed.revokedAt, null);
    assert.ok(!JSON.stringify(live).includes('secret'), 'never a secret, nor where it is sealed');
    const { rows: clients } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      'select id, client_secret_credential_id from connect.oauth_clients where id = $1', [listed.id]));
    const client = clients[0]!;
    assert.deepEqual(await gateway.call(revokeOAuthClient, { params: { clientId: client.id } }, cell.as(root)), { revoked: true });
    assert.deepEqual(await gateway.call(revokeOAuthClient, { params: { clientId: client.id } }, cell.as(root)), { revoked: false });
    assert.ok(!(await gateway.call(listOAuthClients, { query: {} }, cell.as(root))).clients.some((c) => c.id === client.id), 'withdrawn, it leaves the live list');
    const all = (await gateway.call(listOAuthClients, { query: { includeRevoked: 'true' } }, cell.as(root))).clients;
    assert.ok(all.find((c) => c.id === client.id)?.revokedAt !== null, 'and is listed, withdrawn, when asked');
    const { rows: secret } = await inTx(cell.credential, { orgId: cell.org }, () => cell.credential.query(
      'select revoked_at, ciphertext from connect.connection_credentials where id = $1', [client.client_secret_credential_id]));
    assert.ok(secret[0].revoked_at !== null && secret[0].ciphertext === null, 'crypto-shredded');
    const { rows } = await cell.migrate.query(
      `select 1 from platform.outbox where organisation_id = $1 and payload->>'event' = 'oauth_client_revoked' and payload->'resource'->>'id' = $2`, [cell.org, client.id]);
    assert.equal(rows.length, 1);
  });
});

describe('providers the catalogue does not know (spec 15.4)', () => {
  test('a provider\'s discovery document gives its endpoints, flows and scopes with nothing typed', async () => {
    const found = await gateway.call(discoverOAuthProvider, { body: { url: baseUrl } }, cell.as(root));
    assert.deepEqual([found.issuer, found.tokenEndpoint, found.registrationEndpoint, found.scopesSupported, found.codeChallengeMethodsSupported],
      [baseUrl, `${baseUrl}/token`, `${baseUrl}/register`, ['contacts.read', 'contacts.write'], ['S256']]);
    assert.ok(found.metadataUrl.endsWith('/.well-known/oauth-authorization-server'), 'the issuer\'s RFC 8414 address');
    await assert.rejects(gateway.call(discoverOAuthProvider, { body: { url: `${baseUrl}/nowhere/.well-known/oauth-authorization-server` } }, cell.as(root)),
      { code: 'oauth.discovery_missing' });
  });

  test('with no client registered, a manifest that names its metadata registers Silo dynamically and the sign-in proceeds as that client', async () => {
    const document = restManifest({ baseUrl, auth: {
      strategy: 'oauth2_code_pkce', fields: [], scopes: ['contacts.read', 'contacts.write'],
      endpoints: { authorise: 'https://idp.example/authorize', token: `${baseUrl}/token`, metadata: baseUrl },
    } });
    const { connectionId, connectorId } = await draftConnection(document);
    const { state, code, url } = await consent(connectionId);
    assert.equal(url.searchParams.get('client_id'), DYNAMIC_CLIENT.id, 'the client the provider registered');
    assert.deepEqual([registrations.at(-1)!['redirect_uris'], registrations.at(-1)!['token_endpoint_auth_method']],
      [['https://cell.example/oauth/callback'], 'client_secret_basic']);
    const { rows: clients } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select origin, metadata_url, client_secret_credential_id is not null as sealed, registration_access_token_credential_id is not null as token
         from connect.oauth_clients where connector_id = $1`, [connectorId]));
    assert.deepEqual(clients, [{ origin: 'dynamic_registration', metadata_url: baseUrl, sealed: true, token: true }]);
    const done = await callback(state, code);
    assert.equal(done.connectionId, connectionId);
    const { rows: events } = await cell.migrate.query(
      `select payload->>'event' as event, payload->'detail' as detail from platform.outbox where organisation_id = $1
          and payload->>'event' in ('oauth_metadata_discovered', 'oauth_client_registered') order by seq`, [cell.org]);
    assert.ok(events.some((e) => e.event === 'oauth_client_registered' && e.detail.origin === 'dynamic_registration'));
    assert.ok(events.filter((e) => e.event === 'oauth_metadata_discovered').length >= 2, 'discovery recorded, by a person and on the sign-in');
  });
});
