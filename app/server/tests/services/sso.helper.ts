// Shared by the SSO tests: real credential, policy, auth and gateway processes on a fresh
// cell database and Redis, a browser that keeps the session cookie, and a local OIDC
// provider that signs real ID tokens with its own RSA key.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants, createCipheriv, createHash, createPublicKey, generateKeyPairSync, publicEncrypt, randomBytes, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { SignedXml } from 'xml-crypto';
import type pg from 'pg';
import { loadConfig, type Config } from '../../src/config/index.config.ts';
import { storeIdentityProvider } from '../../src/contracts/credential/identityProvider.contract.ts';
import type { CallInput } from '../../src/contracts/endpoint.contract.ts';
import { createServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { provisionOrganisation } from '../../src/db/scripts/provision.script.ts';
import { createLogger } from '../../src/infra/logger.infra.ts';
import { withTransaction } from '../../src/infra/postgres.infra.ts';
import { runProcess, type RunningProcess } from '../../src/process.ts';
import { createAuthService } from '../../src/routes/auth/index.route.ts';
import { service as credentialService } from '../../src/routes/credential/index.route.ts';
import { createGatewayService } from '../../src/routes/gateway/index.route.ts';
import { service as policyService } from '../../src/routes/policy/index.route.ts';
import { SESSION_COOKIE } from '../../src/middleware/cookies.middleware.ts';
import { CELL_ID, createLocalCell } from '../db/fixtures.helper.ts';
import { createHarness, inTx, uuidv7, type Harness } from '../db/harness.helper.ts';
import { LOCAL } from '../infra/services.helper.ts';

export const PASSWORD = 'correct horse battery staple';
export const ORIGIN = 'https://app.silo.test';
// SSO_TEST_LOG=1 prints the services' error logs, for debugging these tests.
const quiet = createLogger({
  service: 'test', cell: CELL_ID, release: 'test', level: 'error',
  write: process.env['SSO_TEST_LOG'] ? (line) => process.stderr.write(`${line}\n`) : () => undefined,
});

export const b64url = (data: Buffer | string): string => Buffer.from(data).toString('base64url');

// ----------------------------------------------------------------------------- the cell

export interface Cell {
  h: Harness;
  migrate: pg.Client;
  app: pg.Client;
  org: string;
  rootMembership: string;
  roles: Record<string, string>;
  gateway: string;
  /** The credential service, for setting a provider up without the policy service. */
  credential: string;
  invitations: { email: string; token: string; correlationId: string }[];
  processes: RunningProcess[];
  close(): Promise<void>;
}

export async function startCell(extraAuth: Record<string, string> = {}, extraCredential: Record<string, string> = {}): Promise<Cell> {
  const h = await createHarness();
  const migrate = await h.connect('test_migrate');
  const app = await h.connect('test_app');
  await createLocalCell(migrate);
  await migrate.query(`insert into iam.kms_key_versions (id, provider, key_uri, version, status, activated_at) values ($1, 'local', 'local:t', 1, 'active', now())`, [uuidv7()]);
  const created = await withTransaction(migrate, {}, (db) => provisionOrganisation(db, {
    slug: 'acme', name: 'Acme', email: 'root@acme.example', firstName: 'Root', lastName: 'Admin', password: PASSWORD, cellId: CELL_ID,
    plan: 'business', timeZone: 'Europe/London',
  }, { ARGON2_MEMORY_KIB: '1024', ARGON2_PASSES: '1' }));
  const roles: Record<string, string> = {};
  const { rows } = await inTx(app, { orgId: created.organisationId }, () =>
    app.query('select id, name from iam.roles where organisation_id = $1', [created.organisationId]));
  for (const row of rows) roles[row.name as string] = row.id as string;

  const env = (service: string, extra: Record<string, string>): Config => loadConfig({
    SILO_ENV: 'test', SILO_SERVICE: service, SILO_CELL_ID: CELL_ID, SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk', SILO_HOSTING: 'gke',
    SILO_BUILD_TARGET: 'commercial', HTTP_HOST: '127.0.0.1', HTTP_PORT: '0', HTTP_DRAIN_SECONDS: '0', ...extra,
  });
  const pgOf = (login: 'test_auth' | 'test_credential' | 'test_app') => ({ PG_CONTROL_URL: h.url(login), REDIS_SESSION_URL: `${LOCAL.redisUrl}/0` });
  const processes: RunningProcess[] = [];
  const credential = await runProcess([credentialService], env('credential', {
    ...pgOf('test_credential'), KMS_PROVIDER: 'local', KMS_LOCAL_KEY: randomBytes(32).toString('base64'),
    // The fake provider listens on loopback over plain HTTP.
    CONNECT_EGRESS_ALLOW_PRIVATE: 'true', CONNECT_EGRESS_ALLOW_HTTP: 'true', ...extraCredential,
  }), { logger: quiet });
  const policy = await runProcess([policyService], env('policy', pgOf('test_app')), { logger: quiet });
  const invitations: { email: string; token: string; correlationId: string }[] = [];
  const auth = await runProcess([createAuthService({
    invitationDelivery: {
      async deliver(invitation) { invitations.push({ email: invitation.email, token: invitation.token, correlationId: invitation.correlationId }); },
    },
    resetDelivery: { async deliver() { /* not used here */ } },
  })], env('auth', {
    ...pgOf('test_auth'), REDIS_DATA_URL: `${LOCAL.redisUrl}/1`, IDENTIFIER_HASH_KEY: randomBytes(32).toString('base64'),
    ARGON2_MEMORY_KIB: '1024', ARGON2_PASSES: '1', LOGIN_ATTEMPTS_PER_ADDRESS: '1000', LOGIN_ATTEMPTS_PER_EMAIL: '1000',
    SERVICE_URL_CREDENTIAL: `http://127.0.0.1:${credential.port}`, SERVICE_URL_POLICY: `http://127.0.0.1:${policy.port}`,
    GATEWAY_PUBLIC_ORIGIN: ORIGIN, ...extraAuth,
  }), { logger: quiet });
  let port = 0;
  const gateway = await runProcess([createGatewayService({ onListening: (p) => { port = p; } })], env('gateway', {
    REDIS_DATA_URL: `${LOCAL.redisUrl}/1`, NATS_LIVE_URL: LOCAL.natsUrl, IDENTIFIER_HASH_KEY: randomBytes(32).toString('base64'),
    GATEWAY_PUBLIC_ORIGIN: ORIGIN, GATEWAY_PUBLIC_HOST: '127.0.0.1', GATEWAY_PUBLIC_PORT: '0', TRUST_PROXY_HOPS: '1',
    SERVICE_URL_AUTH: `http://127.0.0.1:${auth.port}`, SERVICE_URL_POLICY: `http://127.0.0.1:${policy.port}`,
  }), { logger: quiet });
  processes.push(gateway, auth, policy, credential);
  return {
    h, migrate, app, org: created.organisationId, rootMembership: created.membershipId, roles, gateway: `http://127.0.0.1:${port}`,
    credential: `http://127.0.0.1:${credential.port}`, invitations, processes,
    async close() {
      for (const p of processes) await p.stop('test');
      await h.close();
    },
  };
}

// ----------------------------------------------------------------------------- a browser

let addresses = 0;
export interface Browser { cookie: string | undefined; address: string }
export const browser = (): Browser => ({ cookie: undefined, address: `198.51.${Math.floor(++addresses / 250)}.${(addresses % 250) + 1}` });

export interface Reply { status: number; body: any; text: string; headers: Headers }

export async function call(base: string, who: Browser | undefined, method: string, path: string, body?: unknown,
  extraHeaders: Record<string, string> = {}): Promise<Reply> {
  const headers: Record<string, string> = { 'x-forwarded-for': who?.address ?? '198.51.200.1', ...extraHeaders };
  if (method !== 'GET') {
    headers['origin'] = ORIGIN;
    headers['x-silo-csrf'] = '1';
  }
  if (who?.cookie) headers['cookie'] = `${SESSION_COOKIE}=${who.cookie}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  for (const cookie of res.headers.getSetCookie()) {
    const match = /^__Host-silo_session=([^;]*);.*Max-Age=(\d+)$/.exec(cookie);
    if (match && who) who.cookie = match[2] === '0' ? undefined : match[1];
  }
  return { status: res.status, body: text === '' ? undefined : JSON.parse(text), text, headers: res.headers };
}

export async function signIn(base: string, email: string, password = PASSWORD): Promise<Browser> {
  const who = browser();
  const reply = await call(base, who, 'POST', '/sessions', { organisationSlug: 'acme', email, password });
  assert.equal(reply.status, 201, reply.text);
  return who;
}

// ----------------------------------------------------------------------------- an OIDC provider

export interface OidcLogin { claims: Record<string, unknown>; error?: string; state?: string }

export interface FakeOidc {
  issuer: string;
  /** Who signs in at the next /authorize: the claims the ID token will carry. */
  next: OidcLogin;
  /** Sign the next ID token with another key, which the provider never published. */
  rogueKey: boolean;
  tokenRequests: { authorization: string | undefined; body: URLSearchParams }[];
  close(): Promise<void>;
}

export async function startFakeOidc(clientId: string, clientSecret: string): Promise<FakeOidc> {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rogue = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...key.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { claims: Record<string, unknown>; nonce: string; challenge: string; redirectUri: string; clientId: string }>();
  const fake: FakeOidc = {
    issuer: '', next: { claims: {} }, rogueKey: false, tokenRequests: [],
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  const jwt = (claims: Record<string, unknown>, signer: KeyObject): string => {
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k1' }));
    const body = b64url(JSON.stringify(claims));
    return `${head}.${body}.${b64url(sign('sha256', Buffer.from(`${head}.${body}`), signer))}`;
  };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', fake.issuer);
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: fake.issuer, authorization_endpoint: `${fake.issuer}/authorize`, token_endpoint: `${fake.issuer}/token`,
        jwks_uri: `${fake.issuer}/jwks`, response_types_supported: ['code'], subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/authorize') {
      const p = url.searchParams;
      const redirect = new URL(p.get('redirect_uri')!);
      const login = fake.next;
      if (login.error) {
        redirect.searchParams.set('error', login.error);
      } else {
        const code = b64url(randomBytes(16));
        codes.set(code, { claims: login.claims, nonce: p.get('nonce')!, challenge: p.get('code_challenge')!, redirectUri: p.get('redirect_uri')!, clientId: p.get('client_id')! });
        redirect.searchParams.set('code', code);
      }
      redirect.searchParams.set('state', login.state ?? p.get('state')!);
      res.writeHead(302, { location: redirect.href });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); });
      req.on('end', () => {
        const body = new URLSearchParams(raw);
        fake.tokenRequests.push({ authorization: req.headers.authorization, body });
        // RFC 6749 2.3.1: the id and secret are form-encoded before base64.
        const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '')?.[1];
        const [id, secret] = Buffer.from(basic ?? '', 'base64').toString('utf8').split(':').map((part) => decodeURIComponent(part.replaceAll('+', ' ')));
        if (id !== clientId || secret !== clientSecret) return json(401, { error: 'invalid_client' });
        const grant = codes.get(body.get('code') ?? '');
        codes.delete(body.get('code') ?? '');
        if (!grant || body.get('grant_type') !== 'authorization_code' || body.get('redirect_uri') !== grant.redirectUri) {
          return json(400, { error: 'invalid_grant' });
        }
        const verifier = body.get('code_verifier') ?? '';
        if (b64url(createHash('sha256').update(verifier).digest()) !== grant.challenge) return json(400, { error: 'invalid_grant' });
        const now = Math.floor(Date.now() / 1000);
        const idToken = jwt({ iss: fake.issuer, aud: grant.clientId, iat: now, exp: now + 300, nonce: grant.nonce, ...grant.claims },
          fake.rogueKey ? rogue.privateKey : key.privateKey);
        return json(200, { access_token: b64url(randomBytes(16)), token_type: 'Bearer', expires_in: 300, id_token: idToken });
      });
      return undefined;
    }
    return json(404, { error: 'not_found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  fake.issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

/** A browser's whole OIDC sign-in: start, the provider's redirect, and the app's callback page posting back. */
export async function oidcSignIn(base: string, providerId: string, options: { who?: Browser; invitationToken?: string; link?: boolean;
  tamperBinding?: boolean } = {}): Promise<{ who: Browser; reply: Reply; started: Reply }> {
  const who = options.who ?? browser();
  const started = options.link
    ? await call(base, who, 'POST', '/sso/link', { providerId })
    : await call(base, who, 'POST', '/sso/start', { organisationSlug: 'acme', providerId, ...(options.invitationToken ? { invitationToken: options.invitationToken } : {}) });
  if (started.status !== 201) return { who, reply: started, started };
  const authorise = await fetch(started.body.redirectUrl, { redirect: 'manual' });
  const callback = new URL(authorise.headers.get('location')!);
  assert.equal(`${callback.origin}${callback.pathname}`, `${ORIGIN}/sso/callback`);
  const binding = options.tamperBinding ? b64url(randomBytes(32)) : started.body.binding;
  const reply = await call(base, who, 'POST', '/sso/oidc/complete', { callbackQuery: callback.search.slice(1), binding });
  return { who, reply, started };
}

/** Stores a provider as auth would, straight to the credential service (as root). */
export async function storeProvider(cell: Cell, providerId: string, body: CallInput<typeof storeIdentityProvider>['body']): Promise<number> {
  const config = loadConfig({
    SILO_ENV: 'test', SILO_SERVICE: 'workspace', SILO_CELL_ID: CELL_ID, SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk',
    SILO_HOSTING: 'gke', SILO_BUILD_TARGET: 'commercial',
    // Only the HTTP section is used: the workspace service's needs are placeholders.
    PG_CONTROL_URL: 'postgres://unused@127.0.0.1:1/unused', REDIS_DATA_URL: 'redis://127.0.0.1:1/0',
  });
  const client = createServiceClient({ caller: 'auth', http: { ...config.http, serviceUrls: { credential: cell.credential } } });
  try {
    const stored = await client.call(storeIdentityProvider, { params: { providerId }, body }, {
      request: { organisationId: cell.org, membershipId: cell.rootMembership },
    });
    return stored.version;
  } finally {
    client.close();
  }
}

// ----------------------------------------------------------------------------- a SAML identity provider

export interface SamlIdp {
  entityId: string;
  ssoUrl: string;
  /** PEM certificates, by name. */
  certs: Record<string, string>;
  keys: Record<string, string>;
  /** Its single logout address (HTTP-Redirect), where its metadata offers one. */
  sloUrl: string;
  /** The IdP's metadata naming these certificates, and its single logout address with slo. */
  metadata(certNames: string[], options?: { slo?: boolean }): string;
  /** A LogoutRequest or LogoutResponse on the HTTP-Redirect binding, signed with its key: the full URL to the SP's address. */
  logoutRedirect(kind: 'request' | 'response', target: string, fields: { nameId?: string; sessionIndex?: string; inResponseTo?: string; relayState?: string },
    signWith?: string): string;
  /** A signed response to an AuthnRequest. */
  respond(request: { id: string; acsUrl: string; audience: string }, who: { nameId: string; email: string; given?: string; family?: string },
    options?: { signWith?: string; tamper?: (xml: string) => string; context?: string; encryptTo?: string }): string;
}

/** A self-signed signing certificate, through openssl as the mTLS test makes its CA. */
export function selfSigned(dir: string, name: string): { cert: string; key: string } {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.crt`, '-days', '1',
    '-subj', `/CN=${name}`], { cwd: dir, stdio: 'ignore' });
  return { cert: readFileSync(path.join(dir, `${name}.crt`), 'utf8'), key: readFileSync(path.join(dir, `${name}.key`), 'utf8') };
}

export function startFakeSamlIdp(entityId: string): SamlIdp {
  const dir = mkdtempSync(path.join(tmpdir(), 'silo-saml-'));
  const pairs = { first: selfSigned(dir, 'first'), second: selfSigned(dir, 'second'), rogue: selfSigned(dir, 'rogue') };
  rmSync(dir, { recursive: true, force: true });
  const der = (pem: string): string => pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const ssoUrl = 'https://idp.example/sso/redirect';
  const sloUrl = 'https://idp.example/slo/redirect';
  return {
    entityId, ssoUrl, sloUrl,
    certs: Object.fromEntries(Object.entries(pairs).map(([name, p]) => [name, p.cert])),
    keys: Object.fromEntries(Object.entries(pairs).map(([name, p]) => [name, p.key])),
    logoutRedirect(kind, target, fields, signWith = 'first') {
      const at = new Date().toISOString();
      const id = `_l${randomBytes(16).toString('hex')}`;
      const xml = kind === 'request'
        ? `<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${at}" Destination="${target}">`
          + `<saml:Issuer>${entityId}</saml:Issuer><saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">${fields.nameId}</saml:NameID>`
          + `${fields.sessionIndex === undefined ? '' : `<samlp:SessionIndex>${fields.sessionIndex}</samlp:SessionIndex>`}</samlp:LogoutRequest>`
        : `<samlp:LogoutResponse xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${at}" Destination="${target}"${fields.inResponseTo === undefined ? '' : ` InResponseTo="${fields.inResponseTo}"`}>`
          + `<saml:Issuer>${entityId}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status></samlp:LogoutResponse>`;
      const encoded = deflateRawSync(Buffer.from(xml, 'utf8')).toString('base64');
      const query = `${kind === 'request' ? 'SAMLRequest' : 'SAMLResponse'}=${encodeURIComponent(encoded)}`
        + `${fields.relayState === undefined ? '' : `&RelayState=${encodeURIComponent(fields.relayState)}`}`
        + `&SigAlg=${encodeURIComponent('http://www.w3.org/2001/04/xmldsig-more#rsa-sha256')}`;
      const signature = sign('RSA-SHA256', Buffer.from(query, 'utf8'), pairs[signWith as keyof typeof pairs].key).toString('base64');
      return `${target}?${query}&Signature=${encodeURIComponent(signature)}`;
    },
    metadata(certNames, options = {}) {
      const keys = certNames.map((name) => `<md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${der(pairs[name as keyof typeof pairs].cert)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`).join('');
      return `<?xml version="1.0"?><md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${entityId}">`
        + `<md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">${keys}`
        + (options.slo ? `<md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${sloUrl}"/>` : '')
        + '<md:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:persistent</md:NameIDFormat>'
        + `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example/sso/post"/>`
        + `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${ssoUrl}"/>`
        + '</md:IDPSSODescriptor></md:EntityDescriptor>';
    },
    respond(request, who, options = {}) {
      const now = new Date();
      const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();
      const assertionId = `_a${randomBytes(16).toString('hex')}`;
      const attribute = (name: string, value: string | undefined) => (value === undefined ? ''
        : `<saml:Attribute Name="${name}"><saml:AttributeValue>${value}</saml:AttributeValue></saml:Attribute>`);
      const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" `
        + `ID="_r${randomBytes(16).toString('hex')}" Version="2.0" IssueInstant="${at(0)}" Destination="${request.acsUrl}" InResponseTo="${request.id}">`
        + `<saml:Issuer>${entityId}</saml:Issuer>`
        + '<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>'
        + `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" Version="2.0" IssueInstant="${at(0)}">`
        + `<saml:Issuer>${entityId}</saml:Issuer>`
        + `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">${who.nameId}</saml:NameID>`
        + '<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">'
        + `<saml:SubjectConfirmationData InResponseTo="${request.id}" NotOnOrAfter="${at(5)}" Recipient="${request.acsUrl}"/>`
        + '</saml:SubjectConfirmation></saml:Subject>'
        + `<saml:Conditions NotBefore="${at(-1)}" NotOnOrAfter="${at(5)}"><saml:AudienceRestriction><saml:Audience>${request.audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>`
        + `<saml:AuthnStatement AuthnInstant="${at(0)}" SessionIndex="_s1"><saml:AuthnContext><saml:AuthnContextClassRef>${options.context ?? 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport'}</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>`
        + `<saml:AttributeStatement>${attribute('email', who.email)}${attribute('firstName', who.given)}${attribute('lastName', who.family)}</saml:AttributeStatement>`
        + '</saml:Assertion></samlp:Response>';
      const signer = pairs[(options.signWith ?? 'first') as keyof typeof pairs];
      const sig = new SignedXml({
        privateKey: signer.key, publicCert: signer.cert,
        signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
        canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
      });
      sig.addReference({
        xpath: `//*[local-name(.)='Assertion' and @ID='${assertionId}']`,
        transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
        digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
      });
      sig.computeSignature(xml, {
        location: { reference: `//*[local-name(.)='Assertion' and @ID='${assertionId}']/*[local-name(.)='Issuer']`, action: 'after' },
      });
      let signed = (options.tamper ?? ((x: string) => x))(sig.getSignedXml());
      if (options.encryptTo !== undefined) {
        // XML Encryption of the signed assertion to the SP's certificate: AES-256-GCM, its key under RSA-OAEP.
        const start = signed.indexOf('<saml:Assertion');
        const end = signed.indexOf('</saml:Assertion>') + '</saml:Assertion>'.length;
        const key = randomBytes(32);
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        const body = Buffer.concat([iv, cipher.update(signed.slice(start, end), 'utf8'), cipher.final(), cipher.getAuthTag()]);
        const wrapped = publicEncrypt({ key: createPublicKey(options.encryptTo), padding: constants.RSA_PKCS1_OAEP_PADDING }, key);
        const encrypted = '<saml:EncryptedAssertion><xenc:EncryptedData xmlns:xenc="http://www.w3.org/2001/04/xmlenc#" Type="http://www.w3.org/2001/04/xmlenc#Element">'
          + '<xenc:EncryptionMethod Algorithm="http://www.w3.org/2009/xmlenc11#aes256-gcm"/>'
          + '<ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><xenc:EncryptedKey><xenc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p"/>'
          + `<xenc:CipherData><xenc:CipherValue>${wrapped.toString('base64')}</xenc:CipherValue></xenc:CipherData></xenc:EncryptedKey></ds:KeyInfo>`
          + `<xenc:CipherData><xenc:CipherValue>${body.toString('base64')}</xenc:CipherValue></xenc:CipherData></xenc:EncryptedData></saml:EncryptedAssertion>`;
        signed = signed.slice(0, start) + encrypted + signed.slice(end);
      }
      return Buffer.from(signed, 'utf8').toString('base64');
    },
  };
}

/** The AuthnRequest a SAML start redirects to: its ID and where the response must go. */
export function readAuthnRequest(redirectUrl: string): { id: string; acsUrl: string; issuer: string; relayState: string } {
  const url = new URL(redirectUrl);
  const xml = inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest')!, 'base64')).toString('utf8');
  return {
    id: /\sID="([^"]+)"/.exec(xml)![1]!,
    acsUrl: /AssertionConsumerServiceURL="([^"]+)"/.exec(xml)![1]!,
    issuer: /<saml:Issuer[^>]*>([^<]+)</.exec(xml)![1]!,
    relayState: url.searchParams.get('RelayState')!,
  };
}

/** The identity provider posts the browser's form to the gateway's assertion consumer. */
export async function postToAcs(base: string, samlResponse: string, relayState: string): Promise<{ status: number; location: string | null }> {
  const res = await fetch(`${base}/api/v1/sso/saml/acs`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://idp.example', 'sec-fetch-site': 'cross-site', 'x-forwarded-for': '203.0.113.9' },
    body: new URLSearchParams({ SAMLResponse: samlResponse, RelayState: relayState }).toString(),
  });
  await res.arrayBuffer();
  return { status: res.status, location: res.headers.get('location') };
}
