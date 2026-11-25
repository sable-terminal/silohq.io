import { hostname as machineName } from 'node:os';
import type { KeyObject } from 'node:crypto';
import WebSocket from 'ws';
import { isAppError } from '../../utils/error.util';
import { sendHttp, type HttpWire } from '../../infra/network.infra';
import { transportFor } from '../transports/index.transport';
import { openTap, type Tap, type TapWire, type Tapped } from '../transports/tap.transport';
import type { SocketAuth } from '../transports/contract.transport';
import { Assembler, partsOf, type AgentFrame, type Job, type Outcome, type SiloFrame } from './frame.relay';
import { Guard, JobRefused } from './guard.relay';
import { keyPair, open, seal } from './seal.relay';

/**
 * The agent's end of the channel: dial out, wait for jobs, run them, answer.
 *
 * ── THE AGENT IS THE TRANSPORT PACKAGE WITH ONLY `send` WIRED ────────────
 *
 * A job arrives as the wire request Silo prepared — auth already placed — and
 * runs through the same `send` Silo would have called, with `inAgent` set so
 * private addresses are allowed and this agent's guard decides instead. There
 * is one implementation of each protocol, not two.
 *
 * ── IT NEVER WRITES WHAT IT CARRIES ───────────────────────────────────────
 *
 * A job is opened in memory, run, and dropped. The credential in it lives for
 * the length of the job. Nothing is logged but that a job ran and how it ended.
 */

export interface AgentConfig {
  silo: string;
  token: string;
  privateKey: KeyObject;
  guard: Guard;
  version: string;
  /** An `http.Agent` for the channel — a corporate proxy's tunnel — when there is one. */
  channelAgent?: import('node:http').Agent;
  log?: (event: string, detail?: Record<string, unknown>) => void;
}

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
const PING_MS = 30_000;
/** Tapped messages are forwarded in batches of at most this many, or every second. */
const TAP_BATCH = 200;

async function run(job: Job, guard: Guard, signal: AbortSignal): Promise<Outcome> {
  try {
    guard.check(job);
    const response = await guard.within(job.connectionId, () =>
      job.kind === 'http'
        ? sendHttp(job.wire as unknown as HttpWire, { tls: job.options.socket.tls, timeoutMs: job.options.timeoutMs, maxBytes: job.options.maxBytes, retry: false, allowPrivate: true, signal })
        : transportFor(job.kind).send(job.wire, { ...job.options, inAgent: true, signal }),
    );
    return { ok: true, response: { ...response, body: response.body.toString('base64') } };
  } catch (error) {
    if (error instanceof JobRefused) throw error;
    if (isAppError(error)) return { ok: false, error: { kind: error.kind, code: error.code, message: error.message, detail: error.detail } };
    /* A refusal from the socket guard surfaces wrapped by whatever driver hit it. */
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof JobRefused) throw cause;
    if (error instanceof Error && error.name === 'JobRefused') throw error;
    return { ok: false, error: { kind: 'upstream', code: 'upstream.unreachable', message: error instanceof Error ? error.message.slice(0, 500) : 'The agent could not reach the system.' } };
  }
}

export class AgentClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private readonly jobs = new Assembler();
  private readonly tapParts = new Assembler();
  private readonly running = new Map<string, AbortController>();
  private readonly taps = new Map<string, Tap>();
  private readonly tapBuffers = new Map<string, Tapped[]>();
  private pinger: NodeJS.Timeout | null = null;
  private flusher: NodeJS.Timeout | null = null;

  constructor(private readonly config: AgentConfig) {}

  private log(event: string, detail?: Record<string, unknown>): void {
    this.config.log?.(event, detail);
  }

  start(): void {
    this.stopped = false;
    this.connect();
    this.flusher = setInterval(() => this.flushTaps(), 1_000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pinger) clearInterval(this.pinger);
    if (this.flusher) clearInterval(this.flusher);
    for (const controller of this.running.values()) controller.abort();
    for (const tap of this.taps.values()) await tap.close().catch(() => {});
    this.taps.clear();
    this.ws?.close(1000, 'The agent is stopping.');
  }

  private send(frame: AgentFrame): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  private connect(): void {
    const url = `${this.config.silo.replace(/^http/, 'ws').replace(/\/+$/, '')}/api/agents/channel`;
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${this.config.token}` },
      maxPayload: 2 * 1024 * 1024,
      handshakeTimeout: 15_000,
      ...(this.config.channelAgent ? { agent: this.config.channelAgent } : {}),
    });
    this.ws = ws;
    ws.on('open', () => {
      this.attempt = 0;
      this.log('connected', { silo: this.config.silo });
      this.send({ type: 'hello', version: this.config.version, hostname: machineName() });
      this.pinger = setInterval(() => this.send({ type: 'ping' }), PING_MS);
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let frame: SiloFrame;
      try {
        frame = JSON.parse(data.toString()) as SiloFrame;
      } catch {
        return;
      }
      void this.receive(frame);
    });
    ws.on('unexpected-response', (_req, res) => {
      this.log('refused', { status: res.statusCode });
      if (res.statusCode === 401) {
        /* A revoked or unknown token will not start working by retrying. */
        this.stopped = true;
        this.log('token_rejected');
      }
    });
    ws.on('error', (error) => this.log('channel_error', { message: error.message }));
    ws.on('close', (code) => {
      if (this.pinger) clearInterval(this.pinger);
      for (const controller of this.running.values()) controller.abort();
      this.running.clear();
      if (code === 4001) this.log('revoked_or_replaced');
      if (this.stopped) return;
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** this.attempt++) * (0.8 + Math.random() * 0.4);
      setTimeout(() => this.connect(), delay).unref();
    });
  }

  private async receive(frame: SiloFrame): Promise<void> {
    switch (frame.type) {
      case 'welcome':
        this.config.guard.useSiloHosts(frame.hosts);
        this.log('welcome', { hosts: frame.hosts.length });
        return;
      case 'hosts':
        this.config.guard.useSiloHosts(frame.hosts);
        return;
      case 'pong':
        return;
      case 'cancel':
        this.running.get(frame.id)?.abort();
        return;
      case 'job': {
        let sealed: Buffer | null;
        try {
          sealed = this.jobs.add(frame.id, frame);
        } catch {
          this.send({ type: 'failed', id: frame.id, kind: 'too_large', message: 'A job the agent could not reassemble.' });
          return;
        }
        if (sealed) await this.runJob(frame.id, sealed);
        return;
      }
      case 'tap': {
        const sealed = this.tapParts.add(`tap:${frame.connectionId}`, frame);
        if (sealed) await this.openTap(frame.connectionId, sealed);
        return;
      }
      case 'untap':
        await this.taps.get(frame.connectionId)?.close();
        this.taps.delete(frame.connectionId);
        return;
    }
  }

  private async runJob(id: string, sealed: Buffer): Promise<void> {
    let job: Job;
    try {
      job = JSON.parse(open(this.config.privateKey, sealed, id).toString('utf8')) as Job;
      if (job.id !== id) throw new Error('mismatched');
    } catch {
      this.send({ type: 'failed', id, kind: 'unsupported', message: 'The agent could not open this job. It may have been sealed to another agent.' });
      return;
    }
    const controller = new AbortController();
    this.running.set(id, controller);
    const started = Date.now();
    try {
      const outcome = await run(job, this.config.guard, controller.signal);
      const result = seal(job.replyTo, Buffer.from(JSON.stringify(outcome)), id);
      for (const part of partsOf(result)) this.send({ type: 'result', id, ...part });
      this.log('job', { kind: job.kind, connectionId: job.connectionId, ok: outcome.ok, ms: Date.now() - started });
    } catch (error) {
      const refused = error instanceof JobRefused ? error : null;
      this.send({ type: 'failed', id, kind: refused?.kind ?? 'network', message: (error instanceof Error ? error.message : 'The job failed.').slice(0, 500) });
      this.log('job_refused', { kind: job.kind, connectionId: job.connectionId, reason: refused?.kind ?? 'error' });
    } finally {
      this.running.delete(id);
    }
  }

  private async openTap(connectionId: string, sealed: Buffer): Promise<void> {
    try {
      const config = JSON.parse(open(this.config.privateKey, sealed, `tap:${connectionId}`).toString('utf8')) as { wire: TapWire; socket: SocketAuth };
      const url = new URL(config.wire.url);
      const port = Number(url.port || (config.wire.protocol === 'amqp' ? (url.protocol === 'amqps:' ? 5671 : 5672) : url.protocol === 'mqtts:' ? 8883 : 1883));
      this.config.guard.check({ kind: 'queue_tap', connectionId, wire: { kind: 'queue_tap', host: url.hostname, port } as never });
      await this.taps.get(connectionId)?.close();
      const tap = await this.config.guard.within(connectionId, () =>
        openTap(config.wire, config.socket, async (message) => {
          const buffer = this.tapBuffers.get(connectionId) ?? [];
          buffer.push(message);
          this.tapBuffers.set(connectionId, buffer);
          if (buffer.length >= TAP_BATCH) this.flushTaps();
        }),
      );
      this.taps.set(connectionId, tap);
      this.log('tap_open', { connectionId });
    } catch (error) {
      this.send({ type: 'tap_failed', connectionId, message: (error instanceof Error ? error.message : 'The tap could not be opened.').slice(0, 500) });
    }
  }

  private flushTaps(): void {
    for (const [connectionId, buffer] of this.tapBuffers) {
      if (buffer.length === 0) continue;
      this.tapBuffers.set(connectionId, []);
      for (let i = 0; i < buffer.length; i += TAP_BATCH) this.send({ type: 'tapped', connectionId, messages: buffer.slice(i, i + TAP_BATCH) });
    }
  }
}

/**
 * Exchange a one-time enrolment token for this agent's own, with a keypair
 * made here. The private key never leaves the machine.
 */
export async function enrol(input: { silo: string; enrolmentToken: string; version: string }): Promise<{ agentId: string; token: string; name: string; privateKey: KeyObject }> {
  const keys = keyPair();
  const response = await fetch(`${input.silo.replace(/\/+$/, '')}/api/agents/enrol`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enrolmentToken: input.enrolmentToken, publicKey: keys.publicKey, version: input.version, hostname: machineName() }),
  });
  const body = (await response.json().catch(() => ({}))) as { agentId?: string; token?: string; name?: string; error?: { message?: string } };
  if (!response.ok || !body.agentId || !body.token) {
    throw new Error(body.error?.message ?? `Silo answered ${response.status} to the enrolment.`);
  }
  return { agentId: body.agentId, token: body.token, name: body.name ?? '', privateKey: keys.privateKey };
}
