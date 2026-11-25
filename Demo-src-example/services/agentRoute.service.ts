import { withTransaction } from '../infra/db.infra';
import { relayBus } from '../infra/relayBus.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { refusal } from '../utils/error.util';
import type { HttpWire } from '../infra/network.infra';
import { Relay } from '../engine/relay/agent.relay';
import type { AllowedHost } from '../engine/relay/frame.relay';
import { permitted, targetsOf } from '../engine/relay/targets.relay';
import type { ReadContext } from '../engine/read/context.read';
import type { SocketAuth, WireRequest, WireResponse } from '../engine/transports/contract.transport';
import * as agentRepo from '../repos/agent.repo';

/**
 * The relay this process uses, and what a read needs to send through an agent.
 *
 * APART FROM `agent.service` SO A READ CAN REACH IT. The runtime that opens a
 * connection needs the relay; the agent service needs the tap service, which
 * needs the runtime. Keeping the relay and the route lookup here is what keeps
 * that a line rather than a circle.
 */

let relay: Relay | null = null;

export function agentRelay(): Relay {
  relay ??= new Relay(relayBus());
  return relay;
}

/**
 * The agent a connection goes through, its key, and the hosts the admin
 * confirmed. Loaded once per use of a connection. Null when none is assigned
 * or the agent is revoked.
 */
export async function routeFor(organisationId: string, connectionId: string): Promise<{ agentId: string; agentKey: string; hosts: AllowedHost[] } | null> {
  return runWithTenant({ organisationId, membershipId: null }, () =>
    withTransaction(async (db) => {
      const agentId = await agentRepo.agentOf(db, connectionId);
      if (!agentId) return null;
      const agentKey = await agentRepo.publicKeyOf(db, agentId);
      if (!agentKey) return null;
      return { agentId, agentKey, hosts: await agentRepo.hostsForConnection(db, connectionId, agentId) };
    }),
  );
}

/**
 * How a read on an agent-routed connection sends.
 *
 * SILO CHECKS FIRST. Every host the wire would open must be on the list the
 * admin confirmed for this connection before a job is sealed; the agent checks
 * again against its own. A request the runner routed to Silo itself — a
 * presigned download on an unpinned host, sent with no credential — goes
 * direct, through the public-address guard, as it would anywhere.
 */
export function dispatchThrough(organisationId: string, route: { agentId: string; agentKey: string; hosts: AllowedHost[] }): ReadContext['dispatch'] {
  return async (transport, wire, options, via) => {
    if (via.via !== 'agent') return transport.send(wire, options);
    confirm(transport.kind, wire, route.hosts);
    const { signal: _signal, inAgent: _inAgent, ...rest } = options;
    return agentRelay().run({ agentId: route.agentId, organisationId, agentKey: route.agentKey, job: { kind: transport.kind, connectionId: via.connectionId, wire, options: rest } });
  };
}

/** A request auth makes for itself — a token endpoint, a session login — through the agent. */
export function httpThrough(organisationId: string, connectionId: string, route: { agentId: string; agentKey: string; hosts: AllowedHost[] }) {
  return (wire: HttpWire, socket: SocketAuth): Promise<WireResponse> => {
    confirm('http', wire, route.hosts);
    return agentRelay().run({
      agentId: route.agentId,
      organisationId,
      agentKey: route.agentKey,
      job: { kind: 'http', connectionId, wire: wire as unknown as WireRequest, options: { socket, timeoutMs: 30_000, maxBytes: 1_000_000, retry: false, mode: 'read', connectionId } },
    });
  };
}

function confirm(kind: Parameters<typeof targetsOf>[0], wire: object, hosts: AllowedHost[]): void {
  const targets = targetsOf(kind, wire);
  if (targets.length === 0) {
    throw refusal({ message: 'Silo could not tell where this request would go, so it was not sent through the agent.', code: 'refusal.agent_host_not_confirmed' });
  }
  for (const target of targets) {
    if (!permitted(target, hosts)) {
      throw refusal({
        message: `${target.host}:${target.port} is not a host an admin confirmed for this connection. Confirm it where the connection is assigned to its agent.`,
        code: 'refusal.agent_host_not_confirmed',
        detail: { host: target.host, port: target.port },
      });
    }
  }
}
