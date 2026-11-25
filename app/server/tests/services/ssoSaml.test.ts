// SAML sign-in end to end (spec 55.5): a provider configured from its metadata document,
// the SP-initiated flow (the AuthnRequest, the identity provider's form post to the
// gateway's assertion consumer, the ticket the app redeems with its binding), and what
// @node-saml refuses: a changed assertion, the wrong request, the wrong audience, a
// certificate that is not configured. A certificate rollover overlaps two certificates.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { uuidv7 } from '../db/harness.helper.ts';
import {
  b64url, browser, call, ORIGIN, postToAcs, readAuthnRequest, signIn, startCell, startFakeSamlIdp, type Browser, type Cell, type SamlIdp,
} from './sso.helper.ts';

let cell: Cell;
let idp: SamlIdp;
let root: Browser;
const provider = uuidv7();
let version = 0;
const SP_ENTITY = `${ORIGIN}/api/v1/sso/saml/metadata`;
const ACS = `${ORIGIN}/api/v1/sso/saml/acs`;

async function configure(certs: string[], extra: Record<string, unknown> = {}): Promise<any> {
  const reply = await call(cell.gateway, root, 'PUT', `/identity-providers/${provider}`, {
    expectedVersion: version === 0 ? null : version, active: true, jitProvisioning: true, defaultRoleId: cell.roles['Member'], defaultScopeId: null,
    config: { kind: 'saml', metadataXml: idp.metadata(certs), ...extra },
  });
  assert.equal(reply.status, 200, reply.text);
  version = reply.body.version;
  return reply.body;
}

/** The whole browser flow, up to the ticket's redemption. */
async function samlSignIn(who: { nameId: string; email: string }, options: {
  signWith?: string; tamper?: (xml: string) => string; audience?: string; binding?: string; requestOf?: (own: { id: string; acsUrl: string }) => { id: string; acsUrl: string };
} = {}) {
  const person = browser();
  const started = await call(cell.gateway, person, 'POST', '/sso/start', { organisationSlug: 'acme', providerId: provider });
  assert.equal(started.status, 201, started.text);
  assert.ok(started.body.redirectUrl.startsWith(`${idp.ssoUrl}?`), 'to the redirect binding from the metadata');
  const request = readAuthnRequest(started.body.redirectUrl);
  assert.equal(request.acsUrl, ACS);
  assert.equal(request.issuer, SP_ENTITY);
  const target = options.requestOf ? options.requestOf(request) : request;
  const response = idp.respond({ id: target.id, acsUrl: ACS, audience: options.audience ?? SP_ENTITY }, who, options);
  const posted = await postToAcs(cell.gateway, response, request.relayState);
  assert.equal(posted.status, 303);
  const landing = new URL(posted.location!);
  assert.equal(`${landing.origin}${landing.pathname}`, `${ORIGIN}/sso/complete`);
  const fragment = new URLSearchParams(landing.hash.slice(1));
  if (fragment.has('error')) return { person, error: fragment.get('error')!, response, relayState: request.relayState, reply: undefined };
  const reply = await call(cell.gateway, person, 'POST', '/sso/saml/complete', { ticket: fragment.get('ticket'), binding: options.binding ?? started.body.binding });
  return { person, error: undefined, response, relayState: request.relayState, reply, ticket: fragment.get('ticket')! };
}

before(async () => {
  cell = await startCell();
  idp = startFakeSamlIdp('https://idp.example/metadata');
  root = await signIn(cell.gateway, 'root@acme.example');
});

after(async () => {
  await cell?.close();
});

describe('a SAML provider from its metadata', () => {
  test('the metadata gives the entity id, the redirect binding and the signing certificate', async () => {
    const view = await configure(['first'], { overrides: { emailAttribute: 'email' } });
    assert.equal(view.issuer, idp.entityId);
    assert.equal(view.config.kind, 'saml');
    assert.equal(view.config.settings.entityId, idp.entityId);
    assert.equal(view.config.settings.ssoUrl, idp.ssoUrl);
    assert.equal(view.config.settings.signingCertificates.length, 1);
    assert.equal(view.config.settings.nameIdFormat, 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent');
  });

  test('a document that is not IdP metadata is refused', async () => {
    const reply = await call(cell.gateway, root, 'PUT', `/identity-providers/${uuidv7()}`, {
      expectedVersion: null, active: true, config: { kind: 'saml', metadataXml: '<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="x"/>' },
    });
    assert.equal(reply.status, 400);
    assert.equal(reply.body.error.code, 'sso.metadata_invalid');
  });
});

describe('signing in by SAML', () => {
  test('a new person joins just in time, linked by the persistent NameID', async () => {
    const { reply } = await samlSignIn({ nameId: 'saml-person-1', email: 'saml.person@acme.example' });
    assert.ok(reply);
    assert.equal(reply.status, 201, reply.text);
    assert.equal(reply.body.authMethod, 'sso');
    const { rows } = await cell.migrate.query('select subject, linked_via from iam.user_identities where user_id = $1', [reply.body.userId]);
    assert.deepEqual(rows, [{ subject: 'saml-person-1', linked_via: 'jit' }]);
    const again = await samlSignIn({ nameId: 'saml-person-1', email: 'saml.person@acme.example' });
    assert.equal(again.reply!.body.userId, reply.body.userId);
  });

  test('the ticket needs the browser\'s binding, and is used once', async () => {
    const wrong = await samlSignIn({ nameId: 'saml-person-1', email: 'saml.person@acme.example' }, { binding: b64url(Buffer.alloc(32, 7)) });
    assert.equal(wrong.reply!.status, 401);
    assert.equal(wrong.reply!.body.error.code, 'sso.flow_invalid');
    const reuse = await call(cell.gateway, browser(), 'POST', '/sso/saml/complete', { ticket: wrong.ticket, binding: b64url(Buffer.alloc(32, 7)) });
    assert.equal(reuse.status, 401);
  });

  test('a response is accepted once: a replay finds no flow', async () => {
    const first = await samlSignIn({ nameId: 'saml-person-1', email: 'saml.person@acme.example' });
    assert.equal(first.reply!.status, 201);
    const replay = await postToAcs(cell.gateway, first.response, first.relayState);
    assert.match(replay.location!, /#error=sso\.flow_invalid$/);
  });
});

describe('what @node-saml refuses', () => {
  test('an assertion changed after signing', async () => {
    const { error } = await samlSignIn({ nameId: 'saml-person-1', email: 'saml.person@acme.example' }, {
      tamper: (xml) => xml.replace('saml.person@acme.example', 'root@acme.example'),
    });
    assert.equal(error, 'sso.assertion_invalid');
  });

  test('a response to another request', async () => {
    const { error } = await samlSignIn({ nameId: 'saml-person-1', email: 'saml.person@acme.example' }, {
      requestOf: (own) => ({ ...own, id: `_${'ab'.repeat(32)}` }),
    });
    assert.equal(error, 'sso.assertion_invalid');
  });

  test('a response for another service provider', async () => {
    const { error } = await samlSignIn({ nameId: 'saml-person-1', email: 'saml.person@acme.example' }, { audience: 'https://elsewhere.example/sp' });
    assert.equal(error, 'sso.assertion_invalid');
  });

  test('a rollover: both certificates verify while both are configured, then only the new one', async () => {
    const rogue = await samlSignIn({ nameId: 'saml-person-1', email: 'saml.person@acme.example' }, { signWith: 'rogue' });
    assert.equal(rogue.error, 'sso.assertion_invalid');
    const early = await samlSignIn({ nameId: 'saml-person-1', email: 'saml.person@acme.example' }, { signWith: 'second' });
    assert.equal(early.error, 'sso.assertion_invalid', 'not configured yet');

    await configure(['first', 'second']);
    for (const signWith of ['first', 'second']) {
      const both = await samlSignIn({ nameId: 'saml-person-1', email: 'saml.person@acme.example' }, { signWith });
      assert.equal(both.reply?.status, 201, signWith);
    }
    await configure(['second']);
    const retired = await samlSignIn({ nameId: 'saml-person-1', email: 'saml.person@acme.example' }, { signWith: 'first' });
    assert.equal(retired.error, 'sso.assertion_invalid');
    const current = await samlSignIn({ nameId: 'saml-person-1', email: 'saml.person@acme.example' }, { signWith: 'second' });
    assert.equal(current.reply?.status, 201);
  });

  test('a post that is not a SAML response goes back to the app as an error', async () => {
    const posted = await postToAcs(cell.gateway, 'bm90IHNhbWw=', 'not-a-relay-state');
    assert.equal(posted.status, 303);
    assert.match(posted.location!, /#error=sso\.acs_unreadable$/);
  });
});
