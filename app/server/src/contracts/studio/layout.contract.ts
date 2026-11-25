// Object view layouts (spec 34.6): the layout an object view of a type opens with.
//
// Every type has a generated default, from its structure alone. A custom layout is a Studio
// app of kind object_view_layout: a single-page definition bound to the variable `object`,
// built as a draft, reviewed and approved by a holder of app.publish like any app version,
// and on approval the type's one active layout. Reading a type's layout re-checks a custom
// one against main when the ontology has moved: one that no longer validates is marked
// invalid, its author is told, and the generated default is used. A broken layout never
// renders partially. A custom layout renders under the viewer's own permissions (35.6).

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { appVersionView, appView } from './app.contract.ts';

/** The object view's fixed sections after properties and links (34.2), in order. */
export const LAYOUT_SECTIONS = ['timeline', 'actions', 'findings', 'scenarios', 'ask'] as const;

export const generatedLayoutView = z.object({
  properties: z.array(z.uuid()),
  linkGroups: z.array(z.object({ linkTypeId: z.uuid(), direction: z.enum(['outgoing', 'incoming']) })),
  sections: z.array(z.enum(LAYOUT_SECTIONS)),
});

export const objectViewLayoutView = z.object({
  objectTypeId: z.uuid(),
  generated: z.boolean(),
  /** The generated default, when no valid custom layout is active. */
  layout: generatedLayoutView.nullable(),
  custom: z.object({
    layoutId: z.uuid(),
    appId: z.uuid(),
    version: z.int(),
    /** As this viewer may see it. */
    definition: z.record(z.string(), z.json()),
    widgets: z.array(z.object({ id: z.string(), status: z.enum(['available', 'reduced', 'unavailable', 'disabled']), reason: z.string().nullable() })),
    withheld: z.int(),
    statement: z.string().nullable(),
  }).nullable(),
});
export type ObjectViewLayoutView = z.infer<typeof objectViewLayoutView>;

const CALLERS = ['gateway'] as const;

/** A custom layout's draft, owned by the person (app.create); the generated default to start from when no definition is given. */
export const createObjectViewLayout = defineContract({
  service: 'studio', name: 'createObjectViewLayout', method: 'POST', path: '/v1/studio/object-view-layouts', callers: [...CALLERS, 'fde-orchestrator'],
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({
    objectTypeId: z.uuid(),
    name: z.string().trim().min(1).max(200).optional(),
    definition: z.record(z.string(), z.json()).optional(),
    /** A layout an AI FDE proposed and a person accepted: only fde-orchestrator, applying the decision, says so. */
    generatedBy: z.literal('ai_fde').optional(),
  }),
  response: z.object({ app: appView, draft: appVersionView }),
  status: 201,
  maxBodyBytes: 1024 * 1024,
});

/** The layout a type's object view opens with, for the caller (ontology.view). */
export const getObjectViewLayout = defineContract({
  service: 'studio', name: 'getObjectViewLayout', method: 'GET', path: '/v1/studio/object-view-layouts/:objectTypeId', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ objectTypeId: z.uuid() }),
  response: objectViewLayoutView,
});

/**
 * The organisation's custom layouts that apply now or stopped applying (34.6): the type each is
 * for, the app and version it comes from, and whether it still validates. A layout an ontology
 * change broke is listed as invalid until a later one is approved for its type; superseded ones
 * are in their app's history. Metadata only (ontology.view): never a record value.
 */
export const listObjectViewLayouts = defineContract({
  service: 'studio', name: 'listObjectViewLayouts', method: 'GET', path: '/v1/studio/object-view-layouts', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  response: z.object({
    layouts: z.array(z.object({
      id: z.uuid(),
      objectTypeId: z.uuid(),
      appId: z.uuid(),
      version: z.int(),
      status: z.enum(['active', 'invalid']),
      createdBy: z.uuid().nullable(),
      createdAt: z.string(),
      updatedAt: z.string(),
    })),
  }),
});
