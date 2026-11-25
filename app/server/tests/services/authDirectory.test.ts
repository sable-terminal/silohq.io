// auth's wiring to its neighbours: the directory is told of each person the cell now holds,
// by the keyed hash the credential service computes inside the KMS (spec 55.1), never the
// address; and the request's correlation id reaches the email delivery, so one request can
// be followed from the browser to the mail relay.

import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { emailRoutingInput } from '../../src/utils/email.util.ts';
import { issueToken } from '../../src/utils/token.util.ts';
import { CELL_ID } from '../db/fixtures.helper.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { browser, call, PASSWORD, signIn, startCell, type Cell } from './sso.helper.ts';

const KMS_KEY = randomBytes(32);
let cell: Cell;
let directory: Server;
const registrations: { caller: string | undefined; body: { cellId: string; emailHash: string; hashKeyVersion: number }; raw: string }[] = [];
let refuseNext = 0;

before(async () => {
  directory = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); });
    req.on('end', () => {
      if (req.method === 'PUT' && req.url === '/v1/identities' && refuseNext > 0) {
        refuseNext -= 1;
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{"error":{"category":"unavailable","code":"directory.down","message":"no","retryable":true}}');
        return;
      }
      if (req.method === 'PUT' && req.url === '/v1/identities') {
        registrations.push({ caller: req.headers['x-silo-caller'] as string | undefined, body: JSON.parse(raw), raw });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ created: true }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":{"category":"not_found","code":"route.not_found","message":"no","retryable":false}}');
    });
  });
  await new Promise<void>((resolve) => directory.listen(0, '127.0.0.1', () => resolve()));
  cell = await startCell(
    { SERVICE_URL_DIRECTORY: `http://127.0.0.1:${(directory.address() as AddressInfo).port}`, DIRECTORY_RETRY_SECONDS: '1' },
    { KMS_LOCAL_KEY: KMS_KEY.toString('base64'), KMS_DIRECTORY_KEY_URI: 'local:directory', DIRECTORY_KEY_VERSION: '3' },
  );
});

after(async () => {
  await cell?.close();
  await new Promise<void>((resolve) => directory?.close(() => resolve()));
});

describe('the directory (spec 55.1)', () => {
  test('a new person is registered by the keyed hash of their address, never the address', async () => {
    const { token, hash } = issueToken('invitation');
    await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `insert into iam.invitations (id, organisation_id, email, token_hash, role_id, invited_by, expires_at)
       values ($1, $2, 'routed@acme.example', $3, $4, $5, now() + interval '1 day')`, [uuidv7(), cell.org, hash, cell.roles['Member'], cell.rootMembership]));
    const accepted = await call(cell.gateway, browser(), 'POST', '/invitations/accept', {
      organisationSlug: 'acme', token, password: PASSWORD, firstName: 'Ro', lastName: 'Uted',
    });
    assert.equal(accepted.status, 201, accepted.text);
    assert.equal(registrations.length, 1);
    const [registration] = registrations;
    assert.equal(registration!.caller, 'auth');
    assert.equal(registration!.body.cellId, CELL_ID);
    assert.equal(registration!.body.hashKeyVersion, 3);
    // HMAC-SHA-256 under the directory key, over the labelled normal form (the local KMS's MAC).
    const expected = createHmac('sha256', KMS_KEY).update(emailRoutingInput('Routed@ACME.example')).digest('base64url');
    assert.equal(registration!.body.emailHash, expected);
    assert.equal(registration!.raw.includes('routed@acme.example'), false);
  });

  test('a registration the directory missed is kept and tried again until it is made (D69)', async () => {
    const { token, hash } = issueToken('invitation');
    await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `insert into iam.invitations (id, organisation_id, email, token_hash, role_id, invited_by, expires_at)
       values ($1, $2, 'missed@acme.example', $3, $4, $5, now() + interval '1 day')`, [uuidv7(), cell.org, hash, cell.roles['Member'], cell.rootMembership]));
    const before = registrations.length;
    refuseNext = 2;
    const accepted = await call(cell.gateway, browser(), 'POST', '/invitations/accept', {
      organisationSlug: 'acme', token, password: PASSWORD, firstName: 'Mis', lastName: 'Sed',
    });
    assert.equal(accepted.status, 201, 'the person exists whether or not the directory heard');
    const pending = async () => Number((await cell.app.query('select count(*)::int as n from iam.directory_registrations')).rows[0].n);
    assert.equal(await pending(), 1);
    for (let i = 0; i < 100 && registrations.length === before; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(registrations.length, before + 1, 'tried again, with backoff, until the directory took it');
    // The worker removes the pending row once the directory has answered: a moment after the call arrives.
    for (let i = 0; i < 50 && await pending() > 0; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await pending(), 0);
  });

  test('an existing person joining registers nothing new', async () => {
    const before = registrations.length;
    const root = await signIn(cell.gateway, 'root@acme.example');
    void root;
    assert.equal(registrations.length, before);
  });
});

describe('correlation ids', () => {
  test('the invitation email carries the request\'s correlation id', async () => {
    const root = await signIn(cell.gateway, 'root@acme.example');
    const reply = await call(cell.gateway, root, 'POST', '/invitations', { email: 'followed@acme.example', roleId: cell.roles['Member'] },
      { 'idempotency-key': `key-${uuidv7()}` });
    assert.equal(reply.status, 201, reply.text);
    const delivered = cell.invitations.findLast((i) => i.email === 'followed@acme.example')!;
    assert.equal(delivered.correlationId, reply.headers.get('x-correlation-id'));
  });
});
