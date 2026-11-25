// The notify service's mail relay and links (spec 7.5: email, in-product items and push;
// references only, never record values).
//
// Email leaves through an SMTP relay inside the cell, never a web API: the relay is the
// cell's own egress point for mail, so the message's route is the cell's to control.
// Production refuses a relay without TLS. Links in an email point at the web client:
// NOTIFY_LINK_BASE_URL is its origin, https in production.

import { loadPushConfig, type PushConfig } from './push.config.ts';
import { z } from 'zod';
import { parseSection, read, readSecret, zPort, type Env } from './env.config.ts';

export const SMTP_TLS_MODES = ['starttls', 'implicit', 'none'] as const;

const schema = z.object({
  smtpHost: z.string().regex(/^[A-Za-z0-9.-]{1,253}$/, 'must be a host name or address').optional(),
  smtpPort: zPort.optional(),
  smtpTls: z.enum(SMTP_TLS_MODES).default('starttls'),
  smtpUsername: z.string().min(1).max(256).optional(),
  smtpPassword: z.string().min(1).max(1024).optional(),
  smtpCaFile: z.string().min(1).optional(),
  fromAddress: z.email().max(320).default('no-reply@silo.invalid'),
  fromName: z.string().regex(/^[A-Za-z0-9 .'-]{1,64}$/, 'letters, digits, spaces and . \' - only').default('Silo'),
  linkBaseUrl: z.url({ protocol: /^https?$/ }).optional(),
  sendTimeoutMs: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
});

export interface NotifyConfig {
  smtp: {
    host: string | undefined;
    /** 465 for implicit TLS, 587 otherwise, unless set. */
    port: number;
    tls: (typeof SMTP_TLS_MODES)[number];
    username: string | undefined;
    password: string | undefined;
    caFile: string | undefined;
    sendTimeoutMs: number;
  };
  from: { address: string; name: string };
  /** The web client's origin, without a trailing slash. */
  linkBaseUrl: string | undefined;
  /** Mobile push (decision 2026-11-14); undefined where none is configured. */
  push: PushConfig | undefined;
}

export function loadNotifyConfig(env: Env, problems: string[]): NotifyConfig | undefined {
  const parsed = parseSection(schema, {
    smtpHost: read(env, 'SMTP_HOST'),
    smtpPort: read(env, 'SMTP_PORT'),
    smtpTls: read(env, 'SMTP_TLS'),
    smtpUsername: read(env, 'SMTP_USERNAME'),
    smtpPassword: readSecret(env, 'SMTP_PASSWORD', problems),
    smtpCaFile: read(env, 'SMTP_CA_FILE'),
    fromAddress: read(env, 'NOTIFY_FROM_ADDRESS'),
    fromName: read(env, 'NOTIFY_FROM_NAME'),
    linkBaseUrl: read(env, 'NOTIFY_LINK_BASE_URL'),
    sendTimeoutMs: read(env, 'SMTP_SEND_TIMEOUT_MS'),
  }, {
    smtpHost: 'SMTP_HOST', smtpPort: 'SMTP_PORT', smtpTls: 'SMTP_TLS', smtpUsername: 'SMTP_USERNAME', smtpPassword: 'SMTP_PASSWORD',
    smtpCaFile: 'SMTP_CA_FILE', fromAddress: 'NOTIFY_FROM_ADDRESS', fromName: 'NOTIFY_FROM_NAME', linkBaseUrl: 'NOTIFY_LINK_BASE_URL',
    sendTimeoutMs: 'SMTP_SEND_TIMEOUT_MS',
  }, problems);
  if (!parsed) return undefined;
  if ((parsed.smtpUsername === undefined) !== (parsed.smtpPassword === undefined)) {
    problems.push('SMTP_USERNAME: set with SMTP_PASSWORD, or neither');
  }
  return {
    smtp: {
      host: parsed.smtpHost,
      port: parsed.smtpPort ?? (parsed.smtpTls === 'implicit' ? 465 : 587),
      tls: parsed.smtpTls,
      username: parsed.smtpUsername,
      password: parsed.smtpPassword,
      caFile: parsed.smtpCaFile,
      sendTimeoutMs: parsed.sendTimeoutMs,
    },
    from: { address: parsed.fromAddress, name: parsed.fromName },
    linkBaseUrl: parsed.linkBaseUrl?.replace(/\/+$/, ''),
    push: loadPushConfig(env, problems),
  };
}
