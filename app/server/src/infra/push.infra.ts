// Mobile push senders (decision 2026-11-14). A message carries a title, a count and a link
// only, never a record value (spec 6.5). Each send names one device token; the provider's
// answer is reduced to sent, gone (the token is no longer valid: revoke it) or failed.
//
// - FCM HTTP v1: an OAuth access token from the service account (a JWT signed RS256 with its
//   key, exchanged at the token URL, kept until a minute before it expires).
// - APNs, directly over HTTP/2: a provider token (a JWT signed ES256 with the .p8 key), kept
//   fifty minutes, as Apple asks for at most one new token every twenty.
// No provider text is logged or returned: it may echo the token.

import { connect, type ClientHttp2Session } from 'node:http2';
import { createPrivateKey, sign } from 'node:crypto';
import type { PushConfig } from '../config/push.config.ts';
import { AppError } from '../utils/errors.util.ts';

export interface PushMessage { title: string; body: string; link: string; badge: number }
export type PushOutcome = 'sent' | 'gone' | 'failed';

export interface PushSender {
  readonly platform: 'fcm' | 'apns';
  send(token: string, message: PushMessage): Promise<PushOutcome>;
  close?(): Promise<void>;
}

const b64url = (data: Buffer | string): string => Buffer.from(data).toString('base64url');

function jwt(header: object, claims: object, key: string, algorithm: 'RS256' | 'ES256'): string {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const privateKey = createPrivateKey(key);
  const signature = algorithm === 'RS256'
    ? sign('sha256', Buffer.from(input), privateKey)
    : sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${input}.${b64url(signature)}`;
}

export function createFcmSender(config: Extract<PushConfig, { provider: 'fcm' }>): PushSender {
  let cached: { token: string; until: number } | undefined;
  async function accessToken(): Promise<string> {
    if (cached && cached.until > Date.now()) return cached.token;
    const now = Math.floor(Date.now() / 1000);
    const assertion = jwt({ alg: 'RS256', typ: 'JWT' }, {
      iss: config.clientEmail, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: config.tokenUrl, iat: now, exp: now + 3600,
    }, config.privateKey, 'RS256');
    const response = await fetch(config.tokenUrl, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }), signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!response.ok) throw new AppError('upstream', 'the push provider refused its credentials', { code: 'push.credentials_refused', details: { status: response.status } });
    const body = await response.json() as { access_token?: string; expires_in?: number };
    if (typeof body.access_token !== 'string') throw new AppError('upstream', 'the push provider gave no access token', { code: 'push.credentials_refused' });
    cached = { token: body.access_token, until: Date.now() + Math.max(60, (body.expires_in ?? 3600) - 60) * 1000 };
    return cached.token;
  }
  return {
    platform: 'fcm',
    async send(token, message) {
      const response = await fetch(`${config.endpoint}/v1/projects/${config.projectId}/messages:send`, {
        method: 'POST', headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ message: {
          token, notification: { title: message.title, body: message.body }, data: { link: message.link, count: String(message.badge) },
          apns: { payload: { aps: { badge: message.badge } } },
        } }),
        signal: AbortSignal.timeout(config.timeoutMs),
      }).catch(() => undefined);
      if (response === undefined) return 'failed';
      if (response.ok) return 'sent';
      if (response.status === 404) return 'gone';
      const text = await response.text().catch(() => '');
      return text.includes('UNREGISTERED') || text.includes('"NOT_FOUND"') ? 'gone' : 'failed';
    },
  };
}

export function createApnsSender(config: Extract<PushConfig, { provider: 'apns' }>): PushSender {
  let session: ClientHttp2Session | undefined;
  let cached: { token: string; until: number } | undefined;
  const providerToken = (): string => {
    if (cached && cached.until > Date.now()) return cached.token;
    cached = { token: jwt({ alg: 'ES256', kid: config.keyId }, { iss: config.teamId, iat: Math.floor(Date.now() / 1000) }, config.privateKey, 'ES256'),
      until: Date.now() + 50 * 60_000 };
    return cached.token;
  };
  const open = (): ClientHttp2Session => {
    if (session === undefined || session.closed || session.destroyed) {
      session = connect(config.host);
      session.on('error', () => { session = undefined; });
    }
    return session;
  };
  return {
    platform: 'apns',
    send(token, message) {
      return new Promise<PushOutcome>((resolve) => {
        let request;
        try {
          request = open().request({
            ':method': 'POST', ':path': `/3/device/${encodeURIComponent(token)}`, authorization: `bearer ${providerToken()}`,
            'apns-topic': config.topic, 'apns-push-type': 'alert', 'content-type': 'application/json',
          });
        } catch {
          resolve('failed');
          return;
        }
        const timer = setTimeout(() => { request.close(); resolve('failed'); }, config.timeoutMs);
        let status = 0;
        let body = '';
        request.on('response', (headers) => { status = Number(headers[':status']); });
        request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8').slice(0, 2000); });
        request.on('end', () => {
          clearTimeout(timer);
          resolve(status === 200 ? 'sent' : status === 410 || body.includes('BadDeviceToken') || body.includes('Unregistered') ? 'gone' : 'failed');
        });
        request.on('error', () => { clearTimeout(timer); resolve('failed'); });
        request.end(JSON.stringify({ aps: { alert: { title: message.title, body: message.body }, badge: message.badge }, link: message.link }));
      });
    },
    async close() {
      await new Promise<void>((resolve) => { if (session === undefined || session.closed) resolve(); else session.close(() => resolve()); });
    },
  };
}

export function createPushSender(config: PushConfig): PushSender {
  return config.provider === 'fcm' ? createFcmSender(config) : createApnsSender(config);
}
