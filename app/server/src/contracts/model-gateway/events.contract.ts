// What model-gateway tells the rest of the cell about each call, through its outbox in
// the transaction that writes the platform.model_calls row (spec 9.2), so a call is
// recorded, metered and audited together or not at all. References and counts only:
// never the prompt, the document or the output.
//
// - metering.usage, model_usage (here): the tokens a call consumed at the provider, for
//   provider cost per compile, per engagement and per task (spec 7.8, 52.6). Published for
//   every call that reached a model and reported tokens, including one whose output was
//   refused.
// - audit.events, audit_event (contracts/audit/auditEvent.contract.ts): model_call_made,
//   model_call_refused and extraction_carveout_used (spec 62.8). The last carries the file
//   reference and byte count, the one record of record values being sent to a model.

import { z } from 'zod';
import { MODEL_ROLES } from '../../config/model.config.ts';
import { SERVICES } from '../../config/service.config.ts';

/** platform.model_calls.refusal_category. */
export const REFUSAL_CATEGORIES = [
  'redaction_match', 'record_value_field', 'concurrency_bound', 'length_bound', 'extraction_not_enabled',
] as const;
export type RefusalCategory = (typeof REFUSAL_CATEGORIES)[number];

export const modelUsageMessage = {
  topic: 'metering.usage',
  name: 'model_usage',
  version: 1,
  schema: z.strictObject({
    callId: z.uuid(),
    callerService: z.enum(SERVICES),
    role: z.enum(MODEL_ROLES),
    requestType: z.enum(['vocabulary', 'document_extraction', 'embedding']),
    route: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,62}$/),
    model: z.string().min(1).max(200),
    outcome: z.enum(['ok', 'error']),
    inputTokens: z.int().min(0),
    outputTokens: z.int().min(0),
    thinkingTokens: z.int().min(0),
    membershipId: z.uuid().nullable(),
    servicePrincipalId: z.uuid().nullable(),
    /** AI FDE work (spec 52.6). */
    engagementId: z.uuid().nullable(),
    taskId: z.uuid().nullable(),
    /** document_extraction: the file it paid for (billing.token_transactions.silo_file_id). */
    siloFileId: z.uuid().nullable(),
  }),
} as const;

export type ModelUsage = z.infer<typeof modelUsageMessage.schema>;
