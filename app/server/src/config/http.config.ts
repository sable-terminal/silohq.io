// The process's HTTP listener, its service identity and how it reaches other services.
// "Service calls use mTLS with per-cell workload identities, accepted only from listed
// callers" (spec 7.1).
//
// Identity: each service's certificate carries the URI spiffe://<cell id>/service/<name>,
// so a caller from another cell, or with no certificate, is refused. Without TLS
// (development and tests only; production requires it, index.config) a caller names
// itself in a header instead.

import { z } from 'zod';
import { parseSection, read, zPositiveInt, type Env } from './env.config.ts';
import { SERVICES, type ServiceName } from './service.config.ts';

const schema = z.object({
  host: z.string().default('0.0.0.0'),
  // 0 takes any free port (tests).
  port: z.coerce.number().int().min(0).max(65_535).default(8080),
  tlsCertFile: z.string().optional(),
  tlsKeyFile: z.string().optional(),
  tlsCaFile: z.string().optional(),
  // How many proxies in front of the gateway to trust for the client address.
  trustProxyHops: z.coerce.number().int().min(0).max(5).default(1),
  // A request body over this is refused, never truncated. A contract may lower it.
  maxBodyBytes: zPositiveInt(64 * 1024 * 1024).default(1024 * 1024),
  // A request still running after this answers 504; its work may finish, which is why
  // callers retry under idempotency keys.
  requestTimeoutMs: zPositiveInt(10 * 60_000).default(30_000),
  // On SIGTERM: readiness fails for drainSeconds so the load balancer stops sending,
  // then the listener closes and in-flight requests get shutdownTimeoutMs to finish.
  drainSeconds: z.coerce.number().int().min(0).max(120).default(5),
  shutdownTimeoutMs: zPositiveInt(10 * 60_000).default(25_000),
  // Where another service is reached: {service} is replaced by its name (its cluster
  // DNS name). SERVICE_URL_<NAME> overrides one service, for local development.
  serviceUrlTemplate: z.string().regex(/^https?:\/\/[^\s]*\{service\}[^\s]*$/, 'must contain {service}').default('https://{service}:8080'),
  serviceUrls: z.record(z.string(), z.url()).default({}),
  // Load shedding (spec 12.4): from this event-loop delay (p99, ms) the lowest class of work is
  // refused, and each further step sheds the next (infra/load.infra.ts).
  shedStartMs: zPositiveInt(60_000).default(200),
  shedStepMs: zPositiveInt(10_000).default(50),
});

export type HttpConfig = z.output<typeof schema>;

// SERVICE_URL_CONNECT_RUNTIME for connect-runtime, and so on.
export const serviceUrlVariable = (service: ServiceName): string => `SERVICE_URL_${service.toUpperCase().replaceAll('-', '_')}`;

export function loadHttpConfig(env: Env, problems: string[]): HttpConfig | undefined {
  const serviceUrls: Record<string, string> = {};
  for (const service of SERVICES) {
    const url = read(env, serviceUrlVariable(service));
    if (url !== undefined) serviceUrls[service] = url;
  }
  const parsed = parseSection(schema, {
    host: read(env, 'HTTP_HOST'),
    port: read(env, 'HTTP_PORT'),
    tlsCertFile: read(env, 'SERVICE_TLS_CERT_FILE'),
    tlsKeyFile: read(env, 'SERVICE_TLS_KEY_FILE'),
    tlsCaFile: read(env, 'SERVICE_TLS_CA_FILE'),
    trustProxyHops: read(env, 'TRUST_PROXY_HOPS'),
    maxBodyBytes: read(env, 'HTTP_MAX_BODY_BYTES'),
    requestTimeoutMs: read(env, 'HTTP_REQUEST_TIMEOUT_MS'),
    drainSeconds: read(env, 'HTTP_DRAIN_SECONDS'),
    shutdownTimeoutMs: read(env, 'HTTP_SHUTDOWN_TIMEOUT_MS'),
    serviceUrlTemplate: read(env, 'SERVICE_URL_TEMPLATE'),
    serviceUrls,
    shedStartMs: read(env, 'SHED_START_MS'),
    shedStepMs: read(env, 'SHED_STEP_MS'),
  }, {
    host: 'HTTP_HOST', port: 'HTTP_PORT', tlsCertFile: 'SERVICE_TLS_CERT_FILE', tlsKeyFile: 'SERVICE_TLS_KEY_FILE',
    tlsCaFile: 'SERVICE_TLS_CA_FILE', trustProxyHops: 'TRUST_PROXY_HOPS', maxBodyBytes: 'HTTP_MAX_BODY_BYTES',
    requestTimeoutMs: 'HTTP_REQUEST_TIMEOUT_MS', drainSeconds: 'HTTP_DRAIN_SECONDS', shutdownTimeoutMs: 'HTTP_SHUTDOWN_TIMEOUT_MS',
    serviceUrlTemplate: 'SERVICE_URL_TEMPLATE', serviceUrls: 'SERVICE_URL_<NAME>', shedStartMs: 'SHED_START_MS', shedStepMs: 'SHED_STEP_MS',
  }, problems);
  if (parsed) {
    const set = [parsed.tlsCertFile, parsed.tlsKeyFile, parsed.tlsCaFile].filter((v) => v !== undefined).length;
    if (set !== 0 && set !== 3) {
      problems.push('SERVICE_TLS_CERT_FILE: set the certificate, key and CA files together');
    }
  }
  return parsed;
}
