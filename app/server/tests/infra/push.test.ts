// Mobile push senders (decision 2026-11-14): FCM HTTP v1 with a service account's token, and
// APNs over HTTP/2 with an ES256 provider token, each against a local fake. Gone tokens are
// told apart from failures; nothing but a count and a link is sent.

import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createServer as createH2 } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { createApnsSender, createFcmSender } from '../../src/infra/push.infra.ts';

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const message = { title: 'Silo', body: '3 new in Silo', link: 'https://app.test/notifications', badge: 3 };
let fcm: Server;
let fcmUrl = '';
const fcmSeen: { auth: string | undefined; body: any }[] = [];
let tokenExchanges = 0;

before(async () => {
  fcm = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.url === '/token') {
        tokenExchanges += 1;
        const assertion = new URLSearchParams(raw).get('assertion')!;
        const [h, c, sig] = assertion.split('.');
        const ok = verify('sha256', Buffer.from(`${h}.${c}`), rsa.publicKey, Buffer.from(sig!, 'base64url'));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(ok ? { access_token: 'ya29.test', expires_in: 3600 } : { error: 'invalid_grant' }));
        return;
      }
      const body = JSON.parse(raw);
      fcmSeen.push({ auth: req.headers.authorization, body });
      if (body.message.token === 'gone-token-0000000') { res.statusCode = 404; res.end('{"error":{"status":"NOT_FOUND"}}'); return; }
      res.end('{"name":"projects/p/messages/1"}');
    });
  });
  await new Promise<void>((resolve) => fcm.listen(0, '127.0.0.1', resolve));
  fcmUrl = `http://127.0.0.1:${(fcm.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => fcm.close(() => resolve()));
});

describe('push senders (decision 2026-11-14)', () => {
  test('FCM: a service account token, kept; a count and a link; a gone token told apart', async () => {
    const sender = createFcmSender({
      provider: 'fcm', projectId: 'silo-test', clientEmail: 'push@silo-test.iam.gserviceaccount.com',
      privateKey: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, endpoint: fcmUrl, tokenUrl: `${fcmUrl}/token`, timeoutMs: 2000,
    });
    assert.equal(await sender.send('device-token-000001', message), 'sent');
    assert.equal(await sender.send('gone-token-0000000', message), 'gone');
    assert.equal(tokenExchanges, 1, 'the access token is kept');
    assert.equal(fcmSeen[0]!.auth, 'Bearer ya29.test');
    assert.deepEqual(fcmSeen[0]!.body.message.notification, { title: 'Silo', body: '3 new in Silo' });
    assert.deepEqual(fcmSeen[0]!.body.message.data, { link: 'https://app.test/notifications', count: '3' });
  });

  test('APNs: an ES256 provider token over HTTP/2; 410 is gone', async () => {
    const seen: { path: string; auth: string; topic: string; body: any }[] = [];
    const h2 = createH2((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        seen.push({ path: req.headers[':path'] as string, auth: req.headers.authorization as string, topic: req.headers['apns-topic'] as string, body: JSON.parse(raw) });
        res.statusCode = (req.headers[':path'] as string).includes('gone') ? 410 : 200;
        res.end(res.statusCode === 410 ? '{"reason":"Unregistered"}' : '');
      });
    });
    await new Promise<void>((resolve) => h2.listen(0, '127.0.0.1', resolve));
    const sender = createApnsSender({
      provider: 'apns', teamId: 'TEAM123456', keyId: 'KEY1234567', privateKey: ec.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
      topic: 'io.silohq.app', host: `http://127.0.0.1:${(h2.address() as AddressInfo).port}`, timeoutMs: 2000,
    });
    try {
      assert.equal(await sender.send('abcdef0123456789', message), 'sent');
      assert.equal(await sender.send('gone0123456789ab', message), 'gone');
      const [h, c, sig] = seen[0]!.auth.replace('bearer ', '').split('.');
      assert.equal(JSON.parse(Buffer.from(h!, 'base64url').toString()).kid, 'KEY1234567');
      assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig!, 'base64url')));
      assert.deepEqual([seen[0]!.path, seen[0]!.topic], ['/3/device/abcdef0123456789', 'io.silohq.app']);
      assert.deepEqual(seen[0]!.body, { aps: { alert: { title: 'Silo', body: '3 new in Silo' }, badge: 3 }, link: 'https://app.test/notifications' });
    } finally {
      await sender.close!();
      await new Promise<void>((resolve) => h2.close(() => resolve()));
    }
  });
});
