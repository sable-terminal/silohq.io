// The re-check (spec 17.3): a connection's version tested and observed, its drift found and
// acted on. Recorded as a probe run at stage recheck, whose findings are structure only
// (per object, the paths seen with their kinds and counts; the drift; what was done), so the
// next re-check can judge a rename against it.
//
// 1. One at a time per connection (a lock in redis-data, renewed while it runs).
// 2. The conformance suite on the version (read, pagination, filter pushdown, error), and
//    each object's structure from a live sample (connect-runtime observeObject).
// 3. The analysis (drift.service.ts). A halt (a change of meaning, a removed object, a type
//    that cannot hold its values) halts the connection first, so nothing more is served from
//    it; then the repairs are proposed, charged and, for a rename or a lost pushdown, tested
//    and applied. A rename that cannot be applied halts too: until it is, every answer
//    reading that field would be empty.
// 4. Healthy when the suite verified the version the connection runs and nothing drifted
//    that was not repaired: last_healthy_at.
//
// A person's re-check (manual) runs with their request; the weekly re-check and a runtime
// self-heal run as the service, never metered.

import { getConformanceRun, startConformanceRun, type ConformanceRunView } from '../../contracts/conformance/conformance.contract.ts';
import { observeObject } from '../../contracts/connect-runtime/observe.contract.ts';
import type { Drift, RecheckTrigger, RecheckView } from '../../contracts/connector-maintenance/maintenance.contract.ts';
import { manifestSchema, type Manifest } from '../../contracts/connect/manifest.contract.ts';
import { lockKeys } from '../../infra/keyspaces.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { Connection } from '../../models/connect/connection.model.ts';
import type { ProbeRun } from '../../models/connect/probeRun.model.ts';
import { connectionRepo, connectorManifestRepo, probeRunRepo } from '../../repos/connect/index.repo.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { sleep } from '../../utils/time.util.ts';
import { demandOn, loadConnection, type Context, type MaintenanceDeps } from './deps.service.ts';
import { analyse, type ObjectObservation, type ObjectStructure } from './drift.service.ts';
import { asService, type Heals } from './heals.service.ts';

const LOCK_TTL_SECONDS = 30;
const LOCK_RENEW_MS = 10_000;
/** Rows observed per object. */
const SAMPLE_ROWS = 50;

interface Findings {
  trigger: RecheckTrigger;
  conformanceRunId: string | null;
  verified: boolean | null;
  objects: ObjectStructure[];
  drift: Drift[];
  halted: boolean;
  healthy: boolean;
  healProposalIds: string[];
}

const codeOf = (error: unknown): string => (isAppError(error) ? error.code : 'error.unexpected');

function findingsOf(run: ProbeRun): Findings {
  const raw = (run.findings ?? {}) as Partial<Findings>;
  return {
    trigger: raw.trigger ?? 'manual', conformanceRunId: raw.conformanceRunId ?? null, verified: raw.verified ?? null,
    objects: raw.objects ?? [], drift: raw.drift ?? [], halted: raw.halted ?? false, healthy: raw.healthy ?? false,
    healProposalIds: raw.healProposalIds ?? [],
  };
}

export function recheckView(run: ProbeRun): RecheckView {
  const f = findingsOf(run);
  return {
    id: run.id, connectionId: run.connectionId, manifestId: run.manifestId, trigger: f.trigger, status: run.status,
    conformanceRunId: f.conformanceRunId, verified: f.verified,
    objects: f.objects.map((o) => ({ object: o.object, observable: o.observable, reason: o.reason, records: o.records })),
    drift: f.drift, halted: f.halted, healthy: f.healthy, healProposalIds: f.healProposalIds,
    errors: Array.isArray(run.errors) ? (run.errors as unknown[]).filter((e): e is string => typeof e === 'string') : [],
    startedAt: run.startedAt, completedAt: run.completedAt,
  };
}

export function createRechecks(deps: MaintenanceDeps, heals: Heals) {
  const control = deps.databases.pool('control');
  const running = new Map<string, Promise<void>>();

  const lockKey = (organisationId: string, connectionId: string) => lockKeys.key(organisationId, { purpose: 'recheck', resourceId: connectionId });

  async function conformance(ctx: Context, connection: Connection, trigger: RecheckTrigger, runId: string): Promise<ConformanceRunView> {
    // A person's re-check is theirs; the service's runs as the service (weekly or self_heal).
    const as = trigger === 'manual' ? ctx : asService(ctx);
    let run = await deps.services.call(startConformanceRun, {
      body: { connectionId: connection.id, trigger: trigger === 'manual' ? 'manual' : trigger, classes: ['read', 'pagination', 'filter_pushdown', 'error'] },
    }, { ...as, idempotencyKey: `recheck-${runId}` });
    const deadline = Date.now() + deps.runTimeoutMs;
    while (run.status === 'running' && Date.now() < deadline && !deps.signal.aborted) {
      await sleep(deps.pollMs, deps.signal).catch(() => undefined);
      if (!deps.signal.aborted) run = await deps.services.call(getConformanceRun, { params: { runId: run.id } }, as);
    }
    if (deps.signal.aborted) throw new AppError('unavailable', 'the process is stopping', { code: 'maintenance.shutdown', retryable: true });
    if (run.status === 'running') throw new AppError('unavailable', 'the conformance run did not end in time', { code: 'maintenance.conformance_timeout', retryable: true });
    return run;
  }

  async function observe(ctx: Context, connection: Connection, manifest: Manifest): Promise<ObjectObservation[]> {
    const out: ObjectObservation[] = [];
    for (const object of manifest.objects) {
      try {
        const seen = await deps.services.call(observeObject, { body: { connectionId: connection.id, object: object.name, sampleRows: SAMPLE_ROWS } }, asService(ctx));
        out.push({ object: seen.object, observable: seen.observable, reason: seen.reason, records: seen.records, fields: seen.fields });
      } catch (error) {
        out.push({ object: object.name, error: codeOf(error) });
      }
    }
    return out;
  }

  async function record(ctx: Context, runId: string, changes: { status?: ProbeRun['status']; findings: Findings; errors: string[] }): Promise<void> {
    await inTransaction(control, ctx.request, (db) => probeRunRepo.update(db, runId, {
      findings: changes.findings as never, errors: changes.errors as never,
      ...(changes.status === undefined ? {} : { status: changes.status, completedAt: new Date().toISOString() }),
    }));
  }

  /** The work of one re-check, after its run is recorded. Never throws: a failure is recorded. */
  async function work(ctx: Context, connection: Connection, run: ProbeRun, trigger: RecheckTrigger): Promise<void> {
    const errors: string[] = [];
    const findings: Findings = {
      trigger, conformanceRunId: null, verified: null, objects: [], drift: [], halted: false, healthy: false, healProposalIds: [],
    };
    try {
      const { manifest, baselineRun } = await inTransaction(control, ctx.request, async (db) => ({
        manifest: manifestSchema.parse((await connectorManifestRepo.findById(db, connection.manifestId))!.document),
        baselineRun: await probeRunRepo.latestCompletedRecheck(db, connection.id),
      }), { readOnly: true });
      const baseline = new Map((baselineRun === undefined ? [] : findingsOf(baselineRun).objects).map((o) => [o.object, o]));

      const suite = await conformance(ctx, connection, trigger, run.id);
      findings.conformanceRunId = suite.id;
      findings.verified = suite.gate.verified;
      const observations = await observe(ctx, connection, manifest);
      for (const o of observations) {
        if ('error' in o) {
          errors.push(`observe.${o.object}:${o.error}`);
          findings.objects.push({ object: o.object, observable: false, reason: o.error, records: 0, fields: [] });
        } else {
          findings.objects.push(o);
        }
      }

      const analysis = analyse({ manifest, tests: suite.tests, gate: suite.gate, observations, baseline });
      findings.drift = analysis.drift;

      // Halts first: nothing more is served from a connection that would answer wrongly.
      const halts = analysis.proposals.filter((p) => p.halt);
      for (const plan of halts) {
        const p = await heals.propose(ctx, connection, plan);
        findings.healProposalIds.push(p.id);
      }
      if (halts.length > 0) {
        const reason = `drift: ${halts.map((h) => h.changeKind).join(', ')} (${halts.flatMap((h) => h.drift).slice(0, 3)
          .map((d) => `${d.object}${d.field === null ? '' : `.${d.field}`}`).join(', ')})`;
        findings.halted = await heals.halt(ctx, connection, reason);
      }

      // Healthy needs the suite to verify the version the connection now runs, and no drift
      // left that makes answers wrong: a halt, a rename not applied, a type widened but not
      // yet accepted. A new field changes no answer; a lost pushdown is already computed after
      // the source by the runtime.
      let wrong = halts.length > 0;
      let verified = suite.gate.verified;
      for (const plan of analysis.proposals.filter((p) => !p.halt)) {
        const proposed = await heals.propose(ctx, connection, plan);
        findings.healProposalIds.push(proposed.id);
        const charged = await heals.chargeFor(ctx, proposed);
        if (plan.changeKind === 'type_changed') wrong = true;
        if (!plan.auto || findings.halted) {
          if (plan.changeKind === 'rename') wrong = true;
          continue;
        }
        let applied = false;
        if (charged === 'refused') {
          errors.push(`charge.${proposed.id}:refused`);
        } else {
          const outcome = await heals.repair(ctx, await heals.load(ctx, proposed.id), 'auto_applied', ctx.request.membershipId);
          applied = outcome.applied;
          // The repaired version's sandbox run verified it, and it is what the connection runs now.
          if (applied) verified = true;
          else errors.push(`repair.${proposed.id}:${outcome.reason ?? 'not_applied'}`);
        }
        if (plan.changeKind === 'rename' && !applied) {
          // A declared field would be empty in every answer until the rename is applied: halt.
          wrong = true;
          findings.halted = await heals.halt(ctx, connection,
            `drift: rename not applied (${plan.drift.map((d) => `${d.object}.${d.field}`).slice(0, 3).join(', ')})`);
        }
      }

      if (verified && !wrong && !findings.halted) {
        await inTransaction(control, ctx.request, (db) => connectionRepo.markHealthy(db, connection.id));
        findings.healthy = true;
      }
      await record(ctx, run.id, { status: 'completed', findings, errors });
    } catch (error) {
      errors.push(`recheck:${codeOf(error)}`);
      deps.logger.failure('a re-check failed', error, { event: 'maintenance.recheck_failed', resourceId: run.id });
      await record(ctx, run.id, { status: 'failed', findings, errors }).catch((cause: unknown) =>
        deps.logger.failure('recording a failed re-check failed', cause, { event: 'maintenance.record_failed', resourceId: run.id }));
    }
  }

  /**
   * Starts a re-check and answers with its run; the work continues in this process.
   * `done` resolves when it has ended (the weekly worker waits on it).
   */
  async function start(ctx: Context, connectionId: string, trigger: RecheckTrigger): Promise<{ view: RecheckView; done: Promise<void> }> {
    const connection = await loadConnection(deps, ctx, connectionId);
    if (trigger === 'manual') await demandOn(deps, ctx, connection, ['connector.verify']);
    if (connection.status !== 'active' && connection.status !== 'verified') {
      throw new AppError('conflict', `a ${connection.status} connection is not re-checked`, {
        code: 'maintenance.connection_not_checkable', details: { status: connection.status },
      });
    }
    const organisationId = connection.organisationId;
    const token = await deps.data.acquireLock(lockKeys, lockKey(organisationId, connection.id), LOCK_TTL_SECONDS);
    if (token === undefined) {
      throw new AppError('conflict', 'a re-check of this connection is already running', { code: 'maintenance.recheck_in_progress', retryAfterSeconds: 30 });
    }
    let run: ProbeRun;
    try {
      run = await inTransaction(control, ctx.request, (db) => probeRunRepo.insert(db, {
        id: uuidv7(), organisationId, connectionId: connection.id, manifestId: connection.manifestId, stage: 'recheck',
        findings: { trigger, conformanceRunId: null, verified: null, objects: [], drift: [], halted: false, healthy: false, healProposalIds: [] } as never,
      }));
    } catch (error) {
      await deps.data.releaseLock(lockKeys, lockKey(organisationId, connection.id), token).catch(() => false);
      throw error;
    }
    // The person's request outlives the reply: keep its context, not the handler's.
    const context: Context = { request: { ...ctx.request }, correlationId: ctx.correlationId };
    const renew = setInterval(() => {
      void deps.data.renewLock(lockKeys, lockKey(organisationId, connection.id), token, LOCK_TTL_SECONDS).catch(() => false);
    }, LOCK_RENEW_MS);
    const done = work(context, connection, run, trigger).finally(async () => {
      clearInterval(renew);
      running.delete(run.id);
      await deps.data.releaseLock(lockKeys, lockKey(organisationId, connection.id), token).catch(() => false);
    });
    running.set(run.id, done);
    return { view: recheckView(run), done };
  }

  return {
    start,

    async get(ctx: Context, recheckId: string): Promise<RecheckView> {
      const run = await inTransaction(control, ctx.request, (db) => probeRunRepo.findById(db, recheckId), { readOnly: true });
      if (!run || run.stage !== 'recheck') throw new AppError('not_found', 'no such re-check', { code: 'maintenance.recheck_not_found' });
      await demandOn(deps, ctx, await loadConnection(deps, ctx, run.connectionId), ['connector.verify', 'connector.heal_review']);
      return recheckView(run);
    },

    async list(ctx: Context, connectionId: string, limit: number): Promise<RecheckView[]> {
      await demandOn(deps, ctx, await loadConnection(deps, ctx, connectionId), ['connector.verify', 'connector.heal_review']);
      const runs = await inTransaction(control, ctx.request, (db) => probeRunRepo.listRechecks(db, connectionId, limit), { readOnly: true });
      return runs.map(recheckView);
    },

    /**
     * A runtime self-heal: started as the service unless one is running, or one started within
     * the quiet window (so a failing source is not hammered).
     */
    async selfHeal(ctx: Context, connectionId: string, quietMinutes: number): Promise<{ started: boolean; recheckId: string | null }> {
      const service = asService(ctx);
      const last = await inTransaction(control, service.request, (db) => probeRunRepo.listRechecks(db, connectionId, 1), { readOnly: true });
      if (last[0] !== undefined && (last[0].status === 'running' || Date.now() - Date.parse(last[0].startedAt) < quietMinutes * 60_000)) {
        return { started: false, recheckId: last[0].id };
      }
      try {
        const { view } = await start(service, connectionId, 'self_heal');
        return { started: true, recheckId: view.id };
      } catch (error) {
        if (isAppError(error) && (error.code === 'maintenance.recheck_in_progress' || error.code === 'maintenance.connection_not_checkable')) {
          return { started: false, recheckId: null };
        }
        throw error;
      }
    },

    /** Re-checks in progress end (each is recorded however it ended) before the process stops. */
    async close(): Promise<void> {
      await Promise.allSettled([...running.values()]);
    },
  };
}

export type Rechecks = ReturnType<typeof createRechecks>;
