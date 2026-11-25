// Data pipelines (D235): object sets read as the person, transformed by the closed steps of
// pipelineEngine.service.ts (CEL compiled by the expression evaluator, here, never in the browser),
// and written as CSV into an Import Silo source. Only the owner edits and runs a pipeline; anyone
// may preview their own. A run needs silo.import on the output Silo (siloes-import decides it, as
// the person) and writes only into a Silo marked at least as its inputs are: the markings of what
// the inputs read must all be on the Silo, or the run is refused and says which are missing. Each
// run is recorded with its row count and the Silo file it made, or why it failed.
//
// Schedules (D241): the owner sets one (pipeline.save, silo.import on the output Silo now, read on
// the connections its inputs read now, no oftener than every fifteen minutes in the organisation's
// time zone). It runs as its own service principal (kind automation, owned by the owner), granted
// those connections and silo.import, each bounded by the owner at every run (policy). The due
// sweep (workers/workspace/pipelineDue.worker.ts) runs it: missed times are counted, never
// backfilled; each failed run tells the owner; after the failures it allows in a row it pauses, and
// an archived pipeline's schedule pauses too. Removing a schedule revokes its principal.

import { processLoad } from '../../infra/load.infra.ts';
import { tenantMigrationRepo } from '../../repos/platform/tenantMigration.repo.ts';
import { previewExportMarkings } from '../../contracts/files/file.contract.ts';
import type { NodeRef, Relation } from '../../contracts/lineage/lineage.contract.ts';
import { getManifest } from '../../contracts/ontology/manifest.contract.ts';
import { getObjectSet } from '../../contracts/ontology/objectSet.contract.ts';
import { checkFilesSilo, uploadFile } from '../../contracts/siloes/import.contract.ts';
import { raiseNotification } from '../../contracts/notify/notification.contract.ts';
import { resolveAccess } from '../../contracts/policy/decision.contract.ts';
import { pipelineDocument, type PipelineDocument } from '../../contracts/workspace/pipeline.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { Pipeline } from '../../models/workspace/pipeline.model.ts';
import type { PipelineRun } from '../../models/workspace/pipelineRun.model.ts';
import type { PipelineSchedule } from '../../models/workspace/pipelineSchedule.model.ts';
import { organisationRepo, servicePrincipalRepo } from '../../repos/iam/index.repo.ts';
import { resourceMarkingRepo } from '../../repos/gov/index.repo.ts';
import { pipelineRepo, pipelineRunRepo, pipelineScheduleRepo } from '../../repos/workspace/index.repo.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { compileCel } from '../expression-evaluator/cel.service.ts';
import { checkSchedule, missedBetween, nextOccurrence, parseSchedule, validTimeZone } from '../scheduler/schedule.service.ts';
import { demand, member, recordEvent, type Context, type Member, type WorkspaceDeps } from './deps.service.ts';
import { runSteps, StepError, toCsv, type Cell, type Compile, type Table } from './pipelineEngine.service.ts';
import { readRange, typesOf } from './workbooks.service.ts';

type Keyed = Context & Pick<HandlerContext, 'idempotencyKey'>;
const notFound = () => new AppError('not_found', 'no such pipeline', { code: 'workspace.pipeline_not_found' });
const stale = () => new AppError('conflict', 'the pipeline changed since you read it', { code: 'workspace.pipeline_stale' });
const refuse = (message: string, code: string) => new AppError('validation', message, { code });
const BOUNDS = { steps: 10_000, timeMs: 5 };

const documentOf = (p: Pipeline): PipelineDocument => pipelineDocument.parse(p.document);
const scheduleViewOf = (s: PipelineSchedule) => ({
  schedule: s.schedule, timeZone: s.timezone, status: s.status, pausedReason: s.pausedReason, nextRunAt: s.nextRunAt, lastRunAt: s.lastRunAt,
  failuresInARow: s.failuresInARow, pauseAfterFailures: s.pauseAfterFailures, servicePrincipalId: s.servicePrincipalId,
});
const viewOf = (p: Pipeline, s?: PipelineSchedule | undefined) => ({
  id: p.id, name: p.name, ownerMembershipId: p.ownerMembershipId, document: documentOf(p),
  createdAt: p.createdAt, updatedAt: p.updatedAt, archivedAt: p.archivedAt, lockVersion: p.lockVersion,
  schedule: s === undefined ? null : scheduleViewOf(s),
});
const runViewOf = (r: PipelineRun) => ({
  id: r.id, pipelineId: r.pipelineId, status: r.status, rows: r.rows, siloFileId: r.siloFileId, failure: r.failure,
  trigger: (r.startedBy === null ? 'schedule' : 'person') as 'schedule' | 'person', startedBy: r.startedBy, startedAt: r.startedAt, finishedAt: r.finishedAt,
});
const MIN_INTERVAL_MINUTES = 15;

/** CEL over a row's columns, evaluated within bounds, every column typed dyn. */
const compile: Compile = (expression, columns) => {
  const compiled = compileCel(expression, Object.fromEntries(columns.map((c) => [c, 'dyn' as const])));
  return (row) => compiled.evaluate(row, BOUNDS);
};

async function owned(deps: WorkspaceDeps, me: Member, id: string): Promise<Pipeline> {
  const p = await inTransaction(deps.databases.pool('control'), me.request, (db) => pipelineRepo.findById(db, id), { readOnly: true });
  if (!p || p.ownerMembershipId !== me.membershipId) throw notFound();
  return p;
}

/** Inputs over sets and properties the owner may see, joins naming inputs that exist. */
async function checkDocument(deps: WorkspaceDeps, ctx: Context, doc: PipelineDocument): Promise<void> {
  const options = { request: ctx.request, correlationId: ctx.correlationId };
  const manifest = await deps.services.call(getManifest, { query: {} }, options);
  for (const input of doc.inputs) {
    let set: { baseTypeId: string | null };
    try {
      set = await deps.services.call(getObjectSet, { params: { objectSetId: input.objectSetId } }, options);
    } catch (error) {
      if (isAppError(error) && (error.category === 'not_found' || error.category === 'forbidden')) throw refuse(`the input ${input.id} reads an object set you may not see`, 'workspace.pipeline_set_unknown');
      throw error;
    }
    const known = new Set(manifest.objectTypes.find((t) => t.id === set.baseTypeId)?.properties.map((p) => p.identityId) ?? []);
    if (input.propertyIds.some((p) => !known.has(p))) throw refuse(`the input ${input.id} names a property its set's type does not have`, 'workspace.pipeline_property_unknown');
  }
  const names = new Set(doc.inputs.map((i) => i.id));
  for (const s of doc.steps) if (s.op === 'join' && !names.has(s.input)) throw refuse(`a join names ${s.input}, which is not an input`, 'workspace.pipeline_input_unknown');
}

interface Read { tables: Map<string, Table>; inputs: { id: string; rows: number; truncated: boolean; withheld: number; refused: string | null }[]; lineage: { node: NodeRef; relation: Relation }[] }

/** Every input read as the caller: its columns named by the properties' API names. */
async function readInputs(deps: WorkspaceDeps, ctx: Context, doc: PipelineDocument): Promise<Read> {
  const manifest = await deps.services.call(getManifest, { query: {} }, { request: ctx.request, correlationId: ctx.correlationId });
  const apiName = new Map(manifest.objectTypes.flatMap((t) => t.properties.map((p) => [p.identityId, p.apiName] as const)));
  const types = await typesOf(deps, ctx, doc.inputs.map((i) => i.objectSetId));
  const reads = await Promise.all(doc.inputs.map((i) => readRange(deps, ctx, { id: i.id, objectSetId: i.objectSetId, propertyIds: i.propertyIds, limit: i.limit }, types.get(i.objectSetId))));
  const tables = new Map<string, Table>();
  doc.inputs.forEach((input, n) => {
    const r = reads[n]!;
    tables.set(input.id, {
      columns: input.propertyIds.map((p) => apiName.get(p) ?? p),
      rows: r.rows.map((row) => row.map((v): Cell => (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : JSON.stringify(v)))),
    });
  });
  return {
    tables,
    inputs: doc.inputs.map((input, n) => ({ id: input.id, rows: reads[n]!.rows.length, truncated: reads[n]!.truncated, withheld: reads[n]!.withheld, refused: reads[n]!.refused })),
    lineage: [...new Map(reads.flatMap((r) => r.lineage).map((l) => [`${l.node.kind}${l.node.refId}${l.node.version}`, l])).values()],
  };
}

export async function create(deps: WorkspaceDeps, ctx: Context, input: { name: string; document: PipelineDocument }) {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'pipeline.save' });
  await checkDocument(deps, ctx, input.document);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const p = await pipelineRepo.insert(db, { id: uuidv7(), organisationId: me.organisationId, ownerMembershipId: me.membershipId, name: input.name, document: input.document as never });
    await recordEvent(db, me, ctx.correlationId, { event: 'pipeline_created', resource: { type: 'pipeline', id: p.id }, detail: { inputs: input.document.inputs.length, steps: input.document.steps.length } });
    return viewOf(p);
  });
}

export async function list(deps: WorkspaceDeps, ctx: Context, archived: boolean, limit: number) {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) =>
  {
    const rows = await pipelineRepo.listMine(db, me.membershipId, archived, limit);
    const schedules = new Map((await pipelineScheduleRepo.listForPipelines(db, rows.map((p) => p.id))).map((s) => [s.pipelineId, s]));
    return { pipelines: rows.map((p) => { const { document: _d, ...rest } = viewOf(p, schedules.get(p.id)); return rest; }) };
  }, { readOnly: true });
}

const scheduleOf = (deps: WorkspaceDeps, me: Member, id: string) =>
  inTransaction(deps.databases.pool('control'), me.request, (db) => pipelineScheduleRepo.findByKey(db, { organisationId: me.organisationId, pipelineId: id }), { readOnly: true });

export async function get(deps: WorkspaceDeps, ctx: Context, id: string) {
  const me = member(ctx);
  return viewOf(await owned(deps, me, id), await scheduleOf(deps, me, id));
}

export async function save(deps: WorkspaceDeps, ctx: Context, id: string, input: { name?: string | undefined; document: PipelineDocument; lockVersion: number }) {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'pipeline.save' });
  await owned(deps, me, id);
  await checkDocument(deps, ctx, input.document);
  // A scheduled pipeline's principal is granted what its inputs now read.
  const connections = await inputConnections(deps, ctx, input.document);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const p = await pipelineRepo.findForUpdate(db, id);
    if (!p || p.ownerMembershipId !== me.membershipId) throw notFound();
    if (p.archivedAt !== null) throw new AppError('conflict', 'an archived pipeline is not edited', { code: 'workspace.pipeline_archived' });
    if (p.lockVersion !== input.lockVersion) throw stale();
    const saved = (await pipelineRepo.update(db, id, { ...(input.name === undefined ? {} : { name: input.name }), document: input.document as never, lockVersion: p.lockVersion + 1 }))!;
    await recordEvent(db, me, ctx.correlationId, { event: 'pipeline_saved', resource: { type: 'pipeline', id }, detail: { inputs: input.document.inputs.length, steps: input.document.steps.length } });
    const s = await pipelineScheduleRepo.findForUpdate(db, id);
    const schedule = s === undefined ? undefined : await pipelineScheduleRepo.update(db, { organisationId: me.organisationId, pipelineId: id }, { connectionIds: connections });
    return viewOf(saved, schedule);
  });
}

export async function preview(deps: WorkspaceDeps, ctx: Context, id: string, draft: PipelineDocument | undefined) {
  const me = member(ctx);
  const p = await owned(deps, me, id);
  const doc = draft ?? documentOf(p);
  if (draft !== undefined) await checkDocument(deps, ctx, draft);
  const read = await readInputs(deps, ctx, doc);
  try {
    const out = runSteps(read.tables, doc.inputs[0]!.id, doc.steps, compile);
    return { columns: out.columns, rows: out.rows.slice(0, 100), total: out.rows.length, inputs: read.inputs, failedStep: null };
  } catch (error) {
    if (error instanceof StepError) return { columns: [], rows: [], total: 0, inputs: read.inputs, failedStep: { step: error.step, message: error.message } };
    throw error;
  }
}

export async function run(deps: WorkspaceDeps, ctx: Keyed, id: string) {
  const me = member(ctx);
  const p = await owned(deps, me, id);
  return execute(deps, ctx, p, me, ctx.idempotencyKey, true);
}

type Starter = Member | { organisationId: string; servicePrincipalId: string };

/** A run, by a person (who sees a failure as an error) or by the schedule's principal (who records it and goes on). */
async function execute(deps: WorkspaceDeps, ctx: Context, p: Pipeline, starter: Starter, idempotencyKey: string | undefined, rethrow: boolean) {
  const doc = documentOf(p);
  if (doc.output === undefined) throw refuse('the pipeline has no output: choose an Import Silo source to write to', 'workspace.pipeline_no_output');
  if (p.archivedAt !== null) throw new AppError('conflict', 'an archived pipeline does not run', { code: 'workspace.pipeline_archived' });
  const started = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const r = await pipelineRunRepo.insert(db, {
      id: uuidv7(), organisationId: p.organisationId, pipelineId: p.id, status: 'running',
      ...('membershipId' in starter ? { startedBy: starter.membershipId } : { startedByPrincipal: starter.servicePrincipalId }),
    });
    await recordEvent(db, starter, ctx.correlationId, { event: 'pipeline_run_started', resource: { type: 'pipeline', id: p.id }, detail: { run_id: r.id, trigger: 'membershipId' in starter ? 'person' : 'schedule' } });
    return r;
  });
  const finish = (changes: { status: 'completed' | 'failed'; rows?: number; siloFileId?: string; failure?: string }) =>
    inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
      const done = (await pipelineRunRepo.update(db, started.id, {
        status: changes.status, rows: changes.rows ?? null, siloFileId: changes.siloFileId ?? null, failure: changes.failure ?? null, finishedAt: new Date().toISOString(),
      }))!;
      await recordEvent(db, starter, ctx.correlationId, {
        event: changes.status === 'completed' ? 'pipeline_run_completed' : 'pipeline_run_failed', resource: { type: 'pipeline', id: p.id },
        detail: { run_id: started.id, rows: changes.rows ?? null, silo_file_id: changes.siloFileId ?? null, failure: changes.failure?.slice(0, 200) ?? null },
      });
      return runViewOf(done);
    });
  try {
    const read = await readInputs(deps, ctx, doc);
    const refused = read.inputs.find((i) => i.refused !== null);
    if (refused !== undefined) return finish({ status: 'failed', failure: `the input ${refused.id} was not read for you: ${refused.refused}` });
    let table: Table;
    try {
      table = runSteps(read.tables, doc.inputs[0]!.id, doc.steps, compile);
    } catch (error) {
      if (error instanceof StepError) return finish({ status: 'failed', failure: `step ${error.step}: ${error.message}` });
      throw error;
    }
    // Never a declassification: the Silo must carry every marking of what the inputs read.
    const options = { request: ctx.request, correlationId: ctx.correlationId };
    const { markings } = read.lineage.length === 0 ? { markings: [] } : await deps.services.call(previewExportMarkings, { body: { inputs: read.lineage } }, options);
    const siloMarkings = await inTransaction(deps.databases.pool('control'), ctx.request,
      async (db) => new Set((await resourceMarkingRepo.markingsFor(db, 'silo', [doc.output!.siloId])).map((m) => m.markingId)), { readOnly: true });
    const missing = markings.filter((m) => !siloMarkings.has(m.id));
    if (missing.length > 0) return finish({ status: 'failed', failure: `the output Silo does not carry ${missing.map((m) => m.name).join(', ')}, which its inputs do` });
    const csv = toCsv(table);
    const file = await deps.services.call(uploadFile, {
      params: { siloId: doc.output.siloId, sourceId: doc.output.sourceId }, body: { filename: doc.output.filename, contentBase64: Buffer.from(csv, 'utf8').toString('base64') },
    }, { ...options, idempotencyKey: `pipeline.${idempotencyKey ?? started.id}` });
    return finish({ status: 'completed', rows: table.rows.length, siloFileId: file.id });
  } catch (error) {
    const reason = isAppError(error) ? error.message : 'the run stopped';
    const failed = await finish({ status: 'failed', failure: reason });
    if (rethrow || !isAppError(error)) throw error;
    return failed;
  }
}

// ----------------------------------------------------------------------------- schedules (D241)

/** The connections a document's inputs read: each set's type's contributing connections. */
async function inputConnections(deps: WorkspaceDeps, ctx: Context, doc: PipelineDocument): Promise<string[]> {
  const options = { request: ctx.request, correlationId: ctx.correlationId };
  const manifest = await deps.services.call(getManifest, { query: {} }, options);
  const ids = new Set<string>();
  for (const input of doc.inputs) {
    const set = await deps.services.call(getObjectSet, { params: { objectSetId: input.objectSetId } }, options).catch(() => undefined);
    for (const c of manifest.objectTypes.find((t) => t.id === set?.baseTypeId)?.contributingObjects ?? []) ids.add(c.connectionId);
  }
  return [...ids].sort();
}

export async function setSchedule(deps: WorkspaceDeps, ctx: Context, id: string, input: { schedule: string; pauseAfterFailures: number }) {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'pipeline.save' });
  const p = await owned(deps, me, id);
  const doc = documentOf(p);
  if (p.archivedAt !== null) throw new AppError('conflict', 'an archived pipeline is not scheduled', { code: 'workspace.pipeline_archived' });
  if (doc.output === undefined) throw refuse('the pipeline has no output: choose an Import Silo source to write to', 'workspace.pipeline_no_output');
  const options = { request: ctx.request, correlationId: ctx.correlationId };
  // The owner may write into the output Silo now (silo.import, its markings, open): the principal never exceeds them.
  await deps.services.call(checkFilesSilo, { params: { siloId: doc.output.siloId } }, options);
  const connections = await inputConnections(deps, ctx, doc);
  if (connections.length > 0) {
    const access = await deps.services.call(resolveAccess, { body: { connections } }, options);
    const unread = connections.filter((c) => access.connections.find((x) => x.id === c)?.access === undefined || access.connections.find((x) => x.id === c)?.access === 'none');
    if (access.decision !== 'allow' || unread.length > 0) {
      throw new AppError('forbidden', 'you cannot read every system the inputs read, so a schedule could not', { code: 'workspace.pipeline_schedule_unreadable' });
    }
  }
  const now = Date.now();
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const timezone = (await organisationRepo.findById(db, me.organisationId))?.calendarTimeZone ?? 'UTC';
    if (!validTimeZone(timezone)) throw new AppError('integrity', 'the organisation\'s time zone is not known', { code: 'workspace.time_zone_unknown' });
    const schedule = checkSchedule(input.schedule, timezone, MIN_INTERVAL_MINUTES, now);
    const next = new Date(nextOccurrence(schedule, now, timezone)!).toISOString();
    const key = { organisationId: me.organisationId, pipelineId: id };
    const existing = await pipelineScheduleRepo.findForUpdate(db, id);
    let s: PipelineSchedule;
    if (existing !== undefined) {
      s = (await pipelineScheduleRepo.update(db, key, {
        schedule: input.schedule, timezone, connectionIds: connections, pauseAfterFailures: input.pauseAfterFailures,
        ...(existing.status === 'active' ? { nextRunAt: next } : {}),
      }))!;
    } else {
      const principalId = uuidv7();
      await servicePrincipalRepo.insert(db, {
        id: principalId, organisationId: me.organisationId, kind: 'automation', name: `Pipeline ${id}`, scopeId: null,
        ownerMembershipId: me.membershipId, secretHash: null, expiresAt: null, createdBy: me.membershipId,
      });
      s = await pipelineScheduleRepo.insert(db, {
        ...key, servicePrincipalId: principalId, schedule: input.schedule, timezone, status: 'active', connectionIds: connections,
        pauseAfterFailures: input.pauseAfterFailures, nextRunAt: next, createdBy: me.membershipId,
      });
    }
    await recordEvent(db, me, ctx.correlationId, {
      event: 'pipeline_schedule_set', resource: { type: 'pipeline', id },
      detail: { schedule: input.schedule, time_zone: timezone, connections: connections.length, pause_after_failures: input.pauseAfterFailures, service_principal_id: s.servicePrincipalId },
    });
    return viewOf(p, s);
  });
}

export async function removeSchedule(deps: WorkspaceDeps, ctx: Context, id: string) {
  const me = member(ctx);
  const p = await owned(deps, me, id);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const s = await pipelineScheduleRepo.findForUpdate(db, id);
    if (s === undefined) return viewOf(p);
    await pipelineScheduleRepo.remove(db, { organisationId: me.organisationId, pipelineId: id });
    await servicePrincipalRepo.update(db, s.servicePrincipalId, { revokedAt: new Date().toISOString() });
    await recordEvent(db, me, ctx.correlationId, { event: 'pipeline_schedule_removed', resource: { type: 'pipeline', id }, detail: { service_principal_id: s.servicePrincipalId } });
    return viewOf(p);
  });
}

export async function resumeSchedule(deps: WorkspaceDeps, ctx: Context, id: string) {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'pipeline.save' });
  const p = await owned(deps, me, id);
  if (p.archivedAt !== null) throw new AppError('conflict', 'an archived pipeline does not run', { code: 'workspace.pipeline_archived' });
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const s = await pipelineScheduleRepo.findForUpdate(db, id);
    if (s === undefined) throw new AppError('not_found', 'the pipeline is not scheduled', { code: 'workspace.pipeline_not_scheduled' });
    if (s.status === 'active') return viewOf(p, s);
    const next = nextOccurrence(parseSchedule(s.schedule), Date.now(), s.timezone);
    const resumed = (await pipelineScheduleRepo.update(db, { organisationId: me.organisationId, pipelineId: id }, {
      status: 'active', pausedReason: null, failuresInARow: 0, nextRunAt: next === undefined ? null : new Date(next).toISOString(),
    }))!;
    await recordEvent(db, me, ctx.correlationId, { event: 'pipeline_schedule_resumed', resource: { type: 'pipeline', id }, detail: {} });
    return viewOf(p, resumed);
  });
}

/**
 * A due schedule's turn (the sweep): moved to its next time; the times it missed counted, never
 * backfilled; run as its principal; its owner told of a failure, and paused after the failures it
 * allows in a row. A schedule whose pipeline was archived pauses instead of running.
 */
export async function runDue(deps: WorkspaceDeps, organisationId: string, pipelineId: string, dueAt: string, now: number): Promise<void> {
  const control = deps.databases.pool('control');
  const correlationId = uuidv7();
  // Shed under load as a Cron is (12.4): this time is missed, and counted when it next runs.
  if (processLoad().sheds('cron')) return;
  // While the organisation moves cell (spec 6.4) a scheduled run writes nothing: its lease lapses,
  // and the destination counts the times it missed when it next runs there.
  if (await inTransaction(control, { organisationId }, (db) => tenantMigrationRepo.writesPaused(db, organisationId), { readOnly: true })) {
    deps.logger.info('a scheduled pipeline waits while its organisation moves cell', { event: 'workspace.pipeline_schedule_paused_by_migration', organisationId, resourceId: pipelineId });
    return;
  }
  const taken = await inTransaction(control, { organisationId }, async (db) => {
    const s = await pipelineScheduleRepo.findForUpdate(db, pipelineId);
    if (s === undefined || s.status !== 'active') return undefined;
    const key = { organisationId, pipelineId };
    const who = { organisationId, servicePrincipalId: s.servicePrincipalId };
    const p = await pipelineRepo.findById(db, pipelineId);
    if (p === undefined || p.archivedAt !== null) {
      await pipelineScheduleRepo.update(db, key, { status: 'paused', pausedReason: 'archived', nextRunAt: null, leaseExpiresAt: null });
      await recordEvent(db, who, correlationId, { event: 'pipeline_schedule_paused', resource: { type: 'pipeline', id: pipelineId }, detail: { reason: 'archived' } });
      return undefined;
    }
    const schedule = parseSchedule(s.schedule);
    const next = nextOccurrence(schedule, now, s.timezone);
    await pipelineScheduleRepo.update(db, key, { nextRunAt: next === undefined ? null : new Date(next).toISOString(), leaseExpiresAt: null });
    const missed = missedBetween(schedule, Date.parse(dueAt), now, s.timezone);
    if (missed > 0) await recordEvent(db, who, correlationId, { event: 'pipeline_run_skipped', resource: { type: 'pipeline', id: pipelineId }, detail: { reason: 'missed', missed } });
    return { s, p, who };
  });
  if (taken === undefined) return;
  const ctx = { request: { organisationId, servicePrincipalId: taken.s.servicePrincipalId }, correlationId, caller: 'workspace' as const };
  let outcome: Awaited<ReturnType<typeof execute>> | undefined;
  try {
    outcome = await execute(deps, ctx, taken.p, taken.who, `sched.${pipelineId}.${Date.parse(dueAt)}`, false);
  } catch (error) {
    // Not even started (no output, refused before a run was recorded): counted as a failure all the same.
    deps.logger.warn('a scheduled pipeline run could not start', { event: 'workspace.pipeline_schedule_start_failed', organisationId, resourceId: pipelineId,
      ...(isAppError(error) ? { errorCode: error.code } : {}) });
  }
  const failed = outcome === undefined || outcome.status === 'failed';
  await inTransaction(control, { organisationId }, async (db) => {
    const s = await pipelineScheduleRepo.findForUpdate(db, pipelineId);
    if (s === undefined) return;
    const failures = failed ? s.failuresInARow + 1 : 0;
    const pause = failed && failures >= s.pauseAfterFailures && s.status === 'active';
    await pipelineScheduleRepo.update(db, { organisationId, pipelineId }, {
      failuresInARow: failures, lastRunAt: new Date(now).toISOString(), ...(pause ? { status: 'paused', pausedReason: 'failures', nextRunAt: null } : {}),
    });
    if (pause) {
      await recordEvent(db, taken.who, correlationId, { event: 'pipeline_schedule_paused', resource: { type: 'pipeline', id: pipelineId }, detail: { reason: 'failures', failures } });
    }
  });
  if (failed && outcome !== undefined) {
    await deps.services.call(raiseNotification, {
      body: { recipientMembershipId: taken.p.ownerMembershipId, kind: 'pipeline_run_failed', source: { pipelineRunId: outcome.id } },
    }, { request: ctx.request, correlationId }).catch((error: unknown) => deps.logger.failure('the owner of a failed scheduled pipeline run could not be told', error, {
      event: 'workspace.pipeline_notify_failed', organisationId, resourceId: pipelineId,
    }));
  }
}

export async function runs(deps: WorkspaceDeps, ctx: Context, id: string) {
  const me = member(ctx);
  await owned(deps, me, id);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => ({ runs: (await pipelineRunRepo.listForPipeline(db, id)).map(runViewOf) }), { readOnly: true });
}

/** One run by its id, for the pipeline's owner; any other caller is told there is no such run. */
export async function readRun(deps: WorkspaceDeps, ctx: Context, runId: string) {
  const me = member(ctx);
  const found = await inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const r = await pipelineRunRepo.findById(db, runId);
    const p = r === undefined ? undefined : await pipelineRepo.findById(db, r.pipelineId);
    return r !== undefined && p !== undefined && p.ownerMembershipId === me.membershipId ? r : undefined;
  }, { readOnly: true });
  if (found === undefined) throw new AppError('not_found', 'no such pipeline run', { code: 'workspace.pipeline_run_not_found' });
  return runViewOf(found);
}

export async function archive(deps: WorkspaceDeps, ctx: Context, id: string) {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const p = await pipelineRepo.findForUpdate(db, id);
    if (!p || p.ownerMembershipId !== me.membershipId) throw notFound();
    const done = p.archivedAt !== null ? p : (await pipelineRepo.update(db, id, { archivedAt: new Date().toISOString(), lockVersion: p.lockVersion + 1 }))!;
    if (p.archivedAt === null) await recordEvent(db, me, ctx.correlationId, { event: 'pipeline_archived', resource: { type: 'pipeline', id }, detail: {} });
    // Its schedule stops with it (D241).
    let s = await pipelineScheduleRepo.findForUpdate(db, id);
    if (s !== undefined && s.status === 'active') {
      s = await pipelineScheduleRepo.update(db, { organisationId: me.organisationId, pipelineId: id }, { status: 'paused', pausedReason: 'archived', nextRunAt: null });
      await recordEvent(db, me, ctx.correlationId, { event: 'pipeline_schedule_paused', resource: { type: 'pipeline', id }, detail: { reason: 'archived' } });
    }
    return viewOf(done, s);
  });
}
