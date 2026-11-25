// Silo Agent pools and enrolment (spec 10.2, 10.3, 10.9).
//
// - createAgentPool (agent.enrol): a high-availability pool that connections bind to. A
//   production pool needs at least two agents; the pool list says when it has fewer.
// - listAgentPools (agent.view): the pools, their agents and each agent's health.
// - issueAgentEnrolmentToken (agent.enrol): a single-use token valid for 24 hours, shown
//   once. The agent sends it with its signing request to agent.<cell>; it is consumed there.
// - revokeAgent (agent.manage): the agent's service principal and certificate are revoked,
//   and its tunnel closes.
// - setAgentPoolUpdatePolicy, approveAgentPoolUpdate (agent.manage; spec 10.7, 11.4): the pool
//   follows the cell's agent waves (automatic), holds at a version (pinned), or takes only the
//   version someone approved (approval). A pin or an approval overrides the waves. A version
//   named must be one the cell has received, and not older than what the pool's agents run:
//   agents update forwards only.
// - listAgentReleases (agent.view): the agent releases the cell has received, the rollout of
//   the newest through its waves, and the oldest version not yet outdated.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { semver } from '../fleet-control/release.contract.ts';

const CALLERS = ['gateway'] as const;
const timestamp = z.iso.datetime({ offset: true });

export const agentView = z.object({
  id: z.uuid(), name: z.string(), hostname: z.string(), platform: z.string(), version: z.string(),
  status: z.enum(['healthy', 'unhealthy', 'offline', 'revoked']), versionState: z.enum(['current', 'outdated', 'refused']),
  /** When it fell more than three minor releases behind (spec 10.7: refused 90 days after). */
  outdatedSince: timestamp.nullable(),
  previousVersion: z.string().nullable(),
  /** The release it is taking now. */
  updatingTo: z.string().nullable(),
  lastHeartbeatAt: timestamp.nullable(), certificateExpiresAt: timestamp, enrolledAt: timestamp, revokedAt: timestamp.nullable(),
});

export const agentPoolView = z.object({
  id: z.uuid(), name: z.string(), environment: z.enum(['production', 'non_production']),
  updatePolicy: z.enum(['automatic', 'pinned', 'approval']), pinnedVersion: z.string().nullable(),
  approvedVersion: z.string().nullable(), approvedAt: timestamp.nullable(),
  status: z.enum(['active', 'retired']), createdAt: timestamp,
  agents: z.array(agentView),
  /** A production pool with fewer than two live agents (spec 10.3: "the connection page warns"). */
  underProvisioned: z.boolean(),
});

export const createAgentPool = defineContract({
  service: 'connect-registry', name: 'createAgentPool', method: 'POST', path: '/v1/agent-pools', callers: CALLERS,
  // A pool's name is unique among live pools: the same name again is a conflict, not a second pool.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ name: z.string().trim().min(1).max(100), environment: z.enum(['production', 'non_production']).default('production') }),
  response: agentPoolView,
  status: 201,
  maxBodyBytes: 1024,
});

export const listAgentPools = defineContract({
  service: 'connect-registry', name: 'listAgentPools', method: 'GET', path: '/v1/agent-pools', callers: ['gateway', 'admin-portal'],
  context: 'organisation', idempotency: 'none',
  response: z.object({ pools: z.array(agentPoolView) }),
});

export const issueAgentEnrolmentToken = defineContract({
  service: 'connect-registry', name: 'issueAgentEnrolmentToken', method: 'POST', path: '/v1/agent-pools/:poolId/enrolment-tokens', callers: CALLERS,
  // Each call issues a new token; an unused one simply expires.
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ poolId: z.uuid() }),
  response: z.object({
    tokenId: z.uuid(),
    /** Shown once; Silo keeps only its hash. */
    token: z.string(),
    expiresAt: timestamp,
    /** Where the agent enrols and connects: agent.<cell>, TCP 443. */
    endpoint: z.string(),
  }),
  status: 201,
  maxBodyBytes: 256,
});

export const revokeAgent = defineContract({
  service: 'connect-registry', name: 'revokeAgent', method: 'POST', path: '/v1/agents/:agentId/revoke', callers: CALLERS,
  // Revoking a revoked agent changes nothing.
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ agentId: z.uuid() }),
  response: agentView,
  maxBodyBytes: 256,
});

export const setAgentPoolUpdatePolicy = defineContract({
  service: 'connect-registry', name: 'setAgentPoolUpdatePolicy', method: 'PUT', path: '/v1/agent-pools/:poolId/update-policy', callers: CALLERS,
  // The whole policy each time: setting the same again changes nothing.
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ poolId: z.uuid() }),
  body: z.discriminatedUnion('policy', [
    z.strictObject({ policy: z.literal('automatic') }),
    z.strictObject({ policy: z.literal('pinned'), version: semver }),
    z.strictObject({ policy: z.literal('approval') }),
  ]),
  response: agentPoolView,
  maxBodyBytes: 1024,
});

export const approveAgentPoolUpdate = defineContract({
  service: 'connect-registry', name: 'approveAgentPoolUpdate', method: 'PUT', path: '/v1/agent-pools/:poolId/approved-version', callers: CALLERS,
  // Approving the version already approved changes nothing.
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ poolId: z.uuid() }),
  body: z.strictObject({ version: semver }),
  response: agentPoolView,
  maxBodyBytes: 1024,
});

export const agentReleaseView = z.object({
  releaseId: z.string(), version: z.string(), installedAt: timestamp,
  platforms: z.array(z.string()),
});

export const listAgentReleases = defineContract({
  service: 'connect-registry', name: 'listAgentReleases', method: 'GET', path: '/v1/agent-releases', callers: ['gateway', 'admin-portal'],
  context: 'organisation', idempotency: 'none',
  response: z.object({
    releases: z.array(agentReleaseView),
    /** The newest release's progress through the cell's agent waves (spec 11.4); null before any. */
    rollout: z.object({
      version: z.string(),
      status: z.enum(['running', 'halted', 'completed', 'superseded']),
      /** 0 Silo's own organisations, 1 5% of agents, 2 25%, 3 all. */
      wave: z.int().min(0).max(3),
      waveStartedAt: timestamp,
      startedAt: timestamp,
      endedAt: timestamp.nullable(),
      haltReason: z.enum(['heartbeat', 'error_rate', 'refused']).nullable(),
    }).nullable(),
    /** Agents older than this minor release are outdated (spec 10.7); null while the cell has fewer than three. */
    outdatedBelow: z.string().nullable(),
  }),
});
