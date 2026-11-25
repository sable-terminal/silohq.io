// Crons as their owners and admins manage them (spec 40.1, 40.6, 40.8, 40.9).
//
// Creating one: automation.create (and file.export for a report); the owner must be able to
// run the saved view now, since the Cron re-runs it; the schedule is checked against the
// minimum interval in the organisation's time zone. The Cron's service principal (kind
// automation, owned by the owner) is created in the same transaction as the Cron: it is
// what the Cron runs as, and what it may reach is bounded by its owner at every run.
//
// A mutate action (40.5, 43.11): mutation.propose (execute also automation.execute) by the
// person attaching it, who is recorded as its authorising member; a confirmed Action type over
// the question's own type (single-source, or resolvable: each object's records in the systems
// the type may write are named), with the values of the parameters it needs, which are sealed
// with the action and never shown back; execute bounds within what the type may write and
// reach, an expiry ahead, and never a physical type. The authorisation, the connections it
// names and the parameter values are written with the action; only revocation changes them.
//
// Who may change it: the owner, or a holder of automation.manage (within the decision's
// scope rules). Resuming is its own governance action (spec 40.8): never under an owner who
// is no longer active, never while a connection it reads is halted. Deleting stops it for
// good and revokes its principal; the history stays.

import { canonicalJsonBytes } from '../../utils/canonicalJson.util.ts';
import { sealRecordValues } from '../../contracts/credential/recordValue.contract.ts';
import { subscribabilityOf } from '../change-stream/subscribability.service.ts';
import { z } from 'zod';
import { getActionType } from '../../contracts/actions/actionType.contract.ts';
import { getCompiledPlan } from '../../contracts/compile/compile.contract.ts';
import { manifestSchema, type ChangeSourceKind } from '../../contracts/connect/manifest.contract.ts';
import type { ChangeStreamSubscription } from '../../models/connect/changeStreamSubscription.model.ts';
import { getManifest, getVersionManifest } from '../../contracts/ontology/manifest.contract.ts';
import { getObjectSet } from '../../contracts/ontology/objectSet.contract.ts';
import {
  CRON_STATUSES, PAUSED_REASONS, createCron as createCronContract, type ActionInput, type ConditionInput, type ConditionView,
  type CronRunView, type CronView, type FailurePolicy,
} from '../../contracts/scheduler/cron.contract.ts';
import { openView } from '../../contracts/workspace/view.contract.ts';
import { listDetectors } from '../../contracts/recognition/detector.contract.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { Automation, AutomationAction, AutomationCondition } from '../../models/automation/index.model.ts';
import {
  authorisationConnectionRepo, automationActionRepo, automationAuthorisationRepo, automationConditionRepo, automationConnectionRepo, automationRepo,
  automationRunActionRepo, automationRunRepo, automationRunStateRepo,
} from '../../repos/automation/index.repo.ts';
import { changeStreamSubscriptionRepo, connectionRepo, connectorManifestRepo } from '../../repos/connect/index.repo.ts';
import type { Watch } from './watch.service.ts';
import { membershipRepo, organisationRepo, scopeMembershipRepo, scopeRepo, servicePrincipalRepo } from '../../repos/iam/index.repo.ts';
import { AppError, fromDatabaseError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import {
  allowed, cronActor, cronNotFound, demand, member, memberActor, recordEvent, type Context, type Member, type SchedulerDeps,
} from './deps.service.ts';
import { checkSchedule, nextOccurrence, parseSchedule, validTimeZone } from './schedule.service.ts';
import type { ShareGrantee, ViewShareView } from '../../contracts/workspace/sharing.contract.ts';
import type { AutomationRun } from '../../models/automation/index.model.ts';
import type { ViewShare } from '../../models/workspace/viewShare.model.ts';
import { followRepo, viewShareRepo } from '../../repos/workspace/index.repo.ts';
import { effectivePolicy, granteeOf, permitted, type EffectivePolicy } from '../workspace/sharing.service.ts';

type CreateInput = z.output<typeof createCronContract.body>;

const unsupported = (what: string, code: string): AppError => new AppError('validation', `${what} is not built yet`, { code });

// ----------------------------------------------------------------------------- views

function conditionTree(rows: readonly AutomationCondition[]): ConditionView | null {
  const byParent = new Map<string | null, AutomationCondition[]>();
  for (const row of rows) byParent.set(row.parentConditionId, [...(byParent.get(row.parentConditionId) ?? []), row]);
  const build = (row: AutomationCondition): ConditionView => ({
    id: row.id, kind: row.kind, operator: row.operator, combinator: row.combinator,
    // A finding condition's detector and object type are its target.
    target: row.kind === 'finding' ? { detectorId: row.detectorId, objectTypeId: row.objectTypeId } : row.target, value: row.value,
    operands: (byParent.get(row.id) ?? []).sort((a, b) => a.sequence - b.sequence).map(build),
  });
  const root = byParent.get(null)?.[0];
  return root === undefined ? null : build(root);
}

export async function cronViewOf(db: Queryable, row: Automation): Promise<CronView> {
  const [conditions, actions, connectionIds] = await Promise.all([
    automationConditionRepo.listFor(db, row.id), automationActionRepo.listFor(db, row.id), automationConnectionRepo.listFor(db, row.id),
  ]);
  return {
    id: row.id, name: row.name, ownerMembershipId: row.ownerMembershipId, servicePrincipalId: row.servicePrincipalId,
    savedViewId: row.savedViewId, schedule: row.schedule, timezone: row.timezone, status: row.status, pausedReason: row.pausedReason,
    pausedAt: row.pausedAt, nextRunAt: row.nextRunAt, lastRunAt: row.lastRunAt, failurePolicy: row.failurePolicy as FailurePolicy,
    condition: conditionTree(conditions),
    actions: actions.map((a: AutomationAction) => ({
      id: a.id, sequence: a.sequence, kind: a.kind, configuration: a.configuration as Record<string, unknown>,
      escalateMembershipId: a.escalateMembershipId, escalateScopeId: a.escalateScopeId,
    })),
    connectionIds, createdAt: row.createdAt, version: row.version,
  };
}

// ----------------------------------------------------------------------------- creating

function checkCondition(condition: ConditionInput, depth: number): void {
  if (depth > 3) throw new AppError('validation', 'a condition is at most three levels deep; anything deeper belongs in the question', { code: 'scheduler.condition_too_deep' });
  if (condition.kind === 'composite') for (const operand of condition.operands) checkCondition(operand, depth + 1);
}

const findingConditions = (c: ConditionInput): Extract<ConditionInput, { kind: 'finding' }>[] =>
  c.kind === 'finding' ? [c] : c.kind === 'composite' ? c.operands.flatMap(findingConditions) : [];

/** A finding condition names a detector and an object type the owner may see (spec 40.3). */
async function checkFindings(deps: SchedulerDeps, ctx: Context, condition: ConditionInput): Promise<void> {
  const named = findingConditions(condition);
  if (named.length === 0) return;
  const options = { request: ctx.request, correlationId: ctx.correlationId };
  const [{ detectors }, manifest] = await Promise.all([
    deps.services.call(listDetectors, {}, options), deps.services.call(getManifest, { query: {} }, options),
  ]);
  for (const c of named) {
    if (!detectors.some((d) => d.id === c.detectorId)) {
      throw new AppError('validation', 'the finding condition names no detector', { code: 'scheduler.detector_unknown', details: { detectorId: c.detectorId } });
    }
    if (!manifest.objectTypes.some((t) => t.id === c.objectTypeId && t.status !== 'retired')) {
      throw new AppError('validation', 'the finding condition names an object type that is not available to you', {
        code: 'scheduler.object_type_unavailable', details: { objectTypeId: c.objectTypeId },
      });
    }
  }
}

async function insertCondition(db: Queryable, organisationId: string, automationId: string, condition: ConditionInput,
  parentConditionId: string | null, sequence: number): Promise<void> {
  const id = uuidv7();
  const base = { id, organisationId, automationId, parentConditionId, sequence, detectorId: null, objectTypeId: null };
  if (condition.kind === 'composite') {
    await automationConditionRepo.insert(db, { ...base, kind: 'composite', combinator: condition.combinator, target: null, operator: null, value: null });
    for (const [i, operand] of condition.operands.entries()) await insertCondition(db, organisationId, automationId, operand, id, i);
    return;
  }
  if (condition.kind === 'result') {
    await automationConditionRepo.insert(db, {
      ...base, kind: 'result', combinator: null, operator: condition.operator, target: { subject: 'result' },
      value: condition.operator === 'count_crossed' ? { threshold: condition.threshold!, direction: condition.direction! } : null,
    });
    return;
  }
  if (condition.kind === 'value') {
    const value = condition.threshold !== undefined ? { threshold: condition.threshold }
      : condition.proportion !== undefined ? { proportion: condition.proportion } : { hours: condition.hours! };
    await automationConditionRepo.insert(db, {
      ...base, kind: 'value', combinator: null, operator: condition.operator, target: condition.figure, value,
    });
    return;
  }
  if (condition.kind === 'finding') {
    await automationConditionRepo.insert(db, {
      ...base, kind: 'finding', combinator: null, operator: condition.operator, detectorId: condition.detectorId, objectTypeId: condition.objectTypeId,
      target: null, value: condition.threshold === undefined ? null : { threshold: condition.threshold },
    });
  }
}

/** The connections a compiled plan reads: every contributing object of every node's type. */
async function planConnections(deps: SchedulerDeps, ctx: Context, planId: string): Promise<{ connectionIds: string[]; root: Root }> {
  const options = { request: ctx.request, correlationId: ctx.correlationId };
  const stored = await deps.services.call(getCompiledPlan, { params: { planId } }, options);
  const manifest = await deps.services.call(getVersionManifest, { params: { versionId: stored.ontologyVersionId } }, options);
  // A Cron always compiles against main (spec 25.3).
  if (manifest.version.branchKind !== 'main') {
    throw new AppError('validation', 'a Cron runs against main: compile its question on main, not on a branch', { code: 'cron.plan_on_branch' });
  }
  const ids = new Set<string>();
  for (const node of stored.plan.nodes) {
    // Over an interface: every implementing type (21.9).
    const types = node.objectTypeId !== undefined ? manifest.objectTypes.filter((t) => t.id === node.objectTypeId)
      : manifest.objectTypes.filter((t) => t.implements.some((i) => i.interfaceId === node.interfaceId));
    for (const type of types) for (const contributing of type.contributingObjects) ids.add(contributing.connectionId);
  }
  return { connectionIds: [...ids].sort(), root: { typeId: stored.plan.nodes[0]?.objectTypeId ?? '', versionId: stored.ontologyVersionId } };
}

/** The type a Cron's subject returns, and the ontology version it was checked against. */
interface Root { typeId: string; versionId: string }

interface Subject {
  savedViewId: string | null;
  objectSetId: string | null;
  connectionIds: string[];
  /** Absent for a finding-only Cron, which has no question and so no mutate action. */
  root?: Root | undefined;
  /** A watch: per connection, the change source its stream uses. */
  streams: { connectionId: string; sourceKind: ChangeStreamSubscription['sourceKind'] }[];
}

/** A change source as a subscription records it (spec 18.4): email notifications are the provider's events; OPC UA's are its subscription. */
const SUBSCRIPTION_SOURCE: Record<ChangeSourceKind, ChangeStreamSubscription['sourceKind']> = {
  webhook: 'webhook', cdc: 'cdc', poll: 'poll', email: 'provider_events', mqtt: 'mqtt', opcua: 'opcua_subscription',
};

/**
 * The subject the owner can run now (a Cron re-runs it, never exceeding them): a saved
 * question, or a saved object set (filter or explicit, on a type). A change trigger watches
 * an object set whose every source object has a subscribable change stream (it passed the
 * change-stream class; decision 2026-11-15): it is refused otherwise, and a schedule offered
 * (40.2). A polling fallback does not make a stream subscribable: a Cron that polls is a
 * scheduled Cron.
 */
/** A condition made only of finding conditions (spec 40.3). */
export const onlyFindings = (c: ConditionInput): boolean => c.kind === 'finding' || (c.kind === 'composite' && c.operands.every(onlyFindings));

/**
 * A finding-only Cron (spec 40.3): no question, on a schedule; its condition is finding
 * conditions alone and its actions notify or escalate, since a report or a mutation acts on a
 * question's answer.
 */
function findingOnlySubject(input: CreateInput, watch: Watch | undefined): Subject {
  if (watch !== undefined) throw new AppError('validation', 'a change trigger watches an object set', { code: 'scheduler.watch_needs_object_set' });
  if (input.condition === undefined || !onlyFindings(input.condition)) {
    throw new AppError('validation', 'a Cron with no question runs on finding conditions alone: name a detector and an object type', {
      code: 'scheduler.finding_only_conditions',
    });
  }
  if (input.actions.some((a) => a.kind === 'report' || a.kind === 'mutate')) {
    throw new AppError('validation', 'a Cron with no question notifies or escalates: a report or a mutation acts on a question\'s answer', {
      code: 'scheduler.finding_only_actions',
    });
  }
  return { savedViewId: null, objectSetId: null, connectionIds: [], streams: [] };
}

async function resolveSubject(deps: SchedulerDeps, ctx: Context, me: Member, input: CreateInput & { subject: NonNullable<CreateInput['subject']> },
  watch: Watch | undefined): Promise<Subject> {
  const options = { request: me.request, correlationId: ctx.correlationId };
  if ('savedViewId' in input.subject) {
    if (watch !== undefined) throw new AppError('validation', 'a change trigger watches an object set', { code: 'scheduler.watch_needs_object_set' });
    const savedViewId = input.subject.savedViewId;
    const opened = await deps.services.call(openView, { params: { viewId: savedViewId } }, options);
    if (opened.view.kind === 'object_set' || opened.view.manifestId === null) {
      throw unsupported('a Cron over an object set view: name the object set itself', 'scheduler.object_set_unsupported');
    }
    if (opened.view.access === 'view') {
      throw new AppError('forbidden', 'a Cron re-runs the question: you need run access to the view', { code: 'scheduler.view_not_runnable' });
    }
    if (opened.view.archivedAt !== null) throw new AppError('conflict', 'an archived view does not run', { code: 'scheduler.view_archived' });
    const plan = await planConnections(deps, ctx, opened.view.manifestId);
    return { savedViewId, objectSetId: null, ...plan, streams: [] };
  }
  const objectSetId = input.subject.objectSetId;
  if (input.actions.some((a) => a.kind === 'report')) {
    throw new AppError('validation', 'a report exports a saved question\'s answer: an object set has none', { code: 'scheduler.report_needs_question' });
  }
  const set = await deps.services.call(getObjectSet, { params: { objectSetId } }, options);
  if ((set.definition.kind !== 'filter' && set.definition.kind !== 'explicit') || set.baseTypeId === null) {
    throw unsupported(`a Cron over a ${set.definition.kind} set (filter and explicit sets on a type run)`, 'scheduler.object_set_unsupported');
  }
  const manifest = await deps.services.call(getManifest, { query: {} }, options);
  const type = manifest.objectTypes.find((t) => t.id === set.baseTypeId);
  if (type === undefined) throw new AppError('validation', 'the set\'s type is not visible to you', { code: 'scheduler.object_set_unsupported' });
  const connectionIds = [...new Set(type.contributingObjects.map((c) => c.connectionId))].sort();
  const streams: Subject['streams'] = [];
  if (watch !== undefined) {
    const unknown = watch.properties.find((p) => !type.properties.some((x) => x.identityId === p));
    if (unknown !== undefined) throw new AppError('validation', 'a watched property is not one of the set\'s type', { code: 'scheduler.watch_property' });
    await inTransaction(deps.databases.pool('control'), me.request, async (db) => {
      for (const c of type.contributingObjects) {
        const connection = await connectionRepo.findById(db, c.connectionId);
        const row = connection === undefined ? undefined : await connectorManifestRepo.findById(db, connection.manifestId);
        const document = row === undefined ? undefined : manifestSchema.parse(row.document);
        const stream = document?.changeStream?.objects.find((o) => o.object === c.sourceObject);
        if (stream === undefined || stream.sources.length === 0) {
          throw new AppError('validation', `${c.sourceObject} has no change stream to watch: give the Cron a schedule instead`, {
            code: 'scheduler.no_change_stream', details: { connectionId: c.connectionId },
          });
        }
        const gate = (await subscribabilityOf(db, connection!, [c.sourceObject])).get(c.sourceObject)!;
        if (!gate.subscribable) {
          throw new AppError('validation', `${c.sourceObject}'s change stream is not subscribable (it has not passed change-stream conformance): give the Cron a schedule instead`, {
            code: 'scheduler.not_subscribable', details: { connectionId: c.connectionId, failed: gate.failed.join(',') },
          });
        }
        streams.push({ connectionId: c.connectionId, sourceKind: SUBSCRIPTION_SOURCE[stream.sources[0]!.kind] });
      }
    }, { readOnly: true });
  }
  return { savedViewId: null, objectSetId, connectionIds, root: { typeId: type.id, versionId: manifest.version.id }, streams };
}

export async function createCron(deps: SchedulerDeps, ctx: Context, input: CreateInput): Promise<CronView> {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'automation.create' });
  const watch = 'watch' in input.trigger ? input.trigger.watch : undefined;
  const expression = 'schedule' in input.trigger ? input.trigger.schedule : null;
  if (input.condition !== undefined) {
    checkCondition(input.condition, 1);
    await checkFindings(deps, ctx, input.condition);
  }
  if (input.actions.some((a) => a.kind === 'report')) await demand(deps, ctx, { permission: 'file.export' });
  const subject = input.subject === undefined ? findingOnlySubject(input, watch) : await resolveSubject(deps, ctx, me, { ...input, subject: input.subject }, watch);
  const connectionIds = subject.connectionIds;
  const mutateChecks = new Map<number, string[]>();
  for (const [i, action] of input.actions.entries()) {
    if (action.kind === 'mutate') mutateChecks.set(i, await checkMutate(deps, ctx, action, subject.root!));
  }

  // A mutate action's parameter values, sealed to the row they are written in (they may be record values).
  const sealedActions = new Map<number, { id: string; parameterValues: Buffer }>();
  for (const [i, action] of input.actions.entries()) {
    if (action.kind !== 'mutate' || action.parameters === undefined || Object.keys(action.parameters).length === 0) continue;
    const actionId = uuidv7();
    const [sealed] = await deps.services.call(sealRecordValues, {
      body: { items: [{ binding: { table: 'automation.automation_actions', id: actionId, column: 'parameter_values' }, value: canonicalJsonBytes({ v: action.parameters }).toString('base64') }] },
    }, { request: ctx.request, correlationId: ctx.correlationId }).then((out) => out.items);
    sealedActions.set(i, { id: actionId, parameterValues: Buffer.from(sealed!, 'base64') });
  }

  const control = deps.databases.pool('control');
  const now = deps.now();
  const id = uuidv7();
  const principalId = uuidv7();
  try {
    return await inTransaction(control, me.request, async (db) => {
      const organisation = await organisationRepo.findById(db, me.organisationId);
      const timezone = organisation?.calendarTimeZone ?? 'UTC';
      if (!validTimeZone(timezone)) throw new AppError('integrity', 'the organisation\'s time zone is not known', { code: 'scheduler.time_zone_unknown' });
      const schedule = expression === null ? undefined : checkSchedule(expression, timezone, deps.config.minIntervalMinutes, now);
      await checkRecipients(db, input.actions);
      await servicePrincipalRepo.insert(db, {
        id: principalId, organisationId: me.organisationId, kind: 'automation', name: `Cron ${id}`, scopeId: null,
        ownerMembershipId: me.membershipId, secretHash: null, expiresAt: null, createdBy: me.membershipId,
      });
      const row = await automationRepo.insert(db, {
        id, organisationId: me.organisationId, ownerMembershipId: me.membershipId, servicePrincipalId: principalId, name: input.name,
        savedViewId: subject.savedViewId, objectSetId: subject.objectSetId, schedule: expression, watch: (watch ?? null) as never, timezone, status: 'active',
        pausedReason: null, failurePolicy: input.failurePolicy,
        // A watching Cron is due only when a change makes it so.
        nextRunAt: schedule === undefined ? null : new Date(nextOccurrence(schedule, now, timezone)!).toISOString(),
      });
      // Its consumers of the streams it watches (spec 18.3).
      for (const s of subject.streams) {
        await changeStreamSubscriptionRepo.insert(db, {
          id: uuidv7(), organisationId: me.organisationId, connectionId: s.connectionId, objectSetRef: { objectSetId: subject.objectSetId } as never,
          consumerKind: 'cron', cronId: id, sourceKind: s.sourceKind, createdBy: me.membershipId,
        });
      }
      if (input.condition !== undefined) await insertCondition(db, me.organisationId, id, input.condition, null, 0);
      for (const [i, action] of input.actions.entries()) await insertAction(db, me.organisationId, id, action, i + 1, me.membershipId, mutateChecks.get(i), sealedActions.get(i));
      // An execute authorisation is a person's, recorded as theirs (40.5).
      for (const action of input.actions) {
        if (action.kind !== 'mutate' || action.mode !== 'execute') continue;
        await recordEvent(db, me.organisationId, ctx.correlationId, {
          event: 'automation_authorised', actor: memberActor(me.membershipId), resource: { type: 'automation', id },
          detail: { mode: 'execute', max_rows: action.maxRows ?? 0, properties: action.properties?.length ?? 0, connections: action.connectionIds?.length ?? 0 },
        });
      }
      await automationRunStateRepo.insert(db, { organisationId: me.organisationId, automationId: id });
      await automationConnectionRepo.replaceFor(db, me.organisationId, id, connectionIds);
      await recordEvent(db, me.organisationId, ctx.correlationId, {
        event: 'service_principal_created', actor: memberActor(me.membershipId), subjectMembershipId: me.membershipId,
        resource: { type: 'service_principal', id: principalId }, detail: { kind: 'automation' },
      });
      await recordEvent(db, me.organisationId, ctx.correlationId, {
        event: 'automation_created', actor: memberActor(me.membershipId), resource: { type: 'automation', id },
        detail: { actions: input.actions.length, conditioned: input.condition !== undefined, connections: connectionIds.length },
      });
      return cronViewOf(db, row);
    });
  } catch (error) {
    const mapped = fromDatabaseError(error);
    if (mapped.category === 'conflict' && mapped.code !== 'scheduler.view_archived') {
      throw new AppError('conflict', 'you already have a Cron by that name', { code: 'scheduler.name_taken' });
    }
    throw mapped;
  }
}

async function checkRecipients(db: Queryable, actions: readonly ActionInput[]): Promise<void> {
  const members = actions.flatMap((a) => a.kind === 'notify' ? (a.recipients ?? []) : a.kind === 'escalate' && a.membershipId ? [a.membershipId] : []);
  for (const membershipId of new Set(members)) {
    if ((await membershipRepo.findById(db, membershipId))?.status !== 'active') {
      throw new AppError('validation', 'a recipient is not an active member', { code: 'scheduler.recipient_unknown' });
    }
  }
  for (const action of actions) {
    if (action.kind === 'escalate' && action.scopeId !== undefined && !await scopeRepo.findById(db, action.scopeId)) {
      throw new AppError('validation', 'no such scope to escalate to', { code: 'scheduler.scope_unknown' });
    }
  }
}

/**
 * A mutate action's checks (see the header). Returns the connections its authorisation names:
 * execute's, or every connection the Action type may write through.
 */
async function checkMutate(deps: SchedulerDeps, ctx: Context, action: Extract<ActionInput, { kind: 'mutate' }>, root: Root): Promise<string[]> {
  const refuse = (message: string, code: string) => new AppError('validation', message, { code });
  await demand(deps, ctx, { permission: 'mutation.propose' });
  const execute = action.mode === 'execute';
  if (execute) await demand(deps, ctx, { permission: 'automation.execute' });
  const options = { request: ctx.request, correlationId: ctx.correlationId };
  const type = await deps.services.call(getActionType, { params: { actionTypeId: action.actionTypeId } }, options);
  const version = type.current;
  if (type.status !== 'confirmed' || version === null) throw refuse('a Cron mutates through a confirmed Action type', 'scheduler.mutate_type_unconfirmed');
  if (root.typeId !== version.objectTypeId) throw refuse('the Action type changes the question\'s own object type', 'scheduler.mutate_type_mismatch');
  const manifest = await deps.services.call(getVersionManifest, { params: { versionId: root.versionId } }, options);
  const objectType = manifest.objectTypes.find((t) => t.id === version.objectTypeId);
  if (objectType === undefined) throw refuse('the question\'s object type is not in its ontology version', 'scheduler.mutate_type_unknown');
  // Its parameter values: every one it needs, none it does not declare, each of its type.
  const given = (action.parameters ?? {}) as Record<string, unknown>;
  const missing = version.parameters.find((p) => p.required && p.default === undefined && (given[p.name] === undefined || given[p.name] === null));
  if (missing !== undefined) throw refuse(`the Action type needs ${missing.name}: give its value with the action`, 'scheduler.mutate_parameters');
  const undeclared = Object.keys(given).find((name) => !version.parameters.some((p) => p.name === name));
  if (undeclared !== undefined) throw refuse(`${undeclared} is not a parameter of the Action type`, 'scheduler.mutate_parameter_unknown');
  for (const p of version.parameters) {
    const v = given[p.name];
    if (v === undefined || v === null) continue;
    const ok = p.type === 'integer' ? Number.isInteger(v) : p.type === 'decimal' ? typeof v === 'number'
      : p.type === 'boolean' ? typeof v === 'boolean' : p.type === 'string' || p.type === 'date' || p.type === 'timestamp' || p.type === 'enumeration' ? typeof v === 'string' : true;
    if (!ok) throw refuse(`${p.name} is not a ${p.type}`, 'scheduler.mutate_parameter_type');
  }
  if (!execute) return [...version.permittedConnections].sort();
  if (version.riskClass === 'physical') {
    // Recorded as refused (47.8): a Cron may propose a physical Action, never execute one (47.2).
    await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
      await recordEvent(db, ctx.request.organisationId!, ctx.correlationId, {
        event: 'physical_cron_execute_refused', actor: memberActor(ctx.request.membershipId!), resource: { type: 'action_type', id: action.actionTypeId },
        detail: { action_type_version_id: version.id },
      });
      // Chapter 40's name for the same refusal (40.5), read beside the other automation events (D207).
      await recordEvent(db, ctx.request.organisationId!, ctx.correlationId, {
        event: 'automation_actuation_refused', actor: memberActor(ctx.request.membershipId!), resource: { type: 'action_type', id: action.actionTypeId },
        detail: { action_type_version_id: version.id, mode: 'execute' },
      });
    });
    throw refuse('a Cron never executes a physical Action (spec 40.5, 47.2)', 'scheduler.mutate_physical');
  }
  if (Date.parse(action.expiresAt!) <= deps.now()) throw refuse('the authorisation expires in the future', 'scheduler.mutate_expired');
  const unknown = action.properties!.find((p) => version.properties[p] === undefined);
  if (unknown !== undefined) throw refuse(`${unknown} is not a property the Action type may change`, 'scheduler.mutate_property');
  const outside = action.connectionIds!.find((c) => !version.permittedConnections.includes(c));
  if (outside !== undefined) throw refuse('a connection the Action type may not write through', 'scheduler.mutate_connection');
  return [...new Set(action.connectionIds!)].sort();
}

async function insertAction(db: Queryable, organisationId: string, automationId: string, action: ActionInput, sequence: number,
  authorisedBy: string, connections?: string[], sealed?: { id: string; parameterValues: Buffer }): Promise<void> {
  const base = { id: sealed?.id ?? uuidv7(), organisationId, automationId, sequence, actionTypeId: null, authorisationId: null };
  if (action.kind === 'mutate') {
    const authorisationId = uuidv7();
    const execute = action.mode === 'execute';
    await automationAuthorisationRepo.insert(db, {
      id: authorisationId, organisationId, automationId, mode: execute ? 'execute' : 'propose', maxRows: execute ? action.maxRows! : null,
      permittedFields: execute ? action.properties! : null, authorisedBy, expiresAt: execute ? action.expiresAt! : null,
    });
    for (const connectionId of connections ?? []) await authorisationConnectionRepo.insert(db, { organisationId, authorisationId, connectionId });
    await automationActionRepo.insert(db, { ...base, kind: 'mutate', configuration: { mode: action.mode ?? 'propose', parameters: Object.keys(action.parameters ?? {}).sort() },
      actionTypeId: action.actionTypeId, authorisationId, escalateMembershipId: null, escalateScopeId: null, parameterValues: sealed?.parameterValues ?? null });
    return;
  }
  if (action.kind === 'notify') {
    await automationActionRepo.insert(db, { ...base, kind: 'notify', configuration: { recipients: [...new Set(action.recipients ?? [])] },
      escalateMembershipId: null, escalateScopeId: null });
  } else if (action.kind === 'report') {
    await automationActionRepo.insert(db, { ...base, kind: 'report', configuration: { format: action.format ?? 'csv', folderId: action.folderId ?? null },
      escalateMembershipId: null, escalateScopeId: null });
  } else if (action.kind === 'escalate') {
    await automationActionRepo.insert(db, { ...base, kind: 'escalate',
      configuration: action.acknowledgeWithinHours === undefined ? {} : { acknowledgeWithinHours: action.acknowledgeWithinHours },
      escalateMembershipId: action.membershipId ?? null, escalateScopeId: action.scopeId ?? null });
  }
}

// ----------------------------------------------------------------------------- reading

/** Whether a live share reaches the member and the owner's current sharing policy still permits it (40.8, as 37.4). */
async function sharedWith(db: Queryable, row: Automation, membershipId: string): Promise<boolean> {
  const shares = await viewShareRepo.liveReachingAutomation(db, row.id, membershipId);
  if (shares.length === 0) return false;
  const policy = await effectivePolicy(db, row.organisationId, row.ownerMembershipId);
  for (const share of shares) if (await permitted(db, row.ownerMembershipId, granteeOf(share), policy)) return true;
  return false;
}

/**
 * The Cron, if the caller owns it, may manage others', or (to read it and its runs, never to
 * change it) holds a live share of it: sharing shares visibility and history, never
 * authorisation (spec 40.8).
 */
async function reachable(deps: SchedulerDeps, ctx: Context, me: Member, cronId: string, forChange: boolean): Promise<Automation> {
  const found = await inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const row = await automationRepo.findById(db, cronId);
    if (!row || row.deletedAt !== null) return undefined;
    return { row, shared: !forChange && row.ownerMembershipId !== me.membershipId && await sharedWith(db, row, me.membershipId) };
  }, { readOnly: true });
  if (found === undefined) throw cronNotFound();
  if (found.row.ownerMembershipId === me.membershipId) return found.row;
  if (await allowed(deps, ctx, { permission: 'automation.manage' })) return found.row;
  if (found.shared) return found.row;
  throw cronNotFound();
}

export async function getCron(deps: SchedulerDeps, ctx: Context, cronId: string): Promise<CronView> {
  const me = member(ctx);
  const row = await reachable(deps, ctx, me, cronId, false);
  return inTransaction(deps.databases.pool('control'), me.request, (db) => cronViewOf(db, row), { readOnly: true });
}

export async function listCrons(deps: SchedulerDeps, ctx: Context, which: 'mine' | 'managed' | 'shared'): Promise<CronView[]> {
  const me = member(ctx);
  if (which === 'managed') await demand(deps, ctx, { permission: 'automation.manage' });
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    if (which === 'shared') {
      const out: CronView[] = [];
      for (const id of await viewShareRepo.automationsReaching(db, me.membershipId)) {
        const row = await automationRepo.findById(db, id);
        if (row && row.deletedAt === null && row.ownerMembershipId !== me.membershipId && await sharedWith(db, row, me.membershipId)) out.push(await cronViewOf(db, row));
      }
      return out;
    }
    const rows = which === 'mine' ? await automationRepo.listForOwner(db, me.membershipId) : await automationRepo.listAll(db);
    return Promise.all(rows.map((row) => cronViewOf(db, row)));
  }, { readOnly: true });
}

/** Runs as their history shows them: each with its actions, counts only, never values. */
async function runViewsOf(db: Queryable, runs: AutomationRun[]): Promise<CronRunView[]> {
  const actions = await automationRunActionRepo.listForRuns(db, runs.map((r) => r.id));
  return runs.map((run) => ({
      id: run.id, trigger: run.triggerKind, status: run.status, startedAt: run.startedAt, completedAt: run.completedAt,
      conditionOutcome: run.conditionOutcome, skippedReason: run.skippedReason, error: run.error,
      actions: actions.filter((a) => a.runId === run.id).map((a) => ({
        id: a.id, sequence: a.sequence, kind: a.actionKind, outcome: a.outcome, resultCounts: a.resultCounts as Record<string, unknown> | null,
        fileId: a.fileId, mutationId: a.mutationId, escalatedMembershipId: a.escalatedMembershipId, escalatedScopeId: a.escalatedScopeId, acknowledgedAt: a.acknowledgedAt,
        error: a.error,
      })),
  }));
}

export async function listRuns(deps: SchedulerDeps, ctx: Context, cronId: string, limit: number): Promise<CronRunView[]> {
  const me = member(ctx);
  await reachable(deps, ctx, me, cronId, false);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => runViewsOf(db, await automationRunRepo.history(db, cronId, limit)),
    { readOnly: true });
}

/** Home's "Crons that fired" (spec 33.7): runs since a moment on the member's own Crons and the ones they follow and may still read. */
export async function listFiredRuns(deps: SchedulerDeps, ctx: Context, input: { since: string; followedCronIds: string[]; limit: number })
  : Promise<{ runs: { cronId: string; cronName: string; owned: boolean; run: CronRunView }[]; more: boolean }> {
  const me = member(ctx);
  const manager = input.followedCronIds.length > 0 && await allowed(deps, ctx, { permission: 'automation.manage' });
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const crons = new Map<string, { name: string; owned: boolean }>();
    for (const row of await automationRepo.listForOwner(db, me.membershipId)) {
      if (row.deletedAt === null) crons.set(row.id, { name: row.name, owned: true });
    }
    for (const id of new Set(input.followedCronIds)) {
      if (crons.has(id)) continue;
      const row = await automationRepo.findById(db, id);
      if (row && row.deletedAt === null && (manager || await sharedWith(db, row, me.membershipId))) crons.set(row.id, { name: row.name, owned: false });
    }
    const runs = await automationRunRepo.startedSince(db, [...crons.keys()], input.since, input.limit + 1);
    const views = await runViewsOf(db, runs.slice(0, input.limit));
    return {
      runs: views.map((run, i) => {
        const cron = crons.get(runs[i]!.automationId)!;
        return { cronId: runs[i]!.automationId, cronName: cron.name, owned: cron.owned, run };
      }),
      more: runs.length > input.limit,
    };
  }, { readOnly: true });
}

// ----------------------------------------------------------------------------- sharing (40.8)

/** The owner shares the Cron for its visibility and run history, within the sharing policy (40.8, as 37.4). */
export async function shareCron(deps: SchedulerDeps, ctx: Context, cronId: string, input: { grantee: ShareGrantee; expiresAt?: string | undefined })
  : Promise<ViewShareView> {
  const me = member(ctx);
  if (input.expiresAt !== undefined && Date.parse(input.expiresAt) <= deps.now()) {
    throw new AppError('validation', 'a share expires in the future', { code: 'scheduler.share_expiry_past' });
  }
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const row = await automationRepo.findById(db, cronId);
    if (!row || row.deletedAt !== null || row.ownerMembershipId !== me.membershipId) throw cronNotFound();
    const grantee = input.grantee;
    if (grantee.kind === 'membership') {
      if (grantee.membershipId === me.membershipId) throw new AppError('validation', 'a Cron is not shared with its owner', { code: 'scheduler.share_self' });
      const target = await membershipRepo.findById(db, grantee.membershipId);
      if (!target || target.status !== 'active') {
        throw new AppError('validation', 'share with an active member of this organisation', { code: 'scheduler.share_grantee_unknown' });
      }
    } else if (grantee.kind === 'scope') {
      const scope = await scopeRepo.findById(db, grantee.scopeId);
      if (!scope || scope.archivedAt !== null) throw new AppError('validation', 'no such scope', { code: 'scheduler.share_grantee_unknown' });
    }
    const policy = await effectivePolicy(db, me.organisationId, me.membershipId);
    if (!await permitted(db, me.membershipId, grantee, policy)) {
      throw new AppError('forbidden', `the sharing policy (${policy.viewSharingPolicy}) does not allow this share`, {
        code: 'scheduler.share_forbidden', details: { policy: policy.viewSharingPolicy },
      });
    }
    const now = new Date(deps.now()).toISOString();
    const existing = await viewShareRepo.findForAutomationGrantee(db, cronId, {
      ...(grantee.kind === 'membership' ? { membershipId: grantee.membershipId } : {}),
      ...(grantee.kind === 'scope' ? { scopeId: grantee.scopeId } : {}),
      ...(grantee.kind === 'organisation' ? { organisation: true as const } : {}),
    });
    const share = existing
      ? (await viewShareRepo.update(db, existing.id, { expiresAt: input.expiresAt ?? null, revokedAt: null, suspendedAt: null, sharedBy: me.membershipId, sharedAt: now }))!
      : await viewShareRepo.insert(db, {
        id: uuidv7(), organisationId: me.organisationId, automationId: cronId,
        membershipId: grantee.kind === 'membership' ? grantee.membershipId : null, scopeId: grantee.kind === 'scope' ? grantee.scopeId : null,
        organisationWide: grantee.kind === 'organisation' ? true : null, access: 'view', sharedBy: me.membershipId, sharedAt: now,
        expiresAt: input.expiresAt ?? null,
      });
    await recordEvent(db, me.organisationId, ctx.correlationId, {
      event: 'automation_shared', actor: memberActor(me.membershipId), resource: { type: 'automation', id: cronId },
      ...(grantee.kind === 'membership' ? { subjectMembershipId: grantee.membershipId } : {}),
      ...(grantee.kind === 'scope' ? { scopeId: grantee.scopeId } : {}),
      detail: { share_id: share.id, grantee: grantee.kind, expires: input.expiresAt !== undefined, change: 'shared' },
    });
    return cronShareViewOf(db, share, me.membershipId, policy);
  });
}

async function cronShareViewOf(db: Queryable, share: ViewShare, ownerId: string, policy: EffectivePolicy): Promise<ViewShareView> {
  let state: ViewShareView['state'] = share.revokedAt !== null ? 'revoked' : share.suspendedAt !== null ? 'suspended'
    : share.expiresAt !== null && Date.parse(share.expiresAt) <= Date.now() ? 'expired' : 'live';
  if (state === 'live' && !await permitted(db, ownerId, granteeOf(share), policy)) state = 'forbidden_by_policy';
  return {
    id: share.id, viewId: share.automationId!, grantee: granteeOf(share), access: share.access, sharedBy: share.sharedBy, sharedAt: share.sharedAt,
    expiresAt: share.expiresAt, revokedAt: share.revokedAt, suspendedAt: share.suspendedAt, state,
  };
}

export async function revokeCronShare(deps: SchedulerDeps, ctx: Context, cronId: string, shareId: string): Promise<ViewShareView> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const row = await automationRepo.findById(db, cronId);
    if (!row || row.ownerMembershipId !== me.membershipId) throw cronNotFound();
    const found = await viewShareRepo.findById(db, shareId);
    if (!found || found.automationId !== cronId) throw new AppError('not_found', 'no such share', { code: 'scheduler.share_not_found' });
    const share = found.revokedAt !== null ? found : (await viewShareRepo.update(db, found.id, { revokedAt: new Date(deps.now()).toISOString() }))!;
    if (found.revokedAt === null) {
      await recordEvent(db, me.organisationId, ctx.correlationId, {
        event: 'automation_shared', actor: memberActor(me.membershipId), resource: { type: 'automation', id: cronId },
        detail: { share_id: found.id, change: 'revoked' },
      });
    }
    return cronShareViewOf(db, share, me.membershipId, await effectivePolicy(db, me.organisationId, me.membershipId));
  });
}

export async function listCronShares(deps: SchedulerDeps, ctx: Context, cronId: string): Promise<ViewShareView[]> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const row = await automationRepo.findById(db, cronId);
    if (!row || row.ownerMembershipId !== me.membershipId) throw cronNotFound();
    const policy = await effectivePolicy(db, me.organisationId, me.membershipId);
    const out: ViewShareView[] = [];
    for (const share of await viewShareRepo.listForAutomation(db, cronId)) out.push(await cronShareViewOf(db, share, me.membershipId, policy));
    return out;
  }, { readOnly: true });
}

// ----------------------------------------------------------------------------- changing

export async function pauseCron(deps: SchedulerDeps, ctx: Context, cronId: string): Promise<CronView> {
  const me = member(ctx);
  await reachable(deps, ctx, me, cronId, true);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const row = (await automationRepo.findForUpdate(db, cronId))!;
    if (row.status !== 'active') return cronViewOf(db, row);
    const paused = (await automationRepo.update(db, cronId, {
      status: 'paused', pausedReason: 'manual', pausedAt: new Date(deps.now()).toISOString(), version: row.version + 1,
    }))!;
    await recordEvent(db, me.organisationId, ctx.correlationId, {
      event: 'automation_paused', actor: memberActor(me.membershipId), resource: { type: 'automation', id: cronId },
      subjectMembershipId: row.ownerMembershipId, detail: { reason: 'manual' },
    });
    return cronViewOf(db, paused);
  });
}

export async function resumeCron(deps: SchedulerDeps, ctx: Context, cronId: string): Promise<CronView> {
  const me = member(ctx);
  await reachable(deps, ctx, me, cronId, true);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const row = (await automationRepo.findForUpdate(db, cronId))!;
    if (row.status === 'stopped') throw new AppError('conflict', 'a stopped Cron does not resume', { code: 'scheduler.stopped' });
    if (row.status === 'active') return cronViewOf(db, row);
    if ((await membershipRepo.findById(db, row.ownerMembershipId))?.status !== 'active') {
      throw new AppError('conflict', 'a Cron never runs under an owner who is no longer active; it needs a new owner', { code: 'scheduler.owner_inactive' });
    }
    for (const connectionId of await automationConnectionRepo.listFor(db, cronId)) {
      const connection = await connectionRepo.findById(db, connectionId);
      if (connection?.status === 'halted' || connection?.status === 'revoked') {
        throw new AppError('conflict', 'a connection the question reads is halted; resume it first', { code: 'scheduler.connection_halted' });
      }
    }
    const now = deps.now();
    const next = nextOccurrence(parseSchedule(row.schedule!), now, row.timezone);
    const resumed = (await automationRepo.update(db, cronId, {
      status: 'active', pausedReason: null, pausedAt: null, nextRunAt: next === undefined ? null : new Date(next).toISOString(),
      leaseExpiresAt: null, version: row.version + 1,
    }))!;
    await automationRunStateRepo.update(db, { organisationId: row.organisationId, automationId: cronId }, { consecutiveFailures: 0 });
    await recordEvent(db, me.organisationId, ctx.correlationId, {
      event: 'automation_resumed', actor: memberActor(me.membershipId), resource: { type: 'automation', id: cronId },
      subjectMembershipId: row.ownerMembershipId, detail: { was: row.pausedReason },
    });
    return cronViewOf(db, resumed);
  });
}

export async function deleteCron(deps: SchedulerDeps, ctx: Context, cronId: string): Promise<CronView> {
  const me = member(ctx);
  await reachable(deps, ctx, me, cronId, true);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const row = (await automationRepo.findForUpdate(db, cronId))!;
    const at = new Date(deps.now()).toISOString();
    const deleted = (await automationRepo.update(db, cronId, {
      status: 'stopped', pausedReason: null, pausedAt: null, nextRunAt: null, leaseExpiresAt: null, deletedAt: at, version: row.version + 1,
    }))!;
    await servicePrincipalRepo.update(db, row.servicePrincipalId, { revokedAt: at });
    // What it was shared with and followed by ends with it.
    await viewShareRepo.revokeAllForAutomation(db, cronId, at);
    await followRepo.removeForResource(db, 'cron', cronId);
    await recordEvent(db, me.organisationId, ctx.correlationId, {
      event: 'automation_deleted', actor: memberActor(me.membershipId), resource: { type: 'automation', id: cronId },
      subjectMembershipId: row.ownerMembershipId,
    });
    await recordEvent(db, me.organisationId, ctx.correlationId, {
      event: 'service_principal_revoked', actor: memberActor(me.membershipId), resource: { type: 'service_principal', id: row.servicePrincipalId },
      subjectMembershipId: row.ownerMembershipId, detail: { kind: 'automation' },
    });
    return cronViewOf(db, deleted);
  });
}

/** By the member it was raised to, or a member of the scope (or a scope beneath it) it was raised to. */
export async function acknowledgeEscalation(deps: SchedulerDeps, ctx: Context, runActionId: string) {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const action = await automationRunActionRepo.findById(db, runActionId);
    if (!action || action.actionKind !== 'escalate') throw new AppError('not_found', 'no such escalation', { code: 'scheduler.escalation_not_found' });
    let mine = action.escalatedMembershipId === me.membershipId;
    if (!mine && action.escalatedScopeId !== null) {
      const scope = await scopeRepo.findById(db, action.escalatedScopeId);
      const paths = await scopeMembershipRepo.activeScopePaths(db, me.membershipId);
      mine = scope !== undefined && paths.some((p) => p === scope.path || p.startsWith(`${scope.path}.`));
    }
    if (!mine) throw new AppError('not_found', 'no such escalation', { code: 'scheduler.escalation_not_found' });
    const updated = action.acknowledgedAt !== null ? action
      : (await automationRunActionRepo.update(db, runActionId, { acknowledgedBy: me.membershipId, acknowledgedAt: new Date(deps.now()).toISOString() }))!;
    if (action.acknowledgedAt === null) {
      await recordEvent(db, me.organisationId, ctx.correlationId, {
        event: 'automation_escalation_acknowledged', actor: memberActor(me.membershipId), resource: { type: 'automation_run_action', id: runActionId },
      });
    }
    return {
      id: updated.id, sequence: updated.sequence, kind: updated.actionKind, outcome: updated.outcome,
      resultCounts: updated.resultCounts as Record<string, unknown> | null, fileId: updated.fileId, mutationId: updated.mutationId,
      escalatedMembershipId: updated.escalatedMembershipId, escalatedScopeId: updated.escalatedScopeId,
      acknowledgedAt: updated.acknowledgedAt, error: updated.error,
    };
  });
}

export { CRON_STATUSES, PAUSED_REASONS, cronActor };
