// Spatial plans, 3D asset models and their anchors (spec 29.4, 29.5, 66.4; D208).
//
// A plan or model is a file a person imported into an Import Silo (content class site_plan or
// asset_model); registering it for the canvas reads the file itself from the Silo store:
// a plan's size from its PNG or JPEG header, a model checked as a self-contained glTF 2.0
// binary with its unlisted extensions stripped (the stripped copy is what is served, kept in
// the same Silo). The registrar holds asset.upload, silo.import and every marking on the Silo;
// the plan or model carries at least the Silo's markings. A rejected model is recorded
// (asset_model_rejected, with why) and nothing of it is kept.
//
// An anchor needs asset.upload and clearance on the type it anchors; a predicate is type
// checked against the type's properties. Reading lists only what the reader's markings allow,
// counting the rest. Purging (silo.purge, or the Silo file's own purge) keeps the row as the
// record, removes what was served and ends the anchors.
//
// The canvas reads a plan's image, and where the objects it holds stand on the plan, only with
// every marking on the plan; the values it sends to be placed are its own reading, used for
// that answer and never kept.

import { MODEL_PART_BYTES, type AssetModelView, type SpatialAnchorView, type SpatialPlanView } from '../../contracts/canvas-layout/spatial.contract.ts';
import { resolveAccess } from '../../contracts/policy/decision.contract.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import { objectKey, type ObjectKey, type ObjectStore } from '../../infra/objectStorage.infra.ts';
import type { AssetModel, SpatialAnchor, SpatialPlan } from '../../models/clone/index.model.ts';
import { assetModelRepo, spatialAnchorRepo, spatialPlanRepo } from '../../repos/clone/index.repo.ts';
import { resourceMarkingRepo } from '../../repos/gov/index.repo.ts';
import { siloFileRepo, siloRepo } from '../../repos/siloes/index.repo.ts';
import { outboxRepo } from '../../repos/platform/outbox.repo.ts';
import type { StoredLedgerEntry } from '../../contracts/platform/purgeLedger.contract.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { checkGlb, fitGeoreference, rasterSize, readPosition } from '../../utils/spatialAsset.util.ts';
import { modelLevels, type ModelLevels } from './meshLevels.service.ts';
import { compileCel } from '../expression-evaluator/cel.service.ts';
import { access, demand, mainManifest, member, notFound, recordEvent, type Actor, type CanvasDeps, type Context } from './deps.service.ts';

export type SpatialDeps = CanvasDeps & { store?: ObjectStore | undefined };

const refused = (message: string, code: string, details: Record<string, string | number | boolean> = {}) => new AppError('validation', message, { code, details });
const asNumber = (v: string | null): number | null => (v === null ? null : Number(v));

export function planView(p: SpatialPlan): SpatialPlanView {
  return {
    id: p.id, siloId: p.siloId, siloFileId: p.siloFileId, name: p.name, widthPx: p.widthPx, heightPx: p.heightPx,
    controlPoints: p.controlPoints as SpatialPlanView['controlPoints'], markingIds: p.markingIds, uploadedBy: p.uploadedBy, uploadedAt: p.uploadedAt, purgedAt: p.purgedAt,
  };
}

/** A model's levels as served (D249): from its report; a model registered before levels is served whole, as level 0. */
function levelsOf(m: AssetModel): AssetModelView['levels'] {
  const report = m.validationReport as { levelsOfDetail?: unknown; meshes?: number };
  if (Array.isArray(report.levelsOfDetail)) return report.levelsOfDetail as AssetModelView['levels'];
  return [{ level: 0, bytes: Number(m.bytes), triangles: 0, ratio: 1 }];
}

export function modelView(m: AssetModel): AssetModelView {
  const compression = (m.validationReport as { compression?: AssetModelView['compression'] }).compression ?? 'none';
  return {
    id: m.id, siloId: m.siloId, siloFileId: m.siloFileId, name: m.name, format: 'gltf2_glb', bytes: m.bytes, nodeNames: m.nodeNames,
    validationReport: m.validationReport as Record<string, never>, markingIds: m.markingIds, uploadedBy: m.uploadedBy, uploadedAt: m.uploadedAt, purgedAt: m.purgedAt,
    levels: levelsOf(m), compression,
  };
}

export function anchorView(a: SpatialAnchor): SpatialAnchorView {
  return {
    id: a.id, planId: a.planId, assetModelId: a.assetModelId, objectTypeId: a.objectTypeId, objectRef: a.objectRef, matchRule: a.matchRule,
    planX: asNumber(a.planX), planY: asNumber(a.planY), modelNodeName: a.modelNodeName, createdBy: a.createdBy, createdAt: a.createdAt,
  };
}

function storeOf(deps: SpatialDeps): ObjectStore {
  if (deps.store === undefined) throw new AppError('unavailable', 'this cell has no Silo store configured', { code: 'spatial.store_unavailable' });
  return deps.store;
}

/** Whether the actor satisfies every one of these markings. */
async function holdsAll(deps: SpatialDeps, ctx: Context, markingIds: readonly string[]): Promise<boolean> {
  if (markingIds.length === 0) return true;
  const answer = await deps.services.call(resolveAccess, { body: { markings: [...markingIds] } }, { request: ctx.request, correlationId: ctx.correlationId });
  return answer.decision === 'allow' && answer.markings.every((m) => m.satisfied) && answer.markings.length === new Set(markingIds).size;
}

/** The imported file, of the class asked for, in an open Import Silo; with the Silo's markings. */
async function importedFile(deps: SpatialDeps, ctx: Context, siloFileId: string, contentClass: 'site_plan' | 'asset_model') {
  const found = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const file = await siloFileRepo.findById(db, siloFileId);
    const silo = file === undefined ? undefined : await siloRepo.findById(db, file.siloId);
    const markings = silo === undefined ? [] : (await resourceMarkingRepo.markingsFor(db, 'silo', [silo.id])).map((m) => m.markingId);
    return { file, silo, markings };
  }, { readOnly: true });
  const { file, silo, markings } = found;
  if (file === undefined || silo === undefined || silo.kind !== 'import') throw notFound('Silo file', 'spatial.file_not_found');
  // Open as Import takes files: not being purged, not disabled.
  if (silo.status === 'purging' || silo.status === 'disabled' || silo.disabledAt !== null) throw new AppError('conflict', 'the Silo is not open', { code: 'spatial.silo_closed' });
  if (file.status === 'purged' || file.status === 'failed') throw new AppError('conflict', `the file is ${file.status}`, { code: 'spatial.file_unusable' });
  if (file.contentClass !== contentClass) {
    throw refused(`the file was imported as ${file.contentClass}, not ${contentClass}`, 'spatial.wrong_content_class', { contentClass: file.contentClass });
  }
  return { file, silo, markings };
}

/** asset.upload and silo.import (29.4), and every marking on the Silo (the plan carries them). */
async function mayUpload(deps: SpatialDeps, ctx: Context, siloMarkings: readonly string[], extra: readonly string[]): Promise<void> {
  await demand(deps, ctx, { permission: 'asset.upload' });
  await demand(deps, ctx, { permission: 'silo.import' });
  if (!await holdsAll(deps, ctx, [...siloMarkings, ...extra])) {
    throw new AppError('forbidden', 'you lack clearance for a marking on this Silo or asked for here', { code: 'spatial.not_cleared' });
  }
}

export async function registerPlan(deps: SpatialDeps, ctx: Context, input: {
  siloFileId: string; name: string; controlPoints?: { x: number; y: number; lat: number; lon: number }[] | undefined; markingIds: string[];
}): Promise<SpatialPlanView> {
  const who = member(ctx);
  const { file, silo, markings } = await importedFile(deps, ctx, input.siloFileId, 'site_plan');
  await mayUpload(deps, ctx, markings, input.markingIds);
  const size = rasterSize(await storeOf(deps).get('siloes', file.objectStoreKey as ObjectKey));
  if (size === undefined) {
    // SVG and PDF are rasterised by the render service and never served as they are (29.4, 41).
    throw new AppError('conflict', 'only a PNG or JPEG plan is served as it is; an SVG or PDF waits for the render service to rasterise it', {
      code: 'spatial_plan.raster_unavailable', details: { contentType: file.contentType },
    });
  }
  for (const point of input.controlPoints ?? []) {
    if (point.x > size.width || point.y > size.height) throw refused('a control point lies outside the plan', 'spatial_plan.control_point_outside');
  }
  const markingIds = [...new Set([...markings, ...input.markingIds])].sort();
  const plan = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const row = await spatialPlanRepo.insert(db, {
      id: uuidv7(), organisationId: who.organisationId, siloId: silo.id, siloFileId: file.id, rasterTilesetRef: file.objectStoreKey, name: input.name,
      widthPx: size.width, heightPx: size.height, controlPoints: (input.controlPoints ?? null) as never, markingIds, uploadedBy: who.membershipId,
    });
    await recordEvent(db, who, ctx.correlationId, {
      event: 'spatial_plan_uploaded', resource: { type: 'spatial_plan', id: row.id },
      detail: { silo_id: silo.id, silo_file_id: file.id, format: size.format, width_px: size.width, height_px: size.height, georeferenced: input.controlPoints !== undefined, markings: markingIds.length },
    });
    return row;
  });
  return planView(plan);
}

export async function registerModel(deps: SpatialDeps, ctx: Context, input: { siloFileId: string; name: string; markingIds: string[] }): Promise<AssetModelView> {
  const who = member(ctx);
  const { file, silo, markings } = await importedFile(deps, ctx, input.siloFileId, 'asset_model');
  await mayUpload(deps, ctx, markings, input.markingIds);
  const store = storeOf(deps);
  let checked: ReturnType<typeof checkGlb>;
  try {
    checked = checkGlb(await store.get('siloes', file.objectStoreKey as ObjectKey));
  } catch (error) {
    if (error instanceof AppError && error.code === 'asset_model.rejected') {
      // Recorded with why; nothing of the model is kept here (the Silo file stays the person's to purge).
      await inTransaction(deps.databases.pool('control'), ctx.request, (db) => recordEvent(db, who, ctx.correlationId, {
        event: 'asset_model_rejected', resource: { type: 'silo', id: silo.id },
        detail: { silo_file_id: file.id, reason: String(error.details['reason'] ?? 'invalid') },
      }));
    }
    throw error;
  }
  const id = uuidv7();
  // Compressed where it is not, and simplified to its levels (29.5; D249). A model glTF Transform
  // cannot read, though the check passed it, is served as checked, whole.
  let levels: ModelLevels;
  try {
    levels = await modelLevels(checked.glb);
  } catch (error) {
    deps.logger.warn('a checked model could not be simplified; it is served whole', { event: 'canvas.model_levels_failed', organisationId: who.organisationId,
      resourceId: id, ...(error instanceof Error ? { reason: error.message.slice(0, 200) } : {}) });
    levels = { levels: [{ level: 0, glb: checked.glb, triangles: 0, ratio: 1 }], compression: 'none' };
  }
  // What is served: each level, in the same Silo, beside its file (the full model under the model's own key).
  const served = levels.levels.map((l) => l.level === 0
    ? objectKey.organisation(who.organisationId, 'silo', silo.id, 'asset-models', id)
    : objectKey.organisation(who.organisationId, 'silo', silo.id, 'asset-models', `${id}.lod${l.level}`));
  const report = {
    ...checked.report, compression: levels.compression,
    levelsOfDetail: levels.levels.map((l) => ({ level: l.level, bytes: l.glb.length, triangles: l.triangles, ratio: l.ratio })),
  };
  const full = levels.levels[0]!.glb;
  const markingIds = [...new Set([...markings, ...input.markingIds])].sort();
  try {
    for (const [i, l] of levels.levels.entries()) await store.put('siloes', served[i]!, l.glb, 'model/gltf-binary');
    const model = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
      const row = await assetModelRepo.insert(db, {
        id, organisationId: who.organisationId, siloId: silo.id, siloFileId: file.id, name: input.name, bytes: String(full.length),
        lodRefs: served, validationReport: report as never, nodeNames: checked.nodeNames, markingIds, uploadedBy: who.membershipId,
      });
      await recordEvent(db, who, ctx.correlationId, {
        event: 'asset_model_uploaded', resource: { type: 'asset_model', id },
        detail: {
          silo_id: silo.id, silo_file_id: file.id, bytes: full.length, nodes: checked.report.nodes, meshes: checked.report.meshes,
          extensions_stripped: checked.report.extensionsStripped.join(',').slice(0, 200), markings: markingIds.length,
          levels: levels.levels.length, compression: levels.compression,
        },
      });
      return row;
    });
    return modelView(model);
  } catch (error) {
    for (const key of served) await store.purge('siloes', key).catch(() => undefined);
    throw error;
  }
}

export async function setAnchor(deps: SpatialDeps, ctx: Context, input: {
  planId?: string | undefined; assetModelId?: string | undefined; objectTypeId: string; objectRef?: string | undefined; matchRule?: string | undefined;
  planX?: number | undefined; planY?: number | undefined; modelNodeName?: string | undefined;
}): Promise<SpatialAnchorView> {
  const who = member(ctx);
  await demand(deps, ctx, { permission: 'asset.upload' });
  const seen = await access(deps, ctx, { objectTypes: [input.objectTypeId] });
  const type = seen.objectTypes.find((t) => t.id === input.objectTypeId);
  if (seen.decision !== 'allow' || type === undefined || !type.visible) {
    throw new AppError('forbidden', 'anchoring needs clearance on the anchored type', { code: 'spatial.not_cleared' });
  }
  if (input.matchRule !== undefined) {
    const manifest = await mainManifest(deps, ctx);
    const objectType = manifest.objectTypes.find((t) => t.id === input.objectTypeId);
    if (objectType === undefined) throw notFound('object type', 'spatial.object_type_unknown');
    compileCel(input.matchRule, Object.fromEntries(objectType.properties.map((p) => [p.apiName, 'dyn' as const])));
  }
  const anchor = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const target = await liveTarget(db, input);
    if (input.planId !== undefined) {
      const plan = target as SpatialPlan;
      if (input.planX! > plan.widthPx || input.planY! > plan.heightPx) throw refused('the anchor lies outside the plan', 'spatial.anchor_outside');
    } else if (!(target as AssetModel).nodeNames.includes(input.modelNodeName!)) {
      throw refused('the model has no node of that name', 'spatial.node_unknown', { node: input.modelNodeName! });
    }
    const row = await spatialAnchorRepo.insert(db, {
      id: uuidv7(), organisationId: who.organisationId, planId: input.planId ?? null, assetModelId: input.assetModelId ?? null, objectTypeId: input.objectTypeId,
      objectRef: input.objectRef ?? null, matchRule: input.matchRule ?? null, planX: input.planX === undefined ? null : String(input.planX),
      planY: input.planY === undefined ? null : String(input.planY), modelNodeName: input.modelNodeName ?? null, createdBy: who.membershipId,
    });
    await recordEvent(db, who, ctx.correlationId, {
      event: 'spatial_anchor_set', resource: { type: 'spatial_anchor', id: row.id },
      detail: {
        target_kind: input.planId !== undefined ? 'plan' : 'asset_model', target_id: (input.planId ?? input.assetModelId)!, object_type_id: input.objectTypeId,
        by: input.objectRef !== undefined ? 'object' : 'predicate',
      },
    });
    return row;
  });
  return anchorView(anchor);
}

async function liveTarget(db: Queryable, input: { planId?: string | undefined; assetModelId?: string | undefined }): Promise<SpatialPlan | AssetModel> {
  const target = input.planId !== undefined ? await spatialPlanRepo.findById(db, input.planId) : await assetModelRepo.findById(db, input.assetModelId!);
  if (target === undefined) throw notFound(input.planId !== undefined ? 'plan' : 'model', 'spatial.target_not_found');
  if (target.purgedAt !== null) throw new AppError('conflict', 'it has been purged', { code: 'spatial.purged' });
  return target;
}

export async function removeAnchor(deps: SpatialDeps, ctx: Context, anchorId: string): Promise<{ id: string; removedAt: string }> {
  const who = member(ctx);
  await demand(deps, ctx, { permission: 'asset.upload' });
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const anchor = await spatialAnchorRepo.findById(db, anchorId);
    if (anchor === undefined) throw notFound('anchor', 'spatial.anchor_not_found');
    if (anchor.removedAt !== null) return { id: anchor.id, removedAt: anchor.removedAt };
    const removedAt = new Date().toISOString();
    await spatialAnchorRepo.update(db, anchorId, { removedAt });
    await recordEvent(db, who, ctx.correlationId, {
      event: 'spatial_anchor_removed', resource: { type: 'spatial_anchor', id: anchorId },
      detail: { target_kind: anchor.planId !== null ? 'plan' : 'asset_model', target_id: (anchor.planId ?? anchor.assetModelId)!, reason: 'removed' },
    });
    return { id: anchorId, removedAt };
  });
}

/**
 * Purges a plan or model: its row stays as the record, what was served goes (a model's checked
 * copy; a plan is served from its Silo file, which goes with that file's own purge), and its
 * anchors end. Also reached by the Silo file's purge (purgeSpatialForFiles).
 */
async function purgeTarget(db: Queryable, who: Actor, correlationId: string, target: { kind: 'plan'; row: SpatialPlan } | { kind: 'model'; row: AssetModel }, reason: string,
  ledger = true): Promise<string[]> {
  const at = new Date().toISOString();
  const ended = await spatialAnchorRepo.endFor(db, target.kind === 'plan' ? { planId: target.row.id } : { assetModelId: target.row.id }, at);
  if (target.kind === 'plan') {
    await spatialPlanRepo.update(db, target.row.id, { purgedAt: at });
  } else {
    await assetModelRepo.update(db, target.row.id, { purgedAt: at });
  }
  await recordEvent(db, who, correlationId, {
    event: target.kind === 'plan' ? 'spatial_plan_purged' : 'asset_model_purged', resource: { type: target.kind === 'plan' ? 'spatial_plan' : 'asset_model', id: target.row.id },
    detail: { silo_id: target.row.siloId, silo_file_id: target.row.siloFileId, anchors_ended: ended.length, reason },
  });
  // The purge ledger (8.2; D251): kept outside this database, so a restore purges again what came back.
  if (ledger) {
    await outboxRepo.recordPurge(db, { organisationId: who.organisationId, correlationId, entry: target.kind === 'plan'
      ? { kind: 'spatial', planId: target.row.id } : { kind: 'spatial', assetModelId: target.row.id } });
  }
  return target.kind === 'model' ? target.row.lodRefs : [];
}

/**
 * Replays plan and model purges from the purge ledger after a restore (spec 8.2, 12.5; D251):
 * each purged again (anchors ended, a model's served levels removed) where the restore holds it
 * live; skipped where it does not. Recorded as a replay, with no new ledger entry.
 */
export async function replaySpatial(deps: SpatialDeps, entries: readonly StoredLedgerEntry[]): Promise<{ replayed: number; skipped: number }> {
  const control = deps.databases.pool('control');
  let replayed = 0;
  let skipped = 0;
  for (const stored of entries) {
    const e = stored.entry;
    if (e.kind !== 'spatial') { skipped += 1; continue; }
    const request = { organisationId: stored.organisationId };
    const who: Actor = { organisationId: stored.organisationId, request, membershipId: undefined, servicePrincipalId: undefined };
    const served = await inTransaction(control, request, async (db) => {
      if (e.planId !== undefined) {
        const plan = await spatialPlanRepo.findById(db, e.planId);
        return plan === undefined || plan.purgedAt !== null ? undefined : await purgeTarget(db, who, stored.correlationId, { kind: 'plan', row: plan }, 'replayed', false);
      }
      const model = e.assetModelId === undefined ? undefined : await assetModelRepo.findById(db, e.assetModelId);
      return model === undefined || model.purgedAt !== null ? undefined : await purgeTarget(db, who, stored.correlationId, { kind: 'model', row: model }, 'replayed', false);
    });
    if (served === undefined) { skipped += 1; continue; }
    for (const key of served) await storeOf(deps).purge('siloes', key as ObjectKey).catch(() => undefined);
    replayed += 1;
  }
  return { replayed, skipped };
}

export async function purgePlan(deps: SpatialDeps, ctx: Context, planId: string): Promise<SpatialPlanView> {
  const who = member(ctx);
  await demand(deps, ctx, { permission: 'silo.purge' });
  const row = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const plan = await spatialPlanRepo.findById(db, planId);
    if (plan === undefined) throw notFound('plan', 'spatial.target_not_found');
    if (plan.purgedAt === null) await purgeTarget(db, who, ctx.correlationId, { kind: 'plan', row: plan }, 'requested');
    return (await spatialPlanRepo.findById(db, planId))!;
  });
  return planView(row);
}

export async function purgeModel(deps: SpatialDeps, ctx: Context, assetModelId: string): Promise<AssetModelView> {
  const who = member(ctx);
  await demand(deps, ctx, { permission: 'silo.purge' });
  let served: string[] = [];
  const row = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const model = await assetModelRepo.findById(db, assetModelId);
    if (model === undefined) throw notFound('model', 'spatial.target_not_found');
    if (model.purgedAt === null) served = await purgeTarget(db, who, ctx.correlationId, { kind: 'model', row: model }, 'requested');
    return (await assetModelRepo.findById(db, assetModelId))!;
  });
  for (const key of served) await storeOf(deps).purge('siloes', key as ObjectKey);
  return modelView(row);
}

/**
 * A Silo file's purge reaches the plans and models registered from it (66.4, 70): called by
 * the Silo purge in its own transaction. Returns the served objects to remove from the store.
 */
export async function purgeSpatialForFiles(db: Queryable, who: Actor, correlationId: string, siloFileIds: readonly string[]): Promise<{ plans: number; models: number; served: string[] }> {
  if (siloFileIds.length === 0) return { plans: 0, models: 0, served: [] };
  const plans = await spatialPlanRepo.liveForFiles(db, siloFileIds);
  const models = await assetModelRepo.liveForFiles(db, siloFileIds);
  const served: string[] = [];
  for (const plan of plans) await purgeTarget(db, who, correlationId, { kind: 'plan', row: plan }, 'silo_purge');
  for (const model of models) served.push(...await purgeTarget(db, who, correlationId, { kind: 'model', row: model }, 'silo_purge'));
  return { plans: plans.length, models: models.length, served };
}

export async function listAssets(deps: SpatialDeps, ctx: Context) {
  member(ctx);
  const { plans, models, anchors } = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => ({
    plans: await spatialPlanRepo.listLive(db), models: await assetModelRepo.listLive(db), anchors: await spatialAnchorRepo.listLive(db),
  }), { readOnly: true });
  const markings = [...new Set([...plans.flatMap((p) => p.markingIds), ...models.flatMap((m) => m.markingIds)])];
  const types = [...new Set(anchors.map((a) => a.objectTypeId))];
  const answer = markings.length + types.length === 0 ? undefined
    : await deps.services.call(resolveAccess, { body: { markings, objectTypes: types } }, { request: ctx.request, correlationId: ctx.correlationId });
  const allowed = answer === undefined || answer.decision === 'allow';
  const held = new Set(answer?.markings.filter((m) => m.satisfied).map((m) => m.id) ?? []);
  const visible = new Set(answer?.objectTypes.filter((t) => t.visible).map((t) => t.id) ?? []);
  const shownPlans = plans.filter((p) => allowed && p.markingIds.every((m) => held.has(m)));
  const shownModels = models.filter((m) => allowed && m.markingIds.every((x) => held.has(x)));
  const targets = new Set([...shownPlans.map((p) => p.id), ...shownModels.map((m) => m.id)]);
  const shownAnchors = anchors.filter((a) => targets.has((a.planId ?? a.assetModelId)!) && visible.has(a.objectTypeId));
  return {
    plans: shownPlans.map(planView), models: shownModels.map(modelView), anchors: shownAnchors.map(anchorView),
    withheld: plans.length - shownPlans.length + models.length - shownModels.length + anchors.length - shownAnchors.length,
  };
}

/** A plan the reader may see: live, and every marking on it held. */
export async function readablePlan(deps: SpatialDeps, ctx: Context, planId: string): Promise<SpatialPlan> {
  member(ctx);
  const plan = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => spatialPlanRepo.findById(db, planId), { readOnly: true });
  if (plan === undefined) throw notFound('plan', 'spatial.target_not_found');
  if (plan.purgedAt !== null) throw new AppError('conflict', 'it has been purged', { code: 'spatial.purged' });
  if (!await holdsAll(deps, ctx, plan.markingIds)) throw new AppError('forbidden', 'you lack clearance for a marking on this plan', { code: 'spatial.not_cleared' });
  return plan;
}

export async function readPlanImage(deps: SpatialDeps, ctx: Context, planId: string) {
  const plan = await readablePlan(deps, ctx, planId);
  const bytes = await storeOf(deps).get('siloes', plan.rasterTilesetRef as ObjectKey);
  const size = rasterSize(bytes);
  if (size === undefined) throw new AppError('conflict', 'the plan has no raster to serve', { code: 'spatial_plan.raster_unavailable' });
  return { contentType: size.format === 'png' ? 'image/png' as const : 'image/jpeg' as const, widthPx: plan.widthPx, heightPx: plan.heightPx, content: bytes.toString('base64') };
}

/** A model the reader may see: live, and every marking on it held. */
export async function readableModel(deps: SpatialDeps, ctx: Context, assetModelId: string): Promise<AssetModel> {
  member(ctx);
  const model = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => assetModelRepo.findById(db, assetModelId), { readOnly: true });
  if (model === undefined) throw notFound('model', 'spatial.target_not_found');
  if (model.purgedAt !== null) throw new AppError('conflict', 'it has been purged', { code: 'spatial.purged' });
  if (!await holdsAll(deps, ctx, model.markingIds)) throw new AppError('forbidden', 'you lack clearance for a marking on this model', { code: 'spatial.not_cleared' });
  return model;
}

/** A part of the checked model at a level, from the offset asked for (29.5; D228, D249). */
export async function readModelPart(deps: SpatialDeps, ctx: Context, assetModelId: string, offset: number, level = 0) {
  const model = await readableModel(deps, ctx, assetModelId);
  const levels = levelsOf(model);
  const at = levels.find((l) => l.level === level);
  const served = model.lodRefs[level];
  if (at === undefined || served === undefined) {
    if (level > 0) throw refused('the model has no such level', 'asset_model.level_unavailable', { levels: levels.length });
    throw new AppError('conflict', 'the model has nothing to serve', { code: 'asset_model.unavailable' });
  }
  const bytes = at.bytes;
  if (offset >= bytes) throw refused('the model ends before that offset', 'asset_model.offset_out_of_range', { bytes });
  const end = Math.min(offset + MODEL_PART_BYTES, bytes) - 1;
  const part = await storeOf(deps).getRange('siloes', served as ObjectKey, offset, end);
  return { contentType: 'model/gltf-binary' as const, level, bytes, offset, content: part.toString('base64') };
}

const PREDICATE_BOUNDS = { steps: 10_000, timeMs: 10 };

/** The anchor that places an object: its own first, then the first predicate it matches, in the order set. */
async function anchorMatcher(deps: SpatialDeps, ctx: Context, objectTypeId: string, anchors: readonly SpatialAnchor[])
  : Promise<(object: { ref: string; values: Record<string, unknown> }) => { anchor: SpatialAnchor; by: 'anchor' | 'predicate' } | undefined> {
  const byObject = new Map(anchors.filter((a) => a.objectRef !== null).map((a) => [a.objectRef!, a]));
  const ruled = anchors.filter((a) => a.matchRule !== null);
  let predicates: { anchor: SpatialAnchor; holds: (values: Record<string, unknown>) => boolean }[] = [];
  if (ruled.length > 0) {
    const manifest = await mainManifest(deps, ctx);
    const names = manifest.objectTypes.find((t) => t.id === objectTypeId)?.properties.map((p) => p.apiName) ?? [];
    const types = Object.fromEntries(names.map((n) => [n, 'dyn' as const]));
    predicates = ruled.flatMap((anchor) => {
      try {
        const compiled = compileCel(anchor.matchRule!, types);
        return [{
          anchor,
          holds: (values: Record<string, unknown>) => {
            try {
              // A property the reader may not see arrives absent, so a predicate over it places nothing.
              return compiled.evaluate(Object.fromEntries(names.map((n) => [n, values[n] ?? null])), PREDICATE_BOUNDS) === true;
            } catch {
              return false;
            }
          },
        }];
      } catch {
        // A rule the type no longer satisfies (a property retired since) places nothing.
        return [];
      }
    });
  }
  return (object) => {
    const own = byObject.get(object.ref);
    if (own !== undefined) return { anchor: own, by: 'anchor' };
    const matched = predicates.find((p) => p.holds(object.values));
    return matched === undefined ? undefined : { anchor: matched.anchor, by: 'predicate' };
  };
}

/** The reader may see objects of the type, or is refused. */
async function mustSeeType(deps: SpatialDeps, ctx: Context, objectTypeId: string): Promise<void> {
  const seen = await access(deps, ctx, { objectTypes: [objectTypeId] });
  const type = seen.objectTypes.find((t) => t.id === objectTypeId);
  if (seen.decision !== 'allow' || type === undefined || !type.visible) {
    throw new AppError('forbidden', 'you may not see objects of that type', { code: 'spatial.not_cleared' });
  }
}

/** Which node of a model each object stands on (29.5; D228). */
export async function placeOnModel(deps: SpatialDeps, ctx: Context, assetModelId: string, input: {
  objectTypeId: string; objects: { ref: string; values: Record<string, unknown> }[];
}) {
  const model = await readableModel(deps, ctx, assetModelId);
  await mustSeeType(deps, ctx, input.objectTypeId);
  const anchors = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => spatialAnchorRepo.liveOnModel(db, model.id, input.objectTypeId), { readOnly: true });
  const match = await anchorMatcher(deps, ctx, input.objectTypeId, anchors);
  const nodes = new Set(model.nodeNames);
  const placements: { ref: string; node: string; by: 'anchor' | 'predicate'; anchorId: string }[] = [];
  const notPlaced: { ref: string; reason: string }[] = [];
  for (const object of input.objects) {
    const found = match(object);
    if (found === undefined) { notPlaced.push({ ref: object.ref, reason: 'no anchor places it on this model' }); continue; }
    if (!nodes.has(found.anchor.modelNodeName!)) { notPlaced.push({ ref: object.ref, reason: `the model has no node named ${found.anchor.modelNodeName}` }); continue; }
    placements.push({ ref: object.ref, node: found.anchor.modelNodeName!, by: found.by, anchorId: found.anchor.id });
  }
  return { placements, notPlaced };
}

export async function placeOnPlan(deps: SpatialDeps, ctx: Context, planId: string, input: {
  objectTypeId: string; objects: { ref: string; values: Record<string, unknown> }[]; positionProperty?: string | undefined;
}) {
  const plan = await readablePlan(deps, ctx, planId);
  await mustSeeType(deps, ctx, input.objectTypeId);
  const anchors = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => spatialAnchorRepo.liveOnPlan(db, plan.id, input.objectTypeId), { readOnly: true });
  const match = await anchorMatcher(deps, ctx, input.objectTypeId, anchors);
  const fit = input.positionProperty === undefined || plan.controlPoints === null ? undefined
    : fitGeoreference(plan.controlPoints as { x: number; y: number; lat: number; lon: number }[]);
  const placements: { ref: string; x: number; y: number; by: 'anchor' | 'predicate' | 'georeference'; anchorId: string | null }[] = [];
  const notPlaced: { ref: string; reason: string }[] = [];
  for (const object of input.objects) {
    const found = match(object);
    if (found !== undefined) { placements.push({ ref: object.ref, x: Number(found.anchor.planX), y: Number(found.anchor.planY), by: found.by, anchorId: found.anchor.id }); continue; }
    if (fit === undefined) {
      notPlaced.push({ ref: object.ref, reason: plan.controlPoints === null || input.positionProperty === undefined ? 'no anchor places it' : 'the plan\'s control points do not fix a position' });
      continue;
    }
    const point = readPosition(object.values[input.positionProperty!]);
    if (point === undefined) { notPlaced.push({ ref: object.ref, reason: 'no anchor places it, and it has no position Silo can read' }); continue; }
    const at = fit(point);
    if (at.x < 0 || at.y < 0 || at.x > plan.widthPx || at.y > plan.heightPx) { notPlaced.push({ ref: object.ref, reason: 'its position lies outside the plan' }); continue; }
    placements.push({ ref: object.ref, x: at.x, y: at.y, by: 'georeference', anchorId: null });
  }
  return { placements, notPlaced };
}
