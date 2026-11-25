// conformance (catalogue: conformance; spec 17.1, 17.2): runs the suite against a connection
// through connect-runtime and records the run in connect.conformance_runs.
//
// Who may run it: the connection's owner, or a holder of connector.verify (authorising) at
// its owning scope, decided by the policy service. A run is on the connection's current
// manifest version; one runs at a time per connection.
//
// A run is started, answered at once (202) and continued in this process. Each read is a
// probe (the connection need not be active) at the declared pushdown, so a failing operator
// is retested rather than hidden. When it ends, the results and counts are written with
// completed_at, and the run's audit events go to the outbox. A run whose process died
// stays without a completion; the next start or read for that connection closes it as
// abandoned after STALE_MS. Abandoned runs verify nothing.
//
// The change-stream class (streamClass.service; decision 2026-11-15) runs the same way, one
// object and one test record per run, on an active connection: it makes that object's stream
// subscribable or not. It verifies nothing for reads.

import { runStreamClass, type StreamClassInput, type StreamClassTiming } from './streamClass.service.ts';
import { readObject } from '../../contracts/connect-runtime/read.contract.ts';
import {
  gateOf, SUITE_VERSION, type ConformanceRunView, type ConformanceTest, type RunnableClass,
} from '../../contracts/conformance/conformance.contract.ts';
import { manifestSchema, type Manifest } from '../../contracts/connect/manifest.contract.ts';
import { authorise } from '../../contracts/policy/decision.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import type { ConformanceRun } from '../../models/connect/conformanceRun.model.ts';
import type { Connection } from '../../models/connect/connection.model.ts';
import { conformanceRunRepo, connectionRepo, connectorManifestRepo, connectorRepo } from '../../repos/connect/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { recordConnectEvent } from '../connect-registry/connectEvents.service.ts';
import type { Row } from '../connect-runtime/engine.service.ts';
import { runSuite, type Reader } from './suite.service.ts';

export interface ConformanceDeps {
  databases: Databases;
  services: ServiceClient;
  logger: Logger;
  /** A run with no completion this long after it started is closed as abandoned. */
  staleMs?: number;
  /** Per read: the runtime's wall time plus a margin. */
  readTimeoutMs?: number;
  /** The change-stream class's waits for a change to arrive. */
  stream?: StreamClassTiming;
}

type Context = Pick<HandlerContext, 'request' | 'correlationId'> & { caller?: HandlerContext['caller'] };

/**
 * connector-maintenance runs the weekly re-check and the self-heal sandbox on its own (spec
 * 17.3), with no person: it alone may start a weekly or self_heal run, and read it, without a
 * membership. Its runs are recorded with the service as the actor.
 */
const maintenanceActs = (ctx: Context): boolean =>
  ctx.caller === 'connector-maintenance' && ctx.request.membershipId === undefined && ctx.request.servicePrincipalId === undefined;

/** A Silo's store is Silo's own (66.5): there is no customer system to probe. */
const siloStore = (): AppError => new AppError('validation', 'a Silo is Silo\'s own store: conformance runs against customer systems', { code: 'conformance.silo_store' });

const STALE_MS = 30 * 60_000;
const READ_TIMEOUT_MS = 75_000;
/** Failed tests named one by one in the audit trail; the rest are counted. */
const FAILED_EVENTS = 20;

const ABANDONED: ConformanceTest = {
  id: 'suite.completed', class: 'read', object: null, outcome: 'failed', durationMs: 0, reason: 'abandoned', operator: null,
};

function viewOf(run: ConformanceRun): ConformanceRunView {
  const tests = (Array.isArray(run.results) ? run.results : []) as ConformanceTest[];
  const abandoned = tests.some((t) => t.id === ABANDONED.id && t.reason === 'abandoned');
  return {
    id: run.id, connectionId: run.connectionId, manifestId: run.manifestId, suiteVersion: run.suiteVersion, trigger: run.trigger,
    route: run.route, classesRun: run.classesRun, status: run.completedAt === null ? 'running' : abandoned ? 'abandoned' : 'completed',
    passedCount: run.passedCount, failedCount: run.failedCount, notApplicableCount: tests.filter((t) => t.outcome === 'not_applicable').length,
    startedAt: run.startedAt, completedAt: run.completedAt, tests, gate: gateOf(run),
  };
}

export function createConformance(deps: ConformanceDeps) {
  const control = deps.databases.pool('control');
  const staleMs = deps.staleMs ?? STALE_MS;
  const running = new Map<string, { abort: AbortController; done: Promise<void> }>();

  const member = (ctx: Context): string => {
    if (ctx.request.membershipId === undefined) {
      throw new AppError('forbidden', 'conformance runs are started by a member', { code: 'conformance.member_required' });
    }
    return ctx.request.membershipId;
  };

  async function mayVerify(ctx: Context, connection: Connection): Promise<void> {
    if (connection.owningMembershipId === ctx.request.membershipId) return;
    const decision = await deps.services.call(authorise, {
      body: { permission: 'connector.verify', scopeId: connection.owningScopeId, resource: { type: 'connection', id: connection.id } },
    }, { request: ctx.request, correlationId: ctx.correlationId });
    if (decision.decision !== 'allow') {
      throw new AppError('forbidden', 'you do not hold connector.verify here', { code: 'connect.not_permitted', details: { permission: 'connector.verify' } });
    }
  }

  /** The principal probing a connection it drafted: connector.build where the connection is owned. */
  async function mayBuild(ctx: Context, connection: Connection): Promise<void> {
    const decision = connection.createdByServicePrincipalId !== ctx.request.servicePrincipalId ? undefined : await deps.services.call(authorise, {
      body: { permission: 'connector.build', scopeId: connection.owningScopeId, resource: { type: 'connection', id: connection.id } },
    }, { request: ctx.request, correlationId: ctx.correlationId });
    if (decision?.decision !== 'allow') {
      throw new AppError('forbidden', 'a build\'s suite is run by its builder', { code: 'connect.not_permitted', details: { permission: 'connector.build' } });
    }
  }

  async function loadConnection(ctx: Context, connectionId: string): Promise<Connection> {
    const connection = await inTransaction(control, ctx.request, (db) => connectionRepo.findById(db, connectionId), { readOnly: true });
    if (!connection) throw new AppError('not_found', 'no such connection', { code: 'connection.not_found' });
    return connection;
  }

  /** Closes runs left without a completion past the stale age; true when one is still live. */
  async function settleOpen(ctx: Context, connectionId: string): Promise<boolean> {
    return inTransaction(control, ctx.request, async (db) => {
      let live = false;
      for (const run of await conformanceRunRepo.listOpen(db, connectionId)) {
        if (running.has(run.id) || Date.now() - Date.parse(run.startedAt) < staleMs) {
          live = true;
          continue;
        }
        await conformanceRunRepo.update(db, run.id, { results: [ABANDONED] as never, failedCount: 1, completedAt: new Date().toISOString() });
      }
      return live;
    });
  }

  async function complete(ctx: Context, run: ConformanceRun, tests: ConformanceTest[], testRecordRef: string | null = null): Promise<void> {
    const passed = tests.filter((t) => t.outcome === 'passed').length;
    const failed = tests.filter((t) => t.outcome === 'failed');
    await inTransaction(control, ctx.request, async (db) => {
      await conformanceRunRepo.update(db, run.id, {
        results: tests as never, passedCount: passed, failedCount: failed.length, completedAt: new Date().toISOString(),
        ...(testRecordRef === null ? {} : { testRecordRef }),
      });
      const event = { organisationId: run.organisationId, correlationId: ctx.correlationId, membershipId: ctx.request.membershipId, service: 'conformance' as const };
      await recordConnectEvent(db, {
        ...event, event: 'conformance_run_completed', resourceType: 'conformance_run', resourceId: run.id,
        detail: {
          connection_id: run.connectionId, passed, failed: failed.length,
          not_applicable: tests.filter((t) => t.outcome === 'not_applicable').length, verified: gateOf({ ...run, results: tests, completedAt: 'x' }).verified,
        },
      });
      for (const test of failed.slice(0, FAILED_EVENTS)) {
        await recordConnectEvent(db, {
          ...event, event: 'conformance_test_failed', resourceType: 'conformance_run', resourceId: run.id,
          detail: { test: test.id.slice(0, 200), class: test.class, reason: (test.reason ?? 'failed').slice(0, 200) },
        });
      }
    });
  }

  /** Runs the work after the reply and records it, or records the run abandoned. */
  function executeWith(ctx: Context, run: ConformanceRun, abort: AbortController,
    work: () => Promise<{ tests: ConformanceTest[]; testRecordRef?: string | null }>): void {
    const done = (async () => {
      let tests: ConformanceTest[];
      let testRecordRef: string | null = null;
      try {
        const out = await work();
        tests = abort.signal.aborted ? [ABANDONED] : out.tests;
        testRecordRef = out.testRecordRef ?? null;
      } catch (error) {
        deps.logger.failure('a conformance run stopped', error, { event: 'conformance.run_failed', resourceId: run.id });
        tests = [ABANDONED];
      }
      try {
        await complete(ctx, run, tests, testRecordRef);
      } catch (error) {
        deps.logger.failure('recording a conformance run failed; it will be closed as abandoned', error, {
          event: 'conformance.record_failed', resourceId: run.id,
        });
      }
    })().finally(() => running.delete(run.id));
    running.set(run.id, { abort, done });
  }

  function execute(ctx: Context, run: ConformanceRun, manifest: Manifest, classes: readonly RunnableClass[], sandboxed: boolean): void {
    const abort = new AbortController();
    const read: Reader = async (step, options = {}) => {
      const out = await deps.services.call(readObject, {
        body: {
          connectionId: run.connectionId, reason: 'probe', step, declaredPushdown: true, ...options,
          ...(sandboxed ? { manifestId: run.manifestId } : {}),
        },
      }, { request: ctx.request, correlationId: ctx.correlationId, signal: abort.signal, timeoutMs: deps.readTimeoutMs ?? READ_TIMEOUT_MS });
      return { rows: out.rows as Row[], stats: out.stats };
    };
    executeWith(ctx, run, abort, async () => ({ tests: await runSuite(manifest, classes, read, abort.signal) }));
  }

  return {
    async start(ctx: Context, input: {
      connectionId: string; classes: RunnableClass[]; trigger: 'build' | 'weekly' | 'self_heal' | 'manual'; manifestId?: string | undefined;
    })
      : Promise<ConformanceRunView> {
      const asService = maintenanceActs(ctx) && (input.trigger === 'weekly' || input.trigger === 'self_heal');
      // An AI FDE's Integration principal runs a build's suite as the builder's probe does (51.4), under connector.build.
      const asBuilder = input.trigger === 'build' && ctx.request.membershipId === undefined && ctx.request.servicePrincipalId !== undefined;
      const membershipId = asService || asBuilder ? undefined : member(ctx);
      if (input.manifestId !== undefined && (ctx.caller !== 'connector-maintenance' || input.trigger !== 'self_heal')) {
        throw new AppError('forbidden', 'only connector-maintenance tests a repair before it is applied', { code: 'conformance.sandbox_refused' });
      }
      const connection = await loadConnection(ctx, input.connectionId);
      if (asBuilder) await mayBuild(ctx, connection);
      else if (!asService) await mayVerify(ctx, connection);
      // A halted connection's repair is tested before it is applied (spec 17.3); the halted version is not.
      const sandbox = input.manifestId !== undefined && input.manifestId !== connection.manifestId;
      if (connection.status === 'revoked' || (connection.status === 'halted' && !sandbox) || connection.status === 'draft') {
        throw new AppError('conflict', `a ${connection.status} connection is not tested; ${connection.status === 'draft' ? 'probe it first' : 'it serves nothing'}`, {
          code: 'conformance.connection_not_testable', details: { status: connection.status },
        });
      }
      if (await settleOpen(ctx, connection.id)) {
        throw new AppError('conflict', 'a conformance run is already in progress for this connection', { code: 'conformance.run_in_progress', retryAfterSeconds: 30 });
      }
      const { manifest, run } = await inTransaction(control, ctx.request, async (db) => {
        const manifestRow = await connectorManifestRepo.findById(db, input.manifestId ?? connection.manifestId);
        if (manifestRow !== undefined && manifestRow.connectorId !== connection.connectorId) {
          throw new AppError('validation', 'a sandbox run tests a version of the connection\'s own connector', { code: 'conformance.sandbox_manifest_foreign' });
        }
        const connector = await connectorRepo.findById(db, connection.connectorId);
        if (!manifestRow || !connector) throw new AppError('integrity', 'the connection names a missing connector or manifest', { code: 'connection.manifest_missing' });
        if (connector.sourceRoute === 'silo') throw siloStore();
        const row = await conformanceRunRepo.insert(db, {
          id: uuidv7(), organisationId: connection.organisationId, connectionId: connection.id, manifestId: manifestRow.id,
          suiteVersion: SUITE_VERSION, trigger: input.trigger, route: connector.sourceRoute, classesRun: input.classes, results: [],
        });
        await recordConnectEvent(db, {
          organisationId: connection.organisationId, correlationId: ctx.correlationId, membershipId, service: 'conformance',
          event: 'conformance_run_started', resourceType: 'conformance_run', resourceId: row.id,
          detail: { connection_id: connection.id, manifest_id: manifestRow.id, classes: input.classes.join(','), trigger: input.trigger },
        });
        return { manifest: manifestSchema.parse(manifestRow.document), run: row };
      });
      execute({ request: { ...ctx.request }, correlationId: ctx.correlationId }, run, manifest, input.classes, run.manifestId !== connection.manifestId);
      return viewOf(run);
    },

    /** The change-stream class on one streamed object (decision 2026-11-15). */
    async startStreamClass(ctx: Context, connectionId: string, input: StreamClassInput): Promise<ConformanceRunView> {
      const membershipId = member(ctx);
      const connection = await loadConnection(ctx, connectionId);
      await mayVerify(ctx, connection);
      if (connection.status !== 'active') {
        throw new AppError('conflict', 'a stream is tested on an active connection', { code: 'conformance.connection_not_active', details: { status: connection.status } });
      }
      if (await settleOpen(ctx, connection.id)) {
        throw new AppError('conflict', 'a conformance run is already in progress for this connection', { code: 'conformance.run_in_progress', retryAfterSeconds: 30 });
      }
      const { object, run } = await inTransaction(control, ctx.request, async (db) => {
        const manifestRow = await connectorManifestRepo.findById(db, connection.manifestId);
        const connector = await connectorRepo.findById(db, connection.connectorId);
        if (!manifestRow || !connector) throw new AppError('integrity', 'the connection names a missing connector or manifest', { code: 'connection.manifest_missing' });
        if (connector.sourceRoute === 'silo') throw siloStore();
        const manifest = manifestSchema.parse(manifestRow.document);
        const object = manifest.objects.find((o) => o.name === input.object);
        if (object === undefined) throw new AppError('validation', 'the connector has no such object', { code: 'step.object_unknown' });
        if (!manifest.changeStream?.objects.some((o) => o.object === input.object)) {
          throw new AppError('validation', `the connector does not stream ${input.object}`, { code: 'stream.not_declared' });
        }
        const row = await conformanceRunRepo.insert(db, {
          id: uuidv7(), organisationId: connection.organisationId, connectionId: connection.id, manifestId: manifestRow.id,
          suiteVersion: SUITE_VERSION, trigger: 'manual', route: connector.sourceRoute, classesRun: ['change_stream'], results: [],
        });
        await recordConnectEvent(db, {
          organisationId: connection.organisationId, correlationId: ctx.correlationId, membershipId, service: 'conformance',
          event: 'conformance_run_started', resourceType: 'conformance_run', resourceId: row.id,
          detail: { connection_id: connection.id, manifest_id: manifestRow.id, classes: 'change_stream', trigger: 'manual' },
        });
        return { object, run: row };
      });
      const abort = new AbortController();
      const runCtx = { request: { ...ctx.request }, correlationId: ctx.correlationId };
      executeWith(runCtx, run, abort, () => runStreamClass(deps.services, { ...runCtx, signal: abort.signal }, connection.id, object, input,
        deps.stream ?? { waitMs: 120_000, pollMs: 2_000 }));
      return viewOf(run);
    },

    async get(ctx: Context, runId: string): Promise<ConformanceRunView> {
      const run = await inTransaction(control, ctx.request, (db) => conformanceRunRepo.findById(db, runId), { readOnly: true });
      if (!run) throw new AppError('not_found', 'no such conformance run', { code: 'conformance.run_not_found' });
      if (!maintenanceActs(ctx)) {
        const connection = await loadConnection(ctx, run.connectionId);
        // The AI FDE principal that drafted the connection reads its build's runs (51.4).
        if (ctx.request.membershipId === undefined && ctx.request.servicePrincipalId !== undefined) await mayBuild(ctx, connection);
        else await mayVerify(ctx, connection);
      }
      if (run.completedAt === null) await settleOpen(ctx, run.connectionId);
      const fresh = await inTransaction(control, ctx.request, (db) => conformanceRunRepo.findById(db, runId), { readOnly: true });
      return viewOf(fresh!);
    },

    async list(ctx: Context, connectionId: string, limit: number): Promise<Omit<ConformanceRunView, 'tests'>[]> {
      await mayVerify(ctx, await loadConnection(ctx, connectionId));
      const runs = await inTransaction(control, ctx.request, (db) => conformanceRunRepo.listForConnection(db, connectionId, limit), { readOnly: true });
      return runs.map((run) => {
        const { tests: _tests, ...view } = viewOf(run);
        return view;
      });
    },

    /** Runs in flight stop; each is recorded as abandoned if it can still be written. */
    async close(): Promise<void> {
      for (const { abort } of running.values()) abort.abort();
      await Promise.allSettled([...running.values()].map((r) => r.done));
    },
  };
}

export type Conformance = ReturnType<typeof createConformance>;
