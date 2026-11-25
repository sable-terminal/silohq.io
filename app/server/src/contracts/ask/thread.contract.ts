// Ask (spec 36): threads and turns. A thread is a person's private conversation, scoped to
// the page it was opened from (33.6); a turn is one question and its finished outcome:
// an answer, a refusal or a clarification (36.3).
//
// Each turn runs the compile stage (chapter 26: vocabulary, model, plan, bounds, charge)
// and, for a plan, the federated engine (chapter 27). A question asking for a change
// (42.9) comes back as a proposal: how the change would be made (the confirmed Action types
// that fit, or the generic governed edit) and the plan finding the records it changes. Ask
// never executes it (36.4): the reply carries the Action form pre-filled, a person submits it. Ask adds the conversation: the
// thread's scope and its earlier plans go to compile as references; a clarification is
// answered by choosing one of its candidates; an expired result is re-run unmetered.
//
// What a turn keeps (36.8): the outcome, the compiled manifest reference, the refusal
// reason, the clarification candidates (vocabulary references), the data plane result
// reference and the tokens charged; the question itself only as a sealed record value.
// Never result rows, never a value read from a source.
//
// Scope crosses as references and definitions, never as values shown on the page.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { graphView } from '../lineage/lineage.contract.ts';
import { findingView } from '../recognition/finding.contract.ts';

export const RAIL_PAGES = [
  'home', 'explorer', 'clones', 'studio', 'ask', 'scenarios', 'governance', 'connect', 'ontology', 'files', 'siloes',
] as const;

/** Where a thread was opened from (33.6): references only. A saved view's own thread is made by the workspace. */
export const threadScope = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('page'), page: z.enum(RAIL_PAGES) }),
  z.strictObject({ kind: z.literal('object'), objectTypeId: z.uuid(), objectRef: z.uuid() }),
  z.strictObject({ kind: z.literal('object_set'), objectSetId: z.uuid() }),
  z.strictObject({ kind: z.literal('app'), appId: z.uuid() }),
  z.strictObject({ kind: z.literal('scenario'), scenarioId: z.uuid() }),
]);
export type ThreadScope = z.infer<typeof threadScope>;

/** As stored and shown: a saved view's thread is scoped to the view. */
export const storedScope = z.union([threadScope, z.strictObject({ kind: z.literal('saved_view'), savedViewId: z.uuid() })]);
export type StoredScope = z.infer<typeof storedScope>;

export const threadView = z.object({
  id: z.uuid(),
  title: z.string(),
  scope: storedScope.nullable(),
  savedViewId: z.uuid().nullable(),
  /** The AI agent the thread asks (D236), set when it was made. */
  aiAgentId: z.uuid().nullable(),
  turnCount: z.number().int(),
  createdAt: z.string(),
  lastActivityAt: z.string(),
  archivedAt: z.string().nullable(),
});
export type ThreadView = z.infer<typeof threadView>;

export const ASK_TOOLS = [
  'answer', 'find_objects', 'clarify', 'propose_action', 'propose_cron', 'explain_finding', 'explain_lineage', 'open_clone', 'start_scenario',
] as const;

/**
 * What an explanation or navigation tool is about (36.4), by reference: no model call, never
 * charged. Explain lineage: a turn's answer (its plan), a property, or an object (its type's
 * sources). Explain a finding: the finding. Open a clone: an object's view or a type's Clone
 * Canvas, navigation only.
 */
export const SUBJECT_TOOLS = ['explain_finding', 'explain_lineage', 'open_clone', 'start_scenario'] as const;
export const toolSubject = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('turn'), sequence: z.number().int().min(1) }),
  z.strictObject({ kind: z.literal('property'), propertyIdentityId: z.uuid() }),
  z.strictObject({ kind: z.literal('object'), objectTypeId: z.uuid(), objectId: z.uuid() }),
  z.strictObject({ kind: z.literal('clone_canvas'), objectTypeId: z.uuid() }),
  z.strictObject({ kind: z.literal('finding'), findingId: z.uuid() }),
]);
export type ToolSubject = z.infer<typeof toolSubject>;
const SUBJECTS_OF: Readonly<Record<(typeof SUBJECT_TOOLS)[number], readonly ToolSubject['kind'][]>> = {
  explain_lineage: ['turn', 'property', 'object'], explain_finding: ['finding'], open_clone: ['object', 'clone_canvas'],
  // The object that fails (39.4); the question says how.
  start_scenario: ['object'],
};
export const REFUSAL_REASONS = ['no_plan', 'bound_exceeded', 'capability_missing', 'unsupported', 'daily_limit'] as const;

/** A candidate offered by a clarification (36.9): a vocabulary element, never a value. */
export const clarificationOption = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  kind: z.enum(['object_type', 'property', 'link_type', 'route', 'interface', 'time_field']),
  elementId: z.uuid(),
  /** The type name or skin label the person may see. */
  label: z.string().max(200),
  /** The connection the element comes from, as an opaque reference, where it has one. */
  source: z.string().max(200).nullable(),
});
export type ClarificationOption = z.infer<typeof clarificationOption>;

export const turnView = z.object({
  id: z.uuid(),
  sequence: z.number().int(),
  outcome: z.enum(['answer', 'refusal', 'clarification', 'proposal']),
  tool: z.enum(ASK_TOOLS),
  manifestId: z.uuid().nullable(),
  refusalReason: z.enum(REFUSAL_REASONS).nullable(),
  /** For a refusal: a narrowing that would succeed, as compile stated it (vocabulary only). */
  narrowing: z.string().max(500).nullable(),
  clarificationOptions: z.array(clarificationOption).nullable(),
  /**
   * A proposal (42.9, 36.4): how the change would be made, as references. manifestId is the
   * plan finding the records an update or delete changes (re-run it to list them). The values
   * are the asker's own words: not kept on the turn, carried once in the reply's draft.
   */
  proposal: z.object({
    objectTypeId: z.uuid(),
    operation: z.enum(['update', 'create', 'delete']),
    properties: z.array(z.string()),
    /** The confirmed Action types that fit: one is bound; several, the person chooses. */
    candidates: z.array(z.object({ actionTypeId: z.uuid(), actionTypeVersionId: z.uuid(), displayName: z.string() })),
    /** None fits: the generic governed edit (silo.edit). */
    genericEdit: z.boolean(),
  }).nullable(),
  /**
   * A Cron proposed (36.4, 40): the Cron editor pre-filled, as createCron takes it; a person
   * names it and saves it. Its subject is the thread's saved view, or an earlier answer of the
   * thread to save as a view first (36.11). No record value: kept on the turn as it is.
   */
  cron: z.object({
    subject: z.union([z.strictObject({ savedViewId: z.uuid() }), z.strictObject({ fromTurn: z.number().int().min(1) })]),
    trigger: z.object({ schedule: z.string() }),
    condition: z.object({
      kind: z.literal('result'), operator: z.enum(['returned_rows', 'returned_none', 'differs_from_previous', 'count_crossed']),
      threshold: z.int().optional(), direction: z.enum(['above', 'below']).optional(),
    }).nullable(),
    actions: z.array(z.union([z.object({ kind: z.literal('notify'), recipients: z.array(z.uuid()) }), z.object({ kind: z.literal('report'), format: z.literal('csv') })])),
    asWritten: z.string(),
  }).nullable(),
  /** A failure scenario started (36.4, 39.4): saved, private to the asker, ready to run. */
  scenarioId: z.uuid().nullable(),
  /** An explanation or navigation tool's subject, by reference. */
  subject: toolSubject.nullable(),
  /** Only in the reply of an explanation or navigation tool: computed then, never stored. */
  explanation: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('lineage'), graph: graphView }),
    z.object({ kind: z.literal('finding'), finding: findingView }),
    z.object({ kind: z.literal('navigation'), target: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('object_view'), objectTypeId: z.uuid(), objectId: z.uuid() }),
      z.object({ kind: z.literal('clone_canvas'), objectTypeId: z.uuid() }),
    ]) }),
  ]).optional(),
  /**
   * Only in the reply that made a proposal: the Action form pre-filled, for proposeMutation.
   * Each candidate's parameters, or the generic edit; the records come from re-running the plan.
   */
  draft: z.object({
    candidates: z.array(z.object({ actionTypeId: z.uuid(), parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])) })),
    edit: z.object({
      objectTypeId: z.uuid(), operation: z.enum(['update', 'create', 'delete']),
      set: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])), clear: z.array(z.string()),
    }).nullable(),
  }).optional(),
  /** The data plane result; it expires with its TTL, after which re-running is free. */
  resultRef: z.string().nullable(),
  /** Sources that did not answer within bound, by opaque reference. */
  incompleteSources: z.array(z.string()).max(50),
  tokensCharged: z.number().int(),
  /** Whether the question is kept (sealed) on the turn. */
  questionRetained: z.boolean(),
  /**
   * Outside context (36.7): a separate block below the answer, each result cited with its URL
   * and the retrieval time, the query sent shown as sent. Never mixed into figures.
   */
  outsideContext: z.object({
    status: z.enum(['ok', 'unavailable']),
    query: z.string(),
    retrievedAt: z.string(),
    results: z.array(z.object({ title: z.string(), url: z.string(), snippet: z.string() })),
  }).nullable(),
  createdAt: z.string(),
});
export type TurnView = z.infer<typeof turnView>;

const domain = z.string().trim().toLowerCase().max(253).regex(/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'a domain name');

/**
 * ask.web.manage at the scope (36.7; decision 2026-11-14): web context on or off there, an
 * allowlist or a blocklist of domains. In a scope holding marked data it stays off unless
 * coverMarkedData is set by an admin who satisfies every marking held there.
 */
export const setAskWebScopePolicy = defineContract({
  service: 'ask', name: 'setAskWebScopePolicy', method: 'PUT', path: '/v1/ask/web-policy/scopes/:scopeId', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ scopeId: z.uuid() }),
  body: z.strictObject({
    enabled: z.boolean(), allowedDomains: z.array(domain).max(200).default([]), blockedDomains: z.array(domain).max(200).default([]),
    coverMarkedData: z.boolean().default(false),
  }),
  response: z.object({
    scopeId: z.uuid(), enabled: z.boolean(), allowedDomains: z.array(z.string()), blockedDomains: z.array(z.string()),
    markedData: z.boolean(), coveredMarkings: z.int(),
  }),
});

/** ask.web.manage (36.7): the organisation's web context, on or off; available says whether the cell has a provider. */
export const setAskWebPolicy = defineContract({
  service: 'ask', name: 'setAskWebPolicy', method: 'PUT', path: '/v1/ask/web-policy', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ enabled: z.boolean() }),
  response: z.object({ enabled: z.boolean(), available: z.boolean() }),
});

/**
 * The web context policy (36.7): the organisation's switch, which anyone in it may read since it
 * shapes their answers, and the policies of the scopes the reader may manage (ask.web.manage there).
 */
export const readAskWebPolicy = defineContract({
  service: 'ask', name: 'readAskWebPolicy', method: 'GET', path: '/v1/ask/web-policy', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  response: z.object({
    enabled: z.boolean(), available: z.boolean(),
    scopes: z.array(z.object({
      scopeId: z.uuid(), enabled: z.boolean(), allowedDomains: z.array(z.string()), blockedDomains: z.array(z.string()),
      markedData: z.boolean(), coveredMarkings: z.int(), updatedBy: z.uuid(), updatedAt: z.string(),
    })),
  }),
});

const CALLERS = ['gateway'] as const;
const threadParams = z.strictObject({ threadId: z.uuid() });

export const createThread = defineContract({
  service: 'ask', name: 'createThread', method: 'POST', path: '/v1/ask/threads', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({
    /** The person's own label. Never derived from the question, which is a record value. */
    title: z.string().trim().min(1).max(200).optional(),
    scope: threadScope.optional(),
    /**
     * Ask an AI agent (D236): one the person owns or holds a live share of. Each question then
     * compiles with its brief and its object types, under the person's own access, and uses only
     * the tools it allows. Fixed for the thread's life.
     */
    aiAgentId: z.uuid().optional(),
  }),
  response: threadView, status: 201,
});

export const listThreads = defineContract({
  service: 'ask', name: 'listThreads', method: 'GET', path: '/v1/ask/threads', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({
    search: z.string().trim().min(1).max(100).optional(),
    archived: z.stringbool().default(false),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: z.object({ threads: z.array(threadView) }),
});

export const getThread = defineContract({
  service: 'ask', name: 'getThread', method: 'GET', path: '/v1/ask/threads/:threadId', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: threadParams,
  response: z.object({ thread: threadView, turns: z.array(turnView) }),
});

export const renameThread = defineContract({
  service: 'ask', name: 'renameThread', method: 'PATCH', path: '/v1/ask/threads/:threadId', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: threadParams,
  body: z.strictObject({ title: z.string().trim().min(1).max(200) }),
  response: threadView,
});

export const archiveThread = defineContract({
  service: 'ask', name: 'archiveThread', method: 'POST', path: '/v1/ask/threads/:threadId/archive', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: threadParams, response: threadView,
});

/** Widening the scope is recorded on the thread (33.6). */
export const widenThreadScope = defineContract({
  service: 'ask', name: 'widenThreadScope', method: 'PUT', path: '/v1/ask/threads/:threadId/scope', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: threadParams,
  body: z.strictObject({ scope: threadScope.nullable() }),
  response: threadView,
});

export const askQuestion = defineContract({
  service: 'ask', name: 'askQuestion', method: 'POST', path: '/v1/ask/threads/:threadId/turns', callers: CALLERS,
  shed: 'compile', context: 'organisation', idempotency: 'keyed', params: threadParams,
  body: z.strictObject({
    /** As typed. A record value: it goes to compile, which runs the literal pass, and is sealed if kept. */
    question: z.string().trim().min(1).max(2_000),
    /** propose_action: the question asks for a change (42.9); answer may also come back as one. */
    tool: z.enum(['answer', 'find_objects', 'propose_action', 'propose_cron', ...SUBJECT_TOOLS]).default('answer'),
    /** The explanation or navigation tools' subject (36.4): given with them, and only with them. */
    subject: toolSubject.optional(),
    /** Answering a clarification: the turn that offered it and the candidate chosen. */
    clarification: z.strictObject({ sequence: z.number().int().min(1), optionId: clarificationOption.shape.id }).optional(),
    /**
     * This question rephrases an earlier turn's (the person edited and asked again): within
     * metering's window it is charged once across both (spec 36.10, 73.2). The similarity test
     * is an open decision, so a rephrase is what the person marks, never a guess.
     */
    rephrases: z.strictObject({ sequence: z.number().int().min(1) }).optional(),
    /** Ask for an advanced compile (weight 3, query.advanced). */
    advanced: z.boolean().default(false),
  }).superRefine((b, ctx) => {
    const wanted = (SUBJECTS_OF as Record<string, readonly string[] | undefined>)[b.tool];
    if (wanted === undefined && b.subject !== undefined) ctx.addIssue({ code: 'custom', path: ['subject'], message: 'only an explanation or navigation tool takes a subject' });
    if (wanted !== undefined && (b.subject === undefined || !wanted.includes(b.subject.kind))) {
      ctx.addIssue({ code: 'custom', path: ['subject'], message: `${b.tool} is about ${wanted.join(' or ')}` });
    }
  }),
  response: z.object({ thread: threadView, turn: turnView }),
  status: 201, maxBodyBytes: 16 * 1024,
});

/** Re-runs an answered turn's manifest against live data, unmetered (36.8, 36.10). */
export const rerunTurn = defineContract({
  service: 'ask', name: 'rerunTurn', method: 'POST', path: '/v1/ask/threads/:threadId/turns/:sequence/runs', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ threadId: z.uuid(), sequence: z.coerce.number().int().min(1) }),
  response: z.object({
    resultRef: z.string().nullable(),
    refusalReason: z.enum(['bound_exceeded', 'capability_missing', 'unsupported', 'invalid_manifest', 'unavailable']).nullable(),
    incompleteSources: z.array(z.string()).max(50),
    ranAt: z.string(),
  }),
});
