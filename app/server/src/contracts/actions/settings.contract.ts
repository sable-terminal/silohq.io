// The organisation's write-back settings (spec 45.4): the canary sample size. The canary's
// threshold, 10,000 rows, is not a setting and cannot be removed (43.9); the sample written and
// verified first is the organisation's, 100 rows across all connections by default.
//
// And the generic governed edit (42.9): on unless the organisation disables it, when an edit no
// confirmed Action type covers is refused, with the offer to propose an Action type.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const actionSettingsView = z.object({
  /** At this many rows or more a mutation writes a canary sample first. */
  canaryThresholdRows: z.int(),
  /** The sample, across all connections. */
  canarySampleRows: z.int(),
  /** Whether the organisation set the sample (false: the default). */
  custom: z.boolean(),
  /** silo.edit: its Action type id (to propose an edit with) and whether the organisation allows it. */
  genericEdit: z.object({ actionTypeId: z.uuid(), enabled: z.boolean() }),
  /** A physical Action is proposed only with a dry run's receipt (47.5). */
  physicalDryRunRequired: z.boolean(),
});
export type ActionSettingsView = z.infer<typeof actionSettingsView>;

export const getActionSettings = defineContract({
  // compile: whether an intent no Action type fits may compile to the generic edit (42.9).
  service: 'actions', name: 'getActionSettings', method: 'GET', path: '/v1/actions/settings', callers: ['gateway', 'compile'],
  context: 'organisation', idempotency: 'none',
  response: actionSettingsView,
});

export const setCanarySample = defineContract({
  service: 'actions', name: 'setCanarySample', method: 'PUT', path: '/v1/actions/settings/canary', callers: ['gateway'],
  // mutation.policy organisation-wide; a repeat sets the same value.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ sampleRows: z.int().min(1).max(9_999).nullable() }),
  response: actionSettingsView,
});

/** mutation.policy organisation-wide: whether a physical Action needs a dry run's receipt before it is proposed (47.5). */
export const setPhysicalDryRun = defineContract({
  service: 'actions', name: 'setPhysicalDryRun', method: 'PUT', path: '/v1/actions/settings/physical-dry-run', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ required: z.boolean() }),
  response: actionSettingsView,
});

/** mutation.policy organisation-wide: allow or disable the generic governed edit (42.9). */
export const setGenericEdit = defineContract({
  service: 'actions', name: 'setGenericEdit', method: 'PUT', path: '/v1/actions/settings/generic-edit', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ enabled: z.boolean() }),
  response: actionSettingsView,
});
