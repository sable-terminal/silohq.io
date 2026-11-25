// The workspace shell (spec 33): a person's preferences and Home marker, favourites, and
// the organisation's terminology skins.

import { listHeldPermissions } from '../../contracts/policy/decision.contract.ts';
import { getSiloesSetting } from '../../contracts/siloes/siloes.contract.ts';
import { RAIL_ENTRY, RAIL_ITEMS, type RailItem } from '../../contracts/workspace/shell.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { Favourite } from '../../models/workspace/favourite.model.ts';
import type { TerminologySkin } from '../../models/workspace/terminologySkin.model.ts';
import type { WorkspacePreference } from '../../models/workspace/workspacePreference.model.ts';
import { favouriteRepo, terminologySkinRepo, workspacePreferenceRepo } from '../../repos/workspace/index.repo.ts';
import { AppError, fromDatabaseError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { demand, member, recordEvent, type Context, type WorkspaceDeps } from './deps.service.ts';

export interface PreferencesView { railCollapsed: boolean; askPanelOpen: boolean; lastHomeSeenAt: string | null }

const preferencesOf = (row: WorkspacePreference | undefined): PreferencesView => ({
  railCollapsed: row?.railCollapsed ?? false, askPanelOpen: row?.askPanelOpen ?? false, lastHomeSeenAt: row?.lastHomeSeenAt ?? null,
});

export async function preferences(deps: WorkspaceDeps, ctx: Context): Promise<PreferencesView> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) =>
    preferencesOf(await workspacePreferenceRepo.findByKey(db, { organisationId: me.organisationId, membershipId: me.membershipId })), { readOnly: true });
}

export async function updatePreferences(deps: WorkspaceDeps, ctx: Context, changes: { railCollapsed?: boolean | undefined; askPanelOpen?: boolean | undefined })
  : Promise<PreferencesView> {
  const me = member(ctx);
  const set = {
    ...(changes.railCollapsed === undefined ? {} : { railCollapsed: changes.railCollapsed }),
    ...(changes.askPanelOpen === undefined ? {} : { askPanelOpen: changes.askPanelOpen }),
  };
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const key = { organisationId: me.organisationId, membershipId: me.membershipId };
    const existing = await workspacePreferenceRepo.findByKey(db, key);
    if (!existing) return preferencesOf(await workspacePreferenceRepo.insert(db, { ...key, ...set }));
    if (Object.keys(set).length === 0) return preferencesOf(existing);
    return preferencesOf(await workspacePreferenceRepo.update(db, key, set));
  });
}

/** The briefing was rendered: the next one starts after what was shown (design: last_home_seen_at). */
export async function markHomeSeen(deps: WorkspaceDeps, ctx: Context): Promise<{ previous: string | null; seenAt: string }> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const key = { organisationId: me.organisationId, membershipId: me.membershipId };
    const existing = await workspacePreferenceRepo.findByKey(db, key);
    const seenAt = new Date().toISOString();
    const row = existing ? await workspacePreferenceRepo.update(db, key, { lastHomeSeenAt: seenAt })
      : await workspacePreferenceRepo.insert(db, { ...key, lastHomeSeenAt: seenAt });
    return { previous: existing?.lastHomeSeenAt ?? null, seenAt: row!.lastHomeSeenAt! };
  });
}

export interface RailView {
  items: { item: RailItem; available: boolean; needs: { class: string; permissions: string[] } | null }[];
}

/** The rail as this person may use it (spec 33.3): one decision for every entry permission, and whether a Silo is enabled. */
export async function rail(deps: WorkspaceDeps, ctx: Context): Promise<RailView> {
  member(ctx);
  const options = { request: ctx.request, correlationId: ctx.correlationId };
  const asked = [...new Set(RAIL_ITEMS.flatMap((item) => RAIL_ENTRY[item]?.permissions ?? []))];
  const [{ held }, siloes] = await Promise.all([
    deps.services.call(listHeldPermissions, { body: { permissions: asked } }, options),
    deps.services.call(getSiloesSetting, {}, options),
  ]);
  const holds = new Set(held);
  return {
    items: RAIL_ITEMS.filter((item) => item !== 'siloes' || siloes.enabled).map((item) => {
      const entry = RAIL_ENTRY[item];
      const available = entry === null || entry.permissions.some((p) => holds.has(p));
      return { item, available, needs: available || entry === null ? null : { class: entry.class, permissions: [...entry.permissions] } };
    }),
  };
}

export type FavouriteTarget =
  | { kind: 'object'; objectTypeId: string; objectRef: string }
  | { kind: 'app'; appId: string }
  | { kind: 'scenario'; scenarioId: string };

export interface FavouriteView { id: string; target: FavouriteTarget; position: number; createdAt: string }

function favouriteOf(row: Favourite): FavouriteView {
  const target: FavouriteTarget = row.objectRef !== null ? { kind: 'object', objectTypeId: row.objectTypeId!, objectRef: row.objectRef }
    : row.appId !== null ? { kind: 'app', appId: row.appId } : { kind: 'scenario', scenarioId: row.scenarioId! };
  return { id: row.id, target, position: row.position, createdAt: row.createdAt };
}

export async function favourites(deps: WorkspaceDeps, ctx: Context): Promise<FavouriteView[]> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) =>
    (await favouriteRepo.listForMember(db, me.membershipId)).map(favouriteOf), { readOnly: true });
}

/** A reference only, never values (33.10). The element must exist in this organisation, or the key refuses it. */
export async function addFavourite(deps: WorkspaceDeps, ctx: Context, target: FavouriteTarget): Promise<FavouriteView> {
  const me = member(ctx);
  try {
    return await inTransaction(deps.databases.pool('control'), me.request, async (db) => favouriteOf(await favouriteRepo.insert(db, {
      id: uuidv7(), organisationId: me.organisationId, membershipId: me.membershipId,
      objectTypeId: target.kind === 'object' ? target.objectTypeId : null, objectRef: target.kind === 'object' ? target.objectRef : null,
      appId: target.kind === 'app' ? target.appId : null, scenarioId: target.kind === 'scenario' ? target.scenarioId : null,
      position: await favouriteRepo.nextPosition(db, me.membershipId),
    })));
  } catch (error) {
    const mapped = fromDatabaseError(error);
    if (mapped.details['sqlstate'] === '23503') throw new AppError('not_found', 'no such item to favourite', { code: 'workspace.favourite_target_unknown' });
    if (mapped.details['sqlstate'] === '23505') throw new AppError('conflict', 'already a favourite', { code: 'workspace.favourite_exists' });
    throw mapped;
  }
}

export async function removeFavourite(deps: WorkspaceDeps, ctx: Context, favouriteId: string): Promise<{ removed: boolean }> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const row = await favouriteRepo.findById(db, favouriteId);
    if (!row || row.membershipId !== me.membershipId) return { removed: false };
    return { removed: await favouriteRepo.remove(db, row.id) };
  });
}

// ----------------------------------------------------------------------------- skins

export type SkinTarget =
  | { kind: 'object_type'; objectTypeId: string; stateValue?: string | undefined }
  | { kind: 'link_type'; linkTypeId: string }
  | { kind: 'action_type'; actionTypeId: string };

export interface SkinView {
  id: string;
  target: SkinTarget;
  labelSingular: string;
  labelPlural: string | null;
  setBy: string;
  setAt: string;
  supersededAt: string | null;
}

function skinOf(row: TerminologySkin): SkinView {
  const target: SkinTarget = row.objectTypeId !== null
    ? { kind: 'object_type', objectTypeId: row.objectTypeId, ...(row.stateValue === null ? {} : { stateValue: row.stateValue }) }
    : row.linkTypeId !== null ? { kind: 'link_type', linkTypeId: row.linkTypeId } : { kind: 'action_type', actionTypeId: row.actionTypeId! };
  return { id: row.id, target, labelSingular: row.labelSingular, labelPlural: row.labelPlural, setBy: row.setBy, setAt: row.setAt, supersededAt: row.supersededAt };
}

export async function skins(deps: WorkspaceDeps, ctx: Context): Promise<SkinView[]> {
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => (await terminologySkinRepo.listLive(db)).map(skinOf), { readOnly: true });
}

/** Sets the live label, superseding the previous one in the same transaction; never updated in place (33.8). */
export async function setSkin(deps: WorkspaceDeps, ctx: Context, input: { target: SkinTarget; labelSingular: string; labelPlural?: string | undefined })
  : Promise<SkinView> {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'org.terminology.manage', organisationWide: true });
  const t = input.target;
  const key = {
    ...(t.kind === 'object_type' ? { objectTypeId: t.objectTypeId, ...(t.stateValue === undefined ? {} : { stateValue: t.stateValue }) } : {}),
    ...(t.kind === 'link_type' ? { linkTypeId: t.linkTypeId } : {}),
    ...(t.kind === 'action_type' ? { actionTypeId: t.actionTypeId } : {}),
  };
  try {
    return await inTransaction(deps.databases.pool('control'), me.request, async (db) => {
      const now = new Date().toISOString();
      const live = await terminologySkinRepo.findLiveFor(db, key);
      if (live) {
        await terminologySkinRepo.update(db, live.id, { supersededAt: now });
        await recordEvent(db, me, ctx.correlationId, { event: 'terminology_skin_superseded', resource: { type: 'terminology_skin', id: live.id } });
      }
      const row = await terminologySkinRepo.insert(db, {
        id: uuidv7(), organisationId: me.organisationId, objectTypeId: key.objectTypeId ?? null, stateValue: key.stateValue ?? null,
        linkTypeId: key.linkTypeId ?? null, actionTypeId: key.actionTypeId ?? null, labelSingular: input.labelSingular,
        labelPlural: input.labelPlural ?? null, setBy: me.membershipId,
      });
      // The event a reviewer reads first: it names the element by id beside the new label's id (33.11).
      await recordEvent(db, me, ctx.correlationId, {
        event: 'terminology_skin_set', resource: { type: 'terminology_skin', id: row.id },
        detail: { target_kind: t.kind, target_id: key.objectTypeId ?? key.linkTypeId ?? key.actionTypeId ?? null, state_value: key.stateValue !== undefined },
      });
      return skinOf(row);
    });
  } catch (error) {
    const mapped = fromDatabaseError(error);
    if (mapped.details['sqlstate'] === '23503') throw new AppError('not_found', 'no such ontology element', { code: 'workspace.skin_target_unknown' });
    throw mapped;
  }
}

export async function supersedeSkin(deps: WorkspaceDeps, ctx: Context, skinId: string): Promise<SkinView> {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'org.terminology.manage', organisationWide: true });
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const row = await terminologySkinRepo.findById(db, skinId);
    if (!row) throw new AppError('not_found', 'no such skin', { code: 'workspace.skin_not_found' });
    if (row.supersededAt !== null) return skinOf(row);
    const updated = (await terminologySkinRepo.update(db, row.id, { supersededAt: new Date().toISOString() }))!;
    await recordEvent(db, me, ctx.correlationId, { event: 'terminology_skin_superseded', resource: { type: 'terminology_skin', id: row.id } });
    return skinOf(updated);
  });
}
