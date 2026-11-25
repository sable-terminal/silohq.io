import { randomUUID } from 'node:crypto';
import { AppError, bounds, limited, refusal, upstream, type ErrorKind } from '../../utils/error.util';
import type { WireResponse } from '../transports/contract.transport';
import { Assembler, partsOf, type AgentFrame, type AllowedHost, type FailureKind, type Job, type Outcome, type SiloFrame } from './frame.relay';
import { keyPair, open, seal } from './seal.relay';

/**
 * Silo's end of the channel to customers' agents (MANIFEST-V2 §3.4, §9.2, §9.9).
 *
 * ── THE SOCKET LIVES ON ONE INSTANCE; ANY INSTANCE MAY ASK ────────────────
 *
 * An agent holds one WebSocket to whichever instance it reached. A read on
 * another instance seals its job to the agent's key, parks the ciphertext on
 * the bus and tells the holding instance its id; the holder hands it over the
 * socket, and the agent's answer — sealed to the instance that asked — comes
 * back the same way. When the asker holds the socket itself, nothing touches
 * the bus. Either way no instance but the asker can read the result and none at
 * all can read the job.
 *
 * ── BOUNDED PER AGENT ─────────────────────────────────────────────────────
 *
 * Four jobs run at once per agent and thirty-two may wait (§3.5); past that the
 * answer is `limited.agent_busy`, because a customer's one small VM is not a
 * place to queue a whole organisation's questions.
 */

/** Jobs an agent runs at once, and how many may wait behind them. */
const CONCURRENCY = 4;
const QUEUE = 32;
/** How long past the job's own timeout the asker waits before calling the agent lost. */
const GRACE_MS = 5_000;
/** Presence is refreshed by the agent's ping every thirty seconds. */
const PRESENCE_SECONDS = 90;

/** How instances reach each other. Redis in production; in memory for one process. */
export interface Bus {
  readonly instanceId: string;
  publish(channel: string, message: Record<string, unknown>): Promise<void>;
  subscribe(channel: string, handler: (message: Record<string, unknown>) => void): Promise<void>;
  /** Park sealed bytes for another instance to take once. */
  put(organisationId: string, key: string, bytes: Buffer): Promise<void>;
  take(organisationId: string, key: string): Promise<Buffer | null>;
  setPresence(agentId: string, instanceId: string, ttlSeconds: number): Promise<void>;
  presence(agentId: string): Promise<string | null>;
  clearPresence(agentId: string, instanceId: string): Promise<void>;
}

/** One agent's socket, as the relay needs it — whatever library upgraded it. */
export interface FrameSocket {
  send(text: string): void;
  close(code: number, reason: string): void;
  onMessage(handler: (text: string) => void): void;
  onClose(handler: () => void): void;
}

/** What the service answers for an agent: what it may reach, and what it should be tapping. */
export interface AgentHooks {
  hosts(agentId: string, organisationId: string): Promise<AllowedHost[]>;
  seen(agentId: string, organisationId: string, hello: { version?: string; hostname?: string }): Promise<void>;
  /** Tap configurations, each already sealed to the agent. */
  taps(agentId: string, organisationId: string, agentKey: string): Promise<Array<{ connectionId: string; sealed: Buffer }>>;
  tapped(agentId: string, organisationId: string, frame: Extract<AgentFrame, { type: 'tapped' }>): Promise<void>;
  tapFailed(agentId: string, organisationId: string, connectionId: string, message: string): Promise<void>;
}

interface Queued {
  id: string;
  sealed: Buffer;
  asker: string;
}

/** An agent connected to THIS instance. */
class Channel {
  private running = new Set<string>();
  private readonly waiting: Queued[] = [];
  private readonly results = new Assembler();
  private readonly askers = new Map<string, string>();
  private refresh: NodeJS.Timeout | null = null;

  constructor(
    readonly agentId: string,
    readonly organisationId: string,
    readonly agentKey: string,
    private readonly socket: FrameSocket,
    private readonly relay: Relay,
  ) {}

  send(frame: SiloFrame): void {
    this.socket.send(JSON.stringify(frame));
  }

  enqueue(job: Queued): boolean {
    if (this.running.size < CONCURRENCY) {
      this.start(job);
      return true;
    }
    if (this.waiting.length >= QUEUE) return false;
    this.waiting.push(job);
    return true;
  }

  private start(job: Queued): void {
    this.running.add(job.id);
    this.askers.set(job.id, job.asker);
    for (const part of partsOf(job.sealed)) this.send({ type: 'job', id: job.id, ...part });
  }

  private finished(id: string): string | null {
    this.running.delete(id);
    const asker = this.askers.get(id) ?? null;
    this.askers.delete(id);
    const next = this.waiting.shift();
    if (next) this.start(next);
    return asker;
  }

  cancel(id: string): void {
    const at = this.waiting.findIndex((q) => q.id === id);
    if (at >= 0) this.waiting.splice(at, 1);
    if (this.running.has(id)) this.send({ type: 'cancel', id });
  }

  async receive(frame: AgentFrame, hooks: AgentHooks): Promise<void> {
    switch (frame.type) {
      case 'ping':
        this.send({ type: 'pong' });
        await this.relay.bus.setPresence(this.agentId, this.relay.bus.instanceId, PRESENCE_SECONDS);
        await hooks.seen(this.agentId, this.organisationId, {});
        return;
      case 'hello':
        await hooks.seen(this.agentId, this.organisationId, { version: String(frame.version ?? ''), hostname: String(frame.hostname ?? '') });
        return;
      case 'result': {
        if (!this.running.has(frame.id)) return;
        const sealed = this.results.add(frame.id, frame);
        if (!sealed) return;
        const asker = this.finished(frame.id);
        if (asker) await this.relay.deliver(this.organisationId, asker, frame.id, { sealed });
        return;
      }
      case 'failed': {
        if (!this.running.has(frame.id)) return;
        this.results.forget(frame.id);
        const asker = this.finished(frame.id);
        if (asker) await this.relay.deliver(this.organisationId, asker, frame.id, { failed: { kind: frame.kind, message: String(frame.message ?? '').slice(0, 500) } });
        return;
      }
      case 'tapped':
        await hooks.tapped(this.agentId, this.organisationId, frame);
        return;
      case 'tap_failed':
        await hooks.tapFailed(this.agentId, this.organisationId, frame.connectionId, String(frame.message ?? '').slice(0, 500));
        return;
    }
  }

  async opened(hooks: AgentHooks): Promise<void> {
    this.send({ type: 'welcome', agentId: this.agentId, hosts: await hooks.hosts(this.agentId, this.organisationId), instanceKey: this.relay.publicKey });
    for (const tap of await hooks.taps(this.agentId, this.organisationId, this.agentKey)) {
      for (const part of partsOf(tap.sealed)) this.send({ type: 'tap', connectionId: tap.connectionId, ...part });
    }
    /* The admin may confirm or withdraw a host at any moment; the agent hears within a minute. */
    this.refresh = setInterval(() => {
      void hooks.hosts(this.agentId, this.organisationId).then((hosts) => this.send({ type: 'hosts', hosts }), () => {});
    }, 60_000);
    this.refresh.unref();
  }

  closed(): string[] {
    if (this.refresh) clearInterval(this.refresh);
    const lost = [...this.running, ...this.waiting.map((q) => q.id)];
    this.running = new Set();
    this.waiting.length = 0;
    return lost;
  }

  close(reason: string): void {
    this.socket.close(4001, reason);
  }
}

type Delivery = { sealed: Buffer } | { failed: { kind: FailureKind | 'offline'; message: string } };

const FAILURES: Record<FailureKind | 'offline', (message: string) => AppError> = {
  not_allowed: (message) => refusal({ message, code: 'refusal.agent_host_not_confirmed' }),
  blocked: (message) => refusal({ message, code: 'refusal.blocked_host' }),
  busy: (message) => limited({ message, code: 'limited.agent_busy' }),
  timeout: (message) => upstream({ message, code: 'upstream.agent_timeout' }),
  network: (message) => upstream({ message, code: 'upstream.unreachable' }),
  too_large: (message) => bounds({ message, code: 'bounds.bytes' }),
  unsupported: (message) => refusal({ message, code: 'refusal.agent_unsupported' }),
  offline: (message) => upstream({ message, code: 'upstream.agent_offline' }),
};

export class Relay {
  private readonly keys = keyPair();
  private readonly channels = new Map<string, Channel>();
  private readonly pending = new Map<string, { resolve: (d: Delivery) => void; timer: NodeJS.Timeout }>();
  private started = false;
  private hooksSet: AgentHooks | null = null;

  constructor(readonly bus: Bus) {}

  /** What the service answers for agents. Needed before an agent can attach; not to send a job. */
  useHooks(hooks: AgentHooks): void {
    this.hooksSet = hooks;
  }

  private get hooks(): AgentHooks {
    if (!this.hooksSet) throw new Error('The relay has no agent hooks: nothing installed the agent service.');
    return this.hooksSet;
  }

  get publicKey(): string {
    return this.keys.publicKey;
  }

  /** Listen for jobs other instances route here, and results that come back to this one. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.bus.subscribe(`relay:jobs:${this.bus.instanceId}`, (message) => void this.remoteJob(message));
    await this.bus.subscribe(`relay:results:${this.bus.instanceId}`, (message) => void this.remoteResult(message));
    await this.bus.subscribe('relay:control', (message) => {
      const channel = this.channels.get(String(message.agentId));
      if (!channel) return;
      if (message.action === 'revoke') channel.close('This agent was revoked.');
      if (message.action === 'hosts') void this.hooks.hosts(channel.agentId, channel.organisationId).then((hosts) => channel.send({ type: 'hosts', hosts }), () => {});
    });
  }

  /** An authenticated agent's socket, now served by this instance. */
  async attach(agent: { id: string; organisationId: string; publicKey: string }, socket: FrameSocket): Promise<void> {
    await this.start();
    this.channels.get(agent.id)?.close('Replaced by a newer connection from this agent.');
    const channel = new Channel(agent.id, agent.organisationId, agent.publicKey, socket, this);
    this.channels.set(agent.id, channel);
    socket.onMessage((text) => {
      let frame: AgentFrame;
      try {
        frame = JSON.parse(text) as AgentFrame;
      } catch {
        channel.close('A frame that is not JSON.');
        return;
      }
      void channel.receive(frame, this.hooks).catch(() => channel.close('A frame the relay could not handle.'));
    });
    socket.onClose(() => {
      if (this.channels.get(agent.id) !== channel) return;
      this.channels.delete(agent.id);
      void this.bus.clearPresence(agent.id, this.bus.instanceId);
      for (const id of channel.closed()) this.settle(id, { failed: { kind: 'offline', message: 'The agent disconnected while it was answering.' } });
    });
    await this.bus.setPresence(agent.id, this.bus.instanceId, PRESENCE_SECONDS);
    await channel.opened(this.hooks);
  }

  /** Tell whichever instance holds this agent that something changed. */
  async control(agentId: string, action: 'revoke' | 'hosts'): Promise<void> {
    await this.bus.publish('relay:control', { agentId, action });
  }

  /**
   * Run one job on an agent and return what the target answered.
   *
   * THE JOB IS SEALED HERE, before it leaves this function, to the key the
   * agent enrolled with. The credential inside it is readable by that agent
   * and nothing else on the way.
   */
  async run(input: { agentId: string; organisationId: string; agentKey: string; job: Omit<Job, 'id' | 'replyTo'> }): Promise<WireResponse> {
    await this.start();
    const id = randomUUID();
    const job: Job = { ...input.job, id, replyTo: this.keys.publicKey };
    const sealed = seal(input.agentKey, Buffer.from(JSON.stringify(job)), id);

    const delivered = new Promise<Delivery>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.channels.get(input.agentId)?.cancel(id);
        resolve({ failed: { kind: 'timeout', message: 'The agent did not answer in time.' } });
      }, input.job.options.timeoutMs + GRACE_MS);
      timer.unref();
      this.pending.set(id, { resolve, timer });
    });

    const local = this.channels.get(input.agentId);
    if (local) {
      if (!local.enqueue({ id, sealed, asker: this.bus.instanceId })) this.settle(id, { failed: { kind: 'busy', message: 'The agent is answering as many questions as it can. Try again shortly.' } });
    } else {
      const holder = await this.bus.presence(input.agentId);
      if (!holder) {
        this.settle(id, { failed: { kind: 'offline', message: 'The agent for this connection is not connected.' } });
      } else {
        await this.bus.put(input.organisationId, `relay-job-${id}`, sealed);
        await this.bus.publish(`relay:jobs:${holder}`, { id, agentId: input.agentId, organisationId: input.organisationId, asker: this.bus.instanceId });
      }
    }

    const outcome = await delivered;
    if ('failed' in outcome) throw FAILURES[outcome.failed.kind](outcome.failed.message);
    let opened: Outcome;
    try {
      opened = JSON.parse(open(this.keys.privateKey, outcome.sealed, id).toString('utf8')) as Outcome;
    } catch {
      throw upstream({ message: 'The agent sent back something this instance could not open.', code: 'upstream.agent_protocol' });
    }
    if (!opened.ok) {
      throw new AppError(opened.error.kind as ErrorKind, { message: opened.error.message, code: opened.error.code, detail: opened.error.detail });
    }
    return { ...opened.response, body: Buffer.from(opened.response.body, 'base64') };
  }

  /** A result or failure, to the instance that asked for it. */
  async deliver(organisationId: string, asker: string, id: string, delivery: Delivery): Promise<void> {
    if (asker === this.bus.instanceId) {
      this.settle(id, delivery);
      return;
    }
    if ('sealed' in delivery) {
      await this.bus.put(organisationId, `relay-result-${id}`, delivery.sealed);
      await this.bus.publish(`relay:results:${asker}`, { id, organisationId });
    } else {
      await this.bus.publish(`relay:results:${asker}`, { id, organisationId, failed: delivery.failed });
    }
  }

  private settle(id: string, delivery: Delivery): void {
    const waiting = this.pending.get(id);
    if (!waiting) return;
    clearTimeout(waiting.timer);
    this.pending.delete(id);
    waiting.resolve(delivery);
  }

  private async remoteJob(message: Record<string, unknown>): Promise<void> {
    const id = String(message.id);
    const organisationId = String(message.organisationId);
    const asker = String(message.asker);
    const channel = this.channels.get(String(message.agentId));
    const sealed = await this.bus.take(organisationId, `relay-job-${id}`);
    if (!channel || channel.organisationId !== organisationId) {
      await this.deliver(organisationId, asker, id, { failed: { kind: 'offline', message: 'The agent for this connection is not connected.' } });
      return;
    }
    if (!sealed) {
      await this.deliver(organisationId, asker, id, { failed: { kind: 'network', message: 'The job did not reach the instance holding the agent.' } });
      return;
    }
    if (!channel.enqueue({ id, sealed, asker })) {
      await this.deliver(organisationId, asker, id, { failed: { kind: 'busy', message: 'The agent is answering as many questions as it can. Try again shortly.' } });
    }
  }

  private async remoteResult(message: Record<string, unknown>): Promise<void> {
    const id = String(message.id);
    if (!this.pending.has(id)) return;
    if (message.failed && typeof message.failed === 'object') {
      const failed = message.failed as { kind: FailureKind | 'offline'; message: string };
      this.settle(id, { failed: { kind: failed.kind in FAILURES ? failed.kind : 'network', message: String(failed.message) } });
      return;
    }
    const sealed = await this.bus.take(String(message.organisationId), `relay-result-${id}`);
    this.settle(id, sealed ? { sealed } : { failed: { kind: 'network', message: 'The answer did not reach this instance.' } });
  }

  /** Whether an agent's socket is on this instance — for the console's "connected" dot. */
  holds(agentId: string): boolean {
    return this.channels.has(agentId);
  }

  disconnectAll(): void {
    for (const channel of this.channels.values()) channel.close('Silo is restarting.');
  }
}

/** One process, no Redis: every agent is on this instance by definition. */
export class LocalBus implements Bus {
  readonly instanceId = `local-${randomUUID().slice(0, 8)}`;
  private readonly handlers = new Map<string, Array<(m: Record<string, unknown>) => void>>();
  private readonly parked = new Map<string, Buffer>();
  private readonly present = new Map<string, string>();

  async publish(channel: string, message: Record<string, unknown>): Promise<void> {
    for (const handler of this.handlers.get(channel) ?? []) queueMicrotask(() => handler(message));
  }

  async subscribe(channel: string, handler: (m: Record<string, unknown>) => void): Promise<void> {
    this.handlers.set(channel, [...(this.handlers.get(channel) ?? []), handler]);
  }

  async put(organisationId: string, key: string, bytes: Buffer): Promise<void> {
    this.parked.set(`${organisationId}:${key}`, bytes);
  }

  async take(organisationId: string, key: string): Promise<Buffer | null> {
    const found = this.parked.get(`${organisationId}:${key}`) ?? null;
    this.parked.delete(`${organisationId}:${key}`);
    return found;
  }

  async setPresence(agentId: string, instanceId: string): Promise<void> {
    this.present.set(agentId, instanceId);
  }

  async presence(agentId: string): Promise<string | null> {
    return this.present.get(agentId) ?? null;
  }

  async clearPresence(agentId: string, instanceId: string): Promise<void> {
    if (this.present.get(agentId) === instanceId) this.present.delete(agentId);
  }
}
