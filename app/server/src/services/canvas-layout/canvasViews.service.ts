// Canvas views (spec 29.6, 29.10): saved, opened under the opener's own permissions,
// shared within the sharing policy, favourited onto a dashboard, archived.
//
// Access to a view is its owner's, or the best live share that reaches the member and that
// the owner's current policy still permits (the saved-view model, spec 37.4: the policy
// helpers are workspace's, applied to the canvas arm of workspace.view_shares). A view's own
// markings come from its lineage (the set it draws and the set's type): policy decides
// clone.view on it as a view resource, and a view the member may not see is not found.
//
// Opening re-resolves, as the opener: the set (an owner's private set is not visible to
// anyone else), its type, and the type's properties with their field policies. What they
// may not see is absent and counted, with a statement; a reduced open by someone other than
// the owner is audited.

import type { CanvasViewView, OpenedCanvasView } from '../../contracts/canvas-layout/canvasView.contract.ts';
import type { CanvasLayout } from '../../contracts/canvas-layout/layout.contract.ts';
import type { CloneState } from '../../contracts/canvas-layout/stateRule.contract.ts';
import { getObjectSet, type ObjectSetView } from '../../contracts/ontology/objectSet.contract.ts';
import { resolveAccess } from '../../contracts/policy/decision.contract.ts';
import { getScenario } from '../../contracts/simulation/scenario.contract.ts';
import type { ShareGrantee, ViewShareView } from '../../contracts/workspace/sharing.contract.ts';
import type { ViewAccess } from '../../contracts/workspace/view.contract.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { CanvasView } from '../../models/clone/canvasView.model.ts';
import type { ViewShare } from '../../models/workspace/viewShare.model.ts';
import { assetModelRepo, canvasViewRepo, spatialPlanRepo } from '../../repos/clone/index.repo.ts';
import { membershipRepo, scopeRepo } from '../../repos/iam/index.repo.ts';
import { dashboardTileRepo, viewShareRepo } from '../../repos/workspace/index.repo.ts';
import { canonicalJsonBytes } from '../../utils/canonicalJson.util.ts';
import { sha256 } from '../../utils/crypto.util.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { writeLineage } from '../lineage/writer.service.ts';
import { atLeast, effectivePolicy, granteeOf, permitted, type EffectivePolicy } from '../workspace/sharing.service.ts';
import { access, allowed, demand, mainManifest, member, notFound, recordEvent, type Actor, type CanvasDeps, type Context } from './deps.service.ts';

const viewNotFound = () => notFound('canvas view', 'clone.canvas_view_not_found');
const stale = () => new AppError('conflict', 'the view changed since you read it', { code: 'clone.canvas_view_stale' });

export interface Configuration {
  name: string;
  layoutKind: CanvasLayout;
  camera: Record<string, unknown>;
  layers: Partial<Record<string, boolean>>;
  focus: { depth?: number | undefined; refs?: string[] | undefined };
  stateFilter: CloneState[];
  pinnedObjectRefs: string[];
  scenarioId?: string | undefined;
  planId?: string | undefined;
  assetModelId?: string | undefined;
}

export type SaveInput = Configuration & ({ canvasScope: 'object' | 'set'; objectSetId: string } | { canvasScope: 'estate_ontology' | 'estate_map' });

export function viewOf(row: CanvasView, held: 'owner' | ViewAccess): CanvasViewView {
  return {
    id: row.id, name: row.name, canvasScope: row.canvasScope, objectSetId: row.objectSetRef, layoutKind: row.layoutKind,
    camera: row.camera as CanvasViewView['camera'], layers: row.layers as Record<string, boolean>, focus: row.focus as CanvasViewView['focus'],
    stateFilter: row.stateFilter as CloneState[], pinnedObjectRefs: row.pinnedObjectRefs, scenarioId: row.scenarioId, planId: row.planId, assetModelId: row.assetModelId, favourited: row.favourited,
    visibility: row.visibility, ontologyVersion: Number(row.ontologyVersion), ownerMembershipId: row.ownerMembershipId, createdAt: row.createdAt,
    updatedAt: row.updatedAt, archivedAt: row.archivedAt, lockVersion: row.lockVersion, access: held,
  };
}

/** What a member holds on a view: owner, the best live share the owner's policy still permits, or nothing. */
export async function accessTo(db: Queryable, view: CanvasView, membershipId: string): Promise<'owner' | ViewAccess | undefined> {
  if (view.ownerMembershipId === membershipId) return 'owner';
  if (view.archivedAt !== null) return undefined;
  const shares = await viewShareRepo.liveReachingCanvas(db, view.id, membershipId);
  if (shares.length === 0) return undefined;
  const policy = await effectivePolicy(db, view.organisationId, view.ownerMembershipId);
  let best: ViewAccess | undefined;
  for (const share of shares) {
    if (!await permitted(db, view.ownerMembershipId, granteeOf(share), policy)) continue;
    const held = share.access as ViewAccess;
    if (best === undefined || atLeast(held, best)) best = held;
  }
  return best;
}

/** The set as the member sees it, or undefined when it is not theirs to see. */
async function setAs(deps: CanvasDeps, ctx: Context, objectSetId: string): Promise<ObjectSetView | undefined> {
  try {
    return await deps.services.call(getObjectSet, { params: { objectSetId } }, { request: ctx.request, correlationId: ctx.correlationId });
  } catch (error) {
    if (isAppError(error) && (error.category === 'not_found' || error.category === 'forbidden')) return undefined;
    throw error;
  }
}

/** The set definition's hash: the version of its lineage node (contracts/lineage/lineage.contract.ts). */
export const setDefinitionHash = (set: ObjectSetView): string => sha256(canonicalJsonBytes(set.definition)).toString('hex');

function configurationRow(input: Configuration) {
  return {
    name: input.name, layoutKind: input.layoutKind, camera: input.camera as never, layers: input.layers as never, focus: input.focus as never,
    stateFilter: [...new Set(input.stateFilter)], pinnedObjectRefs: [...new Set(input.pinnedObjectRefs)], scenarioId: input.scenarioId ?? null,
    planId: input.planId ?? null, assetModelId: input.assetModelId ?? null,
  };
}

/** Whether a site plan or a 3D model stands for this member: live, and every marking on it held. */
async function planStanding(deps: CanvasDeps, ctx: Context, planId: string, kind: 'plan' | 'model' = 'plan'): Promise<'standing' | 'purged' | 'not_cleared' | 'missing'> {
  const plan: { purgedAt: string | null; markingIds: string[] } | undefined = await inTransaction(deps.databases.pool('control'), ctx.request,
    async (db) => (kind === 'plan' ? await spatialPlanRepo.findById(db, planId) : await assetModelRepo.findById(db, planId)), { readOnly: true });
  if (plan === undefined) return 'missing';
  if (plan.purgedAt !== null) return 'purged';
  if (plan.markingIds.length === 0) return 'standing';
  const answer = await deps.services.call(resolveAccess, { body: { markings: plan.markingIds } }, { request: ctx.request, correlationId: ctx.correlationId });
  return answer.decision === 'allow' && answer.markings.length === new Set(plan.markingIds).size && answer.markings.every((m) => m.satisfied) ? 'standing' : 'not_cleared';
}

/** A plan saved with a view: only under the map layout, and only one standing for the saver. */
async function checkPlan(deps: CanvasDeps, ctx: Context, input: Configuration): Promise<void> {
  if (input.assetModelId !== undefined) {
    if (input.layoutKind !== 'spatial_3d') throw new AppError('validation', 'a 3D model is drawn only by the 3D layout', { code: 'clone.model_needs_3d' });
    const standing = await planStanding(deps, ctx, input.assetModelId, 'model');
    if (standing === 'missing' || standing === 'not_cleared') throw notFound('model', 'spatial.target_not_found');
    if (standing === 'purged') throw new AppError('conflict', 'the model has been purged', { code: 'spatial.purged' });
  }
  if (input.planId === undefined) return;
  if (input.layoutKind !== 'spatial_map') {
    throw new AppError('validation', 'a site plan is drawn only under the map layout', { code: 'clone.plan_needs_map' });
  }
  const standing = await planStanding(deps, ctx, input.planId);
  if (standing === 'missing' || standing === 'not_cleared') throw notFound('plan', 'spatial.target_not_found');
  if (standing === 'purged') throw new AppError('conflict', 'the plan has been purged', { code: 'spatial.purged' });
}

export async function save(deps: CanvasDeps, ctx: Context, input: SaveInput): Promise<CanvasViewView> {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'canvas.save' });
  if (input.canvasScope === 'estate_map' || input.canvasScope === 'estate_ontology') {
    await demand(deps, ctx, { permission: 'estate.view' });
  }
  const set = 'objectSetId' in input ? await setAs(deps, ctx, input.objectSetId) : undefined;
  if ('objectSetId' in input && set === undefined) throw notFound('object set', 'clone.object_set_not_found');
  await checkPlan(deps, ctx, input);
  const manifest = await mainManifest(deps, ctx);
  const type = set?.baseTypeId === null || set === undefined ? undefined : manifest.objectTypes.find((t) => t.id === set.baseTypeId);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const id = uuidv7();
    const row = await canvasViewRepo.insert(db, {
      id, organisationId: me.organisationId, ownerMembershipId: me.membershipId, canvasScope: input.canvasScope,
      objectSetRef: set?.id ?? null, ontologyVersion: String(manifest.version.sequence), ...configurationRow(input),
    });
    // The view is an artefact: its lineage is the set it draws and that set's type (spec 59.3).
    await writeLineage(db, { organisationId: me.organisationId, createdBy: { membershipId: me.membershipId } }, {
      artefact: { kind: 'view', refId: id, version: set === undefined ? `canvas.${input.canvasScope}` : `canvas.${setDefinitionHash(set)}` },
      inputs: [
        ...(set === undefined ? [] : [{ node: { kind: 'object_set' as const, refId: set.id, version: setDefinitionHash(set) }, relation: 'uses' as const }]),
        ...(type === undefined ? [] : [{ node: { kind: 'object_type_version' as const, refId: type.id, version: type.typeVersionId }, relation: 'uses' as const }]),
      ],
    });
    await recordEvent(db, me, ctx.correlationId, {
      event: 'canvas_view_saved', resource: { type: 'canvas_view', id },
      detail: { canvas_scope: input.canvasScope, layout: input.layoutKind, pins: row.pinnedObjectRefs.length },
    });
    return viewOf(row, 'owner');
  });
}

export async function update(deps: CanvasDeps, ctx: Context, canvasViewId: string, input: Configuration & { lockVersion: number })
  : Promise<CanvasViewView> {
  const me = member(ctx);
  const manifest = await mainManifest(deps, ctx);
  await checkPlan(deps, ctx, input);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const view = await canvasViewRepo.findForUpdate(db, canvasViewId);
    if (!view || view.ownerMembershipId !== me.membershipId) throw viewNotFound();
    if (view.lockVersion !== input.lockVersion) throw stale();
    if (view.archivedAt !== null) throw new AppError('conflict', 'an archived view does not change', { code: 'clone.canvas_view_archived' });
    const row = (await canvasViewRepo.update(db, view.id, {
      ...configurationRow(input), ontologyVersion: String(manifest.version.sequence), lockVersion: view.lockVersion + 1,
    }))!;
    await recordEvent(db, me, ctx.correlationId, {
      event: 'canvas_view_updated', resource: { type: 'canvas_view', id: view.id },
      detail: { layout: input.layoutKind, layout_changed: input.layoutKind !== view.layoutKind, pins: row.pinnedObjectRefs.length },
    });
    return viewOf(row, 'owner');
  });
}

/** A view the member may see: held through ownership or a share, and its markings satisfied. */
async function visible(deps: CanvasDeps, ctx: Context, me: Actor & { membershipId: string }, canvasViewId: string)
  : Promise<{ view: CanvasView; held: 'owner' | ViewAccess }> {
  const found = await inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const view = await canvasViewRepo.findById(db, canvasViewId);
    if (!view || view.deletedAt !== null) return undefined;
    const held = await accessTo(db, view, me.membershipId);
    return held === undefined ? undefined : { view, held };
  }, { readOnly: true });
  if (found === undefined) throw viewNotFound();
  // The view's own markings (its lineage) are a policy decision on the view as a resource.
  if (!await allowed(deps, ctx, { permission: 'clone.view', resource: { type: 'view', id: canvasViewId } })) throw viewNotFound();
  return found;
}

export async function open(deps: CanvasDeps, ctx: Context, canvasViewId: string): Promise<OpenedCanvasView> {
  const me = member(ctx);
  const { view, held } = await visible(deps, ctx, me, canvasViewId);
  let objectTypeId: string | null = null;
  let ontologyVersionId: string | null = null;
  let visibleProperties: OpenedCanvasView['visibleProperties'] = [];
  let withheldProperties = 0;
  let pins = view.pinnedObjectRefs;
  let reduced = false;
  if (view.objectSetRef !== null) {
    const set = await setAs(deps, ctx, view.objectSetRef);
    const manifest = await mainManifest(deps, ctx);
    ontologyVersionId = manifest.version.id;
    const type = set?.baseTypeId == null ? undefined : manifest.objectTypes.find((t) => t.id === set.baseTypeId);
    if (set === undefined || type === undefined) {
      reduced = true;
      pins = [];
    } else {
      const decided = await access(deps, ctx, { objectTypes: [type.id], properties: type.properties.map((p) => p.identityId) });
      if (decided.decision !== 'allow' || decided.objectTypes[0]?.visible !== true) {
        reduced = true;
        pins = [];
        withheldProperties = type.properties.length;
      } else {
        objectTypeId = type.id;
        for (const p of decided.properties) {
          if (!p.visible || p.effect === 'deny') withheldProperties += 1;
          else visibleProperties.push({ id: p.id, effect: p.effect });
        }
        visibleProperties = visibleProperties.sort((a, b) => a.id.localeCompare(b.id));
        reduced = withheldProperties > 0;
      }
    }
  }
  // A scenario overlay (30.9) is drawn only for an opener who may see the scenario (ownership or a share, chapter 39).
  let scenarioId = view.scenarioId;
  if (scenarioId !== null) {
    const seen = await deps.services.call(getScenario, { params: { scenarioId } }, { request: ctx.request, correlationId: ctx.correlationId }).catch(() => undefined);
    if (seen === undefined) {
      scenarioId = null;
      reduced = true;
    }
  }
  // A site plan (29.4) stands only while live and only for an opener holding its markings; otherwise the map stands
  // instead (32.8): a purged plan says so, a withheld one is counted as part of what this opener may not see.
  let planId = view.planId;
  let fallback: string | null = null;
  if (planId !== null) {
    const standing = await planStanding(deps, ctx, planId);
    if (standing !== 'standing') {
      planId = null;
      if (standing === 'purged') fallback = 'The site plan was purged, so the map is shown instead.';
      else reduced = true;
    }
  }
  // A 3D model (29.5) likewise: a purged one falls back to the next layout, with the reason (29.12).
  let assetModelId = view.assetModelId;
  if (assetModelId !== null) {
    const standing = await planStanding(deps, ctx, assetModelId, 'model');
    if (standing !== 'standing') {
      assetModelId = null;
      if (standing === 'purged') fallback = [fallback, 'The 3D model was purged, so the next layout is shown instead.'].filter((x) => x !== null).join(' ');
      else reduced = true;
    }
  }
  const withheld = { properties: withheldProperties, pins: view.pinnedObjectRefs.length - pins.length };
  await inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    await recordEvent(db, me, ctx.correlationId, {
      event: 'clone_set_opened', resource: { type: 'canvas_view', id: view.id }, detail: { layout: view.layoutKind, owner: held === 'owner' },
    });
    if (scenarioId !== null) {
      await recordEvent(db, me, ctx.correlationId, {
        event: 'scenario_overlaid', resource: { type: 'canvas_view', id: view.id }, detail: { scenario_id: scenarioId, layout: view.layoutKind },
      });
    }
    if (reduced && held !== 'owner') {
      await recordEvent(db, me, ctx.correlationId, {
        event: 'canvas_view_opened_with_reduced_permissions', resource: { type: 'canvas_view', id: view.id },
        detail: { withheld_properties: withheld.properties, withheld_pins: withheld.pins, type_withheld: objectTypeId === null && view.objectSetRef !== null },
      });
    }
  });
  return {
    view: { ...viewOf(view, held), scenarioId, planId, assetModelId }, objectTypeId, ontologyVersionId, visibleProperties, pinnedObjectRefs: pins, withheld,
    statement: [reduced ? 'Part of this view is not visible to you, so it is not shown.' : null, fallback].filter((x) => x !== null).join(' ') || null,
  };
}

export async function list(deps: CanvasDeps, ctx: Context, filter: 'mine' | 'shared' | 'favourited' | 'archived', limit: number)
  : Promise<CanvasViewView[]> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    if (filter !== 'shared') return (await canvasViewRepo.listOwned(db, me.membershipId, filter, limit)).map((v) => viewOf(v, 'owner'));
    const out: CanvasViewView[] = [];
    for (const view of await canvasViewRepo.findMany(db, await viewShareRepo.canvasViewsReaching(db, me.membershipId), limit)) {
      if (view.ownerMembershipId === me.membershipId) continue;
      const held = await accessTo(db, view, me.membershipId);
      if (held !== undefined) out.push(viewOf(view, held));
    }
    return out;
  }, { readOnly: true });
}

export async function archive(deps: CanvasDeps, ctx: Context, canvasViewId: string): Promise<CanvasViewView> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const view = await canvasViewRepo.findForUpdate(db, canvasViewId);
    if (!view || view.ownerMembershipId !== me.membershipId) throw viewNotFound();
    if (view.archivedAt !== null) return viewOf(view, 'owner');
    const now = new Date().toISOString();
    const shares = await viewShareRepo.revokeAllForCanvas(db, view.id, now);
    const tiles = await dashboardTileRepo.removeForCanvasView(db, view.id);
    const row = (await canvasViewRepo.update(db, view.id, {
      archivedAt: now, favourited: false, visibility: 'private', lockVersion: view.lockVersion + 1,
    }))!;
    await recordEvent(db, me, ctx.correlationId, {
      event: 'canvas_view_archived', resource: { type: 'canvas_view', id: view.id }, detail: { shares_revoked: shares, tiles_removed: tiles },
    });
    return viewOf(row, 'owner');
  });
}

/**
 * The owner's flag promotes the view onto the owner's dashboard, the flag and the tile in
 * one transaction; anyone it is shared with may tile it on their own dashboard.
 */
export async function favourite(deps: CanvasDeps, ctx: Context, canvasViewId: string, grid: [number, number, number, number]): Promise<CanvasViewView> {
  const me = member(ctx);
  const { held } = await visible(deps, ctx, me, canvasViewId);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    let view = (await canvasViewRepo.findForUpdate(db, canvasViewId))!;
    if (view.archivedAt !== null) throw new AppError('conflict', 'an archived view is not favourited', { code: 'clone.canvas_view_archived' });
    const tile = await dashboardTileRepo.findForCanvasView(db, me.membershipId, view.id);
    if (tile) await dashboardTileRepo.update(db, tile.id, { grid });
    else await dashboardTileRepo.insert(db, { id: uuidv7(), organisationId: me.organisationId, membershipId: me.membershipId, canvasViewId: view.id, grid });
    if (held === 'owner' && !view.favourited) view = (await canvasViewRepo.update(db, view.id, { favourited: true, lockVersion: view.lockVersion + 1 }))!;
    return viewOf(view, held);
  });
}

export async function unfavourite(deps: CanvasDeps, ctx: Context, canvasViewId: string): Promise<CanvasViewView> {
  const me = member(ctx);
  const { held } = await visible(deps, ctx, me, canvasViewId);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    let view = (await canvasViewRepo.findForUpdate(db, canvasViewId))!;
    await dashboardTileRepo.removeForCanvasView(db, view.id, me.membershipId);
    if (held === 'owner' && view.favourited) view = (await canvasViewRepo.update(db, view.id, { favourited: false, lockVersion: view.lockVersion + 1 }))!;
    return viewOf(view, held);
  });
}

// ----------------------------------------------------------------------------- sharing

function shareState(share: ViewShare): Exclude<ViewShareView['state'], 'forbidden_by_policy'> {
  if (share.revokedAt !== null) return 'revoked';
  if (share.suspendedAt !== null) return 'suspended';
  if (share.expiresAt !== null && Date.parse(share.expiresAt) <= Date.now()) return 'expired';
  return 'live';
}

async function shareView(db: Queryable, share: ViewShare, ownerId: string, policy: EffectivePolicy): Promise<ViewShareView> {
  let state: ViewShareView['state'] = shareState(share);
  if (state === 'live' && !await permitted(db, ownerId, granteeOf(share), policy)) state = 'forbidden_by_policy';
  return {
    id: share.id, viewId: share.canvasViewId!, grantee: granteeOf(share), access: share.access, sharedBy: share.sharedBy, sharedAt: share.sharedAt,
    expiresAt: share.expiresAt, revokedAt: share.revokedAt, suspendedAt: share.suspendedAt, state,
  };
}

/** Visibility derived from the live shares the policy permits, never trusted alone. */
async function refreshVisibility(db: Queryable, view: CanvasView): Promise<void> {
  const policy = await effectivePolicy(db, view.organisationId, view.ownerMembershipId);
  let visibility: CanvasView['visibility'] = 'private';
  for (const share of await viewShareRepo.listForCanvas(db, view.id)) {
    if (shareState(share) !== 'live' || !await permitted(db, view.ownerMembershipId, granteeOf(share), policy)) continue;
    visibility = share.organisationWide ? 'org_visible' : visibility === 'org_visible' ? visibility : 'shared';
  }
  if (visibility !== view.visibility) await canvasViewRepo.update(db, view.id, { visibility });
}

export interface ShareInput {
  grantee: ShareGrantee;
  access: ViewAccess;
  expiresAt?: string | undefined;
}

export async function share(deps: CanvasDeps, ctx: Context, canvasViewId: string, input: ShareInput): Promise<ViewShareView> {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'canvas.share' });
  if (input.expiresAt !== undefined && Date.parse(input.expiresAt) <= Date.now()) {
    throw new AppError('validation', 'a share expires in the future', { code: 'clone.share_expiry_past' });
  }
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const view = await canvasViewRepo.findForUpdate(db, canvasViewId);
    if (!view || view.ownerMembershipId !== me.membershipId) throw viewNotFound();
    if (view.archivedAt !== null) throw new AppError('conflict', 'an archived view is not shared', { code: 'clone.canvas_view_archived' });
    const grantee = input.grantee;
    if (grantee.kind === 'membership') {
      if (grantee.membershipId === me.membershipId) throw new AppError('validation', 'a view is not shared with its owner', { code: 'clone.share_self' });
      const target = await membershipRepo.findById(db, grantee.membershipId);
      // Only active members of this organisation: sharing never crosses organisations (29.10).
      if (!target || target.status !== 'active') throw new AppError('validation', 'share with an active member of this organisation', { code: 'clone.share_grantee_unknown' });
    } else if (grantee.kind === 'scope') {
      const scope = await scopeRepo.findById(db, grantee.scopeId);
      if (!scope || scope.archivedAt !== null) throw new AppError('validation', 'no such scope', { code: 'clone.share_grantee_unknown' });
    }
    const policy = await effectivePolicy(db, me.organisationId, me.membershipId);
    if (!await permitted(db, me.membershipId, grantee, policy)) {
      throw new AppError('forbidden', `the sharing policy (${policy.viewSharingPolicy}) does not allow this share`, {
        code: 'clone.share_forbidden', details: { policy: policy.viewSharingPolicy },
      });
    }
    const now = new Date().toISOString();
    const existing = await viewShareRepo.findForCanvasGrantee(db, view.id, {
      ...(grantee.kind === 'membership' ? { membershipId: grantee.membershipId } : {}),
      ...(grantee.kind === 'scope' ? { scopeId: grantee.scopeId } : {}),
      ...(grantee.kind === 'organisation' ? { organisation: true as const } : {}),
    });
    const row = existing
      ? (await viewShareRepo.update(db, existing.id, {
        access: input.access, expiresAt: input.expiresAt ?? null, revokedAt: null, suspendedAt: null, sharedBy: me.membershipId, sharedAt: now,
      }))!
      : await viewShareRepo.insert(db, {
        id: uuidv7(), organisationId: me.organisationId, canvasViewId: view.id,
        membershipId: grantee.kind === 'membership' ? grantee.membershipId : null, scopeId: grantee.kind === 'scope' ? grantee.scopeId : null,
        organisationWide: grantee.kind === 'organisation' ? true : null, access: input.access, sharedBy: me.membershipId, sharedAt: now,
        expiresAt: input.expiresAt ?? null,
      });
    await refreshVisibility(db, view);
    await recordEvent(db, me, ctx.correlationId, {
      event: 'canvas_view_shared', resource: { type: 'canvas_view', id: view.id },
      subjectMembershipId: grantee.kind === 'membership' ? grantee.membershipId : null, scopeId: grantee.kind === 'scope' ? grantee.scopeId : null,
      detail: { share_id: row.id, grantee: grantee.kind, access: input.access, expires: input.expiresAt !== undefined },
    });
    return shareView(db, row, me.membershipId, policy);
  });
}

export async function revokeShare(deps: CanvasDeps, ctx: Context, canvasViewId: string, shareId: string): Promise<ViewShareView> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const view = await canvasViewRepo.findForUpdate(db, canvasViewId);
    if (!view || view.ownerMembershipId !== me.membershipId) throw viewNotFound();
    const found = await viewShareRepo.findById(db, shareId);
    if (!found || found.canvasViewId !== view.id) throw notFound('share', 'clone.share_not_found');
    const row = found.revokedAt !== null ? found : (await viewShareRepo.update(db, found.id, { revokedAt: new Date().toISOString() }))!;
    if (found.revokedAt === null) {
      await refreshVisibility(db, view);
      await recordEvent(db, me, ctx.correlationId, {
        event: 'canvas_view_share_revoked', resource: { type: 'canvas_view', id: view.id }, subjectMembershipId: found.membershipId,
        scopeId: found.scopeId, detail: { share_id: found.id },
      });
    }
    return shareView(db, row, me.membershipId, await effectivePolicy(db, me.organisationId, me.membershipId));
  });
}

export async function listShares(deps: CanvasDeps, ctx: Context, canvasViewId: string): Promise<ViewShareView[]> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const view = await canvasViewRepo.findById(db, canvasViewId);
    if (!view || view.deletedAt !== null || view.ownerMembershipId !== me.membershipId) throw viewNotFound();
    const policy = await effectivePolicy(db, me.organisationId, me.membershipId);
    const out: ViewShareView[] = [];
    for (const row of await viewShareRepo.listForCanvas(db, view.id)) out.push(await shareView(db, row, me.membershipId, policy));
    return out;
  }, { readOnly: true });
}

/** One view as the member holds it: a keyed save's replay. */
export async function read(deps: CanvasDeps, ctx: Context, canvasViewId: string): Promise<CanvasViewView> {
  const me = member(ctx);
  const { view, held } = await visible(deps, ctx, me, canvasViewId);
  return viewOf(view, held);
}
