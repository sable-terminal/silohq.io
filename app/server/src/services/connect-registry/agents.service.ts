// Silo Agent pools and enrolment tokens (spec 10.2, 10.3, 10.9;
// contracts/connect-registry/agent.contract.ts). The agent itself enrols at agent.<cell>
// (connect-runtime's agent endpoint), consuming the token issued here.
//
// - agent.enrol creates pools and tokens; agent.view lists them; agent.manage revokes. Each is
//   decided by policy for the organisation (pools have no owning scope yet, so a scope admin's
//   delegation (10.9) waits for one).
// - A token is shown once and kept as its hash; it lasts 24 hours and is single use.
// - Revoking an agent revokes its service principal in the same transaction, so the tunnel
//   refuses it at once (spec 10.7: "Revoking the service principal closes the tunnel at once").
// - Updates (spec 10.7, 11.4), agent.manage: a pool follows the cell's agent waves, is pinned
//   at a version, or takes only a version someone approved; connect-runtime offers its agents
//   updates accordingly. A version named must be one the cell has received from Fleet, and no
//   older than any of the pool's agents runs: an agent never downloads an older version (it
//   goes back only to the version it ran before, when a wave fails).

import type { agentPoolView, agentView, listAgentReleases as listAgentReleasesContract } from '../../contracts/connect-registry/agent.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { Agent } from '../../models/connect/agent.model.ts';
import type { AgentPool } from '../../models/connect/agentPool.model.ts';
import { agentEnrolmentTokenRepo, agentPoolRepo, agentReleaseRepo, agentRepo, agentRolloutRepo } from '../../repos/connect/index.repo.ts';
import type { Queryable } from '../../infra/postgres.infra.ts';
import { isNewer, outdatedFloor } from './agentVersions.service.ts';
import { servicePrincipalRepo } from '../../repos/iam/index.repo.ts';
import { AppError, fromDatabaseError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { issueToken } from '../../utils/token.util.ts';
import { recordConnectEvent } from './connectEvents.service.ts';
import { demand, type RegistryDeps } from './registry.service.ts';

type Context = Pick<HandlerContext, 'request' | 'correlationId'>;
type PoolView = typeof agentPoolView._output;
type AgentView = typeof agentView._output;
type ReleasesView = typeof listAgentReleasesContract.response._output;

const TOKEN_HOURS = 24;
const iso = (value: string): string => new Date(Date.parse(value)).toISOString();
const isoOrNull = (value: string | null): string | null => (value === null ? null : iso(value));

export interface AgentDeps extends RegistryDeps {
  /** The hostname agents enrol and connect at: agent.<cell>. */
  agentEndpoint: string;
}

const member = (ctx: Context): { organisationId: string; membershipId: string } => {
  if (ctx.request.membershipId === undefined) {
    throw new AppError('forbidden', 'agents are managed by a member', { code: 'connect.member_required' });
  }
  return { organisationId: ctx.request.organisationId!, membershipId: ctx.request.membershipId };
};

export const viewOfAgent = (a: Agent): AgentView => ({
  id: a.id, name: a.name, hostname: a.hostname, platform: a.platform, version: a.version, status: a.status, versionState: a.versionState,
  outdatedSince: isoOrNull(a.versionOutdatedAt), previousVersion: a.previousVersion, updatingTo: a.updatingTo,
  lastHeartbeatAt: isoOrNull(a.lastHeartbeatAt), certificateExpiresAt: iso(a.certificateExpiresAt), enrolledAt: iso(a.enrolledAt),
  revokedAt: isoOrNull(a.revokedAt),
});

const viewOfPool = (p: AgentPool, agents: readonly Agent[]): PoolView => {
  const live = agents.filter((a) => a.status !== 'revoked');
  return {
    id: p.id, name: p.name, environment: p.environment, updatePolicy: p.updatePolicy, pinnedVersion: p.pinnedVersion,
    approvedVersion: p.approvedVersion, approvedAt: isoOrNull(p.approvedAt), status: p.status,
    createdAt: iso(p.createdAt), agents: agents.map(viewOfAgent), underProvisioned: p.environment === 'production' && live.length < 2,
  };
};

export async function createAgentPool(deps: AgentDeps, ctx: Context, input: { name: string; environment: 'production' | 'non_production' }): Promise<PoolView> {
  const who = member(ctx);
  await demand(deps, ctx, 'agent.enrol');
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    let pool: AgentPool;
    try {
      pool = await agentPoolRepo.insert(db, { id: uuidv7(), organisationId: who.organisationId, name: input.name, environment: input.environment, createdBy: who.membershipId });
    } catch (error) {
      if (fromDatabaseError(error).category === 'conflict') {
        throw new AppError('conflict', 'a live pool already has that name', { code: 'agent.pool_name_taken' });
      }
      throw error;
    }
    await recordConnectEvent(db, {
      organisationId: who.organisationId, correlationId: ctx.correlationId, event: 'agent_pool_created', membershipId: who.membershipId,
      resourceType: 'agent_pool', resourceId: pool.id, detail: { environment: pool.environment },
    });
    return viewOfPool(pool, []);
  });
}

export async function listAgentPools(deps: AgentDeps, ctx: Context): Promise<{ pools: PoolView[] }> {
  await demand(deps, ctx, 'agent.view');
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const pools = await agentPoolRepo.listLive(db);
    const agents = await agentRepo.forPools(db, pools.map((p) => p.id));
    return { pools: pools.map((p) => viewOfPool(p, agents.filter((a) => a.poolId === p.id))) };
  }, { readOnly: true });
}

export async function issueAgentEnrolmentToken(deps: AgentDeps, ctx: Context, poolId: string)
  : Promise<{ tokenId: string; token: string; expiresAt: string; endpoint: string }> {
  const who = member(ctx);
  await demand(deps, ctx, 'agent.enrol');
  const issued = issueToken('agent_enrolment');
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const pool = await agentPoolRepo.findById(db, poolId);
    if (pool === undefined) throw new AppError('not_found', 'no such pool', { code: 'agent.pool_unknown' });
    if (pool.status !== 'active') throw new AppError('conflict', 'a retired pool takes no agents', { code: 'agent.pool_retired' });
    const expiresAt = new Date(Date.now() + TOKEN_HOURS * 3_600_000).toISOString();
    const token = await agentEnrolmentTokenRepo.insert(db, {
      id: uuidv7(), organisationId: who.organisationId, poolId, tokenHash: issued.hash, createdBy: who.membershipId, expiresAt,
    });
    await recordConnectEvent(db, {
      organisationId: who.organisationId, correlationId: ctx.correlationId, event: 'agent_enrolment_token_issued', membershipId: who.membershipId,
      resourceType: 'agent_pool', resourceId: poolId, detail: { token_id: token.id, expires_at: expiresAt },
    });
    return { tokenId: token.id, token: issued.token, expiresAt, endpoint: deps.agentEndpoint };
  });
}

export async function revokeAgent(deps: AgentDeps, ctx: Context, agentId: string): Promise<AgentView> {
  const who = member(ctx);
  await demand(deps, ctx, 'agent.manage');
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const agent = await agentRepo.findById(db, agentId);
    if (agent === undefined) throw new AppError('not_found', 'no such agent', { code: 'agent.unknown' });
    if (agent.status === 'revoked') return viewOfAgent(agent);
    const at = new Date().toISOString();
    const revoked = (await agentRepo.update(db, agentId, { status: 'revoked', revokedAt: at, revokedBy: who.membershipId }))!;
    await servicePrincipalRepo.update(db, agent.servicePrincipalId, { revokedAt: at });
    await recordConnectEvent(db, {
      organisationId: who.organisationId, correlationId: ctx.correlationId, event: 'agent_revoked', membershipId: who.membershipId,
      resourceType: 'agent', resourceId: agentId, detail: { pool_id: agent.poolId },
    });
    return viewOfAgent(revoked);
  });
}

/** A version a pool may be pinned at or approved for: received by the cell, and no older than its agents run. */
async function usableVersion(db: Queryable, pool: AgentPool, version: string): Promise<void> {
  if (await agentReleaseRepo.findByVersion(db, version) === undefined) {
    throw new AppError('conflict', 'this cell has not received that agent version from Fleet', { code: 'agent.version_unknown' });
  }
  const ahead = (await agentRepo.forPools(db, [pool.id])).filter((a) => a.status !== 'revoked' && isNewer(a.version, version));
  if (ahead.length > 0) {
    throw new AppError('conflict', 'agents update forwards only: some of the pool\'s agents run a later version', {
      code: 'agent.version_older', details: { agents: ahead.length },
    });
  }
}

async function lockedPool(db: Queryable, poolId: string): Promise<AgentPool> {
  const pool = await agentPoolRepo.lock(db, poolId);
  if (pool === undefined) throw new AppError('not_found', 'no such pool', { code: 'agent.pool_unknown' });
  if (pool.status !== 'active') throw new AppError('conflict', 'a retired pool takes no updates', { code: 'agent.pool_retired' });
  return pool;
}

export async function setAgentPoolUpdatePolicy(deps: AgentDeps, ctx: Context, poolId: string,
  body: { policy: 'automatic' } | { policy: 'pinned'; version: string } | { policy: 'approval' }): Promise<PoolView> {
  const who = member(ctx);
  await demand(deps, ctx, 'agent.manage');
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const pool = await lockedPool(db, poolId);
    const pinned = body.policy === 'pinned' ? body.version : null;
    let updated = pool;
    if (pool.updatePolicy !== body.policy || pool.pinnedVersion !== pinned) {
      if (pinned !== null) await usableVersion(db, pool, pinned);
      updated = (await agentPoolRepo.update(db, poolId, { updatePolicy: body.policy, pinnedVersion: pinned }))!;
      await recordConnectEvent(db, {
        organisationId: who.organisationId, correlationId: ctx.correlationId, event: 'agent_update_policy_set', membershipId: who.membershipId,
        resourceType: 'agent_pool', resourceId: poolId, detail: { policy: body.policy, ...(pinned === null ? {} : { version: pinned }) },
      });
    }
    return viewOfPool(updated, await agentRepo.forPools(db, [poolId]));
  });
}

export async function approveAgentPoolUpdate(deps: AgentDeps, ctx: Context, poolId: string, version: string): Promise<PoolView> {
  const who = member(ctx);
  await demand(deps, ctx, 'agent.manage');
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const pool = await lockedPool(db, poolId);
    if (pool.updatePolicy !== 'approval') {
      throw new AppError('conflict', 'the pool does not wait for approval: set its policy to approval first', { code: 'agent.pool_not_approval' });
    }
    let updated = pool;
    if (pool.approvedVersion !== version) {
      await usableVersion(db, pool, version);
      updated = (await agentPoolRepo.update(db, poolId, { approvedVersion: version, approvedBy: who.membershipId, approvedAt: new Date().toISOString() }))!;
      await recordConnectEvent(db, {
        organisationId: who.organisationId, correlationId: ctx.correlationId, event: 'agent_update_approved', membershipId: who.membershipId,
        resourceType: 'agent_pool', resourceId: poolId, detail: { version },
      });
    }
    return viewOfPool(updated, await agentRepo.forPools(db, [poolId]));
  });
}

export async function listAgentReleases(deps: AgentDeps, ctx: Context): Promise<ReleasesView> {
  await demand(deps, ctx, 'agent.view');
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const releases = await agentReleaseRepo.list(db);
    const [rollout] = await agentRolloutRepo.list(db, 1);
    const floor = outdatedFloor(releases.map((r) => r.version));
    return {
      releases: releases.map((r) => ({
        releaseId: r.releaseId, version: r.version, installedAt: iso(r.installedAt),
        platforms: (r.binaries as { platform: string }[]).map((b) => b.platform),
      })),
      rollout: rollout === undefined ? null : {
        version: rollout.version, status: rollout.status, wave: rollout.wave, waveStartedAt: iso(rollout.waveStartedAt),
        startedAt: iso(rollout.startedAt), endedAt: isoOrNull(rollout.endedAt), haltReason: rollout.haltReason,
      },
      outdatedBelow: floor === undefined ? null : `${floor.major}.${floor.minor}.0`,
    };
  }, { readOnly: true });
}
