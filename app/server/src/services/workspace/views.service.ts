// Saved views (spec 37.1 to 37.3, 37.5, 37.6, 37.10).
//
// Saving: a result or analysis view references a compiled manifest the saver compiled (or
// asked in one of their threads); an object_set view references a saved set the saver
// owns or that is shared. The view and its own thread are written in one transaction
// (the keys between them are deferred).
//
// Opening and running: access is owner, or the best live share the owner's current policy
// permits (sharing.service.ts). A view's own markings are a policy decision on the view as
// a resource. Running goes to the engine under the opener's request context, never the
// owner's: the engine drops what the opener may not see, and a reduced run is audited
// (view_opened_with_reduced_permissions, spec 37.5). Running is never metered. The last
// result is a data plane reference under TTL; no row ever reaches the control plane.
//
// Lineage (spec 59.3): a view is written with its node in the same transaction: a result or
// analysis view derives from its compiled plan (compiles_to, from compile's ask_prompt node,
// so the plan's markings reach the view), an object_set view from its set (member_of).
//
// Favouriting: the owner's flag promotes the view onto the owner's dashboard; anyone a
// view is shared with may tile it on their own. A tile whose view is no longer theirs to
// see disappears from their dashboard.

import type { RunOutcomeView, SavedViewView, ViewAccess } from '../../contracts/workspace/view.contract.ts';
import { viewLastRunKeys } from '../../infra/keyspaces.infra.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { DashboardTile } from '../../models/workspace/dashboardTile.model.ts';
import type { SavedView } from '../../models/workspace/savedView.model.ts';
import { compiledManifestRepo, objectSetRepo, planBindingRepo } from '../../repos/ontology/index.repo.ts';
import { runView as runAnalysisView } from './analyses.service.ts';
import { askThreadRepo, askTurnRepo, dashboardTileRepo, followRepo, savedViewRepo, viewShareRepo } from '../../repos/workspace/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { canonicalJsonBytes } from '../../utils/canonicalJson.util.ts';
import { sha256 } from '../../utils/crypto.util.ts';
import type { LineageWriteInput } from '../../contracts/lineage/lineage.contract.ts';
import { reportLineageWriteFailure, writeLineage } from '../lineage/writer.service.ts';
import { allowed, demand, member, recordEvent, viewNotFound, type Context, type Member, type WorkspaceDeps } from './deps.service.ts';
import { accessTo, atLeast } from './sharing.service.ts';

export function viewOf(view: SavedView, access: 'owner' | ViewAccess): SavedViewView {
  return {
    id: view.id, name: view.name, kind: view.kind, manifestId: view.manifestId, objectSetId: view.objectSetId, threadId: view.threadId,
    ownerMembershipId: view.ownerMembershipId, createdAt: view.createdAt, updatedAt: view.updatedAt, lastRunAt: view.lastRunAt,
    favourited: view.favourited, visibility: view.visibility, archivedAt: view.archivedAt,
    transferredFromMembershipId: view.transferredFromMembershipId, transferredAt: view.transferredAt, lockVersion: view.lockVersion, access,
  };
}

export type SaveInput =
  | { kind: 'result' | 'analysis'; name: string; manifestId: string; fromBindingId?: string | undefined }
  | { kind: 'object_set'; name: string; objectSetId: string };

/** Whether a member may make a view of this plan: theirs to begin with, never someone else's by guessing its id. */
async function planIsTheirs(db: Queryable, me: Member, input: SaveInput): Promise<boolean> {
  if (input.kind === 'object_set') {
    const set = await objectSetRepo.findById(db, input.objectSetId);
    return set !== undefined && set.archivedAt === null && (set.ownerMembershipId === me.membershipId || set.visibility === 'shared');
  }
  const manifest = await compiledManifestRepo.findById(db, input.manifestId);
  if (!manifest || manifest.kind !== (input.kind === 'result' ? 'query' : 'analysis')) return false;
  // Identical plans and chains are one manifest: theirs too when they bound their own values to it.
  return manifest.createdByMembershipId === me.membershipId || await askTurnRepo.manifestAskedBy(db, manifest.id, me.membershipId)
    || (input.fromBindingId !== undefined && await planBindingRepo.boundBy(db, input.fromBindingId, manifest.id, me.membershipId));
}

/** Runs a write that creates a view; a lineage failure (which aborted it) is reported to the audit ledger. */
async function reportingLineage<T>(deps: WorkspaceDeps, me: Member, ctx: Context, viewId: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if ((error as { code?: string }).code === 'lineage.write_failed') {
      await reportLineageWriteFailure(deps.databases.pool('control'), { organisationId: me.organisationId, createdBy: { membershipId: me.membershipId } },
        { kind: 'view', refId: viewId, version: 'unknown' }, ctx.correlationId, 'workspace');
    }
    throw error;
  }
}

/** The view's lineage: its node, and the plan or set it derives from. */
async function viewLineage(db: Queryable, input: SaveInput, viewId: string): Promise<LineageWriteInput> {
  if (input.kind === 'object_set') {
    const set = await objectSetRepo.findById(db, input.objectSetId);
    const version = sha256(canonicalJsonBytes(set?.definition ?? null)).toString('hex');
    return {
      artefact: { kind: 'view', refId: viewId, version },
      inputs: [{ node: { kind: 'object_set', refId: input.objectSetId, version }, relation: 'member_of' }],
    };
  }
  const manifest = await compiledManifestRepo.findById(db, input.manifestId);
  const version = manifest?.manifestHash.toString('hex') ?? 'unknown';
  return {
    artefact: { kind: 'view', refId: viewId, version },
    inputs: [{ node: { kind: 'ask_prompt', refId: input.manifestId, version }, relation: 'compiles_to' }],
  };
}

/** Writes a view, its own thread and its lineage together; the view is private and unfavourited. */
async function insertView(db: Queryable, me: Member, input: SaveInput, viewId: string = uuidv7()): Promise<SavedView> {
  const threadId = uuidv7();
  // An artefact cannot exist without its lineage (spec 59.3).
  await writeLineage(db, { organisationId: me.organisationId, createdBy: { membershipId: me.membershipId } }, await viewLineage(db, input, viewId));
  await askThreadRepo.insert(db, {
    id: threadId, organisationId: me.organisationId, ownerMembershipId: me.membershipId, title: input.name,
    scopeKind: 'saved_view', scopeRef: { kind: 'saved_view', savedViewId: viewId }, savedViewId: viewId,
  });
  return savedViewRepo.insert(db, {
    id: viewId, organisationId: me.organisationId, ownerMembershipId: me.membershipId, name: input.name, kind: input.kind,
    manifestId: input.kind === 'object_set' ? null : input.manifestId, objectSetId: input.kind === 'object_set' ? input.objectSetId : null,
    threadId,
  });
}

export async function save(deps: WorkspaceDeps, ctx: Context, input: SaveInput): Promise<SavedViewView> {
  const me = member(ctx);
  // Saving a view from a compiled answer (spec 37.12). Re-running it later is free.
  await demand(deps, ctx, { permission: 'query.compile' });
  const viewId = uuidv7();
  const notFound = () => new AppError('not_found', input.kind === 'object_set' ? 'no such object set' : 'no such compiled plan', { code: 'workspace.plan_not_found' });
  if (input.kind !== 'object_set' && input.fromBindingId !== undefined) {
    // The values bound into the plan travel with it: the view keeps its own copy (under its id).
    // Theirs to save, and values they bound themselves (an Ask turn of theirs, an analysis of theirs): never someone else's values.
    const ok = await inTransaction(deps.databases.pool('control'), me.request, async (db) => await planIsTheirs(db, me, input)
      && await planBindingRepo.boundBy(db, input.fromBindingId!, input.manifestId, me.membershipId), { readOnly: true });
    if (!ok) throw notFound();
    const bound = await deps.engine.bind(input.fromBindingId, viewId, { request: me.request, correlationId: ctx.correlationId });
    if (bound.planId !== input.manifestId) throw new AppError('validation', 'those values belong to another plan', { code: 'workspace.binding_mismatch' });
  }
  return reportingLineage(deps, me, ctx, viewId, () => inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    if (!await planIsTheirs(db, me, input)) throw notFound();
    const view = await insertView(db, me, input, viewId);
    await recordEvent(db, me, ctx.correlationId, { event: 'view_saved', resource: { type: 'view', id: view.id }, detail: { kind: input.kind } });
    return viewOf(view, 'owner');
  }));
}

export async function read(deps: WorkspaceDeps, ctx: Context, viewId: string): Promise<SavedViewView> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const view = await savedViewRepo.findById(db, viewId);
    const access = view && await accessTo(db, view, me.membershipId);
    if (!view || !access) throw viewNotFound();
    return viewOf(view, access);
  }, { readOnly: true });
}

export interface ListInput {
  set: 'mine' | 'shared' | 'favourited' | 'archived';
  search?: string | undefined;
  limit: number;
}

export async function list(deps: WorkspaceDeps, ctx: Context, input: ListInput): Promise<SavedViewView[]> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    if (input.set !== 'shared') {
      const rows = await savedViewRepo.listOwned(db, me.membershipId, {
        archived: input.set === 'archived', favouritedOnly: input.set === 'favourited', search: input.search, limit: input.limit,
      });
      return rows.map((v) => viewOf(v, 'owner'));
    }
    // One row per share that reaches the member; the policy decides which still count.
    const seen = new Map<string, SavedViewView>();
    for (const row of await savedViewRepo.listSharedWith(db, me.membershipId, { search: input.search, limit: input.limit })) {
      if (seen.has(row.id)) continue;
      const access = await accessTo(db, row, me.membershipId);
      if (access) seen.set(row.id, viewOf(row, access));
      if (seen.size >= input.limit) break;
    }
    return [...seen.values()];
  }, { readOnly: true });
}

/** The view if the member may open it: their access, and the view's own markings (a decision on the view). */
async function reachable(deps: WorkspaceDeps, ctx: Context, me: Member, viewId: string, needed: ViewAccess | 'owner')
  : Promise<{ view: SavedView; access: 'owner' | ViewAccess }> {
  const found = await inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const view = await savedViewRepo.findById(db, viewId);
    const access = view && await accessTo(db, view, me.membershipId);
    return view && access ? { view, access } : undefined;
  }, { readOnly: true });
  if (!found) throw viewNotFound();
  const enough = needed === 'owner' ? found.access === 'owner' : found.access === 'owner' || atLeast(found.access, needed);
  if (!enough) {
    throw new AppError('forbidden', needed === 'owner' ? 'only the owner may do that' : `this view is shared with you for ${found.access} only`, {
      code: 'workspace.access_insufficient', details: { held: found.access, needed },
    });
  }
  // A marking on the view restricts it whatever the share (spec 58): denied is not found.
  if (!await allowed(deps, ctx, { permission: 'ontology.view', resource: { type: 'view', id: viewId } })) throw viewNotFound();
  return found;
}

export async function open(deps: WorkspaceDeps, ctx: Context, viewId: string)
  : Promise<{ view: SavedViewView; lastRun: { resultRef: string; ranAt: string } | null }> {
  const me = member(ctx);
  const { view, access } = await reachable(deps, ctx, me, viewId, 'view');
  const held = await deps.data.read(viewLastRunKeys, viewLastRunKeys.key(me.organisationId, { viewId }));
  return { view: viewOf(view, access), lastRun: held ? { resultRef: held.resultRef, ranAt: held.ranAt } : null };
}

/** Re-executes a view's plan under the opener's access (spec 37.5). Never metered. */
export async function run(deps: WorkspaceDeps, ctx: Context, viewId: string): Promise<{ view: SavedViewView; run: RunOutcomeView }> {
  const me = member(ctx);
  const { view, access } = await reachable(deps, ctx, me, viewId, 'run');
  if (view.archivedAt !== null) throw new AppError('conflict', 'an archived view does not run', { code: 'workspace.view_archived' });
  // A view's bound values are kept under its own id; an analysis runs step by step (37.8).
  const target = view.objectSetId !== null ? { objectSetId: view.objectSetId } : { manifestId: view.manifestId!, bindingId: view.id };
  const outcome = view.kind === 'analysis' ? await runAnalysisView(deps, ctx, view.manifestId!, view.id)
    : await deps.engine.run(target, { request: me.request, correlationId: ctx.correlationId });
  const updated = await inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    let row = view;
    if (outcome.outcome === 'result') {
      row = (await savedViewRepo.update(db, view.id, { lastRunAt: outcome.ranAt })) ?? view;
      if (outcome.reduced) {
        await recordEvent(db, me, ctx.correlationId, {
          event: 'view_opened_with_reduced_permissions', resource: { type: 'view', id: view.id }, subjectMembershipId: view.ownerMembershipId,
          detail: { access },
        });
      }
    }
    await recordEvent(db, me, ctx.correlationId, {
      event: 'view_run', resource: { type: 'view', id: view.id },
      detail: { outcome: outcome.outcome, ...(outcome.outcome === 'refused' ? { reason: outcome.reason } : { incomplete_sources: outcome.incompleteSources.length }) },
    });
    return row;
  });
  if (outcome.outcome === 'result') {
    await deps.data.put(viewLastRunKeys, viewLastRunKeys.key(me.organisationId, { viewId }), {
      resultRef: outcome.resultRef, ranAt: outcome.ranAt, ranBy: me.membershipId,
    });
  }
  return { view: viewOf(updated, access), run: outcome };
}

/** A copy is a new private view owned by the recipient (spec 37.4), with a thread of its own. */
export async function copy(deps: WorkspaceDeps, ctx: Context, viewId: string, name: string | undefined): Promise<SavedViewView> {
  const me = member(ctx);
  const { view } = await reachable(deps, ctx, me, viewId, 'copy');
  await demand(deps, ctx, { permission: 'query.compile' });
  const copyId = uuidv7();
  if (view.kind !== 'object_set') {
    // The copy keeps the original's bound values, if it has any.
    await deps.engine.bind(view.id, copyId, { request: me.request, correlationId: ctx.correlationId }).catch((error: unknown) => {
      if ((error as { code?: string }).code !== 'compile.binding_not_found') throw error;
    });
  }
  return reportingLineage(deps, me, ctx, copyId, () => inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const input: SaveInput = view.kind === 'object_set'
      ? { kind: 'object_set', name: name ?? view.name, objectSetId: view.objectSetId! }
      : { kind: view.kind, name: name ?? view.name, manifestId: view.manifestId! };
    const created = await insertView(db, me, input, copyId);
    await recordEvent(db, me, ctx.correlationId, {
      event: 'view_saved', resource: { type: 'view', id: created.id }, detail: { kind: view.kind, copied_from: view.id },
    });
    return viewOf(created, 'owner');
  }));
}

async function owned(db: Queryable, me: Member, viewId: string): Promise<SavedView> {
  const view = await savedViewRepo.findForUpdate(db, viewId);
  if (!view || view.ownerMembershipId !== me.membershipId) throw viewNotFound();
  return view;
}

export async function rename(deps: WorkspaceDeps, ctx: Context, viewId: string, name: string, lockVersion: number): Promise<SavedViewView> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const view = await owned(db, me, viewId);
    if (view.lockVersion !== lockVersion) {
      throw new AppError('conflict', 'the view changed since you read it', { code: 'workspace.view_stale', details: { lockVersion: view.lockVersion } });
    }
    if (view.name === name) return viewOf(view, 'owner');
    const updated = (await savedViewRepo.update(db, view.id, { name, lockVersion: view.lockVersion + 1 }))!;
    await askThreadRepo.update(db, view.threadId, { title: name });
    await recordEvent(db, me, ctx.correlationId, { event: 'view_renamed', resource: { type: 'view', id: view.id } });
    return viewOf(updated, 'owner');
  });
}

/** Archiving takes the view off every dashboard and ends its shares. */
export async function archive(deps: WorkspaceDeps, ctx: Context, viewId: string): Promise<SavedViewView> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const view = await owned(db, me, viewId);
    if (view.archivedAt !== null) return viewOf(view, 'owner');
    const now = new Date().toISOString();
    const revoked = await viewShareRepo.revokeAll(db, view.id, now);
    await dashboardTileRepo.removeForView(db, view.id);
    await followRepo.removeForResource(db, 'view', view.id);
    const updated = (await savedViewRepo.update(db, view.id, { archivedAt: now, favourited: false, visibility: 'private' }))!;
    await recordEvent(db, me, ctx.correlationId, { event: 'view_archived', resource: { type: 'view', id: view.id }, detail: { shares_revoked: revoked } });
    return viewOf(updated, 'owner');
  });
}

const DEFAULT_SPAN = [2, 2] as const;

/** Below every tile the member has: column 1, the next free row. */
function nextGrid(tiles: readonly DashboardTile[]): [number, number, number, number] {
  const row = tiles.reduce((max, t) => Math.max(max, t.grid[1]! + t.grid[3]!), 1);
  return [1, row, DEFAULT_SPAN[0], DEFAULT_SPAN[1]];
}

export async function favourite(deps: WorkspaceDeps, ctx: Context, viewId: string, grid: [number, number, number, number] | undefined)
  : Promise<{ view: SavedViewView; tileId: string }> {
  const me = member(ctx);
  const { view, access } = await reachable(deps, ctx, me, viewId, 'view');
  if (view.archivedAt !== null) throw new AppError('conflict', 'an archived view is not favourited', { code: 'workspace.view_archived' });
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    let row = view;
    let tile = await dashboardTileRepo.findForView(db, me.membershipId, view.id);
    if (!tile) {
      tile = await dashboardTileRepo.insert(db, {
        id: uuidv7(), organisationId: me.organisationId, membershipId: me.membershipId, savedViewId: view.id,
        grid: grid ?? nextGrid(await dashboardTileRepo.listForMember(db, me.membershipId)),
      });
      await recordEvent(db, me, ctx.correlationId, { event: 'view_favourited', resource: { type: 'view', id: view.id }, detail: { owner: access === 'owner' } });
    } else if (grid !== undefined) {
      tile = (await dashboardTileRepo.update(db, tile.id, { grid }))!;
    }
    // The owner's flag is kept in step with the owner's tile (design: saved_views.favourited).
    if (access === 'owner' && !view.favourited) row = (await savedViewRepo.update(db, view.id, { favourited: true }))!;
    return { view: viewOf(row, access), tileId: tile.id };
  });
}

export async function unfavourite(deps: WorkspaceDeps, ctx: Context, viewId: string): Promise<SavedViewView> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const view = await savedViewRepo.findById(db, viewId);
    const access = view && await accessTo(db, view, me.membershipId);
    if (!view || !access) throw viewNotFound();
    let row = view;
    const removed = await dashboardTileRepo.removeForView(db, view.id, me.membershipId);
    if (access === 'owner' && view.favourited) row = (await savedViewRepo.update(db, view.id, { favourited: false }))!;
    if (removed > 0) await recordEvent(db, me, ctx.correlationId, { event: 'view_unfavourited', resource: { type: 'view', id: view.id } });
    return viewOf(row, access);
  });
}

export interface DashboardTileView {
  tileId: string;
  grid: [number, number, number, number];
  view: SavedViewView;
  lastRun: { resultRef: string; ranAt: string } | null;
}

/** The member's dashboard: a tile whose view they may no longer see is removed, not shown (spec 37.6). */
export async function dashboard(deps: WorkspaceDeps, ctx: Context): Promise<DashboardTileView[]> {
  const me = member(ctx);
  const tiles = await inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const out: { tile: DashboardTile; view: SavedViewView }[] = [];
    for (const tile of await dashboardTileRepo.listForMember(db, me.membershipId)) {
      if (tile.savedViewId === null) continue;
      const view = await savedViewRepo.findById(db, tile.savedViewId);
      const access = view && view.archivedAt === null ? await accessTo(db, view, me.membershipId) : undefined;
      if (!view || !access) {
        await dashboardTileRepo.remove(db, tile.id);
        continue;
      }
      out.push({ tile, view: viewOf(view, access) });
    }
    return out;
  });
  const result: DashboardTileView[] = [];
  for (const { tile, view } of tiles) {
    const held = await deps.data.read(viewLastRunKeys, viewLastRunKeys.key(me.organisationId, { viewId: view.id }));
    result.push({ tileId: tile.id, grid: tile.grid as [number, number, number, number], view, lastRun: held ? { resultRef: held.resultRef, ranAt: held.ranAt } : null });
  }
  return result;
}

export async function moveTile(deps: WorkspaceDeps, ctx: Context, tileId: string, grid: [number, number, number, number])
  : Promise<{ tileId: string; grid: [number, number, number, number] }> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const tile = await dashboardTileRepo.findById(db, tileId);
    if (!tile || tile.membershipId !== me.membershipId) throw new AppError('not_found', 'no such tile', { code: 'workspace.tile_not_found' });
    const updated = (await dashboardTileRepo.update(db, tile.id, { grid }))!;
    return { tileId: updated.id, grid: updated.grid as [number, number, number, number] };
  });
}
