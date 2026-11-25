// The admin portal: Silo staff's console for operations and break-glass (spec 7 catalogue,
// chapter 13). Staff reach it on its own listener, apart from the customer gateway, and
// sign in only through the staff identity provider ("Called by: staff identity provider
// only"; platform.operators holds no email or password).
//
// - The staff identity provider is one OIDC issuer, client and secret per deployment. An
//   operator is the row of platform.operators whose idp_subject is the token's sub.
// - Strong authentication is the provider's to perform and ours to require: the ID token's
//   amr must name every method in ADMIN_PORTAL_IDP_REQUIRED_AMR (default hwk, a hardware
//   key), and every claim in ADMIN_PORTAL_DEVICE_CLAIMS must hold its value (the managed,
//   UK device the sovereign cell requires, spec 13.3; the sovereign build refuses to start
//   without one).
// - What a member of staff may do comes from the provider's groups claim, mapped to staff
//   capabilities (ADMIN_PORTAL_GROUP_CAPABILITIES, JSON {group: [capability]}); staff
//   roles are managed, reviewed and removed in the provider (spec 13.4).
// - Staff sessions: 15 minutes idle, 8 hours at most, this build's choice (the spec names
//   break-glass sessions' 4 hours, not the console's).
// - Rate limits per client address and per staff session, as the gateway's, smaller.

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { parseSection, read, readSecret, zBool, zList, zPositiveInt, type Env } from './env.config.ts';

/** What staff may do; the groups claim maps to these (contracts/admin-portal/capability). */
export const STAFF_CAPABILITIES = [
  // Break-glass (13.3): ask for a session and use it once approved; the second staff approval.
  'access.request',
  'access.approve',
  // The operator directory: add staff and set their clearance, residency and sovereign
  // listing; the quarterly review, suspension and removal (13.4).
  'staff.manage',
  'staff.review',
  // Billing staff paths (75.3), each also needing a tenant_act session on the organisation.
  'billing.status',
  // Enterprise contracts (71.6 contract.manage, 74.3 to 74.6): quoting and drafting; margin
  // sign-off, activation, amendment, renewal and invoices; recording a manual payment
  // (payment.record). Staff work on an organisation, not break-glass.
  'contracts.quote',
  'contracts.manage',
  'payments.record',
  // Silo's own OAuth clients (15.4).
  'oauth.clients',
  // Fleet (11.6).
  'fleet.release.register',
  'fleet.release.promote',
  'fleet.release.expedite',
  'fleet.rollout.halt',
  'fleet.sovereign.countersign',
  // The status page (13.2): incident and maintenance notices.
  'status.publish',
  // KEK rotation in the cell (spec 61.1: key.rotate, a Silo operator role, never a tenant permission).
  'key.rotate',
  // Operations: read the cell's health; run a retention sweep or BigQuery measurement now.
  'operations.view',
  'operations.run',
  // An Enterprise organisation's private links, once its VPC-to-VPC link exists (decision 2026-11-09).
  'network.private_links',
  // Tenant migrations (6.4): propose a rebalancing; the three Silo signatures; the window.
  'tenancy.rebalance',
  'tenancy.security_officer',
  'tenancy.sovereign_security_officer',
  'tenancy.contract',
  'tenancy.schedule',
  // Support tickets (U4): read the queue, reply, resolve and take a ticket. The customer's own
  // words only: reading inside the organisation still takes a break-glass session.
  'support.tickets',
] as const;

export type StaffCapability = (typeof STAFF_CAPABILITIES)[number];

const origin = z.url().refine((value) => {
  const url = new URL(value);
  return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value;
}, 'must be an origin: scheme, host and optional port, with no path or trailing slash');

const capabilities = z.record(z.string().min(1).max(256), z.array(z.enum(STAFF_CAPABILITIES)).max(STAFF_CAPABILITIES.length));
const deviceClaims = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_:.-]{0,63}$/), z.union([z.string().max(256), z.boolean()]));

const json = <S extends z.ZodType>(schema: S) => z.string().transform((value, ctx) => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    ctx.addIssue({ code: 'custom', message: 'must be JSON' });
    return z.NEVER;
  }
}).pipe(schema);

const schema = z.object({
  publicHost: z.string().default('0.0.0.0'),
  // 0 takes any free port (tests).
  publicPort: z.coerce.number().int().min(0).max(65_535).default(8444),
  publicOrigin: origin.optional(),
  tlsCertFile: z.string().optional(),
  tlsKeyFile: z.string().optional(),
  idpIssuer: z.url().optional(),
  idpClientId: z.string().min(1).max(256).optional(),
  idpClientSecret: z.string().min(1).max(4096).optional(),
  idpRedirectUri: z.url().optional(),
  requiredAmr: zList.default(['hwk']),
  groupsClaim: z.string().regex(/^[A-Za-z_][A-Za-z0-9_:.-]{0,63}$/).default('groups'),
  groupCapabilities: json(capabilities).default({}),
  deviceClaims: json(deviceClaims).default({}),
  allowInsecureIdp: zBool.default(false),
  sessionIdleMinutes: zPositiveInt(120).default(15),
  sessionAbsoluteMinutes: zPositiveInt(24 * 60).default(8 * 60),
  flowSeconds: zPositiveInt(1_800).default(600),
  requestsPerAddress: zPositiveInt(1_000_000).default(600),
  requestsPerSession: zPositiveInt(1_000_000).default(300),
  sweepSeconds: zPositiveInt(3_600).default(60),
});

export interface AdminPortalConfig {
  publicHost: string;
  publicPort: number;
  /** Required when the process hosts the admin portal (index.config). */
  publicOrigin: string | undefined;
  /** Production requires them (index.config). */
  tls: { certFile: string; keyFile: string } | undefined;
  /** The staff identity provider; required when hosted (index.config). */
  idp: {
    issuer: string | undefined;
    clientId: string | undefined;
    clientSecret: string | undefined;
    redirectUri: string | undefined;
    requiredAmr: string[];
    groupsClaim: string;
    groupCapabilities: Record<string, StaffCapability[]>;
    deviceClaims: Record<string, string | boolean>;
    /** Development and tests only: an http issuer and private addresses. Production refuses it. */
    allowInsecure: boolean;
  };
  session: { idleMinutes: number; absoluteMinutes: number; flowSeconds: number };
  rateLimits: { windowSeconds: number; perAddress: number; perSession: number };
  /** How often running break-glass sessions are checked for expiry. */
  sweepSeconds: number;
}

export function loadAdminPortalConfig(env: Env, problems: string[]): AdminPortalConfig | undefined {
  const parsed = parseSection(schema, {
    publicHost: read(env, 'ADMIN_PORTAL_PUBLIC_HOST'),
    publicPort: read(env, 'ADMIN_PORTAL_PUBLIC_PORT'),
    publicOrigin: read(env, 'ADMIN_PORTAL_PUBLIC_ORIGIN'),
    tlsCertFile: read(env, 'ADMIN_PORTAL_TLS_CERT_FILE'),
    tlsKeyFile: read(env, 'ADMIN_PORTAL_TLS_KEY_FILE'),
    idpIssuer: read(env, 'ADMIN_PORTAL_IDP_ISSUER'),
    idpClientId: read(env, 'ADMIN_PORTAL_IDP_CLIENT_ID'),
    idpClientSecret: readSecret(env, 'ADMIN_PORTAL_IDP_CLIENT_SECRET', problems),
    idpRedirectUri: read(env, 'ADMIN_PORTAL_IDP_REDIRECT_URI'),
    requiredAmr: read(env, 'ADMIN_PORTAL_IDP_REQUIRED_AMR'),
    groupsClaim: read(env, 'ADMIN_PORTAL_IDP_GROUPS_CLAIM'),
    groupCapabilities: readJson(env, 'ADMIN_PORTAL_GROUP_CAPABILITIES', problems),
    deviceClaims: readJson(env, 'ADMIN_PORTAL_DEVICE_CLAIMS', problems),
    allowInsecureIdp: read(env, 'ADMIN_PORTAL_IDP_ALLOW_INSECURE'),
    sessionIdleMinutes: read(env, 'ADMIN_PORTAL_SESSION_IDLE_MINUTES'),
    sessionAbsoluteMinutes: read(env, 'ADMIN_PORTAL_SESSION_ABSOLUTE_MINUTES'),
    flowSeconds: read(env, 'ADMIN_PORTAL_FLOW_SECONDS'),
    requestsPerAddress: read(env, 'ADMIN_PORTAL_REQUESTS_PER_ADDRESS'),
    requestsPerSession: read(env, 'ADMIN_PORTAL_REQUESTS_PER_SESSION'),
    sweepSeconds: read(env, 'ADMIN_PORTAL_SWEEP_SECONDS'),
  }, {
    publicHost: 'ADMIN_PORTAL_PUBLIC_HOST', publicPort: 'ADMIN_PORTAL_PUBLIC_PORT', publicOrigin: 'ADMIN_PORTAL_PUBLIC_ORIGIN',
    tlsCertFile: 'ADMIN_PORTAL_TLS_CERT_FILE', tlsKeyFile: 'ADMIN_PORTAL_TLS_KEY_FILE', idpIssuer: 'ADMIN_PORTAL_IDP_ISSUER',
    idpClientId: 'ADMIN_PORTAL_IDP_CLIENT_ID', idpClientSecret: 'ADMIN_PORTAL_IDP_CLIENT_SECRET',
    idpRedirectUri: 'ADMIN_PORTAL_IDP_REDIRECT_URI', requiredAmr: 'ADMIN_PORTAL_IDP_REQUIRED_AMR',
    groupsClaim: 'ADMIN_PORTAL_IDP_GROUPS_CLAIM', groupCapabilities: 'ADMIN_PORTAL_GROUP_CAPABILITIES',
    deviceClaims: 'ADMIN_PORTAL_DEVICE_CLAIMS', allowInsecureIdp: 'ADMIN_PORTAL_IDP_ALLOW_INSECURE',
    sessionIdleMinutes: 'ADMIN_PORTAL_SESSION_IDLE_MINUTES', sessionAbsoluteMinutes: 'ADMIN_PORTAL_SESSION_ABSOLUTE_MINUTES',
    flowSeconds: 'ADMIN_PORTAL_FLOW_SECONDS', requestsPerAddress: 'ADMIN_PORTAL_REQUESTS_PER_ADDRESS',
    requestsPerSession: 'ADMIN_PORTAL_REQUESTS_PER_SESSION', sweepSeconds: 'ADMIN_PORTAL_SWEEP_SECONDS',
  }, problems);
  if (!parsed) return undefined;
  if ((parsed.tlsCertFile === undefined) !== (parsed.tlsKeyFile === undefined)) {
    problems.push('ADMIN_PORTAL_TLS_CERT_FILE: give the certificate and its key (ADMIN_PORTAL_TLS_KEY_FILE) together');
  }
  if (parsed.sessionIdleMinutes > parsed.sessionAbsoluteMinutes) {
    problems.push('ADMIN_PORTAL_SESSION_IDLE_MINUTES: the idle window cannot be longer than the session');
  }
  return {
    publicHost: parsed.publicHost,
    publicPort: parsed.publicPort,
    publicOrigin: parsed.publicOrigin,
    tls: parsed.tlsCertFile !== undefined && parsed.tlsKeyFile !== undefined ? { certFile: parsed.tlsCertFile, keyFile: parsed.tlsKeyFile } : undefined,
    idp: {
      issuer: parsed.idpIssuer,
      clientId: parsed.idpClientId,
      clientSecret: parsed.idpClientSecret,
      redirectUri: parsed.idpRedirectUri ?? (parsed.publicOrigin === undefined ? undefined : `${parsed.publicOrigin}/sso/callback`),
      requiredAmr: parsed.requiredAmr,
      groupsClaim: parsed.groupsClaim,
      groupCapabilities: parsed.groupCapabilities,
      deviceClaims: parsed.deviceClaims,
      allowInsecure: parsed.allowInsecureIdp,
    },
    session: { idleMinutes: parsed.sessionIdleMinutes, absoluteMinutes: parsed.sessionAbsoluteMinutes, flowSeconds: parsed.flowSeconds },
    rateLimits: { windowSeconds: 60, perAddress: parsed.requestsPerAddress, perSession: parsed.requestsPerSession },
    sweepSeconds: parsed.sweepSeconds,
  };
}

/** A JSON setting given inline or, with _FILE, from a file. */
function readJson(env: Env, name: string, problems: string[]): string | undefined {
  const file = read(env, `${name}_FILE`);
  if (file === undefined) return read(env, name);
  try {
    return readFileSync(file, 'utf8');
  } catch {
    problems.push(`${name}_FILE: the file could not be read`);
    return undefined;
  }
}
