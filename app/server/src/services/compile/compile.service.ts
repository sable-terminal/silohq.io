// The compile stage (spec 26.2): vocabulary → model → compile → plan → bounds → charge →
// execute, in that order and no other.
//
// - vocabulary: the reader's, resolved before the model is called (planner/access);
// - model: model-gateway, role compile, names and types only, with the organisation's
//   calendar and today's date so a phrase can be recognised as a period (26.4);
// - compile: the output is checked against the plan schema and for referential truth; one
//   re-prompt after a schema failure, without any data, then a refusal (26.5);
// - plan and bounds: the planner decomposes it against the reader's access and states its
//   bounds; a plan over them is refused before anything runs (26.10);
// - charge: weight 1, or 3 for an advanced compile (more than two hops), only once a plan
//   exists, keyed so a retry never charges twice; a charge refused names what ran out;
// - execute: the executor runs it.
// A structured plan (a saved view, an Explorer filter) enters at compile: vocabulary and
// bounds still first, no model call, never metered.
// Plans are kept in ontology.compiled_manifests as structure with placeholders, one row per
// manifest hash and policy version.

import { fieldAliasRepo } from '../../repos/ontology/index.repo.ts';
import { narrowFor, WIDEN_ON } from './narrowing.service.ts';
import { z } from 'zod';
import type {
  CompileOutcome, compileFailure, compilePlan, DeprecationNotice, getCompiledPlan, getVocabulary, runCompiledPlan,
} from '../../contracts/compile/compile.contract.ts';
import { openRecordValues, sealRecordValues } from '../../contracts/credential/recordValue.contract.ts';
import { runPlan, type queryResult } from '../../contracts/executor/result.contract.ts';
import { charge, CHARGE_REFUSALS } from '../../contracts/metering/charge.contract.ts';
import { duration } from '../../contracts/simulation/graph.contract.ts';
import { FAILURE_FORMS, statedFailure } from '../../contracts/simulation/scenario.contract.ts';
import type { OntologyManifest } from '../../contracts/ontology/manifest.contract.ts';
import { callModel, outputSpec, parseOutput } from '../../contracts/model-gateway/call.contract.ts';
import {
  ADVANCED_HOPS, explainPlan, PLAN_SCHEMA_VERSION, queryPlan, type PlanExplanation, type PlanParameters, type QueryPlan, type Refusal,
} from '../../contracts/planner/plan.contract.ts';
import { authorise } from '../../contracts/policy/decision.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { compileOutcomeKeys } from '../../infra/keyspaces.infra.ts';
import { inTransaction, type Databases } from '../../infra/postgres.infra.ts';
import type { RedisStore } from '../../infra/redis.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import type { ExecutorBounds } from '../../config/limits.config.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { organisationRepo, policyVersionRepo } from '../../repos/iam/index.repo.ts';
import { compiledManifestRepo, planBindingRepo } from '../../repos/ontology/index.repo.ts';
import { canonicalJsonBytes } from '../../utils/canonicalJson.util.ts';
import { sha256 } from '../../utils/crypto.util.ts';
import { AppError, fromDatabaseError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { recordQueryEvent, recordQueryEvents } from '../executor/events.service.ts';
import { reportLineageWriteFailure, writeLineage, type LineageActor } from '../lineage/writer.service.ts';
import { isRefusal, readerAccess, type ReaderAccess } from '../planner/access.service.ts';
import type { PlanCall } from '../planner/deps.service.ts';
import { activeVersion, manifestOf } from '../planner/manifests.service.ts';
import { localToday } from '../planner/period.service.ts';
import {
  CHAIN_INSTRUCTIONS, INSTRUCTIONS, INTENT_INSTRUCTIONS, modelOutputSchema, modelOutputWithChainSchema, modelOutputWithIntentAndChainSchema, modelOutputWithIntentSchema,
  planInNames, translate, type ModelOutput,
} from './modelPlan.service.ts';
import { compileChain, runChainSteps } from './analysis.service.ts';
import { analysisStep } from '../../contracts/compile/analysis.contract.ts';
import { bindIntent } from './intent.service.ts';
import { columnKey, modelVocabulary, vocabularyView } from './vocabulary.service.ts';

export interface CompileDeps {
  databases: Databases;
  services: ServiceClient;
  /** redis-data: keyed outcomes, for replay. */
  data: RedisStore;
  bounds: ExecutorBounds;
  logger: Logger;
  /** The object types a question is compiled against when the reader may see more (decision 2026-11-15). */
  narrowTypes: number;
}

const MODEL_OUTPUT = outputSpec('QueryPlan', modelOutputSchema);
/** Where a change may be asked for (Ask, 42.9): a plan, or an intent. */
const MODEL_OUTPUT_WITH_INTENT = outputSpec('QueryPlanOrIntent', modelOutputWithIntentSchema);
/** Where a chain may be the answer too (Ask's harder question, 37.8). */
const MODEL_OUTPUT_WITH_CHAIN = outputSpec('QueryPlanOrAnalysis', modelOutputWithChainSchema);
const MODEL_OUTPUT_WITH_INTENT_AND_CHAIN = outputSpec('QueryPlanIntentOrAnalysis', modelOutputWithIntentAndChainSchema);
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;

const callOf = (ctx: HandlerContext, purposeSessionIds?: readonly string[]): PlanCall => ({
  request: ctx.request, correlationId: ctx.correlationId, signal: ctx.signal, purposeSessionIds,
});
const opts = (ctx: HandlerContext) => ({ request: ctx.request, correlationId: ctx.correlationId });
const plannerDeps = (deps: CompileDeps) => ({ databases: deps.databases, services: deps.services, bounds: deps.bounds, logger: deps.logger });

async function allowed(deps: CompileDeps, ctx: HandlerContext, permission: string, purposeSessionIds?: readonly string[]): Promise<boolean> {
  const decision = await deps.services.call(authorise, {
    body: { permission, ...(purposeSessionIds === undefined ? {} : { purposeSessionIds: [...purposeSessionIds] }) },
  }, opts(ctx));
  return decision.decision === 'allow';
}

/**
 * A stored plan's lineage (spec 59.2, 59.3): an ask_prompt node (the plan's vocabulary
 * references, never a prompt's text), using the object type versions it reads and
 * traversing the link types it follows, written in the transaction that stores the plan,
 * so a plan over marked types carries their markings to every view made from it.
 */
async function planLineage(deps: CompileDeps, ctx: HandlerContext, plan: QueryPlan, manifestHash: Buffer) {
  const manifest = await manifestOf(plannerDeps(deps), callOf(ctx), plan.ontologyVersionId);
  const versions = new Map(manifest.objectTypes.map((t) => [t.id, t.typeVersionId]));
  const inputs = [
    // A plan over an interface uses the types implementing it (21.9).
    ...[...new Set(plan.nodes.flatMap((n) => (n.objectTypeId !== undefined ? [n.objectTypeId]
      : manifest.objectTypes.filter((t) => t.implements.some((i) => i.interfaceId === n.interfaceId)).map((t) => t.id))))].flatMap((typeId) => {
      const version = versions.get(typeId);
      return version === undefined ? [] : [{ node: { kind: 'object_type_version' as const, refId: typeId, version }, relation: 'uses' as const }];
    }),
    ...[...new Set(plan.hops.map((h) => h.linkTypeId))].map((linkTypeId) => ({
      node: { kind: 'link_type_version' as const, refId: linkTypeId, version: plan.ontologyVersionId }, relation: 'traverses' as const,
    })),
  ];
  return (planId: string) => ({ artefact: { kind: 'ask_prompt' as const, refId: planId, version: manifestHash.toString('hex') }, inputs });
}

const lineageActor = (ctx: HandlerContext): LineageActor => ({
  organisationId: ctx.request.organisationId!,
  createdBy: ctx.request.membershipId !== undefined ? { membershipId: ctx.request.membershipId } : { servicePrincipalId: ctx.request.servicePrincipalId },
});

/** Keeps a plan's structure, once per manifest hash and policy version; returns its id. */
async function keepPlan(deps: CompileDeps, ctx: HandlerContext, plan: QueryPlan, compileClass: 'standard' | 'advanced'): Promise<string> {
  const organisationId = ctx.request.organisationId!;
  const control = deps.databases.pool('control');
  const manifestHash = sha256(canonicalJsonBytes(plan));
  const lineageOf = await planLineage(deps, ctx, plan, manifestHash);
  const policyVersion = await inTransaction(control, ctx.request, async (db) =>
    String((await policyVersionRepo.findByOrganisationId(db, organisationId))?.version ?? 1), { readOnly: true });
  const key = { organisationId, manifestHash, policyVersion };
  const existing = await inTransaction(control, ctx.request, (db) => compiledManifestRepo.findByManifestHashAndPolicyVersion(db, key), { readOnly: true });
  if (existing) return existing.id;
  const periods = plan.nodes.flatMap((n, node) => (n.period ? [{ node, property: n.period.property, asWritten: n.period.asWritten, expression: n.period.expression }] : []));
  const planId = uuidv7();
  let markings: string[] = [];
  try {
    const kept = await inTransaction(control, ctx.request, async (db) => {
      const row = await compiledManifestRepo.insert(db, {
        id: planId, organisationId, kind: 'query', manifest: plan as never, manifestHash, schemaVersion: PLAN_SCHEMA_VERSION,
        ontologyVersionId: plan.ontologyVersionId, policyVersion, periodExpressions: periods.length === 0 ? null : periods as never, compileClass,
        ...(ctx.request.membershipId !== undefined ? { createdByMembershipId: ctx.request.membershipId } : { createdByServicePrincipalId: ctx.request.servicePrincipalId ?? null }),
      });
      // An artefact cannot exist without its lineage (spec 59.3).
      markings = (await writeLineage(db, lineageActor(ctx), lineageOf(row.id))).markingIds;
      return row.id;
    });
    // The prompt's vocabulary carries its entries' markings (62.4): recorded once, when the plan is first kept.
    if (markings.length > 0) {
      await recordQueryEvent(deps.databases, ctx.request, ctx.correlationId, 'prompt_vocabulary_marked', { markings: markings.length }, kept);
    }
    return kept;
  } catch (error) {
    if (isAppError(error) && error.code === 'lineage.write_failed') {
      await reportLineageWriteFailure(control, lineageActor(ctx), lineageOf(planId).artefact, ctx.correlationId, 'compile');
      throw error;
    }
    // Two identical compiles raced: the other row is this plan.
    if (fromDatabaseError(error).category !== 'conflict') throw error;
    const raced = await inTransaction(control, ctx.request, (db) => compiledManifestRepo.findByManifestHashAndPolicyVersion(db, key), { readOnly: true });
    if (!raced) throw error;
    return raced.id;
  }
}

/**
 * Keeps an analysis manifest (spec 37.8), once per hash and policy version, with its lineage: every
 * type and link its steps' plans use, as a plan's own lineage would name them. Returns its id.
 */
export async function keepAnalysis(deps: CompileDeps, ctx: HandlerContext, manifest: { schemaVersion: string; ontologyVersionId: string; steps: { plans: QueryPlan[] }[] })
  : Promise<string> {
  const organisationId = ctx.request.organisationId!;
  const control = deps.databases.pool('control');
  const manifestHash = sha256(canonicalJsonBytes(manifest));
  const plans = manifest.steps.flatMap((s) => s.plans);
  const parts = await Promise.all(plans.map((p) => planLineage(deps, ctx, p, manifestHash)));
  const inputs = [...new Map(parts.flatMap((part) => part('x').inputs).map((i) => [JSON.stringify(i), i])).values()];
  const policyVersion = await inTransaction(control, ctx.request, async (db) =>
    String((await policyVersionRepo.findByOrganisationId(db, organisationId))?.version ?? 1), { readOnly: true });
  const key = { organisationId, manifestHash, policyVersion };
  const existing = await inTransaction(control, ctx.request, (db) => compiledManifestRepo.findByManifestHashAndPolicyVersion(db, key), { readOnly: true });
  if (existing) return existing.id;
  const id = uuidv7();
  const artefact = { kind: 'ask_prompt' as const, refId: id, version: manifestHash.toString('hex') };
  try {
    return await inTransaction(control, ctx.request, async (db) => {
      await compiledManifestRepo.insert(db, {
        id, organisationId, kind: 'analysis', manifest: manifest as never, manifestHash, schemaVersion: manifest.schemaVersion,
        ontologyVersionId: manifest.ontologyVersionId, policyVersion, periodExpressions: null, compileClass: 'standard',
        ...(ctx.request.membershipId !== undefined ? { createdByMembershipId: ctx.request.membershipId } : { createdByServicePrincipalId: ctx.request.servicePrincipalId ?? null }),
      });
      // An artefact cannot exist without its lineage (spec 59.3).
      await writeLineage(db, lineageActor(ctx), { artefact, inputs });
      return id;
    });
  } catch (error) {
    if (isAppError(error) && error.code === 'lineage.write_failed') {
      await reportLineageWriteFailure(control, lineageActor(ctx), artefact, ctx.correlationId, 'compile');
      throw error;
    }
    if (fromDatabaseError(error).category !== 'conflict') throw error;
    const raced = await inTransaction(control, ctx.request, (db) => compiledManifestRepo.findByManifestHashAndPolicyVersion(db, key), { readOnly: true });
    if (!raced) throw error;
    return raced.id;
  }
}

/** The bounds stage: the planner's decomposition and bounds, or its refusal. */
export async function bound(deps: CompileDeps, ctx: HandlerContext, plan: QueryPlan, parameters: PlanParameters, purposeSessionIds?: readonly string[])
  : Promise<PlanExplanation | Refusal> {
  const out = await deps.services.call(explainPlan, {
    body: { plan, parameters, ...(purposeSessionIds === undefined ? {} : { purposeSessionIds: [...purposeSessionIds] }) },
  }, opts(ctx));
  return out.outcome === 'plan' ? out.explanation : out.refusal;
}

const classOf = (plan: QueryPlan): 'standard' | 'advanced' => (plan.hops.length > ADVANCED_HOPS ? 'advanced' : 'standard');

export async function execute(deps: CompileDeps, ctx: HandlerContext, plan: QueryPlan, parameters: PlanParameters, planId: string, trigger: string,
  purposeSessionIds?: readonly string[]): Promise<{ result: z.infer<typeof queryResult> } | { refusal: Refusal }> {
  const out = await deps.services.call(runPlan, {
    body: {
      plan, parameters, planId, trigger: trigger as never, useCache: true,
      ...(purposeSessionIds === undefined ? {} : { purposeSessionIds: [...purposeSessionIds] }),
    },
  }, { ...opts(ctx), timeoutMs: deps.bounds.wallTimeMs + 10_000 });
  return out.outcome === 'answer' ? { result: out.result } : { refusal: out.refusal };
}

/** The model call, with one re-prompt after a schema failure and no data in it (spec 26.5). */
async function askModel(deps: CompileDeps, ctx: HandlerContext, question: string, access: ReaderAccess, priorPlans: string[], focusTypeId: string | undefined,
  intents: boolean, aiAgent?: QuestionInput['aiAgent'], chains = false): Promise<ModelOutput | Refusal> {
  const instructions = `${intents ? INTENT_INSTRUCTIONS : INSTRUCTIONS}${chains ? `\n${CHAIN_INSTRUCTIONS}` : ''}`;
  const organisationId = ctx.request.organisationId!;
  const { organisation, columns } = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => ({
    organisation: await organisationRepo.findById(db, organisationId),
    // The organisation's names for its columns (21.6), heard as names for the properties mapped from them.
    columns: new Map((await fieldAliasRepo.live(db)).map((a) => [columnKey(a.connectionId, a.fieldPath), a.alias])),
  }), { readOnly: true });
  if (!organisation) throw new AppError('not_found', 'no such organisation', { code: 'compile.organisation_unknown' });
  const today = localToday(Date.now(), organisation.calendarTimeZone);
  // Where the question is asked from: a type the reader may see, named, never a value.
  const focus = focusTypeId === undefined ? undefined : access.types.get(focusTypeId)?.type;
  // An AI agent's brief is first, so a value pattern the gateway finds in it is named as the brief's (D236).
  const brief = aiAgent === undefined || aiAgent.brief.trim() === '' ? [] : [{ title: `AI agent brief: ${aiAgent.name}`, text: aiAgent.brief }];
  const documentation = [
    ...brief,
    ...(focus === undefined ? [] : [{ title: 'Asked from', text: `The question is asked from ${focus.displayName} (${focus.apiName}); where it does not say what it is about, it is about that type.` }]),
    ...priorPlans.map((text, i) => ({ title: `Earlier plan ${i + 1} in this thread`, text })),
  ];
  const body = {
    role: 'compile' as const,
    vocabulary: {
      ...modelVocabulary(access, columns),
      ...(documentation.length === 0 ? {} : { documentation }),
    },
    question,
    context: {
      today: `${String(today.y).padStart(4, '0')}-${String(today.m).padStart(2, '0')}-${String(today.d).padStart(2, '0')}`,
      timeZone: organisation.calendarTimeZone,
      ...(organisation.financialYearStartMonth === null ? {} : { fiscalYearStartMonth: organisation.financialYearStartMonth }),
      weekStartsOn: WEEKDAYS[organisation.weekStartDay - 1]!,
    },
    output: chains ? (intents ? MODEL_OUTPUT_WITH_INTENT_AND_CHAIN : MODEL_OUTPUT_WITH_CHAIN) : intents ? MODEL_OUTPUT_WITH_INTENT : MODEL_OUTPUT,
  };
  for (const attempt of [1, 2]) {
    try {
      const reply = await deps.services.call(callModel, {
        body: { ...body, instructions: attempt === 1 ? instructions : `${instructions}\nThe previous output did not match the required structure. Return only that structure.` },
      }, { ...opts(ctx), timeoutMs: 60_000 });
      const schema = chains ? (intents ? modelOutputWithIntentAndChainSchema : modelOutputWithChainSchema) : intents ? modelOutputWithIntentSchema : modelOutputSchema;
      return parseOutput(schema, reply.output) as ModelOutput;
    } catch (error) {
      if (!isAppError(error)) throw error;
      if (error.code === 'model.output_invalid' && attempt === 1) continue;
      if (error.code === 'model.output_invalid') return { code: 'compile.could_not_compile', reason: 'the question could not be compiled into a plan' };
      if (error.code === 'model.value_pattern' && brief.length > 0 && String(error.details['where'] ?? '').startsWith('vocabulary.documentation.0.')) {
        return {
          code: 'compile.ai_agent_brief_refused', reason: 'this AI agent\'s brief holds something that looks like a record value, which is never sent to a model',
          remedy: 'ask its owner to take the value out of the brief',
        };
      }
      if (error.code === 'model.value_pattern') {
        return {
          code: 'compile.question_refused', reason: 'the question contains something that looks like a record value, which is never sent to a model',
          remedy: 'ask it with the names of what you mean, and filter on values afterwards',
        };
      }
      if (['unavailable', 'upstream', 'timeout', 'bounds'].includes(error.category)) {
        return { code: 'compile.model_unavailable', reason: 'the model is not available to compile the question just now', remedy: 'try again shortly' };
      }
      throw error;
    }
  }
  return { code: 'compile.could_not_compile', reason: 'the question could not be compiled into a plan' };
}

export interface QuestionInput {
  question: string;
  ontologyVersionId?: string | undefined;
  branchId?: string | undefined;
  priorPlanIds: string[];
  rephraseOf?: string | undefined;
  focus?: { objectTypeId: string } | undefined;
  /** The question may ask for a change (Ask, 42.9). */
  intents?: boolean | undefined;
  /** The question may compile into a chain of analysis steps (37.8): an advanced compile. */
  chains?: boolean | undefined;
  /** Asked of an AI agent (D236): its brief, and the types it works with. */
  aiAgent?: { id: string; name: string; brief: string; objectTypeIds: string[]; tools: string[] } | undefined;
  chosen?: { about: 'object_type' | 'time_field' | 'route' | 'property'; elementId: string; rejectedIds: string[] } | undefined;
  bindingId?: string | undefined;
  execute: boolean;
  purposeSessionIds?: string[] | undefined;
}

/**
 * The vocabulary with the candidates a clarification was answered against left out (spec
 * 26.9): a type or property the person did not mean is not offered again, so the term now
 * names one thing. A type left out takes its links with it.
 */
/**
 * An AI agent's object types, of those the reader may see (D236): the model is offered no other.
 * A link stays only between two types kept. An agent naming no type keeps the reader's whole view.
 */
export function withinAiAgent(access: ReaderAccess, aiAgent: QuestionInput['aiAgent']): ReaderAccess {
  if (aiAgent === undefined || aiAgent.objectTypeIds.length === 0) return access;
  const kept = new Set(aiAgent.objectTypeIds);
  const types = new Map([...access.types].filter(([id]) => kept.has(id)));
  const links = new Map([...access.links].filter(([, l]) => types.has(l.link.fromTypeId) && types.has(l.link.toTypeId)));
  return { ...access, types, links };
}

export function narrowed(access: ReaderAccess, chosen: QuestionInput['chosen']): ReaderAccess {
  if (chosen === undefined || chosen.rejectedIds.length === 0) return access;
  const rejected = new Set(chosen.rejectedIds.filter((id) => id !== chosen.elementId));
  if (chosen.about === 'object_type') {
    const types = new Map([...access.types].filter(([id]) => !rejected.has(id)));
    const links = new Map([...access.links].filter(([, l]) => types.has(l.link.fromTypeId) && types.has(l.link.toTypeId)));
    return { ...access, types, links };
  }
  if (chosen.about === 'property') {
    const types = new Map([...access.types].map(([id, t]) => [id, { ...t, properties: new Map([...t.properties].filter(([pid]) => !rejected.has(pid))) }]));
    return { ...access, types };
  }
  return access;
}

/** Keeps the values bound into a plan sealed under the holder's id (an Ask turn, a saved view). */
export async function keepBinding(deps: CompileDeps, ctx: HandlerContext, bindingId: string, planId: string, parameters: PlanParameters): Promise<void> {
  const binding = { table: 'ontology.plan_bindings', id: bindingId, plan: planId };
  const sealed = await deps.services.call(sealRecordValues, {
    body: { items: [{ binding, value: Buffer.from(JSON.stringify(parameters)).toString('base64') }] },
  }, opts(ctx));
  await inTransaction(deps.databases.pool('control'), ctx.request, (db) => planBindingRepo.insertOnce(db, {
    id: bindingId, organisationId: ctx.request.organisationId!, compiledManifestId: planId, parameters: Buffer.from(sealed.items[0]!, 'base64'),
    createdByMembershipId: ctx.request.membershipId ?? null,
    createdByServicePrincipalId: ctx.request.membershipId === undefined ? ctx.request.servicePrincipalId ?? null : null,
  }));
}

/** The values a binding holds for its plan, opened; none when the holder has no binding. */
export async function boundParameters(deps: CompileDeps, ctx: HandlerContext, planId: string, bindingId: string | undefined): Promise<PlanParameters | Refusal> {
  if (bindingId === undefined) return {};
  const row = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => planBindingRepo.findById(db, bindingId), { readOnly: true });
  if (row === undefined) return {};
  if (row.compiledManifestId !== planId) {
    return { code: 'compile.binding_mismatch', reason: 'those values were bound to another plan', element: { kind: 'plan', id: planId } };
  }
  const opened = await deps.services.call(openRecordValues, {
    body: { items: [{ binding: { table: 'ontology.plan_bindings', id: bindingId, plan: planId }, sealed: row.parameters.toString('base64') }] },
  }, opts(ctx));
  return JSON.parse(Buffer.from(opened.items[0]!, 'base64').toString('utf8')) as PlanParameters;
}

export async function compileQuestion(deps: CompileDeps, ctx: HandlerContext, input: QuestionInput): Promise<CompileOutcome> {
  const call = callOf(ctx, input.purposeSessionIds);
  const event = (name: Parameters<typeof recordQueryEvent>[3], detail: Record<string, string | number | boolean | null>, planId?: string) =>
    recordQueryEvent(deps.databases, ctx.request, ctx.correlationId, name, detail, planId);
  const refused = async (refusal: Refusal): Promise<CompileOutcome> => {
    await event('compile_refused', { code: refusal.code });
    return { outcome: 'refusal', refusal };
  };

  if (!await allowed(deps, ctx, 'query.compile', input.purposeSessionIds)) {
    return refused({ code: 'compile.not_permitted', reason: 'you may not compile questions', element: { kind: 'plan' } });
  }
  // Vocabulary, before any model call.
  const versionId = input.ontologyVersionId ?? (await activeVersion(plannerDeps(deps), call, input.branchId)).id;
  const manifest = await manifestOf(plannerDeps(deps), call, versionId);
  const visible = await readerAccess(plannerDeps(deps), call, manifest);
  if (isRefusal(visible)) return refused(visible);
  // Spec 21.15, 57.11: each type the reader's markings left out, never resolved and filtered
  // afterwards, is recorded by reference with how many markings it lacks; never the question.
  await recordQueryEvents(deps.databases, ctx.request, ctx.correlationId, visible.droppedForMarkings.map((d) => ({
    event: 'type_dropped_from_plan' as const, resource: { type: 'object_type', id: d.objectTypeId },
    detail: { unsatisfied_markings: d.unsatisfiedMarkings, ontology_version_id: versionId },
  })));
  const access = narrowed(withinAiAgent(visible, input.aiAgent), input.chosen);
  if (access.types.size === 0 && input.aiAgent !== undefined && input.aiAgent.objectTypeIds.length > 0) {
    return refused({
      code: 'compile.ai_agent_nothing_visible', reason: 'none of the object types this AI agent works with is available to you',
      remedy: 'ask an administrator for access to them, or ask in a thread without the agent',
    });
  }
  if (access.types.size === 0) {
    return refused({ code: 'compile.nothing_visible', reason: 'no object type is available to you to ask about', remedy: 'ask an administrator for access' });
  }
  await event('compile_requested', {
    ontology_version_id: versionId, question_length: input.question.length, prior_plans: input.priorPlanIds.length, ai_agent_id: input.aiAgent?.id ?? null,
  });

  const prior: string[] = [];
  const priorTypes: string[] = [];
  for (const id of input.priorPlanIds) {
    const row = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => compiledManifestRepo.findById(db, id), { readOnly: true });
    const parsed = row ? queryPlan.safeParse(row.manifest) : undefined;
    const text = parsed?.success ? planInNames(parsed.data, access) : undefined;
    if (text !== undefined) prior.push(text);
    if (parsed?.success) priorTypes.push(...parsed.data.nodes.flatMap((n) => (n.objectTypeId === undefined ? [] : [n.objectTypeId])));
  }

  // Narrowing (decision 2026-11-15): a vocabulary larger than the bound is compiled against the
  // types the question is about, and against all of it once where that cannot answer.
  const narrowing = await narrowFor(deps, opts(ctx), {
    question: input.question, access, limit: deps.narrowTypes, keepAlso: [...(input.focus ? [input.focus.objectTypeId] : []), ...priorTypes],
  });

  // Model, then compile's two checks.
  let output = await askModel(deps, ctx, input.question, narrowing?.access ?? access, prior, input.focus?.objectTypeId, input.intents === true, input.aiAgent, input.chains === true);
  if (isRefusal(output)) return refused(output);
  let translated = translate(output, narrowing?.access ?? access, input.chosen);
  let widened = false;
  if (narrowing !== undefined && 'refusal' in translated && WIDEN_ON.has(translated.refusal.code)) {
    widened = true;
    output = await askModel(deps, ctx, input.question, access, prior, input.focus?.objectTypeId, input.intents === true, input.aiAgent, input.chains === true);
    if (isRefusal(output)) return refused(output);
    translated = translate(output, access, input.chosen);
  }
  const narrowedTo = narrowing === undefined ? {} : { narrowing: { objectTypeIds: narrowing.objectTypeIds, widened } };
  if ('refusal' in translated) return refused(translated.refusal);
  if ('clarification' in translated) {
    await event('compile_clarification_returned', { about: translated.clarification.about, options: translated.clarification.options.length });
    return { outcome: 'clarification', clarification: translated.clarification };
  }

  // Charge, only once a plan (or a compiled intent) exists, keyed so a retry never charges twice.
  type Charged = CompileOutcome extends infer O ? O extends { charge: infer C } ? C : never : never;
  const chargeFor = async (correlationId: string, compileClass: 'standard' | 'advanced'): Promise<Charged | Refusal> => {
    try {
      const key = `chg.${sha256(`${ctx.idempotencyKey ?? uuidv7()}`).toString('hex').slice(0, 48)}`;
      const out = await deps.services.call(charge, {
        body: { operation: compileClass === 'advanced' ? 'advanced_compile' : 'compile', correlationId, ...(input.rephraseOf ? { rephraseOf: input.rephraseOf } : {}) },
      }, { ...opts(ctx), idempotencyKey: key });
      return out.charged ? { charged: true, transactionId: out.transactionId, weight: out.weight } : { charged: false, reason: out.reason };
    } catch (error) {
      if (isAppError(error) && (CHARGE_REFUSALS as readonly string[]).includes(error.code ?? '')) {
        return {
          code: error.code!, reason: error.message.slice(0, 1_000), element: { kind: 'plan', id: correlationId },
          remedy: 'buy tokens, or ask again when the allowance renews',
        };
      }
      throw error;
    }
  };

  // An AI agent proposes only what its tools allow (D236): refused here, before anything is charged.
  const agentMay = (tool: string) => input.aiAgent === undefined || input.aiAgent.tools.includes(tool);
  if ('schedule' in translated && !agentMay('propose_cron')) {
    return refused({ code: 'compile.ai_agent_tool', reason: 'this AI agent may not propose Crons', remedy: 'ask it about your data, or ask for the Cron in a thread without the agent' });
  }
  if ('intent' in translated && !agentMay('propose_action')) {
    return refused({ code: 'compile.ai_agent_tool', reason: 'this AI agent may not propose changes', remedy: 'ask it about your data, or ask for the change in a thread without the agent' });
  }

  // A Cron asked for (36.4): the schedule compile wrote; Ask makes it a draft a person saves.
  if ('schedule' in translated) {
    if (input.intents !== true) {
      return refused({ code: 'compile.not_a_question', reason: 'that asks for a Cron: ask it in Ask, which drafts it for you to save' });
    }
    const charged = await chargeFor(uuidv7(), 'standard');
    if (isRefusal(charged)) return refused(charged);
    await event('plan_validated', { compile_class: 'standard', hops: 0, nodes: 0, narrowed: narrowing !== undefined, widened, schedule: true });
    return { outcome: 'schedule', compileClass: 'standard', charge: charged, schedule: translated.schedule };
  }

  // A change asked for (42.9): compiled and bound, never executed; Ask makes it a draft a person submits.
  if ('intent' in translated) {
    if (input.intents !== true) {
      return refused({ code: 'compile.not_a_question', reason: 'that asks for a change: ask it in Ask, which proposes it as an Action for you to submit' });
    }
    const intent = translated.intent;
    let targetsPlanId: string | null = null;
    if (intent.targets !== null) {
      const explanation = await bound(deps, ctx, intent.targets.plan, intent.targets.parameters, input.purposeSessionIds);
      if (isRefusal(explanation)) {
        await event('plan_bounds_refused', { code: explanation.code, ...(explanation.bound ? { bound: explanation.bound.name } : {}) });
        return refused(explanation);
      }
      targetsPlanId = await keepPlan(deps, ctx, intent.targets.plan, 'standard');
      if (input.bindingId !== undefined && Object.keys(intent.targets.parameters).length > 0) {
        await keepBinding(deps, ctx, input.bindingId, targetsPlanId, intent.targets.parameters);
      }
      await event('plan_validated', { compile_class: 'standard', hops: 0, nodes: 1, narrowed: narrowing !== undefined, widened, intent: true }, targetsPlanId);
    }
    const binding = await bindIntent(deps.services, ctx, intent);
    if (binding === null) {
      return refused({
        code: 'compile.generic_edit_disabled', reason: 'no confirmed Action type makes this change, and the organisation does not allow the generic edit',
        remedy: 'propose an Action type for this change to a holder of action.define',
      });
    }
    if (binding.candidates.length > 0) {
      // Which was chosen, or that the person chooses among several (42.12). References and counts, never a value.
      await recordQueryEvents(deps.databases, ctx.request, ctx.correlationId, [{
        event: 'action_intent_bound', resource: { type: 'object_type', id: intent.objectTypeId },
        detail: {
          operation: intent.operation, candidates: binding.candidates.length, properties: intent.set.length + intent.clear.length,
          action_type_id: binding.candidates.length === 1 ? binding.candidates[0]!.actionTypeId : null, targets_plan_id: targetsPlanId,
        },
      }]);
    }
    const charged = await chargeFor(targetsPlanId ?? uuidv7(), 'standard');
    if (isRefusal(charged)) return refused(charged);
    return {
      outcome: 'intent', compileClass: 'standard', charge: charged,
      intent: {
        objectTypeId: intent.objectTypeId, operation: intent.operation, set: Object.fromEntries(intent.set.map((s) => [s.apiName, s.value])),
        clear: intent.clear.map((c) => c.apiName), targetsPlanId, ...binding,
      },
    };
  }
  // A chain (37.8): an advanced compile, kept as an analysis manifest with its values under the
  // binding, charged once now that the chain plan exists, then (to answer) run step by step.
  if ('chain' in translated) {
    if (!agentMay('answer')) return refused({ code: 'compile.ai_agent_tool', reason: 'this AI agent may not answer questions' });
    if (!await allowed(deps, ctx, 'query.advanced', input.purposeSessionIds)) {
      return refused({
        code: 'compile.advanced_not_permitted', reason: 'the question needs a chain of steps, an advanced compile your seat does not include',
        element: { kind: 'plan' }, remedy: 'ask it as one question at a time, or ask for a Business or Enterprise seat',
      });
    }
    const bindingId = input.bindingId ?? uuidv7();
    // Typed as any chain's steps are, with each step's default bound.
    const typed = analysisStep.array().safeParse(translated.chain.steps);
    if (!typed.success) {
      return refused({ code: 'compile.plan_invalid', reason: 'the question compiled to steps that do not hold together, and they are refused rather than repaired', element: { kind: 'plan' } });
    }
    const kept = await compileChain(deps, ctx, { steps: typed.data, parameters: translated.chain.parameters, bindingId }, versionId);
    if (kept.outcome === 'refusal') {
      const r = kept.refused.refusal;
      if (r.bound !== undefined) await event('plan_bounds_refused', { code: r.code, bound: r.bound.name, step: kept.refused.position });
      return refused({ ...r, reason: `step ${kept.refused.position} (${kept.refused.operation.replace('_', ' ')}): ${r.reason}` });
    }
    await event('plan_validated', {
      compile_class: 'advanced', steps: kept.steps.length, hops: kept.steps.filter((x) => x.operation === 'traverse').length, nodes: 0,
      narrowed: narrowing !== undefined, widened, analysis: true,
    }, kept.manifestId);
    const charged = await chargeFor(kept.manifestId, 'advanced');
    if (isRefusal(charged)) return refused(charged);
    const steps = kept.steps.map(({ plans: _plans, ...rest }) => rest);
    if (!input.execute) return { outcome: 'analysis', manifestId: kept.manifestId, compileClass: 'advanced', charge: charged, steps };
    const ran = await runChainSteps(deps, ctx, kept.manifestId, { bindingId, trigger: 'authored', purposeSessionIds: input.purposeSessionIds });
    return { outcome: 'analysis', manifestId: kept.manifestId, compileClass: 'advanced', charge: charged, steps, ran: ran.steps };
  }

  const { plan, parameters } = translated;
  const compileClass = classOf(plan);
  if (compileClass === 'advanced' && !await allowed(deps, ctx, 'query.advanced', input.purposeSessionIds)) {
    return refused({
      code: 'compile.advanced_not_permitted', reason: `the question joins over more than ${ADVANCED_HOPS} links, an advanced compile your seat does not include`,
      element: { kind: 'plan' }, remedy: 'ask it in fewer steps, or ask for a Business or Enterprise seat',
    });
  }

  // Plan and bounds.
  const explanation = await bound(deps, ctx, plan, parameters, input.purposeSessionIds);
  if (isRefusal(explanation)) {
    await event('plan_bounds_refused', { code: explanation.code, ...(explanation.bound ? { bound: explanation.bound.name } : {}) });
    return refused(explanation);
  }
  const planId = await keepPlan(deps, ctx, plan, compileClass);
  if (input.bindingId !== undefined && Object.keys(parameters).length > 0) await keepBinding(deps, ctx, input.bindingId, planId, parameters);
  await event('plan_validated', {
    compile_class: compileClass, hops: plan.hops.length, nodes: plan.nodes.length,
    // Which set the question was compiled against, when narrowed: its size and a digest of its ids (the outcome carries them).
    narrowed: narrowing !== undefined, widened,
    narrowed_types: narrowing?.objectTypeIds.length ?? null,
    narrowed_set: narrowing === undefined ? null : sha256(narrowing.objectTypeIds.join(',')).toString('hex').slice(0, 32),
  }, planId);

  // Charge, only now that a plan exists.
  const charged = await chargeFor(planId, compileClass);
  if (isRefusal(charged)) return refused(charged);

  const notices = deprecationNotices(plan, manifest);
  const noted = notices.length === 0 ? {} : { notices };
  if (!input.execute) return { outcome: 'plan', planId, plan, parameters, compileClass, charge: charged, explanation, ...noted, ...narrowedTo };
  const ran = await execute(deps, ctx, plan, parameters, planId, 'authored', input.purposeSessionIds);
  if ('refusal' in ran) return refused(ran.refusal);
  return { outcome: 'answer', planId, plan, parameters, compileClass, charge: charged, result: ran.result, ...noted, ...narrowedTo };
}

/** The deprecated object types and link types a plan uses, each once (spec 25.7). */
export function deprecationNotices(plan: QueryPlan, manifest: OntologyManifest): DeprecationNotice[] {
  const notices = new Map<string, DeprecationNotice>();
  const note = (elementKind: DeprecationNotice['elementKind'], e: { id: string; apiName: string; status: string; replacedById?: string | null | undefined; retireAfter?: string | undefined } | undefined) => {
    if (e === undefined || e.status !== 'deprecated' || notices.has(e.id)) return;
    notices.set(e.id, { kind: 'deprecated', elementKind, elementId: e.id, apiName: e.apiName, replacedById: e.replacedById ?? null, retireAfter: e.retireAfter ?? null });
  };
  for (const n of plan.nodes) note('object_type', manifest.objectTypes.find((t) => t.id === n.objectTypeId));
  for (const h of plan.hops) note('link_type', manifest.linkTypes.find((l) => l.id === h.linkTypeId));
  return [...notices.values()];
}

/** Keeps the outcome of a keyed compile for a retry; returns the reference the key records. */
export async function keepOutcome(deps: CompileDeps, ctx: HandlerContext, outcome: CompileOutcome): Promise<string> {
  const compileId = uuidv7();
  await deps.data.put(compileOutcomeKeys, compileOutcomeKeys.key(ctx.request.organisationId!, { compileId }), outcome as unknown as Record<string, unknown>);
  return compileId;
}

export async function replayOutcome(deps: CompileDeps, ctx: HandlerContext, ref: string | undefined): Promise<CompileOutcome> {
  const kept = ref === undefined ? undefined : await deps.data.read(compileOutcomeKeys, compileOutcomeKeys.key(ctx.request.organisationId!, { compileId: ref }));
  if (kept === undefined) {
    throw new AppError('conflict', 'this request already ran and its reply has expired; ask again with a new key', { code: 'compile.replay_expired' });
  }
  return kept as unknown as CompileOutcome;
}

/** A plan in structure (spec 26.2): vocabulary and bounds first, no model call, never metered. */
export async function compileStructured(deps: CompileDeps, ctx: HandlerContext, input: z.output<typeof compilePlan.body>)
  : Promise<z.output<typeof compilePlan.response>> {
  const explanation = await bound(deps, ctx, input.plan, input.parameters, input.purposeSessionIds);
  if (isRefusal(explanation)) {
    await recordQueryEvent(deps.databases, ctx.request, ctx.correlationId, 'plan_bounds_refused', { code: explanation.code });
    return { outcome: 'refusal', refusal: explanation };
  }
  const planId = await keepPlan(deps, ctx, input.plan, classOf(input.plan));
  if (!input.execute) return { outcome: 'plan', planId, explanation };
  const ran = await execute(deps, ctx, input.plan, input.parameters, planId, input.trigger, input.purposeSessionIds);
  return 'refusal' in ran ? { outcome: 'refusal', refusal: ran.refusal } : { outcome: 'answer', planId, result: ran.result };
}

/** A stored plan run with its bound values, under the caller's access now. Never metered. */
export async function runCompiled(deps: CompileDeps, ctx: HandlerContext, planId: string, input: z.output<typeof runCompiledPlan.body>)
  : Promise<z.output<typeof runCompiledPlan.response>> {
  // A chain kept from a question (37.8): run step by step; its answer is the last step's (a comparison's first side, its second beside it in Analysis).
  const row = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => compiledManifestRepo.findById(db, planId), { readOnly: true });
  if (row?.kind === 'analysis') {
    const ran = await runChainSteps(deps, ctx, planId, { bindingId: input.bindingId, trigger: input.trigger, purposeSessionIds: input.purposeSessionIds });
    const refused = ran.steps.find((x) => x.outcome === 'refused');
    if (refused?.outcome === 'refused') return { outcome: 'refusal', refusal: refused.refusal };
    const last = ran.last[0];
    if (last === undefined) return { outcome: 'refusal', refusal: { code: 'analysis.not_run', reason: 'the chain has no step that ran' } };
    return { outcome: 'answer', result: last };
  }
  const stored = await compiledPlan(deps, ctx, planId);
  const parameters = await boundParameters(deps, ctx, planId, input.bindingId);
  if (isRefusal(parameters)) return { outcome: 'refusal', refusal: parameters };
  const ran = await execute(deps, ctx, stored.plan, parameters, planId, input.trigger, input.purposeSessionIds);
  return 'refusal' in ran ? { outcome: 'refusal', refusal: ran.refusal } : { outcome: 'answer', result: ran.result };
}

/** A binding copied to a new holder, as a saved view made from an Ask turn keeps the turn's values. */
export async function copyBinding(deps: CompileDeps, ctx: HandlerContext, fromId: string, toId: string): Promise<{ bindingId: string; planId: string }> {
  const row = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => planBindingRepo.findById(db, fromId), { readOnly: true });
  if (row === undefined) throw new AppError('not_found', 'no such binding', { code: 'compile.binding_not_found' });
  const parameters = await boundParameters(deps, ctx, row.compiledManifestId, fromId);
  if (isRefusal(parameters)) throw new AppError('integrity', parameters.reason, { code: parameters.code });
  await keepBinding(deps, ctx, toId, row.compiledManifestId, parameters);
  return { bindingId: toId, planId: row.compiledManifestId };
}

export async function compiledPlan(deps: CompileDeps, ctx: HandlerContext, planId: string): Promise<z.output<typeof getCompiledPlan.response>> {
  const row = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => compiledManifestRepo.findById(db, planId), { readOnly: true });
  const plan = row ? queryPlan.safeParse(row.manifest) : undefined;
  if (!row || !plan?.success) throw new AppError('not_found', 'no such plan', { code: 'compile.plan_not_found' });
  return {
    planId: row.id, plan: plan.data, compileClass: row.compileClass, ontologyVersionId: row.ontologyVersionId,
    policyVersion: Number(row.policyVersion), createdAt: row.createdAt,
  };
}

export async function vocabularyOf(deps: CompileDeps, ctx: HandlerContext, ontologyVersionId: string | undefined, branchId?: string)
  : Promise<z.output<typeof getVocabulary.response>> {
  const call = callOf(ctx);
  const versionId = ontologyVersionId ?? (await activeVersion(plannerDeps(deps), call, branchId)).id;
  const access = await readerAccess(plannerDeps(deps), call, await manifestOf(plannerDeps(deps), call, versionId));
  if (isRefusal(access)) throw new AppError('forbidden', access.reason, { code: access.code });
  return vocabularyView(access);
}

/** What the model may say a failure is (39.4): simulation's forms, no defaults (the model gateway refuses sample values). */
const modelFailureSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('failure'),
    failure: z.object({
      form: z.enum(FAILURE_FORMS), delay: duration.optional(), period: duration.optional(), capacityRemaining: z.number().gt(0).lt(1).optional(),
      asWritten: z.string().max(200),
    }),
  }),
  z.object({ outcome: z.literal('unanswerable') }),
]);
const FAILURE_OUTPUT = outputSpec('StatedFailure', modelFailureSchema);
const FAILURE_INSTRUCTIONS = [
  'State the failure the question describes for the objects it is asked about, in one of these forms: unavailable; delayed (give the delay);',
  'unavailable_for_period (give how long); reduced_capacity (give the share of capacity left, between 0 and 1). Give each duration as a number and a unit',
  '(minutes, hours, days or weeks), with the asker\'s words for the failure. Never compute dates. If the question states no failure, answer unanswerable.',
].join('\n');

/** Ask's start a scenario (36.4): the failure in words to a stated failure, for a type the asker may see; charged as a compile. */
export async function compileFailureStatement(deps: CompileDeps, ctx: HandlerContext, input: { question: string; objectTypeId: string })
  : Promise<z.output<typeof compileFailure.response>> {
  const refusal = (code: string, reason: string) => ({ outcome: 'refusal' as const, refusal: { code, reason } });
  if (!await allowed(deps, ctx, 'query.compile')) return refusal('compile.not_permitted', 'you may not compile questions');
  const call = callOf(ctx);
  const manifest = await manifestOf(plannerDeps(deps), call, (await activeVersion(plannerDeps(deps), call)).id);
  const access = await readerAccess(plannerDeps(deps), call, manifest);
  if (isRefusal(access)) return { outcome: 'refusal', refusal: access };
  const type = access.types.get(input.objectTypeId);
  if (type === undefined) return refusal('compile.unknown_object_type', 'that object type is not available to you');
  const reply = await deps.services.call(callModel, {
    body: {
      role: 'compile', instructions: FAILURE_INSTRUCTIONS, question: input.question, output: FAILURE_OUTPUT,
      vocabulary: { objectTypes: [{ name: type.type.apiName, description: type.type.displayName.slice(0, 2_000), properties: [] }] },
    },
  }, { ...opts(ctx), timeoutMs: 60_000 }).catch((error: unknown) => {
    if (isAppError(error) && error.code === 'model.output_invalid') return undefined;
    throw error;
  });
  const output = reply === undefined ? undefined : modelFailureSchema.safeParse(reply.output);
  if (output === undefined || !output.success) return refusal('compile.could_not_compile', 'the failure could not be stated from that');
  if (output.data.outcome === 'unanswerable') return refusal('compile.not_a_failure', 'that states no failure: say how the objects fail, and for how long');
  const failure = output.data.failure;
  // Checked as simulation checks a stated failure: each form with its own measure, and only it.
  const { asWritten: _words, ...measure } = failure;
  const checked = statedFailure.safeParse({ ...measure, objectTypeId: input.objectTypeId, objectIds: [input.objectTypeId] });
  if (!checked.success) return refusal('compile.failure_invalid', 'each form states its own measure: a delay, a period, or the capacity left');
  let charged;
  try {
    const out = await deps.services.call(charge, { body: { operation: 'compile', correlationId: uuidv7() } },
      { ...opts(ctx), idempotencyKey: `chg.${sha256(`${ctx.idempotencyKey ?? uuidv7()}`).toString('hex').slice(0, 48)}` });
    charged = out.charged ? { charged: true as const, transactionId: out.transactionId, weight: out.weight } : { charged: false as const, reason: out.reason };
  } catch (error) {
    if (isAppError(error) && (CHARGE_REFUSALS as readonly string[]).includes(error.code ?? '')) return refusal(error.code!, error.message.slice(0, 1_000));
    throw error;
  }
  await recordQueryEvent(deps.databases, ctx.request, ctx.correlationId, 'compile_requested', { failure: true, question_length: input.question.length });
  return { outcome: 'failure', failure, charge: charged };
}
