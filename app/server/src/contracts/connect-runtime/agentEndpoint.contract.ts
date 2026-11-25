// The agent endpoint (spec 10.2): agent.<cell>, TCP 443, TLS 1.3, served by connect-runtime.
// Not a service contract: the Silo Agent in the customer's network calls it, outside Silo.
//
// POST /v1/enrol: the agent's first and only call without a client certificate. It sends the
// single-use enrolment token, a PKCS#10 request for the P-256 key it generated and keeps, and
// what it is. The token is consumed and the agent's client certificate issued (30 days),
// with the CA certificate it pins. From then on it authenticates by mutual TLS only.

import { z } from 'zod';
import { AGENT_PLATFORMS, semver } from '../fleet-control/release.contract.ts';

/** The X25519 public key (32 bytes, base64) the agent made for logins sealed to it (spec 10.7), new at each renewal. */
const sealingKey = z.base64().refine((text) => Buffer.from(text, 'base64').length === 32, 'an X25519 public key, 32 bytes');

export const AGENT_ENROL_PATH = '/v1/enrol';

export const agentEnrolRequest = z.strictObject({
  token: z.string().min(10).max(200),
  csr: z.string().min(100).max(8192),
  name: z.string().trim().min(1).max(100),
  hostname: z.string().trim().min(1).max(253),
  platform: z.enum(AGENT_PLATFORMS),
  version: semver,
  sealingKey: sealingKey.optional(),
});
export type AgentEnrolRequest = z.infer<typeof agentEnrolRequest>;

/** POST /v1/renew, over mutual TLS with the current certificate (spec 10.7: renewed at 20 days with a new local key pair). */
export const AGENT_RENEW_PATH = '/v1/renew';
export const agentRenewRequest = z.strictObject({ csr: z.string().min(100).max(8192), sealingKey: sealingKey.optional() });

export const agentEnrolResponse = z.object({
  agentId: z.uuid(),
  organisationId: z.uuid(),
  poolId: z.uuid(),
  /** The agent's client certificate, PEM. */
  certificate: z.string(),
  /** The cell's agent CA certificate, PEM: the tunnel's client certificates chain to it. */
  caCertificate: z.string(),
  /** The key execution grants are signed with, SPKI PEM: the agent runs a write only on a grant it verifies (spec 10.4). */
  grantKey: z.string().optional(),
  /** The key discovery scans are signed with, SPKI PEM: the agent scans only on a scan it verifies (spec 10.5). None in the sovereign build. */
  discoveryKey: z.string().optional(),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type AgentEnrolResponse = z.infer<typeof agentEnrolResponse>;

// Updates through Fleet (spec 10.7, 11.4). The agent asks hourly whether to update, over its
// mutual TLS connection; the cell answers from the releases its Fleet agent installed, the
// pool's update policy and the cell's agent waves. The agent itself checks everything before
// it runs anything: the release's signature and the channel head's by a Silo release key built
// into the agent, the head naming this release on the agent channel, the build target, its
// platform's binary and its digest, and that the version is newer than its own. It keeps the
// binary it ran before, and goes back to it when told (a halted wave) or when the new one fails.
//
//   GET  /v1/update                 what to do now: nothing, update, or go back
//   GET  /v1/update/binary/:sha256  the bytes of a binary offered to this agent
//   POST /v1/update/report          an update the agent refused, or one that failed and was undone

export const AGENT_UPDATE_PATH = '/v1/update';
export const AGENT_BINARY_PATH_PREFIX = '/v1/update/binary/';
export const AGENT_UPDATE_REPORT_PATH = '/v1/update/report';

const signedText = z.strictObject({
  text: z.string(),
  signatures: z.array(z.strictObject({ keyId: z.string(), role: z.enum(['release', 'sovereign']), signature: z.string() })),
});

export const agentUpdateOffer = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('none') }),
  z.strictObject({
    action: z.literal('update'),
    version: semver,
    platform: z.enum(AGENT_PLATFORMS),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    bytes: z.int().min(1),
    /** The channel head (silo.channel.v1) and the release manifest (silo.release.v1), as signed. */
    head: signedText,
    release: signedText,
  }),
  /** Go back to the version run before this one: a wave the agent was in failed its gates. */
  z.strictObject({ action: z.literal('rollback'), version: semver }),
]);
export type AgentUpdateOffer = z.infer<typeof agentUpdateOffer>;

/**
 * Why the agent refused an update or undid one. signature, not_promoted, target, platform and
 * digest mean the cell offered something the agent will not run; failed_to_start means the new
 * binary did not stay up and the agent went back; the rest are the agent's own circumstances.
 */
export const UPDATE_REFUSALS = [
  'signature', 'not_promoted', 'target', 'platform', 'digest', 'failed_to_start',
  'not_newer', 'failed_before', 'storage', 'no_release_key', 'no_previous',
] as const;
/** Refusals that halt a rollout: the release itself, not the host, is at fault. */
export const RELEASE_FAULTS: readonly (typeof UPDATE_REFUSALS)[number][] = ['signature', 'not_promoted', 'target', 'platform', 'digest', 'failed_to_start'];

export const agentUpdateReport = z.strictObject({
  version: semver,
  outcome: z.enum(['refused', 'undone']),
  reason: z.enum(UPDATE_REFUSALS),
});
export type AgentUpdateReport = z.infer<typeof agentUpdateReport>;
