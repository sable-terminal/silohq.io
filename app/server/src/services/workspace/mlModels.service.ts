// Machine learning models (D240): defined and trained by their owner, predicting for whoever asks.
// Training reads the model's set as the owner (as a workbook's live range is read: their access,
// a property they may not see left blank), holds out a fifth of the objects, fits with
// mlEngine.service.ts, and keeps an immutable version: headline figures in the clear, and the
// fitted model (whose encoder holds the categories it learnt, record values) sealed by the
// credential service under the organisation's data key, bound to the version's row. The version
// carries the markings of what training read (worked out as an export's are); its detail is opened,
// and it predicts, only for someone holding every one of them. Predicting reads the set as the
// caller and stores nothing. A training that cannot fit (too few objects with a label, a label of
// the wrong kind) is a failed version saying why.

import { openRecordValues, sealRecordValues } from '../../contracts/credential/recordValue.contract.ts';
import { previewExportMarkings } from '../../contracts/files/file.contract.ts';
import { getManifest } from '../../contracts/ontology/manifest.contract.ts';
import { getObjectSet } from '../../contracts/ontology/objectSet.contract.ts';
import { resolveAccess } from '../../contracts/policy/decision.contract.ts';
import type { ShareGrantee } from '../../contracts/workspace/sharing.contract.ts';
import type { MlModelDefinition, MlModelVersionView, MlModelView } from '../../contracts/workspace/mlModel.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { MlModel } from '../../models/workspace/mlModel.model.ts';
import type { MlModelVersion } from '../../models/workspace/mlModelVersion.model.ts';
import { mlModelRepo, mlModelVersionRepo, viewShareRepo } from '../../repos/workspace/index.repo.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { demand, member, recordEvent, type Context, type Member, type WorkspaceDeps } from './deps.service.ts';
import { documentShares, heldOn, revokeDocumentShare, shareDocument, type DocumentKind, type SharedDocument } from './documentShares.service.ts';
import {
  classificationMetrics, drift, encode, fitClassification, fitEncoder, fitRegression, heldOut, importance, MAX_CLASSES, MAX_TRAINING_ROWS,
  predictClass, predictValue, regressionMetrics, type ClassificationMetrics, type Encoder, type Fitted, type RegressionMetrics, type Value,
} from './mlEngine.service.ts';
import { readRange, typesOf } from './workbooks.service.ts';

type Keyed = Context & Pick<HandlerContext, 'idempotencyKey'>;
type Held = 'owner' | 'view';
const notFound = () => new AppError('not_found', 'no such model', { code: 'workspace.ml_model_not_found' });
const MIN_ROWS = 20;

/** What a trained version keeps sealed. */
interface Artifact {
  features: string[];
  label: string;
  encoder: Encoder;
  model: Fitted;
  importance: { feature: string; weight: number }[];
  evaluation: RegressionMetrics | ClassificationMetrics;
}

function viewOf(m: MlModel, held: Held): MlModelView {
  return {
    id: m.id, name: m.name, description: m.description, task: m.task, objectSetId: m.objectSetId, featurePropertyIds: m.featurePropertyIds,
    labelPropertyId: m.labelPropertyId, publishedVersionId: m.publishedVersionId, ownerMembershipId: m.ownerMembershipId, visibility: m.visibility,
    access: held, createdAt: m.createdAt, updatedAt: m.updatedAt, archivedAt: m.archivedAt, lockVersion: m.lockVersion,
  };
}

function versionViewOf(v: MlModelVersion, published: string | null): MlModelVersionView {
  return {
    id: v.id, modelId: v.modelId, version: v.version, status: v.status, task: v.task, featurePropertyIds: v.featurePropertyIds, labelPropertyId: v.labelPropertyId,
    rowsTrained: v.rowsTrained, rowsTested: v.rowsTested, metrics: v.metrics as MlModelVersionView['metrics'], failure: v.failure, markingIds: v.markingIds,
    trainedBy: v.trainedBy, trainedAt: v.trainedAt, published: v.id === published,
  };
}

export const ML_MODEL: DocumentKind<MlModel> = {
  arm: 'ml_model', notFound,
  findForUpdate: (db, id) => mlModelRepo.findForUpdate(db, id),
  setVisibility: (db, id, visibility) => mlModelRepo.update(db, id, { visibility }),
};
const accessTo = async (db: Queryable, m: MlModel, membershipId: string): Promise<Held | undefined> => {
  const held = await heldOn(db, ML_MODEL as DocumentKind<SharedDocument>, m, membershipId);
  return held === undefined ? undefined : held === 'owner' ? 'owner' : 'view';
};

async function readable(deps: WorkspaceDeps, me: Member, id: string): Promise<{ m: MlModel; held: Held }> {
  const found = await inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const m = await mlModelRepo.findById(db, id);
    const held = m === undefined ? undefined : await accessTo(db, m, me.membershipId);
    return m === undefined || held === undefined ? undefined : { m, held };
  }, { readOnly: true });
  if (found === undefined) throw notFound();
  return found;
}

const call = (ctx: Context) => ({ request: ctx.request, correlationId: ctx.correlationId });

/** The set one the owner may read; each property its type's; the label of the kind the task needs is checked when training. */
async function checkDefinition(deps: WorkspaceDeps, ctx: Context, d: MlModelDefinition) {
  let set: { baseTypeId: string | null };
  try {
    set = await deps.services.call(getObjectSet, { params: { objectSetId: d.objectSetId } }, call(ctx));
  } catch (error) {
    if (isAppError(error) && (error.category === 'not_found' || error.category === 'forbidden')) {
      throw new AppError('validation', 'the model learns from an object set you may not see', { code: 'workspace.ml_model_set_unknown' });
    }
    throw error;
  }
  const manifest = await deps.services.call(getManifest, { query: {} }, call(ctx));
  const type = manifest.objectTypes.find((t) => t.id === set.baseTypeId);
  const known = new Map(type?.properties.map((p) => [p.identityId, p]) ?? []);
  if ([...d.featurePropertyIds, d.labelPropertyId].some((p) => !known.has(p))) {
    throw new AppError('validation', 'a feature or the label is not a property of the set\'s type', { code: 'workspace.ml_model_property_unknown' });
  }
  const label = known.get(d.labelPropertyId)!;
  if (d.task === 'regression' && !['integer', 'decimal', 'money', 'duration'].includes(label.dataType)) {
    throw new AppError('validation', 'a regression predicts a number: its label is a numeric property', { code: 'workspace.ml_model_label_kind' });
  }
  return { typeId: type!.id, apiName: new Map([...known].map(([id, p]) => [id, p.apiName])) };
}

/** Whether the caller holds every one of these markings now. */
async function holdsAll(deps: WorkspaceDeps, ctx: Context, markingIds: readonly string[]): Promise<boolean> {
  if (markingIds.length === 0) return true;
  const answer = await deps.services.call(resolveAccess, { body: { markings: [...markingIds] } }, call(ctx));
  return answer.decision === 'allow' && markingIds.every((id) => answer.markings.find((m) => m.id === id)?.satisfied === true);
}

export async function create(deps: WorkspaceDeps, ctx: Context, d: MlModelDefinition): Promise<MlModelView> {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'model.save' });
  await checkDefinition(deps, ctx, d);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const m = await mlModelRepo.insert(db, {
      id: uuidv7(), organisationId: me.organisationId, ownerMembershipId: me.membershipId, name: d.name, description: d.description, task: d.task,
      objectSetId: d.objectSetId, featurePropertyIds: d.featurePropertyIds, labelPropertyId: d.labelPropertyId,
    });
    await recordEvent(db, me, ctx.correlationId, { event: 'ml_model_created', resource: { type: 'ml_model', id: m.id }, detail: { task: d.task, features: d.featurePropertyIds.length } });
    return viewOf(m, 'owner');
  });
}

export async function list(deps: WorkspaceDeps, ctx: Context, filter: 'mine' | 'shared' | 'archived', limit: number) {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    if (filter !== 'shared') return { mlModels: (await mlModelRepo.listMine(db, me.membershipId, filter === 'archived', limit)).map((m) => viewOf(m, 'owner')) };
    const out: MlModelView[] = [];
    for (const m of await mlModelRepo.listByIds(db, await viewShareRepo.documentsReaching(db, 'ml_model', me.membershipId), limit)) {
      if ((await accessTo(db, m, me.membershipId)) === 'view') out.push(viewOf(m, 'view'));
    }
    return { mlModels: out };
  }, { readOnly: true });
}

export async function get(deps: WorkspaceDeps, ctx: Context, id: string): Promise<MlModelView> {
  const me = member(ctx);
  const { m, held } = await readable(deps, me, id);
  return viewOf(m, held);
}

export async function save(deps: WorkspaceDeps, ctx: Context, id: string, input: { definition: MlModelDefinition; lockVersion: number }): Promise<MlModelView> {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'model.save' });
  const current = await inTransaction(deps.databases.pool('control'), me.request, (db) => mlModelRepo.findById(db, id), { readOnly: true });
  if (!current || current.ownerMembershipId !== me.membershipId) throw notFound();
  await checkDefinition(deps, ctx, input.definition);
  const d = input.definition;
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const m = await mlModelRepo.findForUpdate(db, id);
    if (!m || m.ownerMembershipId !== me.membershipId) throw notFound();
    if (m.archivedAt !== null) throw new AppError('conflict', 'an archived model is not edited', { code: 'workspace.ml_model_archived' });
    if (m.lockVersion !== input.lockVersion) throw new AppError('conflict', 'the model changed since you read it', { code: 'workspace.ml_model_stale' });
    const saved = (await mlModelRepo.update(db, id, {
      name: d.name, description: d.description, task: d.task, objectSetId: d.objectSetId, featurePropertyIds: d.featurePropertyIds, labelPropertyId: d.labelPropertyId,
      lockVersion: m.lockVersion + 1,
    }))!;
    await recordEvent(db, me, ctx.correlationId, { event: 'ml_model_saved', resource: { type: 'ml_model', id }, detail: { task: d.task, features: d.featurePropertyIds.length } });
    return viewOf(saved, 'owner');
  });
}

/** Fits what the rows allow, or says why it cannot. */
function fit(task: MlModel['task'], features: string[], ids: string[], rows: Value[][]): { artifact: Omit<Artifact, 'features' | 'label'>; trained: number; tested: number } | { failure: string } {
  const labelled = rows.map((r, i) => ({ id: ids[i]!, x: r.slice(0, -1), y: r.at(-1) ?? null })).filter((r) => r.y !== null && r.y !== '');
  if (task === 'regression') {
    const numeric = labelled.filter((r) => typeof r.y === 'number' || (typeof r.y === 'string' && /^-?\d+(\.\d+)?$/.test(r.y)));
    if (numeric.length < MIN_ROWS) return { failure: `only ${numeric.length} objects have a numeric label you may see; at least ${MIN_ROWS} are needed` };
    labelled.splice(0, labelled.length, ...numeric);
  } else if (labelled.length < MIN_ROWS) {
    return { failure: `only ${labelled.length} objects have a label you may see; at least ${MIN_ROWS} are needed` };
  }
  const train = labelled.filter((r) => !heldOut(r.id));
  const test = labelled.filter((r) => heldOut(r.id));
  if (train.length < MIN_ROWS / 2 || test.length === 0) return { failure: 'too few objects to hold a fifth out for testing' };
  let encoder: Encoder;
  try {
    encoder = fitEncoder(features, train.map((r) => r.x));
  } catch (error) {
    if (error instanceof RangeError) return { failure: error.message };
    throw error;
  }
  const xs = train.map((r) => encode(encoder, r.x));
  const tx = test.map((r) => encode(encoder, r.x));
  if (task === 'regression') {
    const model = fitRegression(xs, train.map((r) => Number(r.y)), 1);
    const evaluation = regressionMetrics(test.map((r) => Number(r.y)), tx.map((x) => predictValue(model, x)));
    return { artifact: { encoder, model, importance: importance(encoder, model), evaluation }, trained: train.length, tested: test.length };
  }
  const counts = new Map<string, number>();
  for (const r of train) counts.set(String(r.y), (counts.get(String(r.y)) ?? 0) + 1);
  const classes = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_CLASSES).map(([c]) => c);
  if (classes.length < 2) return { failure: 'a classifier needs at least two classes among the labels' };
  const known = (r: { y: Value }) => classes.includes(String(r.y));
  const trainKnown = train.filter(known);
  const testKnown = test.filter(known);
  if (testKnown.length === 0) return { failure: 'no held-out object has one of the classes it learns' };
  const epochs = Math.max(10, Math.min(40, Math.ceil(400_000 / trainKnown.length)));
  const model = fitClassification(trainKnown.map((r) => encode(encoder, r.x)), trainKnown.map((r) => classes.indexOf(String(r.y))), classes, { epochs });
  const evaluation = classificationMetrics(classes, testKnown.map((r) => classes.indexOf(String(r.y))), testKnown.map((r) => predictClass(model, encode(encoder, r.x)).probabilities));
  return { artifact: { encoder, model, importance: importance(encoder, model), evaluation }, trained: trainKnown.length, tested: testKnown.length };
}

const headline = (e: Artifact['evaluation']) => (e.kind === 'regression'
  ? { kind: 'regression' as const, rmse: e.rmse, mae: e.mae, r2: e.r2 }
  : { kind: 'classification' as const, accuracy: e.accuracy, macroF1: e.macroF1, logLoss: e.logLoss, classes: e.classes.length });

export async function train(deps: WorkspaceDeps, ctx: Keyed, id: string): Promise<MlModelVersionView> {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'model.save' });
  const { m } = await readable(deps, me, id);
  if (m.ownerMembershipId !== me.membershipId) throw notFound();
  if (m.archivedAt !== null) throw new AppError('conflict', 'an archived model is not trained', { code: 'workspace.ml_model_archived' });
  const d = { name: m.name, description: m.description, task: m.task, objectSetId: m.objectSetId, featurePropertyIds: m.featurePropertyIds, labelPropertyId: m.labelPropertyId };
  const { apiName } = await checkDefinition(deps, ctx, d);
  const types = await typesOf(deps, ctx, [m.objectSetId]);
  const read = await readRange(deps, ctx, { id: 'training', objectSetId: m.objectSetId, propertyIds: [...m.featurePropertyIds, m.labelPropertyId], limit: MAX_TRAINING_ROWS },
    types.get(m.objectSetId));
  const features = m.featurePropertyIds.map((p) => apiName.get(p)!);
  const rows = read.rows.map((r) => r.map((v): Value => (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : JSON.stringify(v))));
  const fitted = read.refused !== null ? { failure: read.refused } : fit(m.task, features, read.ids, rows);
  // What training read, for the markings the version carries (as an export's are worked out).
  const markings = read.lineage.length === 0 ? [] : (await deps.services.call(previewExportMarkings, { body: { inputs: read.lineage } }, call(ctx))).markings.map((x) => x.id);
  const versionId = uuidv7();
  let sealed: Buffer | null = null;
  if (!('failure' in fitted)) {
    const artifact: Artifact = { features, label: apiName.get(m.labelPropertyId)!, ...fitted.artifact };
    const out = await deps.services.call(sealRecordValues, {
      body: { items: [{ binding: { table: 'workspace.ml_model_versions', id: versionId }, value: Buffer.from(JSON.stringify(artifact)).toString('base64') }] },
    }, call(ctx));
    sealed = Buffer.from(out.items[0]!, 'base64');
  }
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const locked = await mlModelRepo.findForUpdate(db, id);
    if (!locked) throw notFound();
    const version = await mlModelVersionRepo.insert(db, {
      id: versionId, organisationId: me.organisationId, modelId: id, version: await mlModelVersionRepo.nextVersion(db, id), status: 'failure' in fitted ? 'failed' : 'trained',
      task: m.task, objectSetId: m.objectSetId, featurePropertyIds: m.featurePropertyIds, labelPropertyId: m.labelPropertyId,
      rowsTrained: 'failure' in fitted ? null : fitted.trained, rowsTested: 'failure' in fitted ? null : fitted.tested,
      metrics: 'failure' in fitted ? null : headline(fitted.artifact.evaluation) as never, artifact: sealed, markingIds: markings,
      failure: 'failure' in fitted ? fitted.failure.slice(0, 2000) : null, trainedBy: me.membershipId,
    });
    await recordEvent(db, me, ctx.correlationId, 'failure' in fitted
      ? { event: 'ml_model_training_failed', resource: { type: 'ml_model', id }, detail: { version_id: versionId, version: version.version } }
      : {
        event: 'ml_model_trained', resource: { type: 'ml_model', id },
        detail: { version_id: versionId, version: version.version, rows_trained: fitted.trained, rows_tested: fitted.tested, markings: markings.length },
      });
    return versionViewOf(version, locked.publishedVersionId);
  });
}

export async function versions(deps: WorkspaceDeps, ctx: Context, id: string) {
  const me = member(ctx);
  const { m } = await readable(deps, me, id);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) =>
    ({ versions: (await mlModelVersionRepo.listForModel(db, id)).map((v) => versionViewOf(v, m.publishedVersionId)) }), { readOnly: true });
}

/** A trained version of the model, opened for the caller: they must hold every marking on it. */
async function opened(deps: WorkspaceDeps, ctx: Context, me: Member, m: MlModel, versionId: string | undefined) {
  const id = versionId ?? m.publishedVersionId;
  if (id === null) throw new AppError('conflict', 'the model has no published version: name one, or publish one', { code: 'workspace.ml_model_unpublished' });
  const v = await inTransaction(deps.databases.pool('control'), me.request, (db) => mlModelVersionRepo.findById(db, id), { readOnly: true });
  if (v === undefined || v.modelId !== m.id) throw new AppError('not_found', 'no such version of the model', { code: 'workspace.ml_model_version_not_found' });
  if (v.status !== 'trained' || v.artifact === null) throw new AppError('conflict', 'that version did not train', { code: 'workspace.ml_model_version_failed' });
  if (!await holdsAll(deps, ctx, v.markingIds)) {
    throw new AppError('forbidden', 'the model learnt from data marked more closely than you are cleared for', { code: 'workspace.ml_model_not_cleared' });
  }
  const out = await deps.services.call(openRecordValues, {
    body: { items: [{ binding: { table: 'workspace.ml_model_versions', id: v.id }, sealed: v.artifact.toString('base64') }] },
  }, call(ctx));
  return { v, artifact: JSON.parse(Buffer.from(out.items[0]!, 'base64').toString('utf8')) as Artifact };
}

export async function version(deps: WorkspaceDeps, ctx: Context, id: string, versionId: string) {
  const me = member(ctx);
  const { m } = await readable(deps, me, id);
  const { v, artifact } = await opened(deps, ctx, me, m, versionId);
  const e = artifact.evaluation;
  return {
    ...versionViewOf(v, m.publishedVersionId), importance: artifact.importance,
    classes: e.kind === 'classification' ? e.classes.map((label, i) => ({ label, precision: e.precision[i]!, recall: e.recall[i]! })) : null,
    confusion: e.kind === 'classification' ? e.confusion : null,
  };
}

export async function publish(deps: WorkspaceDeps, ctx: Context, id: string, versionId: string): Promise<MlModelView> {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'model.save' });
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const m = await mlModelRepo.findForUpdate(db, id);
    if (!m || m.ownerMembershipId !== me.membershipId) throw notFound();
    const v = await mlModelVersionRepo.findById(db, versionId);
    if (v === undefined || v.modelId !== id) throw new AppError('not_found', 'no such version of the model', { code: 'workspace.ml_model_version_not_found' });
    if (v.status !== 'trained') throw new AppError('conflict', 'a version that did not train is not published', { code: 'workspace.ml_model_version_failed' });
    const saved = (await mlModelRepo.update(db, id, { publishedVersionId: versionId, lockVersion: m.lockVersion + 1 }))!;
    await recordEvent(db, me, ctx.correlationId, { event: 'ml_model_published', resource: { type: 'ml_model', id }, detail: { version_id: versionId, version: v.version } });
    return viewOf(saved, 'owner');
  });
}

/** Predictions for a set's objects, read as the caller now; how far they have drifted from training. Nothing stored. */
export async function predict(deps: WorkspaceDeps, ctx: Context, id: string, input: { versionId?: string | undefined; objectSetId?: string | undefined; limit: number }) {
  const { lineage: _l, ...out } = await predictFor(deps, ctx, id, input);
  return out;
}

/** The same, with what the read read (a notebook's export carries its markings, D242). */
export async function predictFor(deps: WorkspaceDeps, ctx: Context, id: string, input: { versionId?: string | undefined; objectSetId?: string | undefined; limit: number }) {
  const me = member(ctx);
  const { m } = await readable(deps, me, id);
  const { v, artifact } = await opened(deps, ctx, me, m, input.versionId);
  const objectSetId = input.objectSetId ?? m.objectSetId;
  const types = await typesOf(deps, ctx, [objectSetId]);
  if (types.get(objectSetId) === null) throw new AppError('forbidden', 'the objects could not be read for you: the set is not one you may see', { code: 'workspace.ml_model_set_refused' });
  // The type it learnt from: the one its features belong to (the model's own set may be hidden from a viewer).
  const manifest = await deps.services.call(getManifest, { query: {} }, call(ctx));
  const learnt = manifest.objectTypes.find((t) => t.properties.some((p) => p.identityId === v.featurePropertyIds[0]))?.id;
  if (types.get(objectSetId) !== learnt) {
    throw new AppError('validation', 'predictions are made for objects of the type the model learnt from', { code: 'workspace.ml_model_set_type' });
  }
  const read = await readRange(deps, ctx, { id: 'scoring', objectSetId, propertyIds: v.featurePropertyIds, limit: input.limit }, types.get(objectSetId));
  if (read.refused !== null) throw new AppError('forbidden', `the objects could not be read for you: ${read.refused}`, { code: 'workspace.ml_model_set_refused' });
  const rows = read.rows.map((r) => r.map((x): Value => (x === null || typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean' ? x : JSON.stringify(x))));
  const predictions = rows.map((row, i) => {
    const x = encode(artifact.encoder, row);
    if (artifact.model.task === 'regression') return { objectId: read.ids[i]!, value: predictValue(artifact.model, x), probability: null };
    const p = predictClass(artifact.model, x);
    return { objectId: read.ids[i]!, value: p.label, probability: p.probability };
  });
  await inTransaction(deps.databases.pool('control'), me.request, (db) => recordEvent(db, me, ctx.correlationId, {
    event: 'ml_model_predicted', resource: { type: 'ml_model', id }, detail: { version_id: v.id, objects: predictions.length, own_set: objectSetId === m.objectSetId },
  }));
  return {
    versionId: v.id, objectTypeId: types.get(objectSetId) ?? null, predictions, total: read.total, truncated: read.truncated, withheld: read.withheld,
    drift: drift(artifact.encoder, rows), lineage: read.lineage, task: artifact.model.task,
  };
}

export async function archive(deps: WorkspaceDeps, ctx: Context, id: string): Promise<MlModelView> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const m = await mlModelRepo.findForUpdate(db, id);
    if (!m || m.ownerMembershipId !== me.membershipId) throw notFound();
    const done = m.archivedAt !== null ? m : (await mlModelRepo.update(db, id, { archivedAt: new Date().toISOString(), lockVersion: m.lockVersion + 1 }))!;
    if (m.archivedAt === null) await recordEvent(db, me, ctx.correlationId, { event: 'ml_model_archived', resource: { type: 'ml_model', id }, detail: {} });
    return viewOf(done, 'owner');
  });
}

// ----------------------------------------------------------------------------- sharing (37.4, to see and predict with)

const asShare = <T extends { documentId: string; access: 'view' | 'copy' }>(v: T) => { const { documentId, ...rest } = v; return { ...rest, access: 'view' as const, mlModelId: documentId }; };

export async function share(deps: WorkspaceDeps, ctx: Context, id: string, input: { grantee: ShareGrantee; access: 'view'; expiresAt?: string | undefined }) {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'model.save' });
  return inTransaction(deps.databases.pool('control'), me.request, async (db) =>
    asShare(await shareDocument(db, me, ctx.correlationId, ML_MODEL as DocumentKind<SharedDocument>, id, { ...input, access: 'view' })));
}

export async function revoke(deps: WorkspaceDeps, ctx: Context, id: string, shareId: string) {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) =>
    asShare(await revokeDocumentShare(db, me, ctx.correlationId, ML_MODEL as DocumentKind<SharedDocument>, id, shareId)));
}

export async function shares(deps: WorkspaceDeps, ctx: Context, id: string) {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) =>
    ({ shares: (await documentShares(db, me, ML_MODEL as DocumentKind<SharedDocument>, await mlModelRepo.findById(db, id))).map(asShare) }), { readOnly: true });
}
