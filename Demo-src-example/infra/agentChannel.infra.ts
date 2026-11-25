import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { childLogger } from '../config/logger.config';
import type { FrameSocket } from '../engine/relay/agent.relay';

const log = childLogger('agent-channel');

/**
 * The socket an agent holds open to Silo: `GET /api/agents/channel`, upgraded.
 *
 * ── THE AGENT DIALS OUT; NOTHING DIALS IN ─────────────────────────────────
 *
 * The customer opens no port and changes no firewall. The agent connects out
 * over TLS with its bearer token, and every job afterwards travels down the
 * socket it opened. The token is checked BEFORE the upgrade completes, so an
 * unauthenticated client never holds a WebSocket at all.
 *
 * ── DEAD SOCKETS ARE NOTICED ──────────────────────────────────────────────
 *
 * A socket through a NAT that dropped it looks open for ever. The server pings
 * every thirty seconds and terminates a socket that did not answer the last
 * one, so presence is released and a waiting job is failed instead of hanging.
 */

export const CHANNEL_PATH = '/api/agents/channel';
/** A frame part is a megabyte before base64; this leaves room for the JSON around it. */
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const HEARTBEAT_MS = 30_000;

export interface ChannelHandlers {
  authenticate(token: string): Promise<{ id: string; organisationId: string; publicKey: string }>;
  attach(agent: { id: string; organisationId: string; publicKey: string }, socket: FrameSocket): Promise<void>;
}

function frameSocket(ws: WebSocket): FrameSocket {
  return {
    send: (text) => {
      if (ws.readyState === ws.OPEN) ws.send(text);
    },
    close: (code, reason) => ws.close(code, reason.slice(0, 120)),
    onMessage: (handler) => ws.on('message', (data, isBinary) => {
      if (!isBinary) handler(data.toString());
    }),
    onClose: (handler) => ws.on('close', handler),
  };
}

function refuse(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function attachAgentChannel(server: Server, handlers: ChannelHandlers): { close(): void } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const alive = new WeakMap<WebSocket, boolean>();

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== CHANNEL_PATH) {
      refuse(socket, 404, 'Not Found');
      return;
    }
    const header = req.headers.authorization ?? '';
    const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
    if (!token) {
      refuse(socket, 401, 'Unauthorized');
      return;
    }
    handlers.authenticate(token).then(
      (agent) =>
        wss.handleUpgrade(req, socket, head, (ws) => {
          alive.set(ws, true);
          ws.on('pong', () => alive.set(ws, true));
          ws.on('error', (error) => log.warn({ err: error, agentId: agent.id }, 'Agent channel error'));
          void handlers.attach(agent, frameSocket(ws)).catch((error: unknown) => {
            log.warn({ err: error, agentId: agent.id }, 'An agent could not be attached');
            ws.close(1011, 'Silo could not attach this agent.');
          });
        }),
      () => refuse(socket, 401, 'Unauthorized'),
    );
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.close(1012, 'Silo is restarting.');
      wss.close();
    },
  };
}
