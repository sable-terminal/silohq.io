// Connect: how the cell reaches customer systems, and the OAuth engine (spec 14, 15).
//
// Egress from the cell goes only to public addresses over HTTPS. A private, loopback or
// link-local address (the cloud metadata server, cluster services) is refused, because a
// manifest's base URL or a tenant parameter must never reach inside Silo; systems behind a
// firewall are reached through the Silo Agent. Development and tests may allow both, for
// local fakes; production refuses to start with either.
//
// The one exception is an Enterprise organisation's private link (decision 2026-11-09): a
// private address inside one of that organisation's live links is reached for its own
// connections only. CONNECT_CELL_NETWORKS lists the cell's own networks (nodes, pods,
// services, managed databases and Redis), which no link may overlap and the egress never
// reaches whatever a link says; production requires it wherever links are added or used.
// A Private Service Connect endpoint subnet is not one of them.
//
// The OAuth callback is one per cell and encodes nothing about connector or tenant (spec
// 15.3). Pending flows expire after 15 minutes (target).
//
// The defaults are this build's choices: requests time out after 30 seconds, and a response
// over 32 MiB is refused rather than truncated.
//
// The agent endpoint (spec 10.2): agent.<cell> (AGENT_ENDPOINT_HOST, by default
// agent.<SILO_CELL_ID>.silohq.io), where Silo Agents enrol and hold their tunnels, served by
// connect-runtime on AGENT_ENDPOINT_PORT behind a TCP pass-through load balancer, since the
// tunnel's mutual TLS ends here. Its server certificate (AGENT_ENDPOINT_TLS_CERT_FILE,
// AGENT_ENDPOINT_TLS_KEY) and the agent CA's certificate and key (AGENT_CA_CERT_FILE,
// AGENT_CA_KEY) come from the deployment.
//
// Each replica holds the tunnels of the agents the load balancer sent it. AGENT_RELAY_URL is
// this replica's own address on the service listener (https://$(POD_IP):<HTTP_PORT>, from the
// downward API), where the other replicas relay work for the agents it holds; TLS there still
// verifies the service's own name. Unset, this replica gives work only to agents it holds,
// and relays to replicas that set it.
//
// Execution grants (spec 5.6, 10.4): a write through the Silo Agent runs only on a grant
// actions signs with EXECUTION_GRANT_KEY (Ed25519, PKCS#8 PEM, from the deployment), naming
// the Action, the connection, the target and the payload's hash. connect-runtime checks it with
// EXECUTION_GRANT_PUBLIC_KEY (SPKI PEM) before the write leaves the cell, and gives the same key
// to every agent it enrols or renews, which checks the grant itself.
//
// Agent updates (spec 10.7, 11.4): each agent release rolls through the cell's agents in waves,
// the first being Silo's own organisations here (CONNECT_AGENT_FIRST_ORGANISATIONS, ids; none
// by default, when that wave passes at once); then 5%, 25% and all, each soaking
// CONNECT_AGENT_WAVE_SOAK_HOURS (24). Releases are checked against the Silo release key
// (FLEET_RELEASE_PUBLIC_KEY_FILE) and their binaries served from object-files.

import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { parseCidr } from '../utils/network.util.ts';
import { parseSection, read, readSecret, zBool, zList, zPositiveInt, type Env } from './env.config.ts';

const schema = z.object({
  egressAllowPrivate: zBool.default(false),
  egressAllowHttp: zBool.default(false),
  egressTimeoutMs: zPositiveInt(120_000).default(30_000),
  egressMaxResponseBytes: zPositiveInt(256 * 1024 * 1024).default(32 * 1024 * 1024),
  oauthRedirectUri: z.url({ protocol: /^https?$/ }).optional(),
  oauthFlowSeconds: zPositiveInt(3_600).default(900),
  cellNetworks: zList.pipe(z.array(z.string().refine((text) => parseCidr(text) !== undefined, 'must be networks in CIDR notation, comma separated')))
    .optional(),
  agentHost: z.string().regex(/^[a-z0-9.-]{1,253}$/).optional(),
  agentPort: z.coerce.number().int().min(0).max(65_535).default(8443),
  agentTlsCertFile: z.string().min(1).optional(),
  agentCaCertFile: z.string().min(1).optional(),
  agentRelayUrl: z.url({ protocol: /^https?$/ }).refine((text) => new URL(text).pathname === '/' && !/\/$/.test(text) && new URL(text).search === '',
    'a scheme, host and port only, no path').optional(),
  agentFirstOrganisations: zList.pipe(z.array(z.uuid())).default([]),
  agentWaveSoakHours: zPositiveInt(24 * 14).default(24),
  /** Email fallback (spec 14.4): the domain addresses are minted under, whose mail the cell's relay posts to the gateway. */
  inboundEmailDomain: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/, 'a lower-case domain').optional(),
});

export type ConnectConfig = z.output<typeof schema> & {
  /** The agent endpoint's server key, PEM. */
  agentTlsKey?: string | undefined;
  /** The agent CA's private key, PKCS#8 PEM (P-256). */
  agentCaKey?: string | undefined;
  /** actions: the key execution grants are signed with (Ed25519). */
  executionGrantKey?: KeyObject | undefined;
  /** connect-runtime and the agents: the key grants are checked against. */
  executionGrantPublicKey?: KeyObject | undefined;
  /** discovery: the key scans are signed with (Ed25519). */
  discoveryScanKey?: KeyObject | undefined;
  /** connect-runtime and the agents: the key scans are checked against. */
  discoveryScanPublicKey?: KeyObject | undefined;
  /** change-stream: what the mail relay signs each message it posts with (HMAC-SHA256). */
  inboundEmailSecret?: string | undefined;
};

/** A key pair given as two settings: the public half must be the private key's. */
function pair(env: Env, privateName: string, publicName: string, problems: string[]): { privateKey?: KeyObject; publicKey?: KeyObject } {
  const privateKey = ed25519(readSecret(env, privateName, problems), 'private', privateName, problems);
  const publicKey = ed25519(readSecret(env, publicName, problems), 'public', publicName, problems);
  if (privateKey !== undefined && publicKey !== undefined
    && !createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).equals(publicKey.export({ type: 'spki', format: 'der' }))) {
    problems.push(`${publicName}: not the public half of ${privateName}`);
  }
  return { ...(privateKey ? { privateKey } : {}), ...(publicKey ? { publicKey } : {}) };
}

function ed25519(text: string | undefined, kind: 'private' | 'public', name: string, problems: string[]): KeyObject | undefined {
  if (text === undefined) return undefined;
  try {
    const key = kind === 'private' ? createPrivateKey(text) : createPublicKey(text);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('not Ed25519');
    return key;
  } catch {
    problems.push(`${name}: an Ed25519 ${kind === 'private' ? 'private key, PKCS#8' : 'public key, SPKI'} PEM`);
    return undefined;
  }
}

export function loadConnectConfig(env: Env, problems: string[]): ConnectConfig | undefined {
  const parsed = parseSection(schema, {
    egressAllowPrivate: read(env, 'CONNECT_EGRESS_ALLOW_PRIVATE'),
    egressAllowHttp: read(env, 'CONNECT_EGRESS_ALLOW_HTTP'),
    egressTimeoutMs: read(env, 'CONNECT_EGRESS_TIMEOUT_MS'),
    egressMaxResponseBytes: read(env, 'CONNECT_EGRESS_MAX_RESPONSE_BYTES'),
    oauthRedirectUri: read(env, 'OAUTH_REDIRECT_URI'),
    oauthFlowSeconds: read(env, 'OAUTH_FLOW_SECONDS'),
    cellNetworks: read(env, 'CONNECT_CELL_NETWORKS'),
    agentHost: read(env, 'AGENT_ENDPOINT_HOST'),
    agentPort: read(env, 'AGENT_ENDPOINT_PORT'),
    agentTlsCertFile: read(env, 'AGENT_ENDPOINT_TLS_CERT_FILE'),
    agentCaCertFile: read(env, 'AGENT_CA_CERT_FILE'),
    agentRelayUrl: read(env, 'AGENT_RELAY_URL'),
    agentFirstOrganisations: read(env, 'CONNECT_AGENT_FIRST_ORGANISATIONS'),
    agentWaveSoakHours: read(env, 'CONNECT_AGENT_WAVE_SOAK_HOURS'),
    inboundEmailDomain: read(env, 'INBOUND_EMAIL_DOMAIN'),
  }, {
    egressAllowPrivate: 'CONNECT_EGRESS_ALLOW_PRIVATE', egressAllowHttp: 'CONNECT_EGRESS_ALLOW_HTTP',
    egressTimeoutMs: 'CONNECT_EGRESS_TIMEOUT_MS', egressMaxResponseBytes: 'CONNECT_EGRESS_MAX_RESPONSE_BYTES',
    oauthRedirectUri: 'OAUTH_REDIRECT_URI', oauthFlowSeconds: 'OAUTH_FLOW_SECONDS', cellNetworks: 'CONNECT_CELL_NETWORKS',
    agentHost: 'AGENT_ENDPOINT_HOST', agentPort: 'AGENT_ENDPOINT_PORT', agentTlsCertFile: 'AGENT_ENDPOINT_TLS_CERT_FILE',
    agentCaCertFile: 'AGENT_CA_CERT_FILE', agentRelayUrl: 'AGENT_RELAY_URL',
    agentFirstOrganisations: 'CONNECT_AGENT_FIRST_ORGANISATIONS', agentWaveSoakHours: 'CONNECT_AGENT_WAVE_SOAK_HOURS',
    inboundEmailDomain: 'INBOUND_EMAIL_DOMAIN',
  }, problems);
  if (parsed === undefined) return undefined;
  const agentTlsKey = readSecret(env, 'AGENT_ENDPOINT_TLS_KEY', problems);
  const agentCaKey = readSecret(env, 'AGENT_CA_KEY', problems);
  const inboundEmailSecret = readSecret(env, 'INBOUND_EMAIL_SECRET', problems);
  if ((parsed.inboundEmailDomain === undefined) !== (inboundEmailSecret === undefined)) problems.push('INBOUND_EMAIL_DOMAIN and INBOUND_EMAIL_SECRET: set both, or neither');
  if (inboundEmailSecret !== undefined && inboundEmailSecret.length < 32) problems.push('INBOUND_EMAIL_SECRET: at least 32 characters');
  if ((parsed.agentCaCertFile === undefined) !== (agentCaKey === undefined)) problems.push('AGENT_CA_CERT_FILE and AGENT_CA_KEY: set both, or neither');
  if ((parsed.agentTlsCertFile === undefined) !== (agentTlsKey === undefined)) {
    problems.push('AGENT_ENDPOINT_TLS_CERT_FILE and AGENT_ENDPOINT_TLS_KEY: set both, or neither');
  }
  // Two signers, two keys: actions signs writes, discovery signs scans, and neither can sign the other's.
  const grants = pair(env, 'EXECUTION_GRANT_KEY', 'EXECUTION_GRANT_PUBLIC_KEY', problems);
  const scans = pair(env, 'DISCOVERY_SCAN_KEY', 'DISCOVERY_SCAN_PUBLIC_KEY', problems);
  if (grants.publicKey !== undefined && scans.publicKey !== undefined
    && grants.publicKey.export({ type: 'spki', format: 'der' }).equals(scans.publicKey.export({ type: 'spki', format: 'der' }))) {
    problems.push('DISCOVERY_SCAN_PUBLIC_KEY: a key of its own, not the execution grant key');
  }
  return {
    ...parsed, ...(agentTlsKey ? { agentTlsKey } : {}), ...(agentCaKey ? { agentCaKey } : {}),
    ...(grants.privateKey ? { executionGrantKey: grants.privateKey } : {}), ...(grants.publicKey ? { executionGrantPublicKey: grants.publicKey } : {}),
    ...(scans.privateKey ? { discoveryScanKey: scans.privateKey } : {}), ...(scans.publicKey ? { discoveryScanPublicKey: scans.publicKey } : {}),
    ...(inboundEmailSecret ? { inboundEmailSecret } : {}),
  };
}
