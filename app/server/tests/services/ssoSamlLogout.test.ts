// SAML with the cell's service provider key pair (spec 55.5; decision 2026-11-14): the SP
// metadata with its certificate and single logout address, AuthnRequests signed with the
// SP key, assertions encrypted to its certificate (and refused unencrypted where required),
// and single logout from either side: Silo's sign-out sends a signed LogoutRequest to the
// provider; the provider's LogoutRequest ends that person's sessions from it.

import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import {
  browser, call, ORIGIN, postToAcs, readAuthnRequest, selfSigned, signIn, startCell, startFakeSamlIdp, type Browser, type Cell, type SamlIdp,
} from './sso.helper.ts';

let cell: Cell;
let idp: SamlIdp;
let root: Browser;
let sp: { cert: string; key: string };
const provider = uuidv7();
let version = 0;
const SP_ENTITY = `${ORIGIN}/api/v1/sso/saml/metadata`;
const ACS = `${ORIGIN}/api/v1/sso/saml/acs`;
const der = (pem: string): string => pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');

async function configure(extra: Record<string, unknown> = {}): Promise<void> {
  const reply = await call(cell.gateway, root, 'PUT', `/identity-providers/${provider}`, {
    expectedVersion: version === 0 ? null : version, active: true, jitProvisioning: true, defaultRoleId: cell.roles['Member'], defaultScopeId: null,
    config: { kind: 'saml', metadataXml: idp.metadata(['first'], { slo: true }), ...extra },
  });
  assert.equal(reply.status, 200, reply.text);
  version = reply.body.version;
}

/** The browser flow up to a signed-in session: its AuthnRequest's redirect URL kept to read. */
async function samlSignIn(who: { nameId: string; email: string }, options: { encrypt?: boolean } = {}) {
  const person = browser();
  const started = await call(cell.gateway, person, 'POST', '/sso/start', { organisationSlug: 'acme', providerId: provider });
  assert.equal(started.status, 201, started.text);
  const request = readAuthnRequest(started.body.redirectUrl);
  const response = idp.respond({ id: request.id, acsUrl: ACS, audience: SP_ENTITY }, who, options.encrypt ? { encryptTo: sp.cert } : {});
  const posted = await postToAcs(cell.gateway, response, request.relayState);
  const fragment = new URLSearchParams(new URL(posted.location!).hash.slice(1));
  if (fragment.has('error')) return { person, error: fragment.get('error')!, redirectUrl: started.body.redirectUrl as string };
  const reply = await call(cell.gateway, person, 'POST', '/sso/saml/complete', { ticket: fragment.get('ticket'), binding: started.body.binding });
  assert.equal(reply.status, 201, reply.text);
  return { person, error: undefined, redirectUrl: started.body.redirectUrl as string };
}

const events = async (name: string) => (await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
  `select payload->'detail' as detail from platform.outbox where organisation_id = $1 and payload->>'event' = $2 order by created_at`, [cell.org, name],
))).rows.map((r) => r.detail as Record<string, unknown>);

before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'silo-sp-'));
  sp = selfSigned(dir, 'sp');
  rmSync(dir, { recursive: true, force: true });
  cell = await startCell({}, { SAML_SP_PRIVATE_KEY: sp.key, SAML_SP_CERTIFICATE: sp.cert });
  idp = startFakeSamlIdp('https://idp.example/logout-metadata');
  root = await signIn(cell.gateway, 'root@acme.example');
  await configure();
});

after(async () => {
  await cell?.close();
});

describe('the cell\'s SAML service provider key pair (spec 55.5)', () => {
  test('its metadata publishes the certificate, the assertion consumer and the provider\'s single logout address', async () => {
    const res = await fetch(`${cell.gateway}/api/v1/sso/saml/metadata?organisationId=${cell.org}&providerId=${provider}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /samlmetadata\+xml/);
    const xml = await res.text();
    assert.ok(xml.replace(/\s+/g, '').includes(der(sp.cert)), 'the SP certificate');
    assert.match(xml, new RegExp(`entityID="${SP_ENTITY.replace(/[/.]/g, '\\$&')}"`));
    assert.ok(xml.includes(ACS), 'the assertion consumer');
    assert.ok(xml.includes(`${ORIGIN}/api/v1/sso/saml/slo/${cell.org}/${provider}`), 'this provider\'s single logout address');
    assert.match(xml, /AuthnRequestsSigned="true"/);
  });

  test('an AuthnRequest is signed with the SP key, on the redirect binding', async () => {
    const started = await call(cell.gateway, browser(), 'POST', '/sso/start', { organisationSlug: 'acme', providerId: provider });
    const raw = started.body.redirectUrl.slice(started.body.redirectUrl.indexOf('?') + 1) as string;
    const signatureAt = raw.indexOf('&Signature=');
    assert.ok(signatureAt > 0, 'it carries a signature');
    const signed = raw.slice(0, signatureAt);
    const signature = decodeURIComponent(raw.slice(signatureAt + '&Signature='.length));
    assert.match(signed, /SigAlg=http%3A%2F%2Fwww\.w3\.org%2F2001%2F04%2Fxmldsig-more%23rsa-sha256/);
    assert.equal(verify('RSA-SHA256', Buffer.from(signed, 'utf8'), createPublicKey(sp.cert), Buffer.from(signature, 'base64')), true);
  });

  test('an assertion encrypted to the SP certificate signs the person in; where encryption is required, a plain one is refused', async () => {
    const encrypted = await samlSignIn({ nameId: 'enc-1', email: 'encrypted@acme.example' }, { encrypt: true });
    assert.equal(encrypted.error, undefined, 'decrypted by the library with the SP key');
    await configure({ overrides: { requireEncryptedAssertions: true } });
    try {
      const plain = await samlSignIn({ nameId: 'enc-2', email: 'plain@acme.example' });
      assert.ok(plain.error !== undefined, 'refused');
    } finally {
      await configure();
    }
  });
});

describe('single logout (spec 55.5)', () => {
  test('the provider\'s LogoutRequest ends that person\'s sessions from it, and is answered with a LogoutResponse', async () => {
    const signedIn = await samlSignIn({ nameId: 'slo-1', email: 'leaver@acme.example' });
    assert.equal((await call(cell.gateway, signedIn.person, 'GET', '/session')).status, 200);
    const target = `${ORIGIN}/api/v1/sso/saml/slo/${cell.org}/${provider}`;
    const url = new URL(idp.logoutRedirect('request', target, { nameId: 'slo-1', sessionIndex: '_s1', relayState: 'idp-relay' }));
    const res = await fetch(`${cell.gateway}${url.pathname}${url.search}`, { redirect: 'manual', headers: { 'x-forwarded-for': '203.0.113.20' } });
    assert.equal(res.status, 303);
    const answered = new URL(res.headers.get('location')!);
    assert.equal(`${answered.origin}${answered.pathname}`, idp.sloUrl, 'back to the provider');
    const response = inflateRawSync(Buffer.from(answered.searchParams.get('SAMLResponse')!, 'base64')).toString('utf8');
    assert.match(response, /LogoutResponse/);
    assert.ok(answered.searchParams.get('Signature'), 'signed with the SP key');
    assert.equal((await call(cell.gateway, signedIn.person, 'GET', '/session')).status, 401, 'the session has ended');
    assert.deepEqual((await events('single_logout')).at(-1), { provider_id: provider, initiated_by: 'provider', sessions: 1 });

    const forged = new URL(idp.logoutRedirect('request', target, { nameId: 'slo-1', sessionIndex: '_s1' }, 'rogue'));
    const refused = await fetch(`${cell.gateway}${forged.pathname}${forged.search}`, { redirect: 'manual', headers: { 'x-forwarded-for': '203.0.113.21' } });
    assert.match(refused.headers.get('location') ?? '', /\/sign-in#error=/, 'a request not signed by a configured certificate is refused');
  });

  test('signing out sends the browser to the provider with a signed LogoutRequest; its LogoutResponse lands on the sign-in page', async () => {
    const signedIn = await samlSignIn({ nameId: 'slo-2', email: 'outgoing@acme.example' });
    const out = await call(cell.gateway, signedIn.person, 'POST', '/session/single-logout', {});
    assert.equal(out.status, 200, out.text);
    const logout = new URL(out.body.logoutUrl);
    assert.equal(`${logout.origin}${logout.pathname}`, idp.sloUrl);
    const request = inflateRawSync(Buffer.from(logout.searchParams.get('SAMLRequest')!, 'base64')).toString('utf8');
    assert.match(request, /LogoutRequest/);
    assert.match(request, />slo-2</, 'naming the person as the provider knows them');
    assert.match(request, /SessionIndex[^>]*>_s1</, 'and the session');
    assert.ok(logout.searchParams.get('Signature'));
    assert.equal((await call(cell.gateway, signedIn.person, 'GET', '/session')).status, 401, 'ended here first, whatever the provider does');

    const id = /\sID="([^"]+)"/.exec(request)![1]!;
    const back = new URL(idp.logoutRedirect('response', `${ORIGIN}/api/v1/sso/saml/slo/${cell.org}/${provider}`, { inResponseTo: id, ...(logout.searchParams.get('RelayState') === null ? {} : { relayState: logout.searchParams.get('RelayState')! }) }));
    const res = await fetch(`${cell.gateway}${back.pathname}${back.search}`, { redirect: 'manual', headers: { 'x-forwarded-for': '203.0.113.22' } });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `${ORIGIN}/sign-in?signed_out=1`);
    assert.deepEqual((await events('single_logout')).at(-1), { provider_id: provider, initiated_by: 'silo', sessions: 1, provider_told: true });
  });
});
