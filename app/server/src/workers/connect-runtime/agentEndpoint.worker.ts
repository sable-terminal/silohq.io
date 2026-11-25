// The agent endpoint's listener (spec 10.2): agent.<cell>, TLS 1.3 only, HTTP/2 (HTTP/1.1
// for an agent's first call too). It asks every client for a certificate signed by the
// cell's agent CA and refuses none at the handshake: enrolment is the one call made before
// an agent has a certificate, and every other route checks the certificate itself. Behind a
// TCP pass-through load balancer, so the mutual TLS ends here.
//
// The tunnel, work and capture routes (contracts/connect-runtime/agentTunnel.contract.ts) need a
// certificate the CA signed and still valid; the agent is then known by its fingerprint
// (services/connect-runtime/agentTunnels.service.ts). So do the update routes
// (services/connect-runtime/agentUpdates.service.ts): what to do, a binary's bytes, a refusal.
//
// One log line per request: the route, the status and the outcome, never a token, a request
// body or the client address.

import { createSecureServer, type Http2ServerRequest, type Http2ServerResponse, type Http2Session } from 'node:http2';
import { createHash } from 'node:crypto';
import {
  CDC_PATH_PREFIX, captureFrame, heartbeatFrame, MAX_FRAME_BYTES, resultFrame, TUNNEL_PATH, WORK_PATH_PREFIX,
} from '../../contracts/connect-runtime/agentTunnel.contract.ts';
import type { AgentTunnels } from '../../services/connect-runtime/agentTunnels.service.ts';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import {
  AGENT_BINARY_PATH_PREFIX, AGENT_ENROL_PATH, AGENT_RENEW_PATH, AGENT_UPDATE_PATH, AGENT_UPDATE_REPORT_PATH, agentEnrolRequest, agentRenewRequest,
  agentUpdateReport,
} from '../../contracts/connect-runtime/agentEndpoint.contract.ts';
import type { AgentUpdates } from '../../services/connect-runtime/agentUpdates.service.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import type { Worker } from '../../infra/service.infra.ts';
import type { AgentCa } from '../../services/connect-runtime/agentCa.service.ts';
import { enrolAgent, renewAgent, type EnrolmentDeps } from '../../services/connect-runtime/agentEnrolment.service.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';

const MAX_BODY_BYTES = 16 * 1024;
const BINARY_PART_BYTES = 1024 * 1024;

export interface AgentEndpointOptions {
  host: string;
  port: number;
  /** The endpoint's own certificate and key, PEM. */
  tls: { cert: string; key: string };
  ca: AgentCa;
  enrolment: Omit<EnrolmentDeps, 'ca'>;
  tunnels: AgentTunnels;
  /** Updates through Fleet; absent, an agent is told there is nothing to do. */
  updates?: AgentUpdates;
  logger: Logger;
  /** Told the port once it listens (tests bind port 0). */
  onListening?: (port: number) => void;
}

async function bodyOf(req: Http2ServerRequest): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new AppError('bounds', 'the request is too large', { code: 'agent.request_too_large' });
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError('validation', 'the request is not JSON', { code: 'agent.request_invalid' });
  }
}

/** The lines of a request body, each at most MAX_FRAME_BYTES, as they arrive. */
async function* linesOf(req: Http2ServerRequest): AsyncGenerator<string> {
  let carry = '';
  for await (const chunk of req) {
    carry += (chunk as Buffer).toString('utf8');
    if (carry.length > MAX_FRAME_BYTES && !carry.includes('\n')) throw new AppError('bounds', 'a frame is too large', { code: 'agent.frame_too_large' });
    let newline = carry.indexOf('\n');
    while (newline >= 0) {
      const line = carry.slice(0, newline).trim();
      carry = carry.slice(newline + 1);
      if (line !== '') yield line;
      newline = carry.indexOf('\n');
    }
  }
  if (carry.trim() !== '') yield carry.trim();
}

const frameOf = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    throw new AppError('validation', 'a frame is not JSON', { code: 'agent.frame_invalid' });
  }
};

/** A request the client abandoned: its connection reset or its stream closed early. */
function wentAway(error: unknown): boolean {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  return code === 'ECONNRESET' || code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ERR_HTTP2_STREAM_ERROR' || message === 'aborted';
}

/** The client certificate's fingerprint, when the CA signed it and it is valid now; otherwise refused. */
function clientFingerprint(req: Http2ServerRequest): Buffer {
  const socket = req.socket as TLSSocket;
  if (socket.authorized !== true) {
    throw new AppError('unauthenticated', 'present a client certificate the agent CA issued, still valid', { code: 'agent.certificate_required' });
  }
  return createHash('sha256').update(socket.getPeerCertificate().raw).digest();
}

function reply(res: Http2ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
  res.end(text);
}

export function agentEndpoint(options: AgentEndpointOptions): Worker {
  const { logger } = options;
  const handle = async (req: Http2ServerRequest, res: Http2ServerResponse): Promise<string> => {
    const path = new URL(req.url, 'https://agent').pathname;
    if (req.method === 'GET' && path === '/healthz') {
      reply(res, 200, { ok: true });
      return 'ok';
    }
    if (req.method === 'POST' && path === TUNNEL_PATH) {
      const fingerprint = clientFingerprint(req);
      res.setHeader('content-type', 'application/x-ndjson');
      res.setHeader('cache-control', 'no-store');
      // The agent is known before anything is sent: a refusal is still an ordinary error reply.
      const tunnel = await options.tunnels.open(fingerprint, { write: (line) => res.write(line), end: () => res.end() });
      if (!res.headersSent) res.writeHead(200);
      try {
        for await (const line of linesOf(req)) {
          const parsed = heartbeatFrame.safeParse(frameOf(line));
          if (!parsed.success) throw new AppError('validation', 'the tunnel carries heartbeats up', { code: 'agent.frame_invalid' });
          await options.tunnels.heartbeat(tunnel, parsed.data);
        }
      } catch (error) {
        if (!isAppError(error) || (error.code !== 'agent.revoked' && error.code !== 'agent.certificate_replaced')) throw error;
      } finally {
        await options.tunnels.close(tunnel);
        if (!res.writableEnded) res.end();
        res.stream.close();
      }
      return 'tunnel_closed';
    }
    if (req.method === 'POST' && path.startsWith(WORK_PATH_PREFIX)) {
      const fingerprint = clientFingerprint(req);
      const workId = path.slice(WORK_PATH_PREFIX.length);
      if (!/^[0-9a-f-]{36}$/.test(workId)) throw new AppError('not_found', 'no such work', { code: 'agent.work_unknown' });
      const work = options.tunnels.attach(fingerprint, workId);
      // The cell gave up on it (a scan stopped, a caller gone): answering ends the agent's
      // request, which stops what it is doing.
      const abandon = (): void => {
        if (!res.headersSent) reply(res, 200, { received: true, abandoned: true });
        res.stream.close();
      };
      work.abandoned.addEventListener('abort', abandon, { once: true });
      try {
        for await (const line of linesOf(req)) {
          if (work.abandoned.aborted) break;
          const parsed = resultFrame.safeParse(frameOf(line));
          if (!parsed.success) {
            const field = parsed.error.issues[0]?.path.join('.').slice(0, 100) ?? '';
            logger.warn('an agent sent a malformed result frame', { event: 'agent.frame_invalid', route: '/v1/work', reason: field });
            throw new AppError('validation', 'a result frame is malformed', { code: 'agent.frame_invalid', details: { field } });
          }
          work.push(parsed.data);
        }
      } catch (error) {
        if (work.abandoned.aborted) return 'abandoned';
        work.fail(isAppError(error) ? error : new AppError('source_unreachable', 'the agent\'s answer broke off', { code: 'agent.answer_broken' }));
        throw error;
      } finally {
        work.abandoned.removeEventListener('abort', abandon);
      }
      if (work.abandoned.aborted) return 'abandoned';
      reply(res, 200, { received: true });
      return 'answered';
    }
    if (req.method === 'POST' && path.startsWith(CDC_PATH_PREFIX)) {
      const fingerprint = clientFingerprint(req);
      const slotId = path.slice(CDC_PATH_PREFIX.length);
      if (!/^[0-9a-f-]{36}$/.test(slotId)) throw new AppError('not_found', 'no such capture', { code: 'agent.capture_not_leased' });
      const capture = options.tunnels.capture(fingerprint, slotId);
      let broken = true;
      try {
        for await (const line of linesOf(req)) {
          const parsed = captureFrame.safeParse(frameOf(line));
          if (!parsed.success) {
            // Where it is malformed, never what it holds.
            const field = parsed.error.issues[0]?.path.join('.').slice(0, 100) ?? '';
            logger.warn('an agent sent a malformed capture frame', { event: 'agent.frame_invalid', route: path, reason: field });
            throw new AppError('validation', 'a capture frame is malformed', { code: 'agent.frame_invalid', details: { field } });
          }
          await capture.take(parsed.data);
        }
        broken = false;
      } catch (error) {
        // The agent going away mid-stream (its tunnel dropped, or it stopped) ends the capture, nothing more.
        if (!wentAway(error)) throw error;
        return 'capture_broken';
      } finally {
        await capture.end(broken);
      }
      reply(res, 200, { received: true });
      return 'capture_ended';
    }
    if (req.method === 'POST' && path === AGENT_RENEW_PATH) {
      const fingerprint = clientFingerprint(req);
      const parsed = agentRenewRequest.safeParse(await bodyOf(req));
      if (!parsed.success) throw new AppError('validation', 'send a signing request for the new key', { code: 'agent.request_invalid' });
      const renewed = await renewAgent({ ...options.enrolment, ca: options.ca, tunnels: options.tunnels }, fingerprint, parsed.data.csr, uuidv7(),
        parsed.data.sealingKey);
      reply(res, 201, renewed);
      return 'renewed';
    }
    if (req.method === 'GET' && path === AGENT_UPDATE_PATH) {
      const fingerprint = clientFingerprint(req);
      const offer = options.updates === undefined ? { action: 'none' as const } : await options.updates.offer(fingerprint);
      reply(res, 200, offer);
      return `update_${offer.action}`;
    }
    if (req.method === 'GET' && path.startsWith(AGENT_BINARY_PATH_PREFIX)) {
      const fingerprint = clientFingerprint(req);
      const hex = path.slice(AGENT_BINARY_PATH_PREFIX.length);
      if (!/^[0-9a-f]{64}$/.test(hex) || options.updates === undefined) throw new AppError('not_found', 'no such binary', { code: 'agent.binary_unknown' });
      const binary = await options.updates.binary(fingerprint, hex);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': binary.bytes, 'cache-control': 'no-store' });
      // In parts, each written as the agent takes it in: a slow agent holds one part in memory, not the binary.
      let gone = false;
      res.once('close', () => { gone = true; });
      for (let start = 0; start < binary.bytes && !gone; start += BINARY_PART_BYTES) {
        const part = await binary.read(start, Math.min(binary.bytes, start + BINARY_PART_BYTES) - 1);
        if (!res.write(part)) await new Promise<void>((resolve) => { res.once('drain', resolve); res.once('close', resolve); });
      }
      if (gone) return 'binary_abandoned';
      res.end();
      return 'binary_sent';
    }
    if (req.method === 'POST' && path === AGENT_UPDATE_REPORT_PATH) {
      const fingerprint = clientFingerprint(req);
      const parsed = agentUpdateReport.safeParse(await bodyOf(req));
      if (!parsed.success) throw new AppError('validation', 'name the version, what happened and why', { code: 'agent.request_invalid' });
      if (options.updates !== undefined) await options.updates.report(fingerprint, parsed.data, uuidv7());
      reply(res, 200, { received: true });
      return 'update_reported';
    }
    if (req.method === 'POST' && path === AGENT_ENROL_PATH) {
      const parsed = agentEnrolRequest.safeParse(await bodyOf(req));
      if (!parsed.success) throw new AppError('validation', 'send the token, a signing request and what the agent is', { code: 'agent.request_invalid' });
      const enrolled = await enrolAgent({ ...options.enrolment, ca: options.ca }, parsed.data, uuidv7());
      reply(res, 201, enrolled);
      return 'enrolled';
    }
    throw new AppError('not_found', 'no such route', { code: 'agent.route_unknown' });
  };

  return {
    name: 'connect-runtime.agent-endpoint',
    async run(signal) {
      const sessions = new Set<Http2Session>();
      const server = createSecureServer({
        cert: options.tls.cert, key: options.tls.key, ca: [options.ca.certificatePem],
        requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.3', allowHTTP1: true,
      }, (req, res) => {
        const started = performance.now();
        const route = new URL(req.url, 'https://agent').pathname;
        void handle(req, res).then((outcome) => outcome, (error: unknown) => {
          const known = isAppError(error);
          if (!known) logger.failure('the agent endpoint failed a request', error, { event: 'agent.endpoint_failed', route });
          const status = known ? error.httpStatus : 500;
          if (!res.headersSent) {
            reply(res, status, { error: known
              ? { category: error.category, code: error.code, message: error.message }
              : { category: 'internal', code: 'internal', message: 'the request failed' } });
          }
          return known ? error.code : 'unhandled';
        }).then((outcome) => {
          const authorised = (req.socket as TLSSocket).authorized === true;
          logger.info('agent endpoint', {
            event: 'agent.endpoint_request', route, status: res.statusCode, outcome, durationMs: Math.round(performance.now() - started),
            reason: authorised ? 'client_certificate' : 'no_client_certificate',
          });
        });
      });
      server.on('session', (session) => {
        sessions.add(session);
        session.on('close', () => sessions.delete(session));
      });
      server.listen(options.port, options.host);
      await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
      options.onListening?.((server.address() as AddressInfo).port);
      logger.info('agent endpoint listening', { event: 'agent.endpoint_started' });
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
      options.tunnels.shutdown();
      // Gracefully, then not: an agent's half-open tunnel would otherwise hold the close forever.
      for (const session of sessions) {
        session.close();
        setTimeout(() => session.destroy(), 1_000).unref();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
