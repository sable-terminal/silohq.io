// What the person did on the canvas, reported by the client (spec 28, 31.5, 31.9; D208): a clone
// opened, an element drilled into (the second of 31.5's three moves), a flag opened. References
// and closed sets only, never a value; the type named must be one the person can see.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { CANVAS_LAYOUTS } from './layout.contract.ts';

const id = z.uuid();

/** What a drill starts from: an element of an archetype or a canvas layout. */
export const DRILL_ELEMENTS = ['node', 'edge', 'group', 'row', 'cell', 'bar', 'point', 'segment', 'tile'] as const;
/** The flags an element may carry (31.9, 34): a dispute, an extraction to confirm, an unknown or stale state, an inferred value, partial coverage. */
export const ELEMENT_FLAGS = ['dispute', 'extraction', 'unknown_state', 'stale', 'inferred', 'coverage'] as const;

export const recordCanvasInteraction = defineContract({
  service: 'canvas-layout', name: 'recordCanvasInteraction', method: 'POST', path: '/v1/canvas/interactions', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  body: z.discriminatedUnion('event', [
    z.strictObject({ event: z.literal('clone_opened'), objectTypeId: id, objectId: id, layout: z.enum(CANVAS_LAYOUTS).optional(), canvasViewId: id.optional() }),
    z.strictObject({
      event: z.literal('element_drilled'), surface: z.enum(['view', 'canvas']), resultRef: id, element: z.enum(DRILL_ELEMENTS),
      objectTypeId: id.optional(), records: z.int().min(0).max(1_000_000),
    }),
    z.strictObject({ event: z.literal('flag_opened'), flag: z.enum(ELEMENT_FLAGS), objectTypeId: id, objectId: id.optional(), surface: z.enum(['view', 'canvas', 'object_view']) }),
  ]),
  response: z.object({ recorded: z.literal(true) }),
  status: 201,
});
