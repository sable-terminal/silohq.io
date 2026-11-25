import { randomBytes, randomUUID } from 'node:crypto';
import { withTransaction, withoutTenant } from '../infra/db.infra';
import { runUntenanted, runWithTenant } from '../utils/tenantContext.util';
import { hashToken } from '../utils/hash.util';
import { invalid, notFound, refusal, unauthenticated } from '../utils/error.util';
import { childLogger } from '../config/logger.config';
import type { AgentHooks, FrameSocket } from '../engine/relay/agent.relay';
import type { AllowedHost } from '../engine/relay/frame.relay';
import { agentRelay } from './agentRoute.service';
import * as agentRepo from '../repos/agent.repo';
import * as connectorRepo from '../repos/connector.repo';
import * as agentTap from './agentTap.service';
import * as audit from './audit.service';
import { assertCan, authorityOf } from './authorisation.service';
import type { Actor } from './scope.service';

const log = childLogger('agent');

/**
 * Agents: installing one, what it may reach, and the channel it holds open.
 *
 * ── AN ENROLMENT TOKEN IS SHOWN ONCE AND LASTS A DAY ─────────────────────
 *
 * The admin creates an agent and is given a token to paste into the machine
 * that will run it. The agent exchanges it — with the public half of a keypair
 * it made itself — for its own long-lived token, and the enrolment token is
 * gone. Silo never holds the agent's private key and never shows its token
 * again.
 *
 * ── CONFIRMING HOSTS IS THE ADMIN'S ACT, PER CONNECTION ──────────────────
 *
 * A connector says `via: { agent: true }` and names no address. When an admin
 * assigns a connection to an agent they confirm exactly which hosts and ports
 * it may contact for that connection; the relay checks every job against that
 * list before it is sent, and the agent checks it again against its own.
 */

const ENROLMENT_HOURS = 24;
const tenantOf = (actor: Actor) => ({ organisationId: actor.organisationId, membershipId: actor.membershipId });

/* ── The relay's hooks ──────────────────────────────────────────────────── */

const inOrganisation = <T>(organisationId: string, fn: Parameters<typeof withTransaction<T>>[0]) =>
  runWithTenant({ organisationId, membershipId: null }, () => withTransaction(fn));

const hooks: AgentHooks = {
  hosts: (agentId, organisationId) => inOrganisation(organisationId, (db) => agentRepo.hostsForAgent(db, agentId)),
  seen: (agentId, organisationId, hello) => inOrganisation(organisationId, (db) => agentRepo.noteSeen(db, agentId, hello)),
  taps: (agentId, organisationId, agentKey) => agentTap.tapsFor(agentId, organisationId, agentKey),
  tapped: async (agentId, organisationId, frame) => {
    await agentTap.receiveTapped(agentId, organisationId, frame.connectionId, frame.messages);
  },
  tapFailed: async (agentId, organisationId, connectionId, message) => {
    log.warn({ agentId, organisationId, connectionId, message }, 'An agent could not open a tap');
  },
};

agentRelay().useHooks(hooks);

/* ── Administering ──────────────────────────────────────────────────────── */

export interface AgentView extends agentRepo.StoredAgent {
  connected: boolean;
}

const view = async (agent: agentRepo.StoredAgent): Promise<AgentView> => ({
  ...agent,
  connected: agent.revokedAt === null && (agentRelay().holds(agent.id) || (await agentRelay().bus.presence(agent.id)) !== null),
});

export async function create(actor: Actor, name: string): Promise<{ agent: AgentView; enrolmentToken: string; expiresAt: Date }> {
  const enrolmentToken = `silo_enrol_${randomBytes(24).toString('base64url')}`;
  const expiresAt = new Date(Date.now() + ENROLMENT_HOURS * 3_600_000);
  const agent = await runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      assertCan(await authorityOf(db, actor.membershipId, actor.organisationId), 'agent.manage');
      const created = await agentRepo.create(db, {
        id: randomUUID(),
        organisationId: actor.organisationId,
        name: name.trim(),
        enrolmentHash: hashToken(enrolmentToken),
        enrolmentExpiresAt: expiresAt,
        createdBy: actor.membershipId,
      });
      await audit.log(db, { event: 'agent_created', organisationId: actor.organisationId, membershipId: actor.membershipId, userId: null, detail: { agentId: created.id, name: created.name } });
      return created;
    }),
  );
  return { agent: await view(agent), enrolmentToken, expiresAt };
}

export async function list(actor: Actor): Promise<AgentView[]> {
  const agents = await runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      assertCan(await authorityOf(db, actor.membershipId, actor.organisationId), 'agent.manage');
      return agentRepo.list(db);
    }),
  );
  return Promise.all(agents.map(view));
}

export async function revoke(actor: Actor, agentId: string): Promise<void> {
  await runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      assertCan(await authorityOf(db, actor.membershipId, actor.organisationId), 'agent.manage');
      if (!(await agentRepo.revoke(db, agentId, actor.membershipId))) {
        throw notFound({ message: 'There is no such agent, or it is already revoked.', code: 'missing.agent' });
      }
      await audit.log(db, { event: 'agent_revoked', organisationId: actor.organisationId, membershipId: actor.membershipId, userId: null, detail: { agentId } });
    }),
  );
  /* Whichever instance holds its socket closes it now, not at the next reconnect. */
  await agentRelay().control(agentId, 'revoke');
}

/** `host`, `*.suffix`; a port, a range, or every port. */
export interface ConfirmedHost {
  host: string;
  ports: number | [number, number] | 'any';
}

/**
 * Route a connection through an agent, and confirm what it may reach — or
 * take it off the agent. Replaces whatever was confirmed before.
 */
export async function assign(actor: Actor, connectionId: string, input: { agentId: string | null; hosts: ConfirmedHost[] }): Promise<AllowedHost[]> {
  const hosts = await runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      assertCan(await authorityOf(db, actor.membershipId, actor.organisationId), 'agent.manage');
      const [connection] = await connectorRepo.load(db, [connectionId]);
      if (!connection) throw notFound({ message: 'That connection does not exist.', code: 'missing.connection' });
      if (input.agentId) {
        const via = 'via' in connection.manifest.transport ? connection.manifest.transport.via : undefined;
        if (!via?.agent) {
          throw refusal({ message: `${connection.name} is reached from Silo, not through an agent. Its connector would need to say so.`, code: 'refusal.not_agent_routed' });
        }
        const agent = await agentRepo.find(db, input.agentId);
        if (!agent || agent.revokedAt) throw notFound({ message: 'There is no such agent.', code: 'missing.agent' });
        if (input.hosts.length === 0) {
          throw invalid({ message: 'Confirm at least one host this connection may reach through the agent.', code: 'invalid.no_hosts' });
        }
      }
      await agentRepo.assign(db, {
        organisationId: actor.organisationId,
        connectionId,
        agentId: input.agentId,
        confirmedBy: actor.membershipId,
        hosts: input.hosts.map((h) => ({
          id: randomUUID(),
          host: h.host,
          portFrom: h.ports === 'any' ? 1 : Array.isArray(h.ports) ? h.ports[0] : h.ports,
          portTo: h.ports === 'any' ? 65_535 : Array.isArray(h.ports) ? h.ports[1] : h.ports,
        })),
      });
      await audit.log(db, {
        event: 'agent_hosts_confirmed',
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        detail: { connectionId, agentId: input.agentId, hosts: input.hosts },
      });
      return input.agentId ? agentRepo.hostsForConnection(db, connectionId, input.agentId) : [];
    }),
  );
  if (input.agentId) await agentRelay().control(input.agentId, 'hosts');
  return hosts;
}

/** Which agent a connection goes through, and what the admin confirmed it may reach. */
export async function routeOf(actor: Actor, connectionId: string): Promise<{ agentId: string | null; hosts: AllowedHost[] }> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      assertCan(await authorityOf(db, actor.membershipId, actor.organisationId), 'agent.manage');
      const agentId = await agentRepo.agentOf(db, connectionId);
      return { agentId, hosts: agentId ? await agentRepo.hostsForConnection(db, connectionId, agentId) : [] };
    }),
  );
}

/* ── The agent's own calls ──────────────────────────────────────────────── */

/**
 * An enrolment token, exchanged once for the agent's own token.
 *
 * UNTENANTED: the token is what says which organisation this is. The same
 * answer for an unknown token as for a used or expired one.
 */
export async function enrol(input: { enrolmentToken: string; publicKey: string; version: string; hostname: string }): Promise<{ agentId: string; token: string; name: string }> {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(input.publicKey)) {
    throw invalid({ message: 'An agent public key is 32 bytes, base64.', code: 'invalid.agent_key' });
  }
  const token = `silo_agent_${randomBytes(32).toString('base64url')}`;
  const enrolled = await runUntenanted('login-lookup', () =>
    withoutTenant((db) =>
      agentRepo.enrol(db, {
        enrolmentHash: hashToken(input.enrolmentToken),
        tokenHash: hashToken(token),
        lastFour: token.slice(-4),
        publicKey: input.publicKey,
        version: input.version,
        hostname: input.hostname,
      }),
    ),
  );
  if (!enrolled) throw unauthenticated({ message: 'That enrolment token is not valid. Create the agent again for a new one.', code: 'unauthenticated.enrolment' });
  await inOrganisation(enrolled.organisationId, (db) =>
    audit.log(db, { event: 'agent_enrolled', organisationId: enrolled.organisationId, membershipId: null, userId: null, detail: { agentId: enrolled.id, hostname: input.hostname.slice(0, 255), version: input.version.slice(0, 64) } }),
  );
  return { agentId: enrolled.id, token, name: enrolled.name };
}

/** Who a channel's bearer token belongs to. Untenanted, by hash, like a session. */
export async function authenticate(token: string): Promise<{ id: string; organisationId: string; publicKey: string }> {
  const agent = token.startsWith('silo_agent_')
    ? await runUntenanted('login-lookup', () => withoutTenant((db) => agentRepo.byToken(db, hashToken(token))))
    : null;
  if (!agent) throw unauthenticated({ message: 'That agent token is not valid.', code: 'unauthenticated.agent' });
  return { id: agent.id, organisationId: agent.organisationId, publicKey: agent.publicKey };
}

/** A socket whose token checked out, handed to this process's relay. */
export async function attach(agent: { id: string; organisationId: string; publicKey: string }, socket: FrameSocket): Promise<void> {
  await agentRelay().attach(agent, socket);
  log.info({ agentId: agent.id, organisationId: agent.organisationId }, 'Agent connected');
}
