// What the person did in the workspace, reported by the client (spec 33.5, 37; D208): a Cmd-K
// command run, a dashboard tile that fell back to Figure or Table at tile size, an analysis
// step refused at its bound. References, closed sets and counts only.

import { z } from 'zod';
import { ARCHETYPES } from '../canvas-layout/layout.contract.ts';
import { defineContract } from '../endpoint.contract.ts';
import { ANALYSIS_OPERATIONS } from '../compile/analysis.contract.ts';

const id = z.uuid();

/** Cmd-K's entries (33.5): product commands, the opens it offers, and "Ask: typed text". */
export const PALETTE_COMMANDS = [
  'new_app', 'favourite', 'share', 'export', 'switch_representation', 'open_object', 'open_type', 'open_view', 'open_app', 'open_scenario',
  'open_thread', 'open_action_form', 'ask',
] as const;
export const PALETTE_PAGES = ['home', 'explorer', 'object_view', 'view', 'canvas', 'studio', 'ask', 'settings', 'other'] as const;
/** An analysis chain's steps (37.8): the operations a chain is built from. */
export const ANALYSIS_STEPS = ANALYSIS_OPERATIONS;

export const recordWorkspaceInteraction = defineContract({
  service: 'workspace', name: 'recordWorkspaceInteraction', method: 'POST', path: '/v1/interactions', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  body: z.discriminatedUnion('event', [
    z.strictObject({ event: z.literal('palette_command_run'), command: z.enum(PALETTE_COMMANDS), page: z.enum(PALETTE_PAGES) }),
    z.strictObject({
      event: z.literal('dashboard_tile_fallback'), savedViewId: id, from: z.enum(ARCHETYPES), to: z.enum(['figure', 'table']),
      reason: z.enum(['below_minimum_size', 'not_meaningful']),
    }),
    z.strictObject({
      event: z.literal('analysis_step_refused'), savedViewId: id.optional(), step: z.enum(ANALYSIS_STEPS), stepIndex: z.int().min(0).max(100),
      /** The bound that refused it, and the count that exceeded it (37: "the refusal names the step, the bound and the count"). */
      bound: z.string().regex(/^[a-z][a-z0-9_]{0,59}$/), count: z.int().min(0),
    }),
  ]),
  response: z.object({ recorded: z.literal(true) }),
  status: 201,
});
