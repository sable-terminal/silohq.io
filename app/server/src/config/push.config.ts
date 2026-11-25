// Mobile push (decision 2026-11-14): Firebase Cloud Messaging in the commercial cells, APNs
// directly in the sovereign build (FCM is Google-owned). Off unless configured. Credentials
// are secrets: the FCM service account's JSON key, the APNs signing key (.p8).

import { z } from 'zod';
import { parseSection, read, readSecret, zPositiveInt, type Env } from './env.config.ts';

export type PushConfig =
  | { provider: 'fcm'; projectId: string; clientEmail: string; privateKey: string; endpoint: string; tokenUrl: string; timeoutMs: number }
  | { provider: 'apns'; teamId: string; keyId: string; privateKey: string; topic: string; host: string; timeoutMs: number };

const fcm = z.object({
  projectId: z.string().regex(/^[a-z][a-z0-9-]{4,61}$/),
  serviceAccount: z.string().min(2),
  endpoint: z.url({ protocol: /^https?$/ }).default('https://fcm.googleapis.com'),
  tokenUrl: z.url({ protocol: /^https?$/ }).default('https://oauth2.googleapis.com/token'),
  timeoutMs: zPositiveInt(30_000).default(5_000),
});

const apns = z.object({
  teamId: z.string().regex(/^[A-Z0-9]{10}$/),
  keyId: z.string().regex(/^[A-Z0-9]{10}$/),
  privateKey: z.string().includes('PRIVATE KEY'),
  topic: z.string().min(3).max(200),
  host: z.url({ protocol: /^https?$/ }).default('https://api.push.apple.com'),
  timeoutMs: zPositiveInt(30_000).default(5_000),
});

const account = z.object({ client_email: z.email(), private_key: z.string().includes('PRIVATE KEY') });

export function loadPushConfig(env: Env, problems: string[]): PushConfig | undefined {
  const provider = read(env, 'PUSH_PROVIDER');
  if (provider === undefined || provider === 'none') return undefined;
  const sovereign = read(env, 'SILO_BUILD_TARGET') === 'sovereign';
  if (provider === 'fcm') {
    if (sovereign) {
      problems.push('PUSH_PROVIDER: FCM is Google-owned; the sovereign build sends through APNs directly');
      return undefined;
    }
    const parsed = parseSection(fcm, {
      projectId: read(env, 'FCM_PROJECT_ID'), serviceAccount: readSecret(env, 'FCM_SERVICE_ACCOUNT_KEY', problems),
      endpoint: read(env, 'FCM_ENDPOINT'), tokenUrl: read(env, 'FCM_TOKEN_URL'), timeoutMs: read(env, 'PUSH_TIMEOUT_MS'),
    }, { projectId: 'FCM_PROJECT_ID', serviceAccount: 'FCM_SERVICE_ACCOUNT_KEY', endpoint: 'FCM_ENDPOINT', tokenUrl: 'FCM_TOKEN_URL', timeoutMs: 'PUSH_TIMEOUT_MS' },
    problems);
    if (!parsed) return undefined;
    let key: z.infer<typeof account>;
    try {
      key = account.parse(JSON.parse(parsed.serviceAccount));
    } catch {
      problems.push('FCM_SERVICE_ACCOUNT_KEY: a service account JSON key with client_email and private_key');
      return undefined;
    }
    return { provider: 'fcm', projectId: parsed.projectId, clientEmail: key.client_email, privateKey: key.private_key, endpoint: parsed.endpoint,
      tokenUrl: parsed.tokenUrl, timeoutMs: parsed.timeoutMs };
  }
  if (provider === 'apns') {
    const parsed = parseSection(apns, {
      teamId: read(env, 'APNS_TEAM_ID'), keyId: read(env, 'APNS_KEY_ID'), privateKey: readSecret(env, 'APNS_PRIVATE_KEY', problems),
      topic: read(env, 'APNS_TOPIC'), host: read(env, 'APNS_HOST'), timeoutMs: read(env, 'PUSH_TIMEOUT_MS'),
    }, { teamId: 'APNS_TEAM_ID', keyId: 'APNS_KEY_ID', privateKey: 'APNS_PRIVATE_KEY', topic: 'APNS_TOPIC', host: 'APNS_HOST', timeoutMs: 'PUSH_TIMEOUT_MS' },
    problems);
    return parsed === undefined ? undefined : { provider: 'apns', ...parsed };
  }
  problems.push('PUSH_PROVIDER: fcm, apns or none');
  return undefined;
}
