// Every model call, allowed or refused, in one transaction (spec 7.8, 62.8, 9.2):
// - its platform.model_calls row: tokens, latency, route, outcome, prompt hash, and what the
//   provider charges for it at the route's prices (null where the route names none), never
//   the prompt or the output;
// - for a call that reached a model and reported tokens, those tokens on metering.usage
//   (model_usage);
// - its audit events on audit.events (audit_event): model_call_made or model_call_refused,
//   and extraction_carveout_used when a document was sent.
// The ledger row and the messages commit together or not at all.

import type { ModelRole, ModelRoute } from '../../config/model.config.ts';
import type { ServiceName } from '../../config/service.config.ts';
import { auditEventMessage, type AuditActor, type AuditEventPayload } from '../../contracts/audit/auditEvent.contract.ts';
import { modelUsageMessage, type RefusalCategory } from '../../contracts/model-gateway/events.contract.ts';
import type { ModelUsage } from '../../infra/modelProvider.infra.ts';
import { inTransaction, type Databases, type Queryable, type RequestContext } from '../../infra/postgres.infra.ts';
import type { ModelCall } from '../../models/platform/modelCall.model.ts';
import type { JsonValue } from '../../models/table.model.ts';
import { modelCallRepo, outboxRepo } from '../../repos/platform/index.repo.ts';
import { modelCallSchema } from '../../schemas/platform/modelCall.schema.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';

export type LedgerCaller = ModelCall['callerService'];

/** The ledger's caller, or a refusal: a call the ledger cannot hold is never made. */
export function ledgerCaller(caller: ServiceName): LedgerCaller {
  const parsed = modelCallSchema.shape.callerService.safeParse(caller);
  if (parsed.success) return parsed.data;
  throw new AppError('configuration', `model calls from ${caller} cannot be recorded yet, so none is made`, {
    code: 'model.caller_not_recorded', details: { caller },
  });
}

export interface CallRecord {
  callId: string;
  correlationId: string;
  request: RequestContext;
  caller: LedgerCaller;
  role: ModelRole;
  requestType: ModelCall['requestType'];
  route: ModelRoute;
  /** As the endpoint reported it; the route's model when nothing was sent. */
  model: string;
  promptHash: Buffer;
  outcome: ModelCall['outcome'];
  refusalCategory?: RefusalCategory | undefined;
  /** A stable code saying why: model.value_pattern, model.timeout, model.output_invalid. */
  reasonCode?: string | undefined;
  usage?: ModelUsage | undefined;
  latencyMs?: number | undefined;
  engagementId?: string | undefined;
  taskId?: string | undefined;
  /** document_extraction: the file and how much of it was sent. */
  extraction?: { siloId: string; fileId: string; mediaType: string; byteCount: number } | undefined;
}

// Who the call was for: the person, the service principal (AI FDE work), or the service.
function actorOf(record: CallRecord): AuditActor {
  if (record.request.membershipId !== undefined) return { kind: 'membership', membershipId: record.request.membershipId };
  if (record.request.servicePrincipalId !== undefined) {
    return { kind: 'service_principal', servicePrincipalId: record.request.servicePrincipalId };
  }
  return { kind: 'service', service: record.caller };
}

/** Pounds as hundred-millionths: '0.25' is 25_000_000n. */
const nanos = (pounds: string): bigint => {
  const [whole, fraction = ''] = pounds.split('.');
  return BigInt(whole!) * 100_000_000n + BigInt(fraction.padEnd(8, '0').slice(0, 8));
};

/** What the tokens cost at the route's prices, in pounds to eight decimals; null where it names none (pure). */
export function costOf(pricing: ModelRoute['pricing'], usage: ModelUsage): string | null {
  if (pricing === undefined) return null;
  const total = nanos(pricing.inputPerMillion) * BigInt(usage.inputTokens)
    + nanos(pricing.outputPerMillion) * BigInt(usage.outputTokens + usage.thinkingTokens);
  const value = (total + 500_000n) / 1_000_000n;
  return `${value / 100_000_000n}.${(value % 100_000_000n).toString().padStart(8, '0')}`;
}

export async function recordCall(databases: Databases, record: CallRecord): Promise<void> {
  const organisationId = record.request.organisationId!;
  await inTransaction(databases.pool('control'), { organisationId }, async (db) => {
    const usage = record.usage ?? { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 };
    await modelCallRepo.insert(db, {
      organisationId,
      callId: record.callId,
      correlationId: record.correlationId,
      engagementId: record.engagementId ?? null,
      taskId: record.taskId ?? null,
      callerService: record.caller,
      requestType: record.requestType,
      model: record.model,
      modelRoute: record.route.name,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      thinkingTokens: usage.thinkingTokens,
      promptHash: record.promptHash,
      outcome: record.outcome,
      refusalCategory: record.refusalCategory ?? null,
      latencyMs: record.latencyMs ?? null,
      // A refused call reached no model and costs nothing; an unpriced route is unmeasured.
      providerCost: record.outcome === 'refused' ? (record.route.pricing === undefined ? null : '0.00000000') : costOf(record.route.pricing, usage),
    });

    const sent = record.outcome !== 'refused';
    if (sent && usage.inputTokens + usage.outputTokens + usage.thinkingTokens > 0) {
      await publish(db, record, modelUsageMessage, modelUsageMessage.schema.parse({
        callId: record.callId, callerService: record.caller, role: record.role, requestType: record.requestType,
        route: record.route.name, model: record.model, outcome: record.outcome, ...usage,
        membershipId: record.request.membershipId ?? null, servicePrincipalId: record.request.servicePrincipalId ?? null,
        engagementId: record.engagementId ?? null, taskId: record.taskId ?? null, siloFileId: record.extraction?.fileId ?? null,
      }));
    }

    const audit = (event: string, resource: AuditEventPayload['resource'], detail: AuditEventPayload['detail']): Promise<void> =>
      publish(db, record, auditEventMessage, auditEventMessage.schema.parse({
        event, actor: actorOf(record), subjectMembershipId: null, scopeId: null, resource, purposeSessionId: null,
        operatorAccessSessionId: record.request.operatorSessionId ?? null, ipHash: null, detail,
      }));
    const call = { type: 'model_call', id: record.callId };
    const about = {
      caller_service: record.caller, role: record.role, request_type: record.requestType, route: record.route.name,
      engagement_id: record.engagementId ?? null, task_id: record.taskId ?? null,
      ...(record.reasonCode === undefined ? {} : { reason: record.reasonCode }),
    };
    if (!sent) {
      await audit('model_call_refused', call, { ...about, refusal_category: record.refusalCategory ?? null });
      return;
    }
    await audit('model_call_made', call, {
      ...about, outcome: record.outcome, model: record.model, input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
      thinking_tokens: usage.thinkingTokens, latency_ms: record.latencyMs ?? null,
    });
    if (record.extraction) {
      await audit('extraction_carveout_used', { type: 'silo_file', id: record.extraction.fileId }, {
        call_id: record.callId, silo_id: record.extraction.siloId, media_type: record.extraction.mediaType,
        byte_count: record.extraction.byteCount,
      });
    }
  });
}

async function publish(
  db: Queryable, record: CallRecord, message: { topic: 'metering.usage' | 'audit.events'; name: string; version: number },
  payload: JsonValue,
): Promise<void> {
  const organisationId = record.request.organisationId!;
  await outboxRepo.insert(db, {
    id: uuidv7(), organisationId, topic: message.topic, orderingKey: organisationId, event: message.name,
    schemaVersion: message.version, payload, correlationId: record.correlationId,
  });
}
