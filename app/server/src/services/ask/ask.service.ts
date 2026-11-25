// Ask (spec 36): threads and turns over the compile stage and the federated engine.
//
// A turn, in the order the spec makes the security property (36.2): the question and the
// thread's context go to compile, which owns vocabulary, the model call, validation, the
// plan, bounds and the charge; a plan is executed under the asker's own access; the turn
// records the finished outcome. Ask never picks between candidates (36.3): a clarification
// is a reply, and the next turn names the candidate chosen. Ask never writes; proposing an
// Action is a draft a person submits (not built here: the actions service owns the form).
//
// A turn keeps the outcome and references only (36.8). The data plane result expires with
// its TTL; re-running an answered turn is unmetered. Charging is metering's, through
// compile: a refusal and a clarification are free, the compile after a choice is charged
// once, a rephrase inside the window is charged once across both (36.10).

import { effectiveWebPolicy, withinDomains, type EffectiveWebPolicy } from './webPolicy.service.ts';
import { webQueryOf } from './webQuery.service.ts';
import type { WebResult, WebSearch } from '../../infra/webSearch.infra.ts';
import type {
  ClarificationOption, StoredScope, ThreadScope, ThreadView, TurnView,
} from '../../contracts/ask/thread.contract.ts';
import type { AskEventName } from '../../contracts/ask/events.contract.ts';
import { auditEventMessage } from '../../contracts/audit/auditEvent.contract.ts';
import { authorise, listPermittedScopes, resolveAccess } from '../../contracts/policy/decision.contract.ts';
import { getLineage } from '../../contracts/lineage/lineage.contract.ts';
import { getFinding } from '../../contracts/recognition/finding.contract.ts';
import { saveScenario } from '../../contracts/simulation/scenario.contract.ts';
import type { ToolSubject } from '../../contracts/ask/thread.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases, type Queryable, type RequestContext } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import type { AskThread } from '../../models/workspace/askThread.model.ts';
import type { AskTurn } from '../../models/workspace/askTurn.model.ts';
import { objectSetRepo } from '../../repos/ontology/index.repo.ts';
import { outboxRepo } from '../../repos/platform/index.repo.ts';
import { aiAgentRepo, askThreadRepo, askTurnRepo, askWebPolicyRepo } from '../../repos/workspace/index.repo.ts';
import type { AiAgent } from '../../models/workspace/aiAgent.model.ts';
import { aiAgentHeld } from '../workspace/aiAgents.service.ts';
import { organisationRepo } from '../../repos/iam/index.repo.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { sha256 } from '../../utils/crypto.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import type { CompileOutcome, QueryEngine } from '../workspace/queryEngine.service.ts';
import type { QuestionVault } from './questionVault.service.ts';

export interface AskDeps {
  databases: Databases;
  services: ServiceClient;
  logger: Logger;
  engine: QueryEngine;
  vault: QuestionVault;
  /** Ask's web context (36.7); absent where the cell has no provider (and always in the sovereign build). */
  webSearch?: WebSearch | undefined;
}

export interface OutsideContext {
  status: 'ok' | 'unavailable';
  query: string;
  retrievedAt: string;
  results: WebResult[];
}

/**
 * Outside context for an answer (36.7): only after an answer exists, only where the cell has
 * a provider and the organisation has not turned it off, only for a query with no literal in
 * it. A failed search is stated as unavailable; the answer stands either way.
 */
async function outsideContextFor(deps: AskDeps, question: string, policy: EffectiveWebPolicy): Promise<OutsideContext | null> {
  if (deps.webSearch === undefined || !policy.enabled) return null;
  const query = webQueryOf(question);
  if (query === null) return null;
  const retrievedAt = new Date().toISOString();
  try {
    return { status: 'ok', query, retrievedAt, results: withinDomains(await deps.webSearch.search(query), policy) };
  } catch (error) {
    deps.logger.warn('web search was unavailable for an answer', { event: 'ask.web_unavailable', ...(isAppError(error) ? { errorCode: error.code } : {}) });
    return { status: 'unavailable', query, retrievedAt, results: [] };
  }
}

/**
 * ask.web.manage at a scope (36.7; D89): on or off there, with domain lists. Turning it on in a
 * scope holding marked data needs coverOverride, and the admin must satisfy every marking held
 * there now; those are kept as covered.
 */
export async function setWebScopePolicy(deps: AskDeps, ctx: Context, scopeId: string, input: {
  enabled: boolean; allowedDomains: string[]; blockedDomains: string[]; coverMarkedData: boolean;
}) {
  const me = member(ctx);
  const decision = await deps.services.call(authorise, { body: { permission: 'ask.web.manage', scopeId } }, { request: ctx.request, correlationId: ctx.correlationId });
  if (decision.decision !== 'allow') throw new AppError('forbidden', 'you may not manage web context here', { code: 'ask.not_permitted' });
  const pool = deps.databases.pool('control');
  const held = await inTransaction(pool, me.request, (db) => askWebPolicyRepo.markingsHeldIn(db, scopeId), { readOnly: true });
  let covered: string[] = [];
  if (input.enabled && input.coverMarkedData && held.length > 0) {
    const access = await deps.services.call(resolveAccess, { body: { markings: held } }, { request: ctx.request, correlationId: ctx.correlationId });
    if (held.some((m) => !access.markings.some((x) => x.id === m && x.satisfied))) {
      throw new AppError('forbidden', 'only an admin who holds every marking in this scope turns web context on despite it', { code: 'ask.web_marking_unsatisfied' });
    }
    covered = held;
  }
  return inTransaction(pool, me.request, async (db) => {
    const row = await askWebPolicyRepo.upsert(db, {
      id: uuidv7(), organisationId: me.organisationId, scopeId, enabled: input.enabled,
      allowedDomains: [...new Set(input.allowedDomains)], blockedDomains: [...new Set(input.blockedDomains)],
      markedOverrideMarkings: covered, overrideBy: covered.length > 0 ? me.membershipId : null, updatedBy: me.membershipId,
    });
    await recordEvent(db, me, ctx.correlationId, 'ask_web_policy_changed', { type: 'scope', id: scopeId }, {
      enabled: input.enabled, allowed: row.allowedDomains.length, blocked: row.blockedDomains.length, covered_markings: covered.length,
    });
    return {
      scopeId, enabled: row.enabled, allowedDomains: row.allowedDomains, blockedDomains: row.blockedDomains,
      markedData: held.length > 0, coveredMarkings: row.markedOverrideMarkings.length,
    };
  });
}

/**
 * The web context policy (36.7): the organisation's switch, for anyone in it, and the policies of
 * the scopes the reader may manage, each saying whether its scope holds marked data now.
 */
export async function readWebPolicy(deps: AskDeps, ctx: Context) {
  const me = member(ctx);
  const managed = await deps.services.call(listPermittedScopes, { body: { permission: 'ask.web.manage' } }, { request: ctx.request, correlationId: ctx.correlationId });
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const organisation = await organisationRepo.findById(db, me.organisationId);
    const policies = managed.scopes.length === 0 ? [] : await askWebPolicyRepo.forScopes(db, managed.scopes.map((s) => s.id));
    return {
      enabled: organisation?.askWebEnabled === true, available: deps.webSearch !== undefined,
      scopes: policies.map((p) => ({
        scopeId: p.scopeId, enabled: p.enabled, allowedDomains: p.allowedDomains, blockedDomains: p.blockedDomains,
        markedData: p.markedData, coveredMarkings: p.markedOverrideMarkings.length, updatedBy: p.updatedBy, updatedAt: p.updatedAt,
      })),
    };
  }, { readOnly: true });
}

/** ask.web.manage (36.7): the organisation turns its web context off or on. */
export async function setWebPolicy(deps: AskDeps, ctx: Context, enabled: boolean): Promise<{ enabled: boolean; available: boolean }> {
  const me = member(ctx);
  await demand(deps, ctx, 'ask.web.manage');
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const organisation = await organisationRepo.findById(db, me.organisationId);
    if (organisation?.askWebEnabled !== enabled) {
      await organisationRepo.update(db, me.organisationId, { askWebEnabled: enabled, version: (organisation?.version ?? 0) + 1 });
      await recordEvent(db, me, ctx.correlationId, 'ask_web_policy_changed', { type: 'organisation', id: me.organisationId }, { enabled });
    }
    return { enabled, available: deps.webSearch !== undefined };
  });
}

type Context = Pick<HandlerContext, 'request' | 'correlationId'> & { idempotencyKey?: string | undefined };

interface Member { organisationId: string; membershipId: string; request: RequestContext }

function member(ctx: Context): Member {
  const { organisationId, membershipId } = ctx.request;
  if (membershipId === undefined) throw new AppError('forbidden', 'Ask is a member\'s', { code: 'ask.member_required' });
  return { organisationId: organisationId!, membershipId, request: ctx.request };
}

async function demand(deps: AskDeps, ctx: Context, permission: string): Promise<void> {
  const answer = await deps.services.call(authorise, { body: { permission } }, { request: ctx.request, correlationId: ctx.correlationId });
  if (answer.decision !== 'allow') {
    throw new AppError('forbidden', `you do not hold ${permission}`, { code: 'ask.not_permitted', details: { permission } });
  }
}

async function recordEvent(db: Queryable, me: Member, correlationId: string, event: AskEventName | 'ask_scope_widened' | 'web_search_sent',
  resource: { type: string; id: string }, detail: Record<string, string | number | boolean | null> = {}): Promise<void> {
  const payload = auditEventMessage.schema.parse({
    event, actor: { kind: 'membership', membershipId: me.membershipId }, subjectMembershipId: null, scopeId: null, resource,
    purposeSessionId: null, operatorAccessSessionId: null, ipHash: null, detail,
  });
  await outboxRepo.insert(db, {
    id: uuidv7(), organisationId: me.organisationId, topic: auditEventMessage.topic, orderingKey: me.organisationId,
    event: auditEventMessage.name, schemaVersion: auditEventMessage.version, payload, correlationId,
  });
}

const threadNotFound = (): AppError => new AppError('not_found', 'no such thread', { code: 'ask.thread_not_found' });

function scopeOf(thread: AskThread): StoredScope | null {
  return thread.scopeRef === null ? null : thread.scopeRef as StoredScope;
}

export function threadViewOf(thread: AskThread): ThreadView {
  return {
    id: thread.id, title: thread.title, scope: scopeOf(thread), savedViewId: thread.savedViewId, aiAgentId: thread.aiAgentId, turnCount: thread.lastSequence,
    createdAt: thread.createdAt, lastActivityAt: thread.lastActivityAt, archivedAt: thread.archivedAt,
  };
}

function turnViewOf(turn: AskTurn, extra: {
  narrowing?: string | null; incompleteSources?: string[]; draft?: TurnView['draft']; explanation?: TurnView['explanation'];
} = {}): TurnView {
  const proposed = turn.proposal as ({ kind?: string } & Record<string, unknown>) | null;
  const { kind: _kind, ...cron } = proposed?.kind === 'cron' ? proposed : { kind: undefined };
  return {
    proposal: proposed === null || proposed.kind === 'cron' ? null : proposed as TurnView['proposal'],
    cron: proposed?.kind === 'cron' ? cron as TurnView['cron'] : null,
    subject: (turn.subject ?? null) as TurnView['subject'],
    scenarioId: turn.scenarioId,
    ...(extra.explanation === undefined ? {} : { explanation: extra.explanation }),
    ...(extra.draft === undefined ? {} : { draft: extra.draft }),
    outsideContext: (turn.outsideContext ?? null) as TurnView['outsideContext'],
    id: turn.id, sequence: turn.sequence, outcome: turn.outcome, tool: turn.tool as TurnView['tool'], manifestId: turn.manifestId,
    refusalReason: turn.refusalReason, narrowing: extra.narrowing ?? null,
    clarificationOptions: turn.clarificationOptions === null ? null : turn.clarificationOptions as ClarificationOption[],
    resultRef: turn.resultRef, incompleteSources: extra.incompleteSources ?? [], tokensCharged: turn.tokensCharged,
    questionRetained: turn.question !== null, createdAt: turn.createdAt,
  };
}

/** Scope crosses as references; a saved object set must be the person's or shared, like any other read of it. */
async function checkScope(db: Queryable, me: Member, scope: ThreadScope | null | undefined): Promise<void> {
  if (scope?.kind !== 'object_set') return;
  const set = await objectSetRepo.findById(db, scope.objectSetId);
  if (!set || set.archivedAt !== null || (set.ownerMembershipId !== me.membershipId && set.visibility !== 'shared')) {
    throw new AppError('not_found', 'no such object set', { code: 'ask.scope_not_found' });
  }
}

/**
 * An AI agent the person may ask (D236): their own, or one shared with them live under its
 * owner's policy, and not archived. Checked when a thread is made with it and at every question,
 * so a share revoked or an agent archived stops the next question.
 */
async function askableAiAgent(db: Queryable, me: Member, id: string, inThread: boolean): Promise<AiAgent> {
  const a = await aiAgentRepo.findById(db, id);
  const held = a === undefined ? undefined : await aiAgentHeld(db, a, me.membershipId);
  if (a === undefined || held === undefined) {
    throw inThread
      ? new AppError('forbidden', 'this thread\'s AI agent is no longer available to you', { code: 'ask.ai_agent_unavailable' })
      : new AppError('not_found', 'no such AI agent', { code: 'ask.ai_agent_not_found' });
  }
  if (a.archivedAt !== null) throw new AppError('conflict', 'this AI agent is archived and is asked no more', { code: 'ask.ai_agent_archived' });
  return a;
}

const TOOL_WORDS: Readonly<Record<AiAgent['tools'][number], string>> = {
  answer: 'answer questions', find_objects: 'find objects', propose_action: 'propose changes', propose_cron: 'propose Crons',
};

async function ownThread(db: Queryable, me: Member, threadId: string, lock: boolean): Promise<AskThread> {
  const thread = lock ? await askThreadRepo.findForUpdate(db, threadId) : await askThreadRepo.findById(db, threadId);
  // A thread is private and never shared (36.8).
  if (!thread || thread.ownerMembershipId !== me.membershipId) throw threadNotFound();
  return thread;
}

// ----------------------------------------------------------------------------- threads

export async function createThread(deps: AskDeps, ctx: Context,
  input: { title?: string | undefined; scope?: ThreadScope | undefined; aiAgentId?: string | undefined }): Promise<ThreadView> {
  const me = member(ctx);
  await demand(deps, ctx, 'query.compile');
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    await checkScope(db, me, input.scope);
    const agent = input.aiAgentId === undefined ? undefined : await askableAiAgent(db, me, input.aiAgentId, false);
    const thread = await askThreadRepo.insert(db, {
      id: uuidv7(), organisationId: me.organisationId, ownerMembershipId: me.membershipId, title: input.title ?? agent?.name ?? 'New thread',
      scopeKind: input.scope?.kind ?? null, scopeRef: input.scope ?? null, aiAgentId: agent?.id ?? null,
    });
    return threadViewOf(thread);
  });
}

export async function readThread(deps: AskDeps, ctx: Context, threadId: string): Promise<ThreadView> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => threadViewOf(await ownThread(db, me, threadId, false)),
    { readOnly: true });
}

export async function listThreads(deps: AskDeps, ctx: Context, input: { search?: string | undefined; archived: boolean; limit: number })
  : Promise<ThreadView[]> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) =>
    (await askThreadRepo.listOwned(db, me.membershipId, input)).map(threadViewOf), { readOnly: true });
}

export async function getThread(deps: AskDeps, ctx: Context, threadId: string): Promise<{ thread: ThreadView; turns: TurnView[] }> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const thread = await ownThread(db, me, threadId, false);
    return { thread: threadViewOf(thread), turns: (await askTurnRepo.listForThread(db, thread.id)).map((t) => turnViewOf(t)) };
  }, { readOnly: true });
}

export async function renameThread(deps: AskDeps, ctx: Context, threadId: string, title: string): Promise<ThreadView> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const thread = await ownThread(db, me, threadId, true);
    if (thread.savedViewId !== null) {
      throw new AppError('conflict', 'a saved view\'s thread takes the view\'s name; rename the view', { code: 'ask.thread_is_view' });
    }
    return threadViewOf((await askThreadRepo.update(db, thread.id, { title }))!);
  });
}

export async function archiveThread(deps: AskDeps, ctx: Context, threadId: string): Promise<ThreadView> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const thread = await ownThread(db, me, threadId, true);
    if (thread.savedViewId !== null) throw new AppError('conflict', 'a saved view\'s thread goes with the view', { code: 'ask.thread_is_view' });
    if (thread.archivedAt !== null) return threadViewOf(thread);
    const updated = (await askThreadRepo.update(db, thread.id, { archivedAt: new Date().toISOString() }))!;
    await recordEvent(db, me, ctx.correlationId, 'ask_thread_archived', { type: 'ask_thread', id: thread.id });
    return threadViewOf(updated);
  });
}

/** Widening (or narrowing) the scope is recorded on the thread and audited (33.6). */
export async function setScope(deps: AskDeps, ctx: Context, threadId: string, scope: ThreadScope | null): Promise<ThreadView> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const thread = await ownThread(db, me, threadId, true);
    if (thread.savedViewId !== null) throw new AppError('conflict', 'a saved view\'s thread is scoped to the view', { code: 'ask.thread_is_view' });
    await checkScope(db, me, scope);
    const updated = (await askThreadRepo.update(db, thread.id, { scopeKind: scope?.kind ?? null, scopeRef: scope ?? null }))!;
    await recordEvent(db, me, ctx.correlationId, 'ask_scope_widened', { type: 'ask_thread', id: thread.id }, {
      from: thread.scopeKind, to: scope?.kind ?? null,
    });
    return threadViewOf(updated);
  });
}

// ----------------------------------------------------------------------------- turns

export interface AskInput {
  question: string;
  tool: 'answer' | 'find_objects' | 'propose_action' | 'propose_cron' | 'explain_finding' | 'explain_lineage' | 'open_clone' | 'start_scenario';
  subject?: ToolSubject | undefined;
  clarification?: { sequence: number; optionId: string } | undefined;
  rephrases?: { sequence: number } | undefined;
  advanced: boolean;
}

const RUN_REFUSALS = { bound_exceeded: 'bound_exceeded', capability_missing: 'capability_missing', unsupported: 'unsupported' } as const;

export async function ask(deps: AskDeps, ctx: Context, threadId: string, input: AskInput): Promise<{ thread: ThreadView; turn: TurnView }> {
  if (input.tool === 'start_scenario') return startScenario(deps, ctx, threadId, input as AskInput & { subject: ToolSubject });
  if (input.subject !== undefined) return explainOrOpen(deps, ctx, threadId, input as AskInput & { subject: ToolSubject });
  const me = member(ctx);
  await demand(deps, ctx, 'query.compile');
  if (input.advanced) await demand(deps, ctx, 'query.advanced');
  const pool = deps.databases.pool('control');

  // The thread's context, read before the model is called (no lock held across it).
  const context = await inTransaction(pool, me.request, async (db) => {
    const thread = await ownThread(db, me, threadId, false);
    if (thread.archivedAt !== null) throw new AppError('conflict', 'this thread is archived', { code: 'ask.thread_archived' });
    // Asked of an AI agent (D236): still the person's to ask, and only with a tool it allows.
    const aiAgent = thread.aiAgentId === null ? undefined : await askableAiAgent(db, me, thread.aiAgentId, true);
    if (aiAgent !== undefined && !(aiAgent.tools as string[]).includes(input.tool)) {
      throw new AppError('validation', `this AI agent may not ${TOOL_WORDS[input.tool as keyof typeof TOOL_WORDS] ?? input.tool}`, {
        code: 'ask.ai_agent_tool', details: { tool: input.tool },
      });
    }
    let chosen: ClarificationOption | undefined;
    let rejected: ClarificationOption[] = [];
    if (input.clarification !== undefined) {
      const offered = await askTurnRepo.findBySequence(db, thread.id, input.clarification.sequence);
      const options = offered?.outcome === 'clarification' ? offered.clarificationOptions as ClarificationOption[] : [];
      chosen = options.find((o) => o.id === input.clarification!.optionId);
      if (!chosen) throw new AppError('validation', 'choose one of the candidates that turn offered', { code: 'ask.clarification_unknown' });
      rejected = options.filter((o) => o !== chosen);
    }
    // A rephrase names an earlier turn of this thread that produced a plan: its compile is the one the window counts from.
    let rephraseOf: string | undefined;
    if (input.rephrases !== undefined) {
      const earlier = await askTurnRepo.findBySequence(db, thread.id, input.rephrases.sequence);
      if (earlier === undefined) throw new AppError('validation', 'that turn is not in this thread', { code: 'ask.rephrase_unknown' });
      rephraseOf = earlier.manifestId ?? undefined;
    }
    const turns = await askTurnRepo.listForThread(db, thread.id);
    // What a Cron proposed here would re-run (36.4): the thread's saved view, or its latest answer, to save as a view first (36.11).
    const latestAnswer = [...turns].reverse().find((t) => t.outcome === 'answer' && t.manifestId !== null && t.subject === null);
    const cronSubject = thread.savedViewId !== null ? { savedViewId: thread.savedViewId }
      : latestAnswer !== undefined ? { fromTurn: latestAnswer.sequence } : undefined;
    if (input.tool === 'propose_cron' && cronSubject === undefined) {
      throw new AppError('validation', 'a Cron re-runs a question: ask the question first, or ask from a saved view', { code: 'ask.cron_needs_question' });
    }
    const web = await effectiveWebPolicy(db, me.membershipId, (await organisationRepo.findById(db, me.organisationId))?.askWebEnabled === true);
    return {
      web, thread, chosen, rejected, rephraseOf, previousTurnId: turns.at(-1)?.id, cronSubject, aiAgent,
      priorManifestIds: await askTurnRepo.recentManifests(db, thread.id, 5),
    };
  }, { readOnly: true });

  const turnId = uuidv7();
  const caller = { request: me.request, correlationId: ctx.correlationId };
  // The question's retry key (the gateway scopes it to the member) makes the charge's key,
  // so a retried question is compiled and charged once.
  const chargeKey = `ask.${sha256(`${threadId}:${ctx.idempotencyKey ?? turnId}`).toString('hex').slice(0, 48)}`;
  const compiled: CompileOutcome = await deps.engine.compile({
    // The subject tools never reach compile (explainOrOpen); these are the compiled ones.
    question: input.question, tool: input.tool as 'answer' | 'find_objects' | 'propose_action' | 'propose_cron', scope: scopeOf(context.thread), priorManifestIds: context.priorManifestIds,
    chosen: context.chosen, rejected: context.rejected, advanced: input.advanced, turnId, chargeKey, previousTurnId: context.previousTurnId,
    rephraseOf: context.rephraseOf,
    ...(context.aiAgent === undefined ? {} : {
      aiAgent: { id: context.aiAgent.id, name: context.aiAgent.name, brief: context.aiAgent.brief, objectTypeIds: context.aiAgent.objectTypeIds, tools: context.aiAgent.tools },
    }),
  }, caller);

  // A plan runs under the asker's access (unless compile ran it already). A run the engine
  // cannot make now is still an answer: the plan is kept and re-running it later is free.
  let run: Awaited<ReturnType<QueryEngine['run']>> | undefined;
  // The values bound at compile are kept under the turn's id (a binding), so the plan replays with them.
  if (compiled.outcome === 'plan') run = compiled.ran ?? await deps.engine.run({ manifestId: compiled.manifestId, bindingId: turnId }, caller);

  // Outside context runs only after an answer exists (36.7): never on a refusal or a clarification.
  const answered = compiled.outcome === 'plan' && !(run?.outcome === 'refused' && run.reason in RUN_REFUSALS);
  const outside = answered ? await outsideContextFor(deps, input.question, context.web) : null;
  const sealed = await deps.vault.seal({ organisationId: me.organisationId, threadId, turnId, question: input.question });
  return inTransaction(pool, me.request, async (db) => {
    const thread = await ownThread(db, me, threadId, true);
    const sequence = thread.lastSequence + 1;
    const now = new Date().toISOString();
    const base = {
      id: turnId, organisationId: me.organisationId, threadId: thread.id, sequence,
      question: sealed, questionPurgedAt: sealed === null ? now : null,
    };
    let turn: AskTurn;
    let narrowing: string | null = null;
    let incomplete: string[] = [];
    let draft: TurnView['draft'];
    const resource = { type: 'ask_thread', id: thread.id };
    // What was answered is recorded as answered: a proposal tool that came back with a plan answered a question.
    const answeredWith = input.tool === 'propose_action' || input.tool === 'propose_cron' ? 'answer' : input.tool;
    if (compiled.outcome === 'schedule' && context.cronSubject === undefined) {
      // A Cron asked for in a thread with nothing to re-run: a finished refusal saying what would succeed.
      narrowing = 'ask the question the Cron should re-run first, then ask for the schedule';
      turn = await askTurnRepo.insert(db, { ...base, outcome: 'refusal', refusalReason: 'no_plan', tool: 'propose_cron' });
      await recordEvent(db, me, ctx.correlationId, 'ask_refused', resource, { sequence, reason: 'no_plan', at: 'cron_subject' });
    } else if (compiled.outcome === 'schedule') {
      // A Cron proposed (36.4): never saved here. The draft is createCron's body but its name; no record value, so kept whole.
      const s = compiled.schedule;
      const cron = {
        subject: context.cronSubject!, trigger: { schedule: s.schedule }, condition: s.condition,
        actions: [s.action === 'report' ? { kind: 'report' as const, format: 'csv' as const } : { kind: 'notify' as const, recipients: [] }], asWritten: s.asWritten,
      };
      turn = await askTurnRepo.insert(db, {
        ...base, outcome: 'proposal', tool: 'propose_cron', tokensCharged: compiled.tokensCharged, proposal: { kind: 'cron', ...cron } as never,
        manifestId: 'fromTurn' in cron.subject ? (await askTurnRepo.findBySequence(db, thread.id, cron.subject.fromTurn))?.manifestId ?? null : null,
      });
      await recordEvent(db, me, ctx.correlationId, 'ask_cron_proposed', resource, {
        sequence, schedule: s.schedule, condition: s.condition?.operator ?? 'always', action: s.action,
        subject: 'savedViewId' in cron.subject ? 'saved_view' : 'turn', tokens_charged: compiled.tokensCharged,
      });
      if (compiled.rephraseUncharged) await recordEvent(db, me, ctx.correlationId, 'ask_rephrase_uncharged', resource, { sequence });
    } else if (compiled.outcome === 'intent') {
      // A change asked for (42.9, 36.4): never executed. The turn keeps how it would be made, as
      // references; the reply carries the Action form pre-filled, which a person submits.
      const i = compiled.intent;
      turn = await askTurnRepo.insert(db, {
        ...base, outcome: 'proposal', manifestId: i.targetsPlanId, tool: 'propose_action', tokensCharged: compiled.tokensCharged,
        proposal: {
          objectTypeId: i.objectTypeId, operation: i.operation, properties: [...Object.keys(i.set), ...i.clear].sort(),
          candidates: i.candidates.map((c) => ({ actionTypeId: c.actionTypeId, actionTypeVersionId: c.actionTypeVersionId, displayName: c.displayName })),
          genericEdit: i.genericEdit,
        } as never,
      });
      draft = {
        candidates: i.candidates.map((c) => ({ actionTypeId: c.actionTypeId, parameters: c.parameters })),
        edit: i.genericEdit ? { objectTypeId: i.objectTypeId, operation: i.operation, set: i.set, clear: i.clear } : null,
      };
      // References and counts, never a value (36.13).
      await recordEvent(db, me, ctx.correlationId, 'ask_action_proposed', resource, {
        sequence, object_type_id: i.objectTypeId, operation: i.operation, candidates: i.candidates.length, generic_edit: i.genericEdit,
        manifest_id: i.targetsPlanId ?? 'none', tokens_charged: compiled.tokensCharged,
      });
      if (compiled.rephraseUncharged) await recordEvent(db, me, ctx.correlationId, 'ask_rephrase_uncharged', resource, { sequence });
    } else if (compiled.outcome === 'clarification') {
      turn = await askTurnRepo.insert(db, { ...base, outcome: 'clarification', clarificationOptions: compiled.options, tool: 'clarify' });
      await recordEvent(db, me, ctx.correlationId, 'ask_clarification_offered', resource, { sequence, candidates: compiled.options.length });
    } else if (compiled.outcome === 'refusal') {
      narrowing = compiled.narrowing;
      turn = await askTurnRepo.insert(db, { ...base, outcome: 'refusal', refusalReason: compiled.reason, tool: answeredWith });
      await recordEvent(db, me, ctx.correlationId, 'ask_refused', resource, { sequence, reason: compiled.reason });
    } else if (run?.outcome === 'refused' && run.reason in RUN_REFUSALS) {
      // Refused at execution (a bound only the data could show): a finished refusal.
      turn = await askTurnRepo.insert(db, {
        ...base, outcome: 'refusal', refusalReason: RUN_REFUSALS[run.reason as keyof typeof RUN_REFUSALS], manifestId: compiled.manifestId, tool: answeredWith,
      });
      await recordEvent(db, me, ctx.correlationId, 'ask_refused', resource, {
        sequence, reason: run.reason, at: 'execution', manifest_id: compiled.manifestId, tokens_charged_at_compile: compiled.tokensCharged,
      });
    } else if (compiled.outcome === 'plan') {
      incomplete = run?.outcome === 'result' ? run.incompleteSources : [];
      turn = await askTurnRepo.insert(db, {
        ...base, outcome: 'answer', manifestId: compiled.manifestId, resultRef: run?.outcome === 'result' ? run.resultRef : null,
        tool: answeredWith, tokensCharged: compiled.tokensCharged, outsideContext: outside as never,
      });
      if (outside !== null) {
        // Every web call is audited with its scope and the query sent (decision 2026-11-14): the question's wording, never a record value.
        await recordEvent(db, me, ctx.correlationId, 'ask_web_context_added', resource, {
          sequence, status: outside.status, results: outside.results.length, query: outside.query, scope_id: context.web.scopeId ?? 'organisation',
        });
        // The search as it left the cell (62.8): counts only.
        await recordEvent(db, me, ctx.correlationId, 'web_search_sent', resource, { sequence, status: outside.status, results: outside.results.length });
      }
      // Read first by a reviewer: the manifest reference and the tokens charged, never a value (36.13).
      await recordEvent(db, me, ctx.correlationId, 'ask_question_compiled', resource, {
        sequence, manifest_id: compiled.manifestId, compile_class: compiled.compileClass, tokens_charged: compiled.tokensCharged,
        ran: run?.outcome === 'result',
        // Which AI agent, at which saved version, shaped the plan (D236).
        ...(context.aiAgent === undefined ? {} : { ai_agent_id: context.aiAgent.id, ai_agent_version: context.aiAgent.lockVersion }),
      });
      if (compiled.rephraseUncharged) await recordEvent(db, me, ctx.correlationId, 'ask_rephrase_uncharged', resource, { sequence });
    } else {
      throw new AppError('internal', 'compile returned an outcome Ask does not know', { code: 'ask.outcome_unknown' });
    }
    if (context.chosen !== undefined && compiled.outcome !== 'clarification') {
      await recordEvent(db, me, ctx.correlationId, 'ask_clarification_chosen', resource, {
        sequence, from_sequence: input.clarification!.sequence, element_id: context.chosen.elementId,
      });
    }
    const updated = (await askThreadRepo.update(db, thread.id, { lastSequence: sequence, lastActivityAt: now }))!;
    return { thread: threadViewOf(updated), turn: turnViewOf(turn, { narrowing, incompleteSources: incomplete, draft }) };
  });
}

/**
 * The explanation and navigation tools (36.4): about a subject named by reference, answered
 * by the service that owns it under the asker's own access, with no model call and no charge.
 * Explain lineage reads the lineage of a turn's answer (its plan), a property, or an object's
 * type (lineage.view; what the asker's markings withhold is withheld); explain a finding reads
 * the finding (its detector, inputs, computation and score); open a clone checks the asker may
 * see the type (clone.view, its markings) and returns where to go: navigation only, the
 * destination reads under its own checks. The turn keeps the subject; the reply carries the
 * explanation once.
 */
async function explainOrOpen(deps: AskDeps, ctx: Context, threadId: string, input: AskInput & { subject: ToolSubject })
  : Promise<{ thread: ThreadView; turn: TurnView }> {
  const me = member(ctx);
  await demand(deps, ctx, 'query.compile');
  const pool = deps.databases.pool('control');
  const caller = { request: me.request, correlationId: ctx.correlationId };
  const subject = input.subject;
  const planOf = await inTransaction(pool, me.request, async (db) => {
    const thread = await ownThread(db, me, threadId, false);
    if (thread.archivedAt !== null) throw new AppError('conflict', 'this thread is archived', { code: 'ask.thread_archived' });
    if (subject.kind !== 'turn') return null;
    const earlier = await askTurnRepo.findBySequence(db, thread.id, subject.sequence);
    if (earlier?.manifestId == null) throw new AppError('not_found', 'that turn has no answer to explain', { code: 'ask.subject_not_found' });
    return earlier.manifestId;
  }, { readOnly: true });

  let explanation: NonNullable<TurnView['explanation']>;
  if (input.tool === 'explain_finding' && subject.kind === 'finding') {
    explanation = { kind: 'finding', finding: await deps.services.call(getFinding, { params: { findingId: subject.findingId }, query: {} }, caller) };
  } else if (input.tool === 'explain_lineage') {
    const node = subject.kind === 'turn' ? { kind: 'ask_prompt' as const, refId: planOf! }
      : subject.kind === 'property' ? { kind: 'property' as const, refId: subject.propertyIdentityId }
        : { kind: 'object_type_version' as const, refId: (subject as { objectTypeId: string }).objectTypeId };
    explanation = { kind: 'lineage', graph: await deps.services.call(getLineage, { query: { ...node, depth: 32, maxNodes: 2_000 } }, caller) };
  } else {
    const objectTypeId = (subject as { objectTypeId: string }).objectTypeId;
    const decision = await deps.services.call(authorise, { body: { permission: 'clone.view', resource: { type: 'object_type', id: objectTypeId } } }, caller);
    // Not visible and not there are one answer, so existence is never disclosed.
    if (decision.decision !== 'allow') throw new AppError('not_found', 'nothing to open there', { code: 'ask.subject_not_found' });
    explanation = {
      kind: 'navigation',
      target: subject.kind === 'object' ? { kind: 'object_view', objectTypeId, objectId: subject.objectId } : { kind: 'clone_canvas', objectTypeId },
    };
  }

  const turnId = uuidv7();
  const sealed = await deps.vault.seal({ organisationId: me.organisationId, threadId, turnId, question: input.question });
  return inTransaction(pool, me.request, async (db) => {
    const thread = await ownThread(db, me, threadId, true);
    const sequence = thread.lastSequence + 1;
    const now = new Date().toISOString();
    const turn = await askTurnRepo.insert(db, {
      id: turnId, organisationId: me.organisationId, threadId: thread.id, sequence, question: sealed, questionPurgedAt: sealed === null ? now : null,
      outcome: 'answer', tool: input.tool, subject: subject as never, manifestId: planOf, tokensCharged: 0,
    });
    const updated = (await askThreadRepo.update(db, thread.id, { lastSequence: sequence, lastActivityAt: now }))!;
    return { thread: threadViewOf(updated), turn: turnViewOf(turn, { explanation }) };
  });
}

/**
 * Start a scenario (36.4, 39.4): the question states how the named object fails; compile
 * states it in simulation's forms (charged as a compile); simulation saves it as the asker's
 * failure scenario (simulation.run), private and ready to run. Creating a scenario writes
 * nothing to a source: running it is the asker's next step, charged as a simulation then.
 */
async function startScenario(deps: AskDeps, ctx: Context, threadId: string, input: AskInput & { subject: ToolSubject })
  : Promise<{ thread: ThreadView; turn: TurnView }> {
  const me = member(ctx);
  await demand(deps, ctx, 'query.compile');
  const pool = deps.databases.pool('control');
  const caller = { request: me.request, correlationId: ctx.correlationId };
  const subject = input.subject as Extract<ToolSubject, { kind: 'object' }>;
  await inTransaction(pool, me.request, async (db) => {
    const thread = await ownThread(db, me, threadId, false);
    if (thread.archivedAt !== null) throw new AppError('conflict', 'this thread is archived', { code: 'ask.thread_archived' });
  }, { readOnly: true });
  const turnId = uuidv7();
  const chargeKey = `ask.${sha256(`${threadId}:${ctx.idempotencyKey ?? turnId}`).toString('hex').slice(0, 48)}`;
  const stated = await deps.engine.failure({ question: input.question, objectTypeId: subject.objectTypeId, chargeKey }, caller);
  let scenarioId: string | null = null;
  if (stated.outcome === 'failure') {
    const { asWritten, ...failure } = stated.failure;
    const scenario = await deps.services.call(saveScenario, {
      body: { name: (asWritten.trim() === '' ? 'Scenario from Ask' : asWritten).slice(0, 200), statedFailure: { ...failure, objectTypeId: subject.objectTypeId, objectIds: [subject.objectId] } },
    }, caller);
    scenarioId = scenario.id;
  }
  const sealed = await deps.vault.seal({ organisationId: me.organisationId, threadId, turnId, question: input.question });
  return inTransaction(pool, me.request, async (db) => {
    const thread = await ownThread(db, me, threadId, true);
    const sequence = thread.lastSequence + 1;
    const now = new Date().toISOString();
    const base = { id: turnId, organisationId: me.organisationId, threadId: thread.id, sequence, question: sealed, questionPurgedAt: sealed === null ? now : null,
      tool: 'start_scenario', subject: subject as never };
    const resource = { type: 'ask_thread', id: thread.id };
    let turn: AskTurn;
    if (stated.outcome === 'refusal') {
      turn = await askTurnRepo.insert(db, { ...base, outcome: 'refusal', refusalReason: stated.reason });
      await recordEvent(db, me, ctx.correlationId, 'ask_refused', resource, { sequence, reason: stated.reason, at: 'scenario' });
    } else {
      turn = await askTurnRepo.insert(db, { ...base, outcome: 'answer', scenarioId, tokensCharged: stated.tokensCharged });
      // References and counts: the scenario, the form and how many objects, never a value.
      await recordEvent(db, me, ctx.correlationId, 'ask_scenario_started', resource, {
        sequence, scenario_id: scenarioId!, form: stated.failure.form, objects: 1, tokens_charged: stated.tokensCharged,
      });
    }
    const updated = (await askThreadRepo.update(db, thread.id, { lastSequence: sequence, lastActivityAt: now }))!;
    return { thread: threadViewOf(updated), turn: turnViewOf(turn, { narrowing: stated.outcome === 'refusal' ? stated.narrowing : null }) };
  });
}

export async function readTurn(deps: AskDeps, ctx: Context, threadId: string, sequence: number): Promise<{ thread: ThreadView; turn: TurnView }> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const thread = await ownThread(db, me, threadId, false);
    const turn = await askTurnRepo.findBySequence(db, thread.id, sequence);
    if (!turn) throw new AppError('not_found', 'no such turn', { code: 'ask.turn_not_found' });
    return { thread: threadViewOf(thread), turn: turnViewOf(turn) };
  }, { readOnly: true });
}

/** Re-runs an answered turn's plan against live data, unmetered (36.8, 36.10). The turn itself is never rewritten. */
export async function rerun(deps: AskDeps, ctx: Context, threadId: string, sequence: number) {
  const me = member(ctx);
  const turn = await inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const thread = await ownThread(db, me, threadId, false);
    return askTurnRepo.findBySequence(db, thread.id, sequence);
  }, { readOnly: true });
  if (!turn) throw new AppError('not_found', 'no such turn', { code: 'ask.turn_not_found' });
  if (turn.outcome !== 'answer' || turn.manifestId === null) {
    throw new AppError('conflict', 'only an answered turn re-runs', { code: 'ask.turn_not_answer' });
  }
  const run = await deps.engine.run({ manifestId: turn.manifestId, bindingId: turn.id }, { request: me.request, correlationId: ctx.correlationId });
  return run.outcome === 'result'
    ? { resultRef: run.resultRef, refusalReason: null, incompleteSources: run.incompleteSources, ranAt: run.ranAt }
    : { resultRef: null, refusalReason: run.reason, incompleteSources: [], ranAt: new Date().toISOString() };
}
