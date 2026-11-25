// The public listener: HTTPS (plain HTTP outside production), with WebSocket upgrades
// handed to the live endpoint. Separate from the service listener (src/process.ts),
// which speaks mTLS to other services and answers the orchestrator's probes: the pod
// leaves the load balancer when that listener's /readyz fails, and this one keeps
// serving through the drain.

import type { IncomingMessage, RequestListener, Server } from 'node:http';
import { createServer as createPlainServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

export interface PublicListenerOptions {
  host: string;
  port: number;
  tls: { cert: Buffer; key: Buffer } | undefined;
  handler: RequestListener;
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  requestTimeoutMs: number;
}

export interface PublicListener {
  readonly server: Server;
  readonly port: number;
  /** Stops accepting, waits up to timeoutMs for requests in flight, then closes what is left. */
  close(timeoutMs: number): Promise<boolean>;
}

export async function openPublicListener(options: PublicListenerOptions): Promise<PublicListener> {
  let inFlight = 0;
  const idle: (() => void)[] = [];
  const counted: RequestListener = (req, res) => {
    inFlight += 1;
    res.on('close', () => {
      inFlight -= 1;
      if (inFlight === 0) for (const resolve of idle.splice(0)) resolve();
    });
    options.handler(req, res);
  };
  const server: Server = options.tls
    ? createTlsServer({ cert: options.tls.cert, key: options.tls.key, minVersion: 'TLSv1.2' }, counted)
    : createPlainServer(counted);
  server.requestTimeout = options.requestTimeoutMs;
  server.headersTimeout = Math.min(options.requestTimeoutMs, 20_000);
  server.on('upgrade', options.upgrade);
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
    else socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  let closing: Promise<boolean> | undefined;
  return {
    server,
    port: (server.address() as AddressInfo).port,
    close(timeoutMs) {
      closing ??= (async () => {
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeIdleConnections();
        const inTime = inFlight === 0 ? true : await new Promise<boolean>((resolve) => {
          idle.push(() => resolve(true));
          setTimeout(() => resolve(false), timeoutMs).unref();
        });
        server.closeAllConnections();
        await closed;
        return inTime;
      })();
      return closing;
    },
  };
}
