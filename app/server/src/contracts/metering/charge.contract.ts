// The charge (spec 73): every metered operation asks metering to charge it, and metering
// alone decides whether it is charged, from which source and at what weight. Weights are
// fixed per operation (73.1) and never sent by the caller. The non-charging rules (73.2)
// are enforced here, not in the interface: a never-metered trigger or a rephrase within
// the window returns charged: false and writes no row. Exhaustion is refused with the
// bound named, and nothing is charged; a charge is never partly applied.
//
// Compile charges only once a plan exists (spec 5.4, 26.10): it calls after planning and
// before execution, under an Idempotency-Key, so a retry never charges twice.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const OPERATIONS = [
  'compile', 'advanced_compile', 'connector_generation', 'repair_proposal', 'document_extraction', 'simulation',
  'simulation_rerun',
] as const;
export type Operation = (typeof OPERATIONS)[number];

/** Spec 73.2: work that enters with a plan already in structure, or makes no model call. */
export const NEVER_METERED = [
  'saved_view_run', 'dashboard_refresh', 'alert_poll', 'cache_hit', 'connection_added', 'refusal', 'cron_run',
  'live_stream', 'index_refresh',
] as const;

export const SOURCES = ['grant', 'allowance', 'purchase', 'contract'] as const;

/** Units charged: whole for tokens, a fraction for a simulation re-run. numeric(12,4) as text. */
export const units = z.string().regex(/^\d{1,8}(\.\d{1,4})?$/);

const chargeBody = z.strictObject({
  operation: z.enum(OPERATIONS),
  /** The query, connector, file or simulation charged for (the ledger's correlation_id). */
  correlationId: z.uuid(),
  /** Why the operation ran. Anything but authored is never metered (73.2). */
  trigger: z.enum(['authored', ...NEVER_METERED]).default('authored'),
  /** Compile only: the earlier charged compile this one rephrases. Within the window, it is not charged again. */
  rephraseOf: z.uuid().optional(),
  /** AI FDE work (73.5): charged to the contract allocation or the engaging membership's purchased balance. */
  engagementId: z.uuid().optional(),
  // What the charge bought, as the ledger requires per operation.
  siloFileId: z.uuid().optional(),
  simulationRunId: z.uuid().optional(),
  healProposalId: z.uuid().optional(),
  connectorManifestId: z.uuid().optional(),
}).superRefine((body, ctx) => {
  const needs: Partial<Record<Operation, keyof typeof body>> = {
    document_extraction: 'siloFileId', simulation: 'simulationRunId', simulation_rerun: 'simulationRunId',
    repair_proposal: 'healProposalId', connector_generation: 'connectorManifestId',
  };
  const references = ['siloFileId', 'simulationRunId', 'healProposalId', 'connectorManifestId'] as const;
  const required = needs[body.operation];
  for (const field of references) {
    if (field === required && body[field] === undefined) ctx.addIssue({ code: 'custom', path: [field], message: `${body.operation} names the ${field} it paid for` });
    if (field !== required && body[field] !== undefined) ctx.addIssue({ code: 'custom', path: [field], message: `${body.operation} does not take ${field}` });
  }
  if (body.rephraseOf !== undefined && body.operation !== 'compile' && body.operation !== 'advanced_compile') {
    ctx.addIssue({ code: 'custom', path: ['rephraseOf'], message: 'only a compile is a rephrase' });
  }
});

export const charge = defineContract({
  service: 'metering', name: 'charge', method: 'POST', path: '/v1/charges',
  callers: ['compile', 'simulation', 'fde-orchestrator', 'connector-builder', 'connector-maintenance', 'siloes-import', 'model-gateway'],
  // The person's request (membership), or the AI FDE's (service principal, with an engagement).
  context: 'organisation', idempotency: 'keyed',
  body: chargeBody,
  response: z.discriminatedUnion('charged', [
    z.object({
      charged: z.literal(true),
      /** The ledger row, the record a customer disputes against. */
      transactionId: z.string().regex(/^\d{1,19}$/),
      operation: z.enum(OPERATIONS),
      pool: z.enum(['tokens', 'simulations']),
      weight: units,
      source: z.enum(SOURCES),
    }),
    z.object({ charged: z.literal(false), reason: z.enum(['never_metered', 'rephrase_window']) }),
  ]),
  maxBodyBytes: 2048,
});

/** Codes a refused charge carries, each naming what was exhausted. */
export const CHARGE_REFUSALS = [
  'metering.daily_limit_reached', 'metering.allowance_exhausted', 'metering.no_allowance', 'metering.purchased_exhausted',
  'metering.engagement_budget',
] as const;
