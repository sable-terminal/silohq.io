// model-gateway (spec 7.8, 62): every model call in the cell passes through here.
//
// A call goes through these steps, in order:
// 1. the caller may use the role (ROLE_CALLERS), the role has a route, and the ledger can
//    record the caller; otherwise the request is refused before it is a model call;
// 2. the gateway builds the prompt from the typed request and hashes it;
// 3. refusals before sending, each recorded: record_value_field, redaction_match,
//    length_bound, extraction_not_enabled, concurrency_bound;
// 4. the call, under the route's timeout and the caller's request;
// 5. the output is checked against the caller's output schema; output that does not
//    match is refused, never repaired (spec 62.3);
// 6. the call is recorded (ledger, usage, audit) before the output is returned. If it
//    cannot be recorded, the output is not returned.
// Prompts, documents and outputs are never logged: the log carries the call id, route,
// outcome, token count and duration.

import { embedTexts } from '../../contracts/model-gateway/embedding.contract.ts';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DocumentMediaType, ModelConfig, ModelRole } from '../../config/model.config.ts';
import { ROLE_CALLERS, type callModel, type modelCallResult } from '../../contracts/model-gateway/call.contract.ts';
import type { extractDocument } from '../../contracts/model-gateway/extraction.contract.ts';
import type { ParsedInput } from '../../contracts/endpoint.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import type { EmbedReply, ModelProvider, ModelReply } from '../../infra/modelProvider.infra.ts';
import { inTransaction, type Databases } from '../../infra/postgres.infra.ts';
import { siloFileRepo, siloRepo } from '../../repos/siloes/index.repo.ts';
import { AppError, isAppError, refuse } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { ledgerCaller, recordCall, type CallRecord } from './ledger.service.ts';
import { assemblePrompt, type Prompt } from './prompt.service.ts';
import { findingsRefusal, outputSchemaRefusal, redactionRefusal, type Refusal } from './screen.service.ts';
import type { Slots } from './slots.service.ts';

export type CallResult = z.input<typeof modelCallResult>;

export interface ModelGatewayDeps {
  databases: Databases;
  slots: Slots;
  /** One endpoint per role that has a route. */
  providers: ReadonlyMap<ModelRole, ModelProvider>;
  config: ModelConfig;
  logger: Logger;
}

export interface ModelGateway {
  call(input: ParsedInput<typeof callModel>['body'], ctx: HandlerContext): Promise<CallResult>;
  extract(input: ParsedInput<typeof extractDocument>['body'], ctx: HandlerContext): Promise<CallResult>;
  embed(input: ParsedInput<typeof embedTexts>['body'], ctx: HandlerContext): Promise<z.input<typeof embedTexts.response>>;
}

// A lease outlives the call's timeout, so a slot is never freed while its call can still run.
const LEASE_MARGIN_MS = 5_000;

type Base = Omit<CallRecord, 'outcome' | 'refusalCategory' | 'reasonCode' | 'usage' | 'latencyMs'>;

export function createModelGateway(deps: ModelGatewayDeps): ModelGateway {
  const { config, logger } = deps;

  const providerFor = (role: ModelRole): ModelProvider => {
    const provider = deps.providers.get(role);
    if (provider === undefined) {
      throw new AppError('unavailable', `this cell has no model route for ${role}`, { code: 'model.role_unavailable', details: { role } });
    }
    return provider;
  };

  // The caller's JSON Schema as a check. One the gateway cannot read is the caller's defect.
  const outputCheck = (schema: Record<string, unknown>): z.ZodType => {
    try {
      return z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
    } catch {
      throw new AppError('validation', 'the output schema is not a JSON Schema the gateway can check', { code: 'model.output_schema_invalid' });
    }
  };

  const tokensBound = (provider: ModelProvider, asked: number | undefined): { tokens: number; refusal?: Refusal } => {
    const limit = provider.route.maxOutputTokens;
    const tokens = asked ?? limit;
    return tokens <= limit ? { tokens } : { tokens, refusal: { category: 'length_bound', error: refuse.bound('model_output_tokens', limit) } };
  };

  const record = async (base: Base, outcome: Pick<CallRecord, 'outcome' | 'refusalCategory' | 'reasonCode' | 'usage' | 'latencyMs'>)
    : Promise<void> => recordCall(deps.databases, { ...base, ...outcome });

  const refused = async (base: Base, refusal: Refusal, log: Logger): Promise<never> => {
    try {
      await record(base, { outcome: 'refused', refusalCategory: refusal.category, reasonCode: refusal.error.code });
    } catch (error) {
      log.failure('a refused model call could not be recorded', error, { event: 'model.ledger_failed', resourceId: base.callId });
    }
    log.warn('model call refused', {
      event: 'model.call_refused', reason: refusal.category, errorCode: refusal.error.code, resourceType: 'model_call',
      resourceId: base.callId, dependency: base.route.name,
    });
    throw refusal.error;
  };

  const send = async (base: Base, provider: ModelProvider, prompt: Prompt, maxOutputTokens: number, ctx: HandlerContext,
    check: z.ZodType, document?: { mediaType: DocumentMediaType; data: Buffer }): Promise<CallResult> => {
    const log = ctx.logger;
    const slot = await deps.slots.acquire(base.request.organisationId!, base.callId, provider.route.timeoutMs + LEASE_MARGIN_MS);
    if (!('release' in slot)) {
      return refused(base, {
        category: 'concurrency_bound',
        error: new AppError('capacity', `refused: the ${slot.bound} bound of ${slot.limit} calls in flight is reached; retry shortly`, {
          code: `bound.${slot.bound}`, details: { bound: slot.bound, limit: slot.limit }, retryAfterSeconds: 1,
        }),
      }, log);
    }

    const started = performance.now();
    let reply: ModelReply | undefined;
    let failure: unknown;
    try {
      reply = await provider.generate({
        system: prompt.system, user: prompt.user, output: { name: prompt.outputName, schema: prompt.outputSchema }, maxOutputTokens,
        signal: ctx.signal, document,
      });
    } catch (error) {
      failure = error;
    }
    const latencyMs = Math.round(performance.now() - started);
    await slot.release().catch((error: unknown) => {
      log.failure('a model call slot could not be released; its lease will expire', error, { event: 'model.slot_release_failed' });
    });

    if (reply === undefined) {
      const error = isAppError(failure) ? failure : new AppError('internal', 'the model call failed', { code: 'model.call_failed', cause: failure });
      try {
        await record(base, { outcome: 'error', reasonCode: error.code, latencyMs });
      } catch (ledgerError) {
        log.failure('a failed model call could not be recorded', ledgerError, { event: 'model.ledger_failed', resourceId: base.callId });
      }
      log.warn('model call failed', {
        event: 'model.call', outcome: 'error', errorCode: error.code, resourceType: 'model_call', resourceId: base.callId,
        dependency: base.route.name, durationMs: latencyMs,
      });
      throw error;
    }

    const recorded = { ...base, model: reply.model };
    const output = parseOutput(reply, check);
    if (output.ok === false) {
      try {
        await record(recorded, { outcome: 'error', reasonCode: 'model.output_invalid', usage: reply.usage, latencyMs });
      } catch (ledgerError) {
        log.failure('a refused model output could not be recorded', ledgerError, { event: 'model.ledger_failed', resourceId: base.callId });
      }
      log.warn('model output refused', {
        event: 'model.call', outcome: 'output_invalid', reason: reply.finish, resourceType: 'model_call', resourceId: base.callId,
        dependency: base.route.name, durationMs: latencyMs,
      });
      throw new AppError('upstream', 'the model\'s output does not match the output schema; it is refused, not repaired', {
        code: 'model.output_invalid', details: { finish: reply.finish, issues: output.issues },
      });
    }

    try {
      await record(recorded, { outcome: 'ok', usage: reply.usage, latencyMs });
    } catch (error) {
      log.failure('a model call could not be recorded; its output is withheld', error, { event: 'model.ledger_failed', resourceId: base.callId });
      throw new AppError('unavailable', 'the model call could not be recorded, so its output is withheld', {
        code: 'model.ledger_unavailable', cause: error,
      });
    }
    log.info('model call', {
      event: 'model.call', outcome: 'ok', resourceType: 'model_call', resourceId: base.callId, dependency: base.route.name,
      durationMs: latencyMs, count: reply.usage.inputTokens + reply.usage.outputTokens + reply.usage.thinkingTokens,
    });
    return { callId: base.callId, output: output.value, model: reply.model, route: base.route.name, usage: reply.usage, latencyMs };
  };

  /**
   * Text embeddings (decision 2026-11-15): screened as a prompt is (a value pattern refuses the
   * whole request), within the request bound, one slot, recorded with counts and the hash of
   * the texts, never the texts or the vectors.
   */
  const embed = async (input: ParsedInput<typeof embedTexts>['body'], ctx: HandlerContext) => {
    const log = ctx.logger;
    const provider = providerFor('embedding');
    const joined = input.texts.join('\n');
    const base: Base = {
      callId: uuidv7(), correlationId: ctx.correlationId, request: ctx.request, caller: ledgerCaller(ctx.caller), role: 'embedding', requestType: 'embedding',
      route: provider.route, model: provider.route.model, promptHash: createHash('sha256').update(`${input.task}\n${joined}`, 'utf8').digest(),
      engagementId: undefined, taskId: undefined,
    };
    const bytes = Buffer.byteLength(joined, 'utf8');
    const refusal = redactionRefusal({ texts: input.texts })
      ?? (bytes > config.maxRequestBytes ? { category: 'length_bound' as const, error: refuse.bound('model_request_bytes', config.maxRequestBytes, { bytes }) } : undefined);
    if (refusal !== undefined) return refused(base, refusal, log);
    const slot = await deps.slots.acquire(base.request.organisationId!, base.callId, provider.route.timeoutMs + LEASE_MARGIN_MS);
    if (!('release' in slot)) {
      return refused(base, {
        category: 'concurrency_bound',
        error: new AppError('capacity', `refused: the ${slot.bound} bound of ${slot.limit} calls in flight is reached; retry shortly`, {
          code: `bound.${slot.bound}`, details: { bound: slot.bound, limit: slot.limit }, retryAfterSeconds: 1,
        }),
      }, log);
    }
    const started = performance.now();
    let reply: EmbedReply | undefined;
    let failure: unknown;
    try {
      reply = await provider.embed({ texts: input.texts, task: input.task, signal: ctx.signal });
    } catch (error) {
      failure = error;
    }
    const latencyMs = Math.round(performance.now() - started);
    await slot.release().catch((error: unknown) => {
      log.failure('a model call slot could not be released; its lease will expire', error, { event: 'model.slot_release_failed' });
    });
    if (reply === undefined) {
      const error = isAppError(failure) ? failure : new AppError('internal', 'the embedding call failed', { code: 'model.call_failed', cause: failure });
      await record(base, { outcome: 'error', reasonCode: error.code, latencyMs }).catch((ledgerError: unknown) => {
        log.failure('a failed embedding call could not be recorded', ledgerError, { event: 'model.ledger_failed', resourceId: base.callId });
      });
      throw error;
    }
    try {
      await record({ ...base, model: reply.model }, { outcome: 'ok', usage: reply.usage, latencyMs });
    } catch (error) {
      throw new AppError('unavailable', 'the embedding call could not be recorded, so its output is withheld', { code: 'model.ledger_unavailable', cause: error });
    }
    log.info('model call', {
      event: 'model.call', outcome: 'ok', resourceType: 'model_call', resourceId: base.callId, dependency: provider.route.name, durationMs: latencyMs,
      count: input.texts.length,
    });
    return { vectors: reply.vectors, model: reply.model, route: provider.route.name, usage: reply.usage, latencyMs };
  };

  return {
    embed,
    async call(input, ctx) {
      if (!ROLE_CALLERS[input.role].includes(ctx.caller)) {
        throw new AppError('forbidden', `${ctx.caller} may not use the ${input.role} role`, {
          code: 'model.role_not_permitted', details: { caller: ctx.caller, role: input.role },
        });
      }
      const caller = ledgerCaller(ctx.caller);
      const provider = providerFor(input.role);
      const check = outputCheck(input.output.schema);
      const prompt = assemblePrompt({
        role: input.role, instructions: input.instructions, vocabulary: input.vocabulary, question: input.question,
        context: input.context, findingsSummary: input.findingsSummary, output: input.output,
      });
      const base: Base = {
        callId: uuidv7(), correlationId: ctx.correlationId, request: ctx.request, caller, role: input.role, requestType: 'vocabulary',
        route: provider.route, model: provider.route.model, promptHash: prompt.hash, engagementId: input.engagementId, taskId: input.taskId,
      };
      const tokens = tokensBound(provider, input.maxOutputTokens);
      const refusal = findingsRefusal(input.findingsSummary)
        ?? outputSchemaRefusal(input.output.schema)
        ?? redactionRefusal({
          instructions: input.instructions, vocabulary: input.vocabulary, question: input.question, context: input.context,
          findingsSummary: input.findingsSummary, output: input.output,
        })
        ?? (prompt.bytes > config.maxRequestBytes
          ? { category: 'length_bound' as const, error: refuse.bound('model_request_bytes', config.maxRequestBytes, { bytes: prompt.bytes }) }
          : undefined)
        ?? tokens.refusal;
      if (refusal) return refused(base, refusal, ctx.logger);
      return send(base, provider, prompt, tokens.tokens, ctx, check);
    },

    async extract(input, ctx) {
      const caller = ledgerCaller(ctx.caller);
      const provider = providerFor('document_extraction');
      const { mediaType } = input.document;
      if (!provider.route.documentMediaTypes.includes(mediaType)) {
        throw new AppError('validation', `this cell's extraction route does not read ${mediaType}`, {
          code: 'model.media_type_unsupported', details: { mediaType },
        });
      }
      const check = outputCheck(input.output.schema);
      const data = Buffer.from(input.document.contentBase64, 'base64');
      const prompt = assemblePrompt({
        role: 'document_extraction', instructions: input.instructions, output: input.output, document: { mediaType, bytes: data.length },
      });
      const base: Base = {
        callId: uuidv7(), correlationId: ctx.correlationId, request: ctx.request, caller, role: 'document_extraction',
        requestType: 'document_extraction', route: provider.route, model: provider.route.model, promptHash: prompt.hash,
        extraction: { siloId: input.siloId, fileId: input.fileId, mediaType, byteCount: data.length },
      };
      const tokens = tokensBound(provider, input.maxOutputTokens);
      const refusal = outputSchemaRefusal(input.output.schema)
        // The document is the carve-out and is not scanned; everything around it is.
        ?? redactionRefusal({ instructions: input.instructions, output: input.output })
        ?? (prompt.bytes > config.maxRequestBytes
          ? { category: 'length_bound' as const, error: refuse.bound('model_request_bytes', config.maxRequestBytes, { bytes: prompt.bytes }) }
          : undefined)
        ?? (data.length > config.maxDocumentBytes
          ? { category: 'length_bound' as const, error: refuse.bound('model_document_bytes', config.maxDocumentBytes, { bytes: data.length }) }
          : undefined)
        ?? tokens.refusal
        ?? await carveOutRefusal(deps.databases, ctx.request.organisationId!, input.siloId, input.fileId);
      if (refusal) return refused(base, refusal, ctx.logger);
      return send(base, provider, prompt, tokens.tokens, ctx, check, { mediaType, data });
    },
  };
}

// The carve-out applies to a live import Silo (not being purged or disabled; one still
// 'provisioning' takes files before the federated engine can plan against it) whose carve-out
// a holder of silo.enable acknowledged, and to a file imported into it that is not tabular
// (spec 62.5).
async function carveOutRefusal(databases: Databases, organisationId: string, siloId: string, fileId: string): Promise<Refusal | undefined> {
  const reason = await inTransaction(databases.pool('control'), { organisationId }, async (db) => {
    const silo = await siloRepo.findById(db, siloId);
    if (silo === undefined || silo.kind !== 'import' || silo.status === 'purging' || silo.status === 'disabled') return 'not_an_active_import_silo';
    if (silo.carveoutAcknowledgedAt === null) return 'carveout_not_acknowledged';
    const file = await siloFileRepo.findById(db, fileId);
    if (file === undefined || file.siloId !== siloId || file.status === 'purged') return 'file_not_in_silo';
    if (file.contentClass === 'tabular') return 'tabular_file';
    return undefined;
  }, { readOnly: true });
  if (reason === undefined) return undefined;
  return {
    category: 'extraction_not_enabled',
    error: new AppError('forbidden', `refused: document extraction is not enabled for this file (${reason}); nothing was sent`, {
      code: 'model.extraction_not_enabled', details: { reason },
    }),
  };
}

type Parsed = { ok: true; value: z.core.util.JSONType } | { ok: false; issues: number };

// The output as the endpoint returned it, checked and never repaired.
function parseOutput(reply: ModelReply, check: z.ZodType): Parsed {
  let json: unknown;
  try {
    json = JSON.parse(reply.text);
  } catch {
    return { ok: false, issues: 1 };
  }
  const checked = check.safeParse(json);
  if (!checked.success) return { ok: false, issues: checked.error.issues.length };
  return { ok: true, value: json as z.core.util.JSONType };
}
