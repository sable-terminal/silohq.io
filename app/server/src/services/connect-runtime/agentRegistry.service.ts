// Which connect-runtime replica holds each agent's tunnel (spec 10.3, 7.3; redis-data
// tun:{org}:<agentId>). Every cell runs at least three replicas, and the agent endpoint's load
// balancer sends each agent's tunnel to one of them. So that "work goes to the least-loaded
// healthy agent" of a pool wherever its tunnel is, each replica writes, with every heartbeat
// of an agent it holds, where to relay that agent's work, its pool, its health and its load.
// The entry lives 30 seconds: a replica that dies stops refreshing, and its agents fall out
// of the choice. A replica without a relay address writes nothing, and only relays.

import { tunnelKeys } from '../../infra/keyspaces.infra.ts';
import type { RedisStore } from '../../infra/redis.infra.ts';

/** An agent as its replica last described it. */
export interface RegisteredAgent {
  agentId: string;
  poolId: string;
  replicaId: string;
  relayUrl: string;
  healthy: boolean;
  activeCalls: number;
  tunnelId: string;
}

/** What a replica says about an agent it holds. */
export interface HeldAgent {
  agentId: string;
  organisationId: string;
  poolId: string;
  tunnelId: string;
  version: string;
  connectedAt: number;
  lastHeartbeat: number;
  healthy: boolean;
  activeCalls: number;
}

export interface RegistryDeps {
  store: RedisStore;
  /** This replica, as it names itself in the registry. */
  replicaId: string;
  /** This replica's own address on the service listener; absent, it publishes nothing. */
  relayUrl?: string | undefined;
}

export function createAgentRegistry(deps: RegistryDeps) {
  const key = (organisationId: string, agentId: string) => tunnelKeys.key(organisationId, { agentId });

  return {
    replicaId: deps.replicaId,

    /** Says where this agent's work may be relayed, refreshing the entry's 30 seconds. */
    async publish(agent: HeldAgent): Promise<void> {
      if (deps.relayUrl === undefined) return;
      await deps.store.putHash(tunnelKeys, key(agent.organisationId, agent.agentId), {
        connectRuntimePod: deps.replicaId, tunnelId: agent.tunnelId, agentVersion: agent.version,
        connectedAt: new Date(agent.connectedAt).toISOString(), lastHeartbeatAt: new Date(agent.lastHeartbeat).toISOString(),
        poolId: agent.poolId, relayUrl: deps.relayUrl, healthy: agent.healthy, activeCalls: agent.activeCalls,
      });
    },

    /** The tunnel closed: its entry goes, unless the agent has meanwhile opened another, here or elsewhere. */
    async withdraw(agent: Pick<HeldAgent, 'organisationId' | 'agentId' | 'tunnelId'>): Promise<void> {
      if (deps.relayUrl === undefined) return;
      const k = key(agent.organisationId, agent.agentId);
      const current = await deps.store.readHash(tunnelKeys, k);
      if (current?.connectRuntimePod === deps.replicaId && current.tunnelId === agent.tunnelId) await deps.store.remove(tunnelKeys, k);
    },

    /** These agents of a pool as other replicas hold them: healthy ones, still refreshed. */
    async elsewhere(organisationId: string, poolId: string, agentIds: readonly string[]): Promise<RegisteredAgent[]> {
      const entries = await Promise.all(agentIds.map(async (agentId) => ({ agentId, entry: await deps.store.readHash(tunnelKeys, key(organisationId, agentId)) })));
      return entries.flatMap(({ agentId, entry }) => (entry !== undefined && entry.poolId === poolId && entry.healthy
        && entry.connectRuntimePod !== deps.replicaId
        ? [{ agentId, poolId, replicaId: entry.connectRuntimePod, relayUrl: entry.relayUrl, healthy: true, activeCalls: entry.activeCalls, tunnelId: entry.tunnelId }]
        : []));
    },
  };
}

export type AgentRegistry = ReturnType<typeof createAgentRegistry>;
