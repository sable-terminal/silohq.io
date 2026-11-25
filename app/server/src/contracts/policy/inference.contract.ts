// The organisation's inference switches (decision 2026-11-11; D71). Each lets Silo go beyond
// observed evidence in one place, and each is off until a holder of org.inference.manage turns
// it on: simulation priors from stated lead times; probabilistic record matches proposed to
// resolution's reviewers; inferred link candidates proposed to the ontology's reviewers; and a
// probability on findings from their detector's dispositions. What is inferred always says so.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const inferenceSettingsView = z.object({
  simulation: z.boolean(),
  resolution: z.boolean(),
  links: z.boolean(),
  findings: z.boolean(),
});
export type InferenceSettings = z.infer<typeof inferenceSettingsView>;

export const getInferenceSettings = defineContract({
  service: 'policy', name: 'getInferenceSettings', method: 'GET', path: '/v1/inference-settings', callers: ['gateway', 'admin-portal'],
  context: 'organisation', idempotency: 'none',
  response: inferenceSettingsView,
});

export const setInferenceSettings = defineContract({
  service: 'policy', name: 'setInferenceSettings', method: 'PATCH', path: '/v1/inference-settings', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  body: inferenceSettingsView.partial().strict().refine((b) => Object.keys(b).length > 0, 'name a switch'),
  response: inferenceSettingsView,
});
