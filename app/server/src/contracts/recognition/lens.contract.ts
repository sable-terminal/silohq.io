// Lenses (spec 38.9): a person's private working layer over the shared ontology. A Lens
// belongs to a membership and holds references, counts and dispositions, never record
// values. A dismissal in a Lens silences the finding for its owner only, never counts
// toward thresholds, and leaves the finding visible to everyone else.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { DISPOSITIONS } from './finding.contract.ts';
import { shareGrantee } from '../workspace/sharing.contract.ts';

const workingSet = z.discriminatedUnion('kind', [
  /** A saved object set, by reference. */
  z.strictObject({ kind: z.literal('object_set'), name: z.string().trim().min(1).max(200), objectSetId: z.uuid() }),
  /** A list of findings. */
  z.strictObject({ kind: z.literal('findings'), name: z.string().trim().min(1).max(200), findingIds: z.array(z.uuid()).max(1000) }),
  /** A list of objects of one type, by Silo object id. */
  z.strictObject({ kind: z.literal('objects'), name: z.string().trim().min(1).max(200), objectTypeId: z.uuid(), objectIds: z.array(z.uuid()).max(1000) }),
]);

export const lensView = z.object({
  id: z.uuid(),
  name: z.string(),
  workingSets: z.array(workingSet),
  dispositions: z.object({ confirmed: z.int(), dismissed: z.int(), deferred: z.int() }),
  version: z.int(),
  createdAt: z.string(),
});
export type LensView = z.infer<typeof lensView>;

export const createLens = defineContract({
  service: 'recognition', name: 'createLens', method: 'POST', path: '/v1/recognition/lenses', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ name: z.string().trim().min(1).max(200), workingSets: z.array(workingSet).max(50).default([]) }),
  response: lensView,
  status: 201,
});

export const listLenses = defineContract({
  service: 'recognition', name: 'listLenses', method: 'GET', path: '/v1/recognition/lenses', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  response: z.object({ lenses: z.array(lensView) }),
});

export const updateLens = defineContract({
  service: 'recognition', name: 'updateLens', method: 'PATCH', path: '/v1/recognition/lenses/:lensId', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ lensId: z.uuid() }),
  body: z.strictObject({
    name: z.string().trim().min(1).max(200).optional(),
    workingSets: z.array(workingSet).max(50).optional(),
    archive: z.literal(true).optional(),
    version: z.int().min(1),
  }),
  response: lensView,
});

/** A personal disposition: no permission beyond seeing the finding (38.11). */
export const recordLensDisposition = defineContract({
  service: 'recognition', name: 'recordLensDisposition', method: 'PUT', path: '/v1/recognition/lenses/:lensId/dispositions/:findingId',
  callers: ['gateway'], context: 'organisation', idempotency: 'none',
  params: z.strictObject({ lensId: z.uuid(), findingId: z.uuid() }),
  body: z.strictObject({ disposition: z.enum(DISPOSITIONS) }),
  response: z.object({ lensId: z.uuid(), findingId: z.uuid(), disposition: z.enum(DISPOSITIONS), recordedAt: z.string() }),
});

// ----------------------------------------------------------------------------- sharing (decision 2026-11-14)
// Under the owner's sharing policy; a shared Lens resolves under the opener's own access on
// every open, and sharing never grants access. Coverage is the proportion each recipient sees.

export const LENS_ACCESS = ['view', 'use', 'copy'] as const;

export const lensShareView = z.object({
  id: z.uuid(), lensId: z.uuid(), grantee: shareGrantee, access: z.enum(LENS_ACCESS), coverageAtShare: z.number(),
  sharedBy: z.uuid(), createdAt: z.string(), revokedAt: z.string().nullable(),
});

const lensParam = z.strictObject({ lensId: z.uuid() });

export const shareLens = defineContract({
  service: 'recognition', name: 'shareLens', method: 'POST', path: '/v1/recognition/lenses/:lensId/shares', callers: ['gateway'],
  // A repeat adds another share; the owner revokes whichever they do not want.
  context: 'organisation', idempotency: 'none', params: lensParam,
  body: z.strictObject({ grantee: shareGrantee, access: z.enum(LENS_ACCESS) }),
  response: z.object({ share: lensShareView, coverage: z.object({ recipients: z.int(), lowest: z.number(), highest: z.number() }) }),
  status: 201,
});

export const listLensShares = defineContract({
  service: 'recognition', name: 'listLensShares', method: 'GET', path: '/v1/recognition/lenses/:lensId/shares', callers: ['gateway'],
  context: 'organisation', idempotency: 'none', params: lensParam,
  response: z.object({ shares: z.array(lensShareView) }),
});

export const revokeLensShare = defineContract({
  service: 'recognition', name: 'revokeLensShare', method: 'DELETE', path: '/v1/recognition/lens-shares/:shareId', callers: ['gateway'],
  // Revoking a revoked share changes nothing.
  context: 'organisation', idempotency: 'none', params: z.strictObject({ shareId: z.uuid() }),
  response: z.undefined(),
});

export const openedLensView = lensView.extend({
  access: z.enum(['owner', ...LENS_ACCESS]),
  /** References the opener may not see, dropped. */
  hidden: z.int(),
  statement: z.string().nullable(),
});

export const openLens = defineContract({
  service: 'recognition', name: 'openLens', method: 'GET', path: '/v1/recognition/lenses/:lensId', callers: ['gateway'],
  context: 'organisation', idempotency: 'none', params: lensParam,
  response: openedLensView,
});

export const listSharedLenses = defineContract({
  service: 'recognition', name: 'listSharedLenses', method: 'GET', path: '/v1/recognition/shared-lenses', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  response: z.object({ lenses: z.array(openedLensView) }),
});

export const copyLens = defineContract({
  service: 'recognition', name: 'copyLens', method: 'POST', path: '/v1/recognition/lenses/:lensId/copy', callers: ['gateway'],
  // A repeat is refused: the member already has a Lens with that name.
  context: 'organisation', idempotency: 'none', params: lensParam,
  body: z.strictObject({ name: z.string().trim().min(1).max(200) }),
  response: lensView,
  status: 201,
});
