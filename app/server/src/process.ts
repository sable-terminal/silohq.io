// The process that runs one or more services (docs/siloServiceCatalogue.doc.md), and its
// service listener (spec 7.1).
//
// The process opens the union of what its services need (infra/service.infra.ts), registers
// a readiness check for each, serves every route on one listener and runs every worker.
// Services sharing a process keep their own names: each calls others as itself, so
// splitting them later changes no interface.
//
// The service listener: Express, with each endpoint bound to its contract
// (contracts/endpoint.contract.ts). Every request passes, in order (src/middleware):
// 1. correlation: the caller's x-correlation-id, or a new one, echoed back;
// 2. the request's log line and its trace span;
// 3. the caller: its mTLS identity, which the contract must list (caller.middleware);
// 4. context: the identity headers the contract requires, for row-level security;
// 5. the body (JSON, bounded) and its validation against the contract's schemas;
// 6. the Idempotency-Key a keyed operation requires;
// 7. the handler, under the request timeout and once per idempotency key, and its reply
//    validated against the contract before it is sent: Zod on both sides.
// Errors leave as one body shape, with Retry-After where a refusal names a wait.
// /healthz answers while the process is alive; /readyz runs the dependency checks and
// fails while the process drains on shutdown.
//
// Health signals (spec 11.2): every contract route's answer is counted (status and latency,
// nothing it carried), with any gauge a service keeps; in a cell whose Fleet agent the process
// can reach (SERVICE_URL_FLEET_CONTROL), they are reported to it every half minute under the
// process's release, for its release gates.
//
// Shutdown, on SIGTERM or stop(): readiness fails at once; after drainSeconds the
// listener closes and in-flight requests get shutdownTimeoutMs to finish; workers are
// told to stop and awaited; then clients, buses, Redis and the databases close, in that
// order. A worker that fails stops the process, so the orchestrator restarts it rather
// than leaving half a service running.

import { readFileSync } from 'node:fs';
import { createServer as createPlainServer, type Server } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type express from 'express';
import type { HttpConfig } from './config/http.config.ts';
import type { Config } from './config/index.config.ts';
import type { RedisInstance } from './config/redis.config.ts';
import type { Environment, ServiceName } from './config/service.config.ts';
import { connectDurableBus, connectLiveBus } from './infra/bus.infra.ts';
import { Health } from './infra/health.infra.ts';
import type { RouteBinding } from './infra/http.infra.ts';
import { createLogger, type Logger } from './infra/logger.infra.ts';
import { openDatabases } from './infra/postgres.infra.ts';
import { connectRedis, type RedisStore } from './infra/redis.infra.ts';
import { createServiceClient } from './infra/serviceClient.infra.ts';
import type { ServiceDefinition, ServiceNeeds, Worker } from './infra/service.infra.ts';
import { createRequestSignals, type RequestSignals } from './infra/signals.infra.ts';
import { reportProcessSignals, SIGNAL_REPORTERS } from './contracts/fleet-control/signals.contract.ts';
import { hostname } from 'node:os';
import { recordRedactionViolation, type Telemetry } from './infra/telemetry.infra.ts';
import { jsonBody } from './middleware/body.middleware.ts';
import { refuseBranchReference } from './middleware/branch.middleware.ts';
import { callerIdentity, requestContext } from './middleware/caller.middleware.ts';
import { deadline } from './middleware/deadline.middleware.ts';
import { dispatch } from './middleware/dispatch.middleware.ts';
import { errorHandler, notFound } from './middleware/errors.middleware.ts';
import { idempotencyKey } from './middleware/idempotency.middleware.ts';
import { correlation, createApp, requestLog } from './middleware/request.middleware.ts';
import { traceSpan } from './middleware/trace.middleware.ts';
import { shedUnderLoad } from './middleware/shed.middleware.ts';
import { processLoad } from './infra/load.infra.ts';
import { validateRequest } from './middleware/validate.middleware.ts';
import { AppError } from './utils/errors.util.ts';
import { sleep } from './utils/time.util.ts';

// ----------------------------------------------------------------------------- the service listener

export interface HttpServerOptions {
  /** The services this process hosts; every route must belong to one. */
  services: readonly ServiceName[];
  cellId: string;
  environment: Environment;
  http: HttpConfig;
  logger: Logger;
  health: Health;
  routes: readonly RouteBinding[];
  /** redis-data, for keyed operations. Required when any route is keyed. */
  idempotency?: RedisStore;
  /** Where each route's answer is counted. */
  signals?: RequestSignals;
}

export interface HttpServer {
  readonly server: Server;
  readonly app: express.Express;
  listen(): Promise<{ port: number }>;
  /** Readiness fails from now on, so the load balancer stops sending new requests. */
  drain(): void;
  /**
   * Stops accepting connections and waits up to timeoutMs for requests in flight, then
   * closes whatever is left. Resolves true when every request finished in time.
   */
  close(timeoutMs: number): Promise<boolean>;
}

export function createHttpServer(options: HttpServerOptions): HttpServer {
  const { http, logger } = options;
  const load = processLoad({ startMs: http.shedStartMs, stepMs: http.shedStepMs });
  const tls = http.tlsCertFile !== undefined;
  if (!tls && options.environment === 'production') {
    throw new AppError('configuration', 'production services use mTLS (spec 7.1)', { code: 'config.http.tls' });
  }
  for (const binding of options.routes) {
    if (!options.services.includes(binding.contract.service)) {
      throw new AppError('configuration', `${binding.contract.id} belongs to a service this process does not host`, {
        code: 'config.http.route',
      });
    }
    if (binding.contract.idempotency === 'keyed' && options.idempotency === undefined) {
      throw new AppError('configuration', `${binding.contract.id} is keyed, so the process needs redis-data`, { code: 'config.http.idempotency' });
    }
  }

  const app = createApp();
  let draining = false;
  let inFlight = 0;
  const idle: (() => void)[] = [];
  const settle = (): void => {
    inFlight -= 1;
    if (inFlight === 0) for (const resolve of idle.splice(0)) resolve();
  };

  app.use((_req, res, next) => {
    inFlight += 1;
    res.on('close', settle);
    if (draining) res.setHeader('connection', 'close');
    next();
  });
  app.use(correlation({ trustCaller: true }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/readyz', async (_req, res) => {
    if (draining) {
      res.status(503).json({ ok: false, draining: true });
      return;
    }
    const readiness = await options.health.readiness();
    res.status(readiness.ok ? 200 : 503).json({
      ok: readiness.ok,
      checks: readiness.checks.map((c) => ({ name: c.name, ok: c.ok, ...(c.errorCategory ? { errorCategory: c.errorCategory } : {}) })),
    });
  });

  for (const binding of options.routes) {
    const { contract } = binding;
    const method = contract.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
    const timed = contract.timeoutMs === undefined;
    app[method](contract.path,
      (_req, res, next) => {
        const started = performance.now();
        res.on('finish', () => options.signals?.record(res.statusCode, performance.now() - started, timed));
        next();
      },
      requestLog(logger, { id: contract.id, method: contract.method, event: 'http.request', message: 'request' }),
      traceSpan(contract.id),
      callerIdentity(contract, { tls, cellId: options.cellId }),
      requestContext(contract),
      // Under load, the work's class is refused before its body is read (12.4).
      shedUnderLoad(contract, load),
      jsonBody(Math.min(contract.maxBodyBytes ?? http.maxBodyBytes, http.maxBodyBytes), {
        fallback: { code: 'request.unreadable', message: 'the request body could not be read' },
      }),
      refuseBranchReference(contract),
      validateRequest(contract),
      idempotencyKey(contract),
      // The listener's timeout, or the operation's declared bound where it is longer (a plan run, a scenario run).
      deadline(contract.id, Math.max(http.requestTimeoutMs, contract.timeoutMs ?? 0)),
      dispatch(binding, options.idempotency));
  }

  app.use(notFound(), errorHandler({ logger, audience: 'service', event: 'http.failed', message: 'request failed' }));

  const server = tls
    ? createTlsServer({
      key: readFileSync(http.tlsKeyFile!), cert: readFileSync(http.tlsCertFile!), ca: readFileSync(http.tlsCaFile!),
      // Health probes cannot present a client certificate, so the handshake admits any
      // client and every contract route refuses one that is not authorised.
      requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.3',
    }, app)
    : createPlainServer(app);
  server.requestTimeout = http.requestTimeoutMs + 5_000;

  return {
    server,
    app,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(http.port, http.host, () => {
        server.off('error', reject);
        resolve({ port: (server.address() as AddressInfo).port });
      });
    }),
    drain: () => {
      draining = true;
    },
    close: async (timeoutMs) => {
      draining = true;
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      const finished = inFlight === 0 ? Promise.resolve(true) : new Promise<boolean>((resolve) => {
        idle.push(() => resolve(true));
        setTimeout(() => resolve(false), timeoutMs).unref();
      });
      const inTime = await finished;
      server.closeAllConnections();
      await closed;
      return inTime;
    },
  };
}

// ----------------------------------------------------------------------------- the process

export interface RunningProcess {
  readonly port: number;
  /** Shuts down as on SIGTERM. Resolves true when everything stopped in time. */
  stop(reason?: string): Promise<boolean>;
  /** Settles when the process has stopped, by stop(), a signal or a failed worker. */
  readonly stopped: Promise<boolean>;
}

export interface RunOptions {
  logger?: Logger;
  telemetry?: Telemetry;
  /** Stop on SIGTERM and SIGINT, and exit when stopped. For the real entry point only. */
  handleSignals?: boolean;
  /** How often health signals go to the cell's Fleet agent; half a minute by default. */
  signalsReportMs?: number;
}

export async function runProcess(definitions: readonly ServiceDefinition[], config: Config, options: RunOptions = {}): Promise<RunningProcess> {
  const names = definitions.map((d) => d.name);
  const missing = config.hosted.filter((s) => !names.includes(s));
  const extra = names.filter((s) => !config.hosted.includes(s));
  if (missing.length > 0 || extra.length > 0 || new Set(names).size !== names.length) {
    throw new AppError('configuration', 'the services defined must be exactly those this process hosts (SILO_SERVICES)', {
      code: 'config.process.services', details: { missing: missing.join(','), extra: extra.join(',') },
    });
  }
  const signals = createRequestSignals();
  const logger = options.logger ?? createLogger({
    service: config.service, cell: config.cell.id, release: config.release, level: config.telemetry.logLevel,
    // The metric that pages (13.2), and, where the line named an organisation, its count in the signals for its audit log (D209).
    onViolation: (kinds, organisationId) => {
      recordRedactionViolation(kinds);
      if (organisationId !== undefined) signals.redaction(organisationId, kinds);
    },
  });
  const health = new Health();
  const startedAt = new Date().toISOString();
  const needsOf = (d: ServiceDefinition): ServiceNeeds => (typeof d.needs === 'function' ? d.needs(config) : d.needs);
  const union = <T>(pick: (needs: ServiceNeeds) => readonly T[] | undefined): T[] =>
    [...new Set(definitions.flatMap((d) => [...(pick(needsOf(d)) ?? [])]))];

  const opened: { close(): Promise<unknown> }[] = [];
  const closeAll = async (): Promise<void> => {
    for (const resource of opened.reverse()) await resource.close().catch(() => undefined);
  };

  try {
    const databases = openDatabases(config.postgres, config.service, union((n) => n.postgres), { logger });
    opened.push({ close: () => databases.close(config.http.shutdownTimeoutMs) });
    for (const check of databases.healthChecks()) health.register(check);

    const redis: Partial<Record<RedisInstance, RedisStore>> = {};
    for (const instance of union((n) => n.redis)) {
      const store = await connectRedis(instance, config.redis, { logger });
      redis[instance] = store;
      opened.push({ close: () => store.close() });
      health.register({ name: `redis.${instance}`, check: () => store.ping() });
    }

    const buses = union((n) => n.bus);
    const liveBus = buses.includes('live') ? await connectLiveBus(config.bus, config.service) : undefined;
    if (liveBus) opened.push({ close: () => liveBus.close() });
    const durableBus = buses.includes('durable') ? await connectDurableBus(config.bus, config.service) : undefined;
    if (durableBus) opened.push({ close: () => durableBus.close() });

    const routes: RouteBinding[] = [];
    const workers: Worker[] = [];
    for (const definition of definitions) {
      const services = createServiceClient({ caller: definition.name, cell: config.cell.id, http: config.http });
      opened.push({ close: async () => services.close() });
      const parts = await definition.create({
        config, logger: logger.child({ resourceType: definition.name }), databases, redis, liveBus, durableBus, services, signals,
      });
      routes.push(...parts.routes);
      workers.push(...(parts.workers ?? []));
      if (parts.close) opened.push({ close: parts.close });
    }

    const server = createHttpServer({
      services: config.hosted, cellId: config.cell.id, environment: config.environment, http: config.http, logger, health, routes, signals,
      ...(redis.data ? { idempotency: redis.data } : {}),
    });
    // In a cell, the Fleet agent gates releases on these (spec 11.2); the global tier and the agent itself report nothing.
    const reporter = config.hosted.find((s) => (SIGNAL_REPORTERS as readonly string[]).includes(s));
    if (config.http.serviceUrls['fleet-control'] !== undefined && reporter !== undefined && config.hosted.every((s) => SIGNAL_REPORTERS.includes(s))) {
      const client = createServiceClient({ caller: reporter, cell: config.cell.id, http: config.http });
      opened.push({ close: async () => client.close() });
      workers.push(signalsWorker({
        report: async () => {
          const now = await signals.snapshot();
          await client.call(reportProcessSignals, {
            params: { processId: (process.env['HOSTNAME'] ?? hostname()).toLowerCase().replace(/[^a-z0-9.-]/g, '-').slice(0, 253) },
            body: { services: [...config.hosted], release: config.release, startedAt, reportedAt: new Date().toISOString(), ...now },
          }, { timeoutMs: 10_000 });
        },
        intervalMs: options.signalsReportMs ?? 30_000, logger,
      }));
    }
    const { port } = await server.listen();

    const workersStop = new AbortController();
    let resolveStopped!: (clean: boolean) => void;
    const stopped = new Promise<boolean>((resolve) => { resolveStopped = resolve; });
    let stopping: Promise<boolean> | undefined;

    const stop = (reason = 'requested'): Promise<boolean> => {
      stopping ??= (async () => {
        logger.info('stopping', { event: 'process.stopping', reason });
        server.drain();
        if (config.http.drainSeconds > 0) await sleep(config.http.drainSeconds * 1000);
        const requestsDone = await server.close(config.http.shutdownTimeoutMs);
        workersStop.abort(new AppError('unavailable', 'the process is stopping', { code: 'process.stopping' }));
        const workersDone = await Promise.race([
          Promise.allSettled(running).then(() => true),
          sleep(config.http.shutdownTimeoutMs).then(() => false),
        ]);
        await closeAll();
        await options.telemetry?.shutdown().catch(() => undefined);
        const clean = requestsDone && workersDone && reason !== 'worker_failed';
        logger.info('stopped', { event: 'process.stopped', reason, outcome: clean ? 'clean' : 'forced' });
        resolveStopped(clean);
        return clean;
      })();
      return stopping;
    };

    const running = workers.map((worker) => worker.run(workersStop.signal).catch((error: unknown) => {
      if (workersStop.signal.aborted) return;
      logger.failure('a worker failed; stopping the process', error, { event: 'worker.failed', reason: worker.name });
      void stop('worker_failed');
    }));

    if (options.handleSignals) {
      for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        process.once(signal, () => {
          void stop(signal).then((clean) => process.exit(clean ? 0 : 1));
        });
      }
      void stopped.then((clean) => process.exit(clean ? 0 : 1));
    }

    logger.info('started', { event: 'process.started', count: definitions.length });
    return { port, stop, stopped };
  } catch (error) {
    await closeAll();
    throw error;
  }
}

/** Reports the process's health signals to the cell's Fleet agent; a failed report is logged, never fatal. */
function signalsWorker(options: { report: () => Promise<void>; intervalMs: number; logger: Logger }): Worker {
  return {
    name: 'process.signals',
    async run(signal) {
      while (!signal.aborted) {
        await options.report().catch((error: unknown) => {
          options.logger.failure('health signals could not be reported to the Fleet agent', error, { event: 'process.signals_unreported' });
        });
        await sleep(options.intervalMs, signal).catch(() => undefined);
      }
    },
  };
}
