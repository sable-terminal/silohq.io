// Machine learning models (D240; beyond the spec: the models of the Foundry-comparison features).
// A model learns one property of an object set's objects (its label) from others (its features):
// a number (regression) or a category (classification). Training reads the set as its owner, holds
// out a fifth of the objects (by a stable hash of their ids) to evaluate on, and makes an immutable
// version: how it scored, which features mattered, and the fitted model sealed under the
// organisation's data key, since the categories it learnt are record values. A version carries
// the markings of what training read; reading its detail or predicting with it needs them all.
//
// Predicting reads a set's objects as whoever asks, under their own access, and answers with each
// object's prediction and how far the population has drifted from the training one: nothing is
// stored. The published version is the one predictions use unless another is named. Shared to see
// and predict with (view), never to copy; only the owner trains, publishes and edits. The
// arithmetic is services/workspace/mlEngine.service.ts: no library, nothing run but it.

import { z } from 'zod';
import { recordValue } from '../../utils/recordValue.util.ts';
import { defineContract } from '../endpoint.contract.ts';
import { shareGrantee } from './sharing.contract.ts';

const CALLERS = ['gateway'] as const;

export const mlModelDefinition = z.strictObject({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2_000).default(''),
  task: z.enum(['regression', 'classification']),
  /** The objects it learns from: a saved set the owner may read. */
  objectSetId: z.uuid(),
  featurePropertyIds: z.array(z.uuid()).min(1).max(50).refine((ids) => new Set(ids).size === ids.length, 'each feature once'),
  labelPropertyId: z.uuid(),
}).refine((d) => !d.featurePropertyIds.includes(d.labelPropertyId), 'the label is not also a feature');
export type MlModelDefinition = z.infer<typeof mlModelDefinition>;

const access = z.enum(['owner', 'view']);
export const mlModelView = z.object({
  id: z.uuid(), name: z.string(), description: z.string(), task: z.enum(['regression', 'classification']), objectSetId: z.uuid(),
  featurePropertyIds: z.array(z.uuid()), labelPropertyId: z.uuid(), publishedVersionId: z.uuid().nullable(),
  ownerMembershipId: z.uuid(), visibility: z.enum(['private', 'shared', 'org_visible']), access,
  createdAt: z.string(), updatedAt: z.string(), archivedAt: z.string().nullable(), lockVersion: z.int(),
});
export type MlModelView = z.infer<typeof mlModelView>;

/** Headline figures on the held-out fifth: never a value read. */
export const mlMetrics = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('regression'), rmse: z.number(), mae: z.number(), r2: z.number() }),
  z.object({ kind: z.literal('classification'), accuracy: z.number(), macroF1: z.number(), logLoss: z.number(), classes: z.int() }),
]);

export const mlModelVersionView = z.object({
  id: z.uuid(), modelId: z.uuid(), version: z.int(), status: z.enum(['trained', 'failed']), task: z.enum(['regression', 'classification']),
  featurePropertyIds: z.array(z.uuid()), labelPropertyId: z.uuid(), rowsTrained: z.int().nullable(), rowsTested: z.int().nullable(),
  metrics: mlMetrics.nullable(), failure: z.string().nullable(), markingIds: z.array(z.uuid()), trainedBy: z.uuid(), trainedAt: z.string(), published: z.boolean(),
});
export type MlModelVersionView = z.infer<typeof mlModelVersionView>;

/** A version opened, for someone holding every marking on it: which features mattered and, for a classifier, how each class fared. */
export const mlModelVersionDetail = mlModelVersionView.extend({
  importance: z.array(z.object({ feature: z.string(), weight: z.number() })),
  classes: recordValue(z.array(z.object({ label: z.string(), precision: z.number(), recall: z.number() }))).nullable(),
  /** Rows are the actual class, columns the predicted, in the order of classes. */
  confusion: z.array(z.array(z.int())).nullable(),
});

export const mlPrediction = z.object({
  objectId: z.uuid(),
  value: recordValue(z.union([z.number(), z.string()])),
  /** A classifier's confidence in its class; null for a regression. */
  probability: z.number().nullable(),
});

export const mlModelShareView = z.object({
  id: z.uuid(), mlModelId: z.uuid(), grantee: shareGrantee, access: z.literal('view'), sharedBy: z.uuid(), sharedAt: z.string(),
  expiresAt: z.string().nullable(), revokedAt: z.string().nullable(), state: z.enum(['live', 'expired', 'revoked', 'suspended', 'forbidden_by_policy']),
});

const params = z.strictObject({ mlModelId: z.uuid() });
const versionParams = z.strictObject({ mlModelId: z.uuid(), versionId: z.uuid() });

export const createMlModel = defineContract({
  service: 'workspace', name: 'createMlModel', method: 'POST', path: '/v1/ml-models', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed', body: mlModelDefinition, response: mlModelView, status: 201,
});

export const listMlModels = defineContract({
  service: 'workspace', name: 'listMlModels', method: 'GET', path: '/v1/ml-models', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ filter: z.enum(['mine', 'shared', 'archived']).default('mine'), limit: z.coerce.number().int().min(1).max(200).default(50) }),
  response: z.object({ mlModels: z.array(mlModelView) }),
});

export const getMlModel = defineContract({
  service: 'workspace', name: 'getMlModel', method: 'GET', path: '/v1/ml-models/:mlModelId', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params, response: mlModelView,
});

/** The owner's edit: the set one they may read, each property of its type. Versions already trained keep what they learnt from. */
export const saveMlModel = defineContract({
  service: 'workspace', name: 'saveMlModel', method: 'PUT', path: '/v1/ml-models/:mlModelId', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params, body: z.strictObject({ definition: mlModelDefinition, lockVersion: z.int().min(1) }), response: mlModelView,
});

/** Trained now, as the owner: a new version, trained or failed with why. */
export const trainMlModel = defineContract({
  service: 'workspace', name: 'trainMlModel', method: 'POST', path: '/v1/ml-models/:mlModelId/versions', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed', params, response: mlModelVersionView, status: 201, timeoutMs: 180_000,
});

export const listMlModelVersions = defineContract({
  service: 'workspace', name: 'listMlModelVersions', method: 'GET', path: '/v1/ml-models/:mlModelId/versions', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params, response: z.object({ versions: z.array(mlModelVersionView) }),
});

export const getMlModelVersion = defineContract({
  service: 'workspace', name: 'getMlModelVersion', method: 'GET', path: '/v1/ml-models/:mlModelId/versions/:versionId', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: versionParams, response: mlModelVersionDetail,
});

/** The version predictions use (the owner): one that trained. */
export const publishMlModelVersion = defineContract({
  service: 'workspace', name: 'publishMlModelVersion', method: 'POST', path: '/v1/ml-models/:mlModelId/versions/:versionId/publication', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: versionParams, response: mlModelView,
});

/** Predictions for a set's objects, read as the caller now: nothing stored. The published version, or one named; the model's own set, or another of its type. */
export const predictMlModel = defineContract({
  service: 'workspace', name: 'predictMlModel', method: 'POST', path: '/v1/ml-models/:mlModelId/predictions', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params,
  body: z.strictObject({ versionId: z.uuid().optional(), objectSetId: z.uuid().optional(), limit: z.int().min(1).max(5_000).default(500) }),
  response: z.object({
    versionId: z.uuid(), objectTypeId: z.uuid().nullable(), predictions: z.array(mlPrediction), total: z.int(), truncated: z.boolean(),
    /** Features the caller may not see: predicted as if missing. */
    withheld: z.int(),
    drift: z.array(z.object({ feature: z.string(), psi: z.number(), level: z.enum(['stable', 'moderate', 'shifted']) })),
  }),
  status: 201, timeoutMs: 120_000,
});

export const archiveMlModel = defineContract({
  service: 'workspace', name: 'archiveMlModel', method: 'POST', path: '/v1/ml-models/:mlModelId/archive', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params, response: mlModelView,
});

export const shareMlModel = defineContract({
  service: 'workspace', name: 'shareMlModel', method: 'POST', path: '/v1/ml-models/:mlModelId/shares', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params,
  body: z.strictObject({ grantee: shareGrantee, access: z.literal('view').default('view'), expiresAt: z.iso.datetime({ offset: true }).optional() }),
  response: mlModelShareView, status: 201,
});

export const revokeMlModelShare = defineContract({
  service: 'workspace', name: 'revokeMlModelShare', method: 'POST', path: '/v1/ml-models/:mlModelId/shares/:shareId/revoke', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: z.strictObject({ mlModelId: z.uuid(), shareId: z.uuid() }), response: mlModelShareView,
});

export const listMlModelShares = defineContract({
  service: 'workspace', name: 'listMlModelShares', method: 'GET', path: '/v1/ml-models/:mlModelId/shares', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params, response: z.object({ shares: z.array(mlModelShareView) }),
});
