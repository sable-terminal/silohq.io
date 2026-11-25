// The agent tunnels this connect-runtime holds (spec 10.2, 10.3, 10.6, 10.7;
// contracts/connect-runtime/agentTunnel.contract.ts).
//
// - An agent is known by its client certificate's fingerprint (connect.resolve_agent), checked
//   when the tunnel opens, on every heartbeat and before every piece of work, so a revoked
//   agent gets no work and its tunnel closes at its next heartbeat at the latest (10.7). A second
//   tunnel from the same agent replaces the first.
// - Health (10.3): "Agents heartbeat every 10 seconds; three misses mark one unhealthy." The
//   sweep marks it (agent_unhealthy); its next heartbeat marks it healthy again
//   (agent_recovered). A closed tunnel leaves it offline. Heartbeats reach the database on a
//   change of health and at most once a minute otherwise.
// - Work (10.3): "Work goes to the least-loaded healthy agent", by the calls it reported plus
//   those given it since. Queries and Actions are never spooled (10.6): with no healthy agent of
//   the pool connected, work is refused at once as source unreachable. Results come only from
//   the agent the work was given to, and the work ends at its deadline.
// - One replica holds an agent's tunnel, and says so in the registry with each heartbeat
//   (agentRegistry.service). Work goes to the pool's least-loaded healthy agent wherever its
//   tunnel is: one held elsewhere gets it relayed to its replica (relayAgentWork), which gives
//   it to that agent if it still holds it. An agent no longer there, or a replica that cannot
//   be reached, passes the work to the next agent, but a write only when it cannot have
//   reached the agent: a write never runs twice.
// - Change data capture rides on the heartbeat (agentCaptures.service): leases renewed and
//   slots taken as the agent beats, given up when its tunnel closes.
// - Logins (10.7): work naming a connection's login (seal) has it sealed by the credential
//   service for the very agent and piece of work it is given to, here on the replica holding
//   the agent, so a relayed piece of work is sealed where it lands; the sealed login rides in
//   the work's payload, and connect-runtime never holds it in clear.
// - Versions (10.7, 11.4): an agent heartbeating another version than recorded has updated (or
//   gone back): recorded at once, with agent_updated. The work each agent was given, and the
//   part it failed itself (an internal error, an answer broken off), is counted for the agent
//   waves' error-rate gate. An agent refused for its age gets no work until it updates.

import type { AgentAllowlists } from './agentAllowlists.service.ts';
import { downFrame, type DownFrame, type HeartbeatFrame, type ResultFrame, type WorkKind } from '../../contracts/connect-runtime/agentTunnel.contract.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases, type RequestContext } from '../../infra/postgres.infra.ts';
import { agentRepo } from '../../repos/connect/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { recordConnectEvent } from '../connect-registry/connectEvents.service.ts';
import { isNewer } from '../connect-registry/agentVersions.service.ts';
import type { AgentCapturesService, CaptureStream } from './agentCaptures.service.ts';
import type { AgentRegistry, RegisteredAgent } from './agentRegistry.service.ts';
import { isAppError } from '../../utils/errors.util.ts';

export interface TunnelDeps {
  databases: Databases;
  logger: Logger;
  /** How often agents heartbeat (10 s); three missed mark one unhealthy. Tests shorten it. */
  heartbeatMs?: number;
  /** How often an unchanged heartbeat reaches the database (60 s). */
  flushMs?: number;
  now?: () => number;
  /** Change data capture through these tunnels, where the cell runs it. */
  captures?: AgentCapturesService;
  /** Where every replica's agents are, and how to relay work to another replica. */
  registry?: AgentRegistry;
  relay?: (target: RegisteredAgent, work: RelayedWork) => Promise<ResultFrame[]>;
  /** The signed actuation allow-lists, compared at each heartbeat (spec 47.4). */
  allowlists?: AgentAllowlists;
  /** The connection's login for one piece of work on one agent (the credential service); undefined: the agent holds it. */
  seal?: (input: SealRequest & { organisationId: string; agentId: string; workId: string }) => Promise<{ sealed: string; expiresAt: string } | undefined>;
  /** An OPC UA endpoint's application key for one piece of work on one agent (the credential service, spec 20.3). */
  sealKey?: (input: SealKeyRequest & { organisationId: string; agentId: string; workId: string }) => Promise<{ sealed: string; expiresAt: string }>;
}

/** A piece of work's OPC UA application key, sealed where the work is given to its agent. */
export interface SealKeyRequest {
  connectionId: string;
  endpointId: string;
  reason: 'query' | 'probe' | 'change_stream';
  request: RequestContext;
  correlationId: string;
}

/** A piece of work's login, sealed where the work is given to its agent. */
export interface SealRequest {
  connectionId: string;
  reason: 'connect' | 'query' | 'mutation' | 'read_back' | 'probe' | 'change_stream';
  request: RequestContext;
  correlationId: string;
}

/** Work given to one agent, relayed to the replica holding it. */
export interface RelayedWork {
  organisationId: string;
  poolId: string;
  kind: WorkKind;
  payload: Record<string, unknown>;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  /** The connection whose login the work needs (spec 10.7). */
  seal?: SealRequest | undefined;
  /** The OPC UA endpoint whose application key the work needs (spec 20.3). */
  sealKey?: SealKeyRequest | undefined;
}

/** The tunnel's downward half: the cell writes frames into it. */
export interface TunnelSink {
  write(line: string): void;
  end(): void;
}

interface Live {
  agentId: string;
  organisationId: string;
  poolId: string;
  tunnelId: string;
  connectedAt: number;
  fingerprint: string;
  sink: TunnelSink;
  load: Omit<HeartbeatFrame, 'type'> | undefined;
  lastHeartbeat: number;
  lastFlush: number;
  healthy: boolean;
  given: number;
  /** The version recorded for it; a heartbeat naming another is an update. */
  version: string;
  /** Too old to be given work (spec 10.7). */
  refused: boolean;
  /** Work ended since the last flush, and the part the agent failed. */
  workDone: number;
  workFailed: number;
}

interface Pending {
  id: string;
  agent: Live;
  push(frame: ResultFrame): void;
  fail(error: AppError): void;
  attached: boolean;
  /** Aborted when the cell gives up on the work before its end: the agent's stream is closed, and it stops. */
  abandoned: AbortController;
}

/** The frames that end a piece of work. */
const LAST_FRAMES: ReadonlySet<ResultFrame['type']> = new Set(['done', 'error', 'pong', 'end']);

const MISSES = 3;
const unreachable = (message: string, code = 'agent.unavailable'): AppError => new AppError('source_unreachable', message, { code });

export function createAgentTunnels(deps: TunnelDeps) {
  const now = deps.now ?? Date.now;
  const heartbeatMs = deps.heartbeatMs ?? 10_000;
  const flushMs = deps.flushMs ?? 60_000;
  const control = deps.databases.pool('control');
  const live = new Map<string, Live>();
  const pending = new Map<string, Pending>();

  const identify = (fingerprint: Buffer) => inTransaction(control, {}, (db) => agentRepo.resolve(db, fingerprint), { readOnly: true });
  /** Agents whose certificate this replica is renewing now: the database may already hold the new fingerprint. */
  const renewing = new Set<string>();

  /**
   * The agent as the database knows it now. A renewal on this replica racing the check is
   * followed, never taken for a replacement: the check is asked again with the new fingerprint,
   * or answered 'renewing' while the renewal has not finished.
   */
  async function verify(agent: Live): Promise<Awaited<ReturnType<typeof identify>> | 'renewing'> {
    const asked = agent.fingerprint;
    const found = await identify(Buffer.from(asked, 'hex'));
    if (found !== undefined) return found;
    if (agent.fingerprint !== asked) return identify(Buffer.from(agent.fingerprint, 'hex'));
    return renewing.has(agent.agentId) ? 'renewing' : undefined;
  }

  /** The agent's row: health, heartbeat and tunnel, its work since, and the event its health change raises. */
  async function record(agent: Live, changes: { status?: 'healthy' | 'unhealthy' | 'offline'; connected?: boolean; event?: 'agent_unhealthy' | 'agent_recovered' }) {
    const at = new Date(now()).toISOString();
    const done = agent.workDone;
    const failed = agent.workFailed;
    await inTransaction(control, { organisationId: agent.organisationId }, async (db) => {
      await agentRepo.update(db, agent.agentId, {
        ...(changes.status ? { status: changes.status } : {}),
        ...(changes.connected === true ? { tunnelConnectedAt: at } : changes.connected === false ? { tunnelConnectedAt: null } : {}),
        ...(agent.load ? { lastHeartbeatAt: new Date(agent.lastHeartbeat).toISOString(), activeCalls: agent.load.activeCalls, cdcReaders: agent.load.cdcReaders,
          discoveryDisabledLocally: agent.load.discoveryDisabled } : {}),
      });
      if (done > 0) await agentRepo.addWork(db, agent.agentId, done, failed);
      if (changes.event) {
        await recordConnectEvent(db, {
          organisationId: agent.organisationId, correlationId: uuidv7(), event: changes.event, service: 'connect-runtime',
          resourceType: 'agent', resourceId: agent.agentId, detail: { pool_id: agent.poolId },
        });
      }
    });
    agent.workDone -= done;
    agent.workFailed -= failed;
    // Only a write that carried a heartbeat counts: the first heartbeat after opening is written at once.
    if (agent.load !== undefined) agent.lastFlush = now();
  }

  /** The agent heartbeats another version than recorded: it updated, or went back (spec 10.7, 10.9). */
  async function versionChanged(agent: Live, to: string): Promise<void> {
    const from = agent.version;
    await inTransaction(control, { organisationId: agent.organisationId }, async (db) => {
      const changed = await agentRepo.changeVersion(db, agent.agentId, from, to, new Date(now()).toISOString());
      if (changed === undefined) return;
      await recordConnectEvent(db, {
        organisationId: agent.organisationId, correlationId: uuidv7(), event: 'agent_updated', service: 'connect-runtime',
        resourceType: 'agent', resourceId: agent.agentId,
        detail: { pool_id: agent.poolId, from_version: from, to_version: to, direction: isNewer(to, from) ? 'up' : 'down' },
      });
    });
    agent.version = to;
    deps.logger.info('an agent is on another version', {
      event: 'agent.updated', organisationId: agent.organisationId, resourceId: agent.agentId, outcome: to, reason: from,
    });
  }

  /** Tells the other replicas where this agent is and how loaded; a registry failure leaves them choosing without it. */
  async function publish(agent: Live): Promise<void> {
    if (deps.registry === undefined) return;
    try {
      await deps.registry.publish({
        agentId: agent.agentId, organisationId: agent.organisationId, poolId: agent.poolId, tunnelId: agent.tunnelId,
        version: agent.version.replace(/[^A-Za-z0-9_.-]/g, '_'), connectedAt: agent.connectedAt,
        // An agent refused for its age takes no work, from here or relayed.
        lastHeartbeat: agent.lastHeartbeat, healthy: agent.healthy && !agent.refused, activeCalls: (agent.load?.activeCalls ?? 0) + agent.given,
      });
    } catch (error) {
      deps.logger.failure('the agent registry was not told of a tunnel', error, { event: 'agent.registry_failed', resourceId: agent.agentId });
    }
  }

  const loadOf = (agent: Live): number => (agent.load?.activeCalls ?? 0) + agent.given;

  /** The pool's healthy agents other replicas hold; none when there is no registry or it cannot be read. */
  async function elsewhere(organisationId: string, poolId: string): Promise<RegisteredAgent[]> {
    if (deps.registry === undefined || deps.relay === undefined) return [];
    try {
      const ids = await inTransaction(control, { organisationId }, (db) => agentRepo.withTunnels(db, poolId), { readOnly: true });
      const others = ids.filter((id) => !live.has(id));
      return others.length === 0 ? [] : await deps.registry.elsewhere(organisationId, poolId, others);
    } catch (error) {
      deps.logger.failure('the agent registry could not be read; only agents held here get work', error, { event: 'agent.registry_failed' });
      return [];
    }
  }

  /** A relay that failed before the agent could have run the work, or any failure of work that may run again. */
  const passOn = (error: unknown, repeatable: boolean): boolean => {
    if (!isAppError(error)) return false;
    if (error.code === 'agent.not_here') return true;
    if (error.code !== 'service.unreachable') return false;
    const cause = (error as { cause?: { code?: unknown } }).cause;
    return repeatable || cause?.code === 'ECONNREFUSED';
  };

  function send(agent: Live, frame: DownFrame): void {
    agent.sink.write(`${JSON.stringify(downFrame.parse(frame))}\n`);
  }

  function drop(agent: Live, error: AppError): void {
    for (const work of pending.values()) if (work.agent === agent) work.fail(error);
  }

  const sweep = setInterval(() => {
    for (const agent of live.values()) {
      if (agent.healthy && now() - agent.lastHeartbeat > MISSES * heartbeatMs) {
        agent.healthy = false;
        deps.logger.warn('an agent missed three heartbeats', { event: 'agent.unhealthy', organisationId: agent.organisationId, resourceId: agent.agentId });
        void record(agent, { status: 'unhealthy', event: 'agent_unhealthy' }).catch((error: unknown) =>
          deps.logger.failure('an agent\'s health was not recorded', error, { event: 'agent.record_failed' }));
        void publish(agent);
      }
    }
  }, Math.max(50, Math.floor(heartbeatMs / 2)));
  sweep.unref();

  /** The agent refused a write's grant: audited (agent_write_grant_refused, read first, spec 10.9). */
  function refusedGrant(agent: Live, work: RelayedWork, reason: string): void {
    const connectionId = typeof work.payload['connectionId'] === 'string' ? work.payload['connectionId'] : null;
    deps.logger.warn('an agent refused a write\'s execution grant', {
      event: 'agent.write_grant_refused', organisationId: agent.organisationId, resourceId: agent.agentId, reason,
    });
    void inTransaction(control, { organisationId: agent.organisationId }, (db) => recordConnectEvent(db, {
      organisationId: agent.organisationId, correlationId: uuidv7(), event: 'agent_write_grant_refused', service: 'connect-runtime',
      resourceType: 'agent', resourceId: agent.agentId, detail: { reason, ...(connectionId === null ? {} : { connection_id: connectionId }) },
    })).catch((error: unknown) => deps.logger.failure('a refused grant was not audited', error, { event: 'agent.record_failed' }));
  }

  /**
   * agent_target_refused (not named in 10.9, read like agent_write_grant_refused): the agent
   * refused a system its host's owner does not allow (its configuration's targets), whether the
   * work came with a sealed login (login_refused, target) or was a request to send
   * (target_refused). The cell aimed the agent somewhere the customer has not opened.
   */
  async function refusedTarget(agent: Live, work: RelayedWork, via: 'login' | 'request'): Promise<void> {
    const connectionId = typeof work.payload['connectionId'] === 'string' ? work.payload['connectionId'] : null;
    deps.logger.warn('an agent refused a system its host does not allow', {
      event: 'agent.target_refused', organisationId: agent.organisationId, resourceId: agent.agentId, reason: via,
    });
    await inTransaction(control, { organisationId: agent.organisationId }, (db) => recordConnectEvent(db, {
      organisationId: agent.organisationId, correlationId: uuidv7(), event: 'agent_target_refused', service: 'connect-runtime',
      resourceType: 'agent', resourceId: agent.agentId,
      detail: { via, work: work.kind, ...(connectionId === null ? {} : { connection_id: connectionId }) },
    })).catch((error: unknown) => deps.logger.failure('a refused target was not audited', error, { event: 'agent.record_failed' }));
  }

  /** Gives work to an agent held here, checked as it is now; its result frames, in order. */
  async function* give(agent: Live, input: RelayedWork): AsyncGenerator<ResultFrame> {
    const found = await verify(agent);
    if (found === undefined || (found !== 'renewing' && found.status === 'revoked')) throw unreachable('the pool\'s agent is revoked', 'agent.revoked');
    if (found !== 'renewing') agent.refused = found.versionState === 'refused';
    if (agent.refused) throw unreachable('the agent is more than three minor releases old and refused work until it updates', 'agent.version_refused');

    const id = uuidv7();
    const queue: ResultFrame[] = [];
    let failure: AppError | undefined;
    let wake: (() => void) | undefined;
    const notify = (): void => {
      wake?.();
      wake = undefined;
    };
    const work: Pending = {
      id, agent, attached: false, abandoned: new AbortController(),
      push(frame) {
        queue.push(frame);
        notify();
      },
      fail(error) {
        failure ??= error;
        notify();
      },
    };
    pending.set(id, work);
    agent.given += 1;
    const timer = setTimeout(() => work.fail(new AppError('timeout', 'the agent did not answer in time', { code: 'agent.timeout' })), input.timeoutMs);
    const onAbort = (): void => work.fail(new AppError('timeout', 'the request was abandoned', { code: 'agent.abandoned' }));
    input.signal?.addEventListener('abort', onAbort, { once: true });
    let ended = false;
    // The agent's own failure, for the waves' error-rate gate: an internal error, or an answer that broke off.
    let agentFailed = false;
    try {
      let payload = input.payload;
      if (input.seal !== undefined) {
        if (deps.seal === undefined) throw new AppError('configuration', 'this replica cannot obtain a connection\'s login', { code: 'agent.login_unavailable' });
        const credential = await deps.seal({ ...input.seal, organisationId: agent.organisationId, agentId: agent.agentId, workId: id });
        if (credential !== undefined) payload = { ...payload, credential };
      }
      if (input.sealKey !== undefined) {
        if (deps.sealKey === undefined) throw new AppError('configuration', 'this replica cannot obtain an application key', { code: 'agent.key_unavailable' });
        payload = { ...payload, applicationKey: await deps.sealKey({ ...input.sealKey, organisationId: agent.organisationId, agentId: agent.agentId, workId: id }) };
      }
      send(agent, { type: 'work', id, kind: input.kind, deadline: new Date(now() + input.timeoutMs).toISOString(), payload });
      for (;;) {
        while (queue.length > 0) {
          const frame = queue.shift()!;
          if (frame.type === 'error' && frame.category === 'grant_refused') refusedGrant(agent, input, frame.reason ?? 'unsigned');
          if (frame.type === 'error' && frame.category === 'login_refused') {
            deps.logger.warn('an agent did not take the login sealed for its work', {
              event: 'agent.login_refused', organisationId: agent.organisationId, resourceId: agent.agentId, reason: frame.reason ?? 'sealing',
            });
            if (frame.reason === 'target') await refusedTarget(agent, input, 'login');
          }
          if (frame.type === 'error' && frame.category === 'target_refused') await refusedTarget(agent, input, 'request');
          if (frame.type === 'error' && frame.category === 'internal') agentFailed = true;
          ended = LAST_FRAMES.has(frame.type);
          yield frame;
          if (ended) return;
        }
        if (failure !== undefined) {
          if (failure.code === 'agent.answer_broken' || failure.code === 'agent.unavailable') agentFailed = true;
          throw failure;
        }
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    } finally {
      if (ended || agentFailed) {
        agent.workDone += 1;
        if (agentFailed) agent.workFailed += 1;
      }
      if (!ended) work.abandoned.abort();
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      pending.delete(id);
      agent.given -= 1;
    }
  }
  return {
    /** A tunnel opened by the agent holding this certificate; it replaces one it already had. */
    async open(fingerprint: Buffer, sink: TunnelSink): Promise<Live> {
      const found = await identify(fingerprint);
      if (found === undefined) throw new AppError('unauthenticated', 'no agent holds this certificate', { code: 'agent.unknown' });
      if (found.status === 'revoked') throw new AppError('forbidden', 'the agent is revoked', { code: 'agent.revoked' });
      const earlier = live.get(found.id);
      if (earlier !== undefined) {
        send(earlier, { type: 'close', reason: 'replaced' });
        earlier.sink.end();
        drop(earlier, unreachable('the agent reconnected; the work it held was lost'));
        await deps.captures?.closed(earlier);
      }
      const agent: Live = {
        agentId: found.id, organisationId: found.organisationId, poolId: found.poolId, tunnelId: uuidv7(), connectedAt: now(),
        fingerprint: fingerprint.toString('hex'), sink, load: undefined, lastHeartbeat: now(), lastFlush: 0, healthy: true, given: 0,
        version: found.version, refused: found.versionState === 'refused', workDone: 0, workFailed: 0,
      };
      live.set(found.id, agent);
      await record(agent, { status: 'healthy', connected: true, ...(found.status === 'unhealthy' ? { event: 'agent_recovered' as const } : {}) });
      await publish(agent);
      deps.logger.info('agent tunnel opened', { event: 'agent.tunnel_opened', organisationId: agent.organisationId, resourceId: agent.agentId });
      return agent;
    },

    /** A heartbeat on the agent's tunnel. A revoked agent's tunnel is closed. */
    async heartbeat(agent: Live, frame: HeartbeatFrame): Promise<void> {
      const { type: _type, ...load } = frame;
      agent.load = load;
      agent.lastHeartbeat = now();
      const found = await verify(agent);
      // Mid-renewal: the next heartbeat checks the new fingerprint.
      if (found === 'renewing') return;
      if (found === undefined) {
        // Its certificate was renewed through another replica: it reconnects with the new one.
        send(agent, { type: 'close', reason: 'replaced' });
        agent.sink.end();
        throw new AppError('unauthenticated', 'the agent\'s certificate was replaced', { code: 'agent.certificate_replaced' });
      }
      if (found.status === 'revoked') {
        send(agent, { type: 'close', reason: 'revoked' });
        agent.sink.end();
        throw new AppError('forbidden', 'the agent is revoked: its tunnel is closed', { code: 'agent.revoked' });
      }
      agent.refused = found.versionState === 'refused';
      if (frame.version !== agent.version) await versionChanged(agent, frame.version);
      if (!agent.healthy) {
        agent.healthy = true;
        await record(agent, { status: 'healthy', event: 'agent_recovered' });
      } else if (now() - agent.lastFlush >= flushMs) {
        await record(agent, {});
      }
      if (live.get(agent.agentId) === agent) await publish(agent);
      // An agent refused for its age reads no captures: its leases lapse to the pool's other agents.
      // The signed actuation allow-lists (47.4): what differs from what the agent holds is sent.
      if (deps.allowlists !== undefined && live.get(agent.agentId) === agent) {
        try {
          await deps.allowlists.beat(agent, (frame) => send(agent, frame), frame.allowlists ?? []);
        } catch (error) {
          deps.logger.failure('actuation allow-lists were not compared this heartbeat', error, {
            event: 'agent.allowlist_beat_failed', organisationId: agent.organisationId, resourceId: agent.agentId,
          });
        }
      }
      if (deps.captures !== undefined && live.get(agent.agentId) === agent && !agent.refused) {
        try {
          await deps.captures.beat(agent, (frame) => send(agent, frame), { reading: frame.cdcSlots ?? [], spooled: frame.cdcSpooled ?? [] });
        } catch (error) {
          deps.logger.failure('change capture leases were not kept this heartbeat', error, {
            event: 'agent.cdc_beat_failed', organisationId: agent.organisationId, resourceId: agent.agentId,
          });
        }
      }
    },

    /** The agent's tunnel closed: it is offline, and the work it held fails. */
    async close(agent: Live): Promise<void> {
      if (live.get(agent.agentId) !== agent) return;
      live.delete(agent.agentId);
      drop(agent, unreachable('the agent\'s tunnel closed before it answered'));
      // What was sent it is forgotten: its heartbeat on the next tunnel says what it holds.
      deps.allowlists?.forget(agent.agentId);
      await deps.captures?.closed(agent).catch((error: unknown) =>
        deps.logger.failure('an agent\'s capture leases were not given up; they lapse', error, { event: 'agent.cdc_release_failed' }));
      await deps.registry?.withdraw(agent).catch((error: unknown) =>
        deps.logger.failure('the agent registry still names a closed tunnel; it lapses', error, { event: 'agent.registry_failed' }));
      // A revoked agent stays revoked; any other is offline until it connects again.
      const found = await identify(Buffer.from(agent.fingerprint, 'hex'));
      // A newer tunnel of the same agent may have opened meanwhile: it is not offline then.
      if (live.has(agent.agentId)) return;
      await record(agent, found?.status === 'revoked' ? { connected: false } : { status: 'offline', connected: false });
      deps.logger.info('agent tunnel closed', { event: 'agent.tunnel_closed', organisationId: agent.organisationId, resourceId: agent.agentId });
    },

    /**
     * One piece of work, given to the least-loaded healthy agent of the pool, held here or by
     * another replica; its result frames, in order, ending with done (an error frame is yielded
     * as it is). Naming the agent gives it to that agent only, held here (a relay's end).
     */
    async *dispatch(input: RelayedWork & { agentId?: string }): AsyncGenerator<ResultFrame> {
      const here = [...live.values()]
        .filter((a) => a.organisationId === input.organisationId && a.poolId === input.poolId && a.healthy && !a.refused
          && (input.agentId === undefined || a.agentId === input.agentId))
        .sort((a, b) => loadOf(a) - loadOf(b));
      if (input.agentId !== undefined) {
        if (here[0] === undefined) throw unreachable('that agent is not connected to this replica', 'agent.not_here');
        yield* give(here[0], input);
        return;
      }
      const choices: ({ load: number; local: Live } | { load: number; remote: RegisteredAgent })[] = [
        ...here.map((local) => ({ load: loadOf(local), local })),
        ...(await elsewhere(input.organisationId, input.poolId)).map((remote) => ({ load: remote.activeCalls, remote })),
      ];
      // Least loaded first; on a tie, an agent held here saves a hop.
      choices.sort((a, b) => a.load - b.load || Number('remote' in a) - Number('remote' in b));
      if (choices.length === 0) throw unreachable('no healthy Silo Agent of the connection\'s pool is connected');
      const repeatable = input.kind !== 'sql.transaction';
      let failure: unknown;
      for (const choice of choices.slice(0, 3)) {
        if ('local' in choice) {
          yield* give(choice.local, input);
          return;
        }
        let frames: ResultFrame[];
        try {
          frames = await deps.relay!(choice.remote, input);
        } catch (error) {
          if (!passOn(error, repeatable)) throw error;
          failure = error;
          continue;
        }
        yield* frames;
        return;
      }
      throw failure ?? unreachable('no healthy Silo Agent of the connection\'s pool is connected');
    },

    /** Whether this replica holds the agent's tunnel, healthy. */
    holds(organisationId: string, agentId: string): boolean {
      const agent = live.get(agentId);
      return agent !== undefined && agent.organisationId === organisationId && agent.healthy;
    },

    /** The replica holding an agent's tunnel elsewhere, as it last said. */
    async heldElsewhere(organisationId: string, poolId: string, agentId: string): Promise<RegisteredAgent | undefined> {
      return deps.registry === undefined ? undefined : (await deps.registry.elsewhere(organisationId, poolId, [agentId]))[0];
    },

    /** Relayed work for an agent this replica holds: its frames, collected. */
    async relayed(input: RelayedWork & { agentId: string }): Promise<ResultFrame[]> {
      const frames: ResultFrame[] = [];
      for await (const frame of this.dispatch(input)) frames.push(frame);
      return frames;
    },


    /** The result stream for a piece of work: only the agent it was given to may answer, once. */
    attach(fingerprint: Buffer, workId: string): { push(frame: ResultFrame): void; fail(error: AppError): void; abandoned: AbortSignal } {
      const work = pending.get(workId);
      if (work === undefined) throw new AppError('not_found', 'no such work is waiting', { code: 'agent.work_unknown' });
      if (work.agent.fingerprint !== fingerprint.toString('hex')) {
        throw new AppError('forbidden', 'that work was given to another agent', { code: 'agent.work_not_yours' });
      }
      if (work.attached) throw new AppError('conflict', 'that work is already being answered', { code: 'agent.work_answered' });
      work.attached = true;
      return { push: (frame) => work.push(frame), fail: (error) => work.fail(error), abandoned: work.abandoned.signal };
    },

    /**
     * The agent's certificate is being renewed on this replica. Done with the new fingerprint, its
     * live tunnel is known by it until it reconnects; done without one, nothing changed.
     */
    renewing(agentId: string): { done(fingerprint?: Buffer): void } {
      renewing.add(agentId);
      return {
        done(fingerprint) {
          const agent = live.get(agentId);
          if (fingerprint !== undefined && agent !== undefined) agent.fingerprint = fingerprint.toString('hex');
          renewing.delete(agentId);
        },
      };
    },

    /** The capture stream an agent opens for a slot it was given (POST /v1/cdc/:slotId). */
    capture(fingerprint: Buffer, slotId: string): CaptureStream {
      if (deps.captures === undefined) throw new AppError('not_found', 'this cell runs no change capture', { code: 'agent.route_unknown' });
      const hex = fingerprint.toString('hex');
      const agent = [...live.values()].find((a) => a.fingerprint === hex);
      if (agent === undefined) throw new AppError('conflict', 'open the tunnel first', { code: 'agent.tunnel_required' });
      return deps.captures.open(agent, slotId, (frame) => send(agent, frame));
    },

    /** The agents this replica holds a tunnel for, for a pool. */
    connected(organisationId: string, poolId: string): { agentId: string; healthy: boolean; activeCalls: number }[] {
      return [...live.values()].filter((a) => a.organisationId === organisationId && a.poolId === poolId)
        .map((a) => ({ agentId: a.agentId, healthy: a.healthy, activeCalls: (a.load?.activeCalls ?? 0) + a.given }));
    },

    /** Every tunnel closed, for shutdown. */
    shutdown(): void {
      clearInterval(sweep);
      for (const agent of live.values()) {
        try {
          send(agent, { type: 'close', reason: 'shutting_down' });
          agent.sink.end();
        } catch {
          // already gone
        }
      }
    },
  };
}

export type AgentTunnels = ReturnType<typeof createAgentTunnels>;
export type LiveTunnel = Live;
