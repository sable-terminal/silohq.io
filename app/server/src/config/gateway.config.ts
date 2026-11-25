// The gateway's public edge (spec 7.3, 30.3): the listener browsers reach, apart from the
// service listener (http.config) that other services and the orchestrator's probes use.
//
// Defaults, this build's choices (the spec names the mechanisms, not the numbers):
// - the public origin is the one origin the web client is served from; there is no CORS
//   beyond it, and state-changing requests and WebSocket handshakes must come from it;
// - per-minute fixed windows: 3,000 requests per client address (an office behind one
//   NAT address shares it) and 600 per session;
// - WebSockets: 8 per session on one pod, a 15-second heartbeat (spec 30.3), 20 client
//   messages a second, and the session checked every 15 seconds, so a revoked or idle
//   session's sockets close within LIMITS.statePlane.revocationCloseSeconds (30).

import { z } from 'zod';
import { LIMITS } from './limits.config.ts';
import { parseSection, read, zPositiveInt, type Env } from './env.config.ts';

const origin = z.url().refine((value) => {
  const url = new URL(value);
  return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value;
}, 'must be an origin: scheme, host and optional port, with no path or trailing slash');

const schema = z.object({
  publicHost: z.string().default('0.0.0.0'),
  // 0 takes any free port (tests).
  publicPort: z.coerce.number().int().min(0).max(65_535).default(8443),
  publicOrigin: origin.optional(),
  tlsCertFile: z.string().optional(),
  tlsKeyFile: z.string().optional(),
  webRoot: z.string().min(1).optional(),
  /** Comma-separated origins of the object store signed uploads go to (Files' large uploads, 41.4); the page policy lets the browser reach them. */
  uploadOrigins: z.string().optional().transform((v, ctx) => {
    const list = (v ?? '').split(',').map((x) => x.trim()).filter((x) => x !== '');
    for (const o of list) if (!origin.safeParse(o).success) ctx.addIssue({ code: 'custom', message: `${o} is not an origin` });
    return list;
  }),
  requestsPerAddress: zPositiveInt(1_000_000).default(3_000),
  requestsPerSession: zPositiveInt(1_000_000).default(600),
  // Every session and API client of one organisation together (spec 12.4: one tenant cannot consume a cell).
  requestsPerOrganisation: zPositiveInt(10_000_000).default(30_000),
  socketsPerSession: zPositiveInt(100).default(8),
  heartbeatSeconds: zPositiveInt(60).default(15),
  sessionCheckSeconds: zPositiveInt(LIMITS.statePlane.revocationCloseSeconds).default(15),
  clientMessagesPerSecond: zPositiveInt(1_000).default(20),
});

export interface GatewayConfig {
  publicHost: string;
  publicPort: number;
  /** Required when the process hosts the gateway (index.config). */
  publicOrigin: string | undefined;
  /** The public certificate and key; production requires them (index.config). */
  tls: { certFile: string; keyFile: string } | undefined;
  /** The web client's static export (app/web/out), served at the public origin; absent, the edge serves the API only. */
  webRoot: string | undefined;
  /** Where the browser may send a signed upload: the object store's origins, added to the pages' connect-src. */
  uploadOrigins: string[];
  /** Requests per minute. */
  rateLimits: { windowSeconds: number; perAddress: number; perSession: number; perOrganisation: number };
  live: { socketsPerSession: number; heartbeatSeconds: number; sessionCheckSeconds: number; clientMessagesPerSecond: number };
}

export function loadGatewayConfig(env: Env, problems: string[]): GatewayConfig | undefined {
  const parsed = parseSection(schema, {
    publicHost: read(env, 'GATEWAY_PUBLIC_HOST'),
    publicPort: read(env, 'GATEWAY_PUBLIC_PORT'),
    publicOrigin: read(env, 'GATEWAY_PUBLIC_ORIGIN'),
    tlsCertFile: read(env, 'GATEWAY_TLS_CERT_FILE'),
    tlsKeyFile: read(env, 'GATEWAY_TLS_KEY_FILE'),
    webRoot: read(env, 'GATEWAY_WEB_ROOT'),
    uploadOrigins: read(env, 'GATEWAY_UPLOAD_ORIGINS'),
    requestsPerAddress: read(env, 'GATEWAY_REQUESTS_PER_ADDRESS'),
    requestsPerSession: read(env, 'GATEWAY_REQUESTS_PER_SESSION'),
    requestsPerOrganisation: read(env, 'GATEWAY_REQUESTS_PER_ORGANISATION'),
    socketsPerSession: read(env, 'GATEWAY_SOCKETS_PER_SESSION'),
    heartbeatSeconds: read(env, 'GATEWAY_HEARTBEAT_SECONDS'),
    sessionCheckSeconds: read(env, 'GATEWAY_SESSION_CHECK_SECONDS'),
    clientMessagesPerSecond: read(env, 'GATEWAY_CLIENT_MESSAGES_PER_SECOND'),
  }, {
    publicHost: 'GATEWAY_PUBLIC_HOST', publicPort: 'GATEWAY_PUBLIC_PORT', publicOrigin: 'GATEWAY_PUBLIC_ORIGIN',
    tlsCertFile: 'GATEWAY_TLS_CERT_FILE', tlsKeyFile: 'GATEWAY_TLS_KEY_FILE', webRoot: 'GATEWAY_WEB_ROOT', uploadOrigins: 'GATEWAY_UPLOAD_ORIGINS',
    requestsPerAddress: 'GATEWAY_REQUESTS_PER_ADDRESS', requestsPerSession: 'GATEWAY_REQUESTS_PER_SESSION', requestsPerOrganisation: 'GATEWAY_REQUESTS_PER_ORGANISATION',
    socketsPerSession: 'GATEWAY_SOCKETS_PER_SESSION', heartbeatSeconds: 'GATEWAY_HEARTBEAT_SECONDS',
    sessionCheckSeconds: 'GATEWAY_SESSION_CHECK_SECONDS', clientMessagesPerSecond: 'GATEWAY_CLIENT_MESSAGES_PER_SECOND',
  }, problems);
  if (!parsed) return undefined;
  if ((parsed.tlsCertFile === undefined) !== (parsed.tlsKeyFile === undefined)) {
    problems.push('GATEWAY_TLS_CERT_FILE: set the certificate and key files together');
  }
  return {
    publicHost: parsed.publicHost,
    publicPort: parsed.publicPort,
    publicOrigin: parsed.publicOrigin,
    tls: parsed.tlsCertFile !== undefined && parsed.tlsKeyFile !== undefined
      ? { certFile: parsed.tlsCertFile, keyFile: parsed.tlsKeyFile } : undefined,
    webRoot: parsed.webRoot,
    uploadOrigins: parsed.uploadOrigins,
    rateLimits: { windowSeconds: 60, perAddress: parsed.requestsPerAddress, perSession: parsed.requestsPerSession, perOrganisation: parsed.requestsPerOrganisation },
    live: {
      socketsPerSession: parsed.socketsPerSession,
      heartbeatSeconds: parsed.heartbeatSeconds,
      sessionCheckSeconds: parsed.sessionCheckSeconds,
      clientMessagesPerSecond: parsed.clientMessagesPerSecond,
    },
  };
}
