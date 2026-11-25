// Concept templates in the global tier (spec 22.7; D210): Silo staff author them, a second
// person reviews them, and Fleet signs the set of reviewed and withdrawn templates for every
// cell. A cell's Fleet agent reads the signed set here and hands it to its catalogue, which
// verifies Silo's signature before writing a row. Names and field names only.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { signatureRecord } from './release.contract.ts';

export const TEMPLATE_STATUSES = ['draft', 'reviewed', 'withdrawn'] as const;
const fieldName = z.string().trim().min(1).max(100);

export const conceptTemplateView = z.object({
  id: z.uuid(), name: z.string(), fieldNames: z.array(z.string()), revision: z.int().min(1), status: z.enum(TEMPLATE_STATUSES),
  authoredBy: z.uuid(), reviewedBy: z.uuid().nullable(), reviewedAt: z.string().nullable(), withdrawnAt: z.string().nullable(),
});
export type ConceptTemplateView = z.infer<typeof conceptTemplateView>;

export const templateInput = z.strictObject({ name: z.string().trim().min(1).max(200), fieldNames: z.array(fieldName).min(1).max(200) });

/** What a cell installs: every reviewed and withdrawn template, as Silo signed it. */
export const conceptTemplateSet = z.strictObject({
  schema: z.literal('silo.concept_templates.v1'),
  generatedAt: z.string(),
  templates: z.array(conceptTemplateView.extend({ status: z.enum(['reviewed', 'withdrawn']) })).max(5_000),
});
export type ConceptTemplateSet = z.infer<typeof conceptTemplateSet>;

export const getConceptTemplateSet = defineContract({
  service: 'fleet-control', name: 'getConceptTemplateSet', method: 'GET', path: '/v1/concept-templates', callers: ['fleet-control'],
  context: 'none', idempotency: 'none',
  response: z.object({ set: conceptTemplateSet, signatures: z.array(signatureRecord).min(1).max(4), digest: z.string() }),
});
