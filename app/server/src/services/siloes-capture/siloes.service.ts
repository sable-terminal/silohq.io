// The Silo lifecycle (spec 66.6, 66.10, 70.1): the organisation's switch, the Siloes page,
// Capture Siloes and their nominations, and retention for every Silo type.

import type { SiloView } from '../../contracts/siloes/siloes.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { organisationRepo } from '../../repos/iam/index.repo.ts';
import { siloObjectTypeRepo, siloRepo, transitionRepo } from '../../repos/siloes/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { demand, recordEvent } from '../warehouse-schema/warehouse.service.ts';
import {
  CAPTURE_STORE, cleared, ENABLE_DISCLOSURE, loadSilo, loadSiloView, open, person, readManifest, requireSiloes, siloesEnabled, siloView,
  type Context, type SiloesDeps,
} from './deps.service.ts';

const NOT_PERMITTED = 'siloes.not_permitted';

// ----------------------------------------------------------------------------- the switch

export async function getSetting(deps: SiloesDeps, ctx: Context): Promise<{ enabled: boolean; disclosure: string }> {
  const enabled = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => siloesEnabled(db, ctx.request.organisationId!), { readOnly: true });
  return { enabled, disclosure: ENABLE_DISCLOSURE };
}

/** silo.enable, super admin only. Off only once every Silo is disabled and purged (70.4). */
export async function setEnabled(deps: SiloesDeps, ctx: Context, enabled: boolean): Promise<{ enabled: boolean; disclosure: string }> {
  person(ctx);
  await demand(deps, ctx, 'silo.enable', NOT_PERMITTED);
  const organisationId = ctx.request.organisationId!;
  await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    if (await siloesEnabled(db, organisationId) === enabled) return;
    if (!enabled && (await siloRepo.list(db, false)).length > 0) {
      throw new AppError('conflict', 'every Silo must be disabled and purged before Siloes are switched off', { code: 'siloes.siloes_remaining' });
    }
    await organisationRepo.update(db, organisationId, { storageEnabled: enabled });
    await recordEvent(db, ctx.request, ctx.correlationId, {
      event: enabled ? 'silo_enabled' : 'silo_disabled', resource: { type: 'organisation', id: organisationId }, service: 'siloes-capture',
    });
  });
  return { enabled, disclosure: ENABLE_DISCLOSURE };
}

// ----------------------------------------------------------------------------- the Siloes page

export async function listSiloes(deps: SiloesDeps, ctx: Context, includeDisabled: boolean): Promise<{ siloes: SiloView[] }> {
  await requireSiloes(deps, ctx);
  await demand(deps, ctx, 'silo.manage', NOT_PERMITTED);
  const manifest = await readManifest(deps, ctx).catch(() => undefined);
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const out: SiloView[] = [];
    for (const silo of await siloRepo.list(db, includeDisabled)) out.push(await siloView(db, silo, manifest));
    return { siloes: out };
  }, { readOnly: true });
}

/** The Siloes page (66.9): each Silo, what it holds and when it last took data in, and the links between them and why. */
export async function getSiloesWeb(deps: SiloesDeps, ctx: Context) {
  await requireSiloes(deps, ctx);
  await demand(deps, ctx, 'silo.manage', NOT_PERMITTED);
  const manifest = await readManifest(deps, ctx).catch(() => undefined);
  const visible = new Set((manifest?.objectTypes ?? []).map((t) => t.id));
  const nodes = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const out = [];
    for (const silo of await siloRepo.list(db, false)) {
      const view = await siloView(db, silo, manifest);
      // An Import Silo holds the object types its objects are mapped to, through its source connection (66.5, 68.5).
      const mapped = silo.kind === 'import' && silo.sourceConnectionId !== null
        ? (manifest?.objectTypes ?? []).filter((t) => t.contributingObjects.some((c) => c.connectionId === silo.sourceConnectionId)).map((t) => t.id) : [];
      const heldTypeIds = [...new Set([...view.objectTypes.map((t) => t.objectTypeId), ...mapped])].filter((id) => visible.has(id)).sort();
      out.push({ ...view, heldTypeIds, lastUpdatedAt: await siloRepo.lastUpdatedOf(db, silo.id) });
    }
    return out;
  }, { readOnly: true });
  const links = [];
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = new Set(nodes[i]!.heldTypeIds);
      const b = new Set(nodes[j]!.heldTypeIds);
      const shared = [...a].filter((t) => b.has(t));
      const joined = (manifest?.linkTypes ?? []).filter((l) => l.status === 'active'
        && ((a.has(l.fromTypeId) && b.has(l.toTypeId)) || (a.has(l.toTypeId) && b.has(l.fromTypeId))));
      if (shared.length === 0 && joined.length === 0) continue;
      links.push({
        from: nodes[i]!.id, to: nodes[j]!.id,
        why: [...(shared.length > 0 ? ['same_type' as const] : []), ...(joined.length > 0 ? ['linked_types' as const] : [])],
        objectTypeIds: [...new Set([...shared, ...joined.flatMap((l) => [l.fromTypeId, l.toTypeId])])].sort(), linkTypeIds: joined.map((l) => l.id).sort(),
      });
    }
  }
  return { siloes: nodes, links, presentation: nodes.length >= 2 && links.length > 0 ? 'graph' as const : 'list' as const };
}

export async function getSilo(deps: SiloesDeps, ctx: Context, siloId: string): Promise<SiloView> {
  await requireSiloes(deps, ctx);
  await demand(deps, ctx, 'silo.manage', NOT_PERMITTED);
  return loadSiloView(deps, ctx, siloId);
}

// ----------------------------------------------------------------------------- Capture

export async function createCaptureSilo(deps: SiloesDeps, ctx: Context, input: { name: string; purpose: string; retentionDays: number })
  : Promise<SiloView> {
  await requireSiloes(deps, ctx);
  const creator = person(ctx);
  await demand(deps, ctx, 'silo.create', NOT_PERMITTED);
  const organisationId = ctx.request.organisationId!;
  const id = uuidv7();
  await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    // The organisation's Capture partitions exist before the first transition can.
    await transitionRepo.ensurePartitions(db, organisationId);
    await siloRepo.insert(db, {
      id, organisationId, kind: 'capture', name: input.name, purpose: input.purpose, retentionDays: input.retentionDays,
      location: deps.location, status: 'active', storeRef: CAPTURE_STORE, createdBy: creator,
    });
    await recordEvent(db, ctx.request, ctx.correlationId, {
      event: 'silo_created', resource: { type: 'silo', id }, detail: { kind: 'capture', retention_days: input.retentionDays }, service: 'siloes-capture',
    });
  }).catch(nameTaken);
  return loadSiloView(deps, ctx, id);
}

export function nameTaken(error: unknown): never {
  if (error instanceof AppError && error.details['sqlstate'] === '23505') {
    throw new AppError('conflict', 'a live Silo already has that name', { code: 'siloes.name_taken' });
  }
  throw error;
}

export async function addCaptureType(deps: SiloesDeps, ctx: Context, siloId: string, input: { objectTypeId: string; properties: string[] })
  : Promise<SiloView> {
  await requireSiloes(deps, ctx);
  const adder = person(ctx);
  await demand(deps, ctx, 'silo.manage', NOT_PERMITTED);
  const pool = deps.databases.pool('control');
  const silo = await inTransaction(pool, ctx.request, async (db) => open(await loadSilo(db, siloId, 'capture')), { readOnly: true });
  await cleared(deps, ctx, await readManifest(deps, ctx), input.objectTypeId, input.properties);
  await inTransaction(pool, ctx.request, async (db) => {
    // Nothing cascades: this type alone, however connected it is (66.6).
    await siloObjectTypeRepo.insert(db, {
      id: uuidv7(), organisationId: silo.organisationId, siloId, objectTypeId: input.objectTypeId, nominatedProperties: input.properties, addedBy: adder,
    });
    await recordEvent(db, ctx.request, ctx.correlationId, {
      event: 'silo_concept_added', resource: { type: 'silo', id: siloId },
      detail: { object_type_id: input.objectTypeId, properties: input.properties.join(',') }, service: 'siloes-capture',
    });
  }).catch((error: unknown) => {
    if (error instanceof AppError && error.details['sqlstate'] === '23505') {
      throw new AppError('conflict', 'that object type is already in this Silo', { code: 'siloes.type_present' });
    }
    throw error;
  });
  return loadSiloView(deps, ctx, siloId);
}

export async function changeCaptureProperties(deps: SiloesDeps, ctx: Context, siloId: string, objectTypeId: string, properties: string[])
  : Promise<SiloView> {
  await requireSiloes(deps, ctx);
  person(ctx);
  await demand(deps, ctx, 'silo.manage', NOT_PERMITTED);
  const pool = deps.databases.pool('control');
  await inTransaction(pool, ctx.request, async (db) => open(await loadSilo(db, siloId, 'capture')), { readOnly: true });
  await cleared(deps, ctx, await readManifest(deps, ctx), objectTypeId, properties);
  await inTransaction(pool, ctx.request, async (db) => {
    const before = await siloObjectTypeRepo.findLive(db, siloId, objectTypeId);
    if (before === undefined) throw new AppError('not_found', 'that object type is not in this Silo', { code: 'siloes.type_absent' });
    await siloObjectTypeRepo.update(db, before.id, { nominatedProperties: properties });
    await recordEvent(db, ctx.request, ctx.correlationId, {
      event: 'silo_fields_changed', resource: { type: 'silo', id: siloId },
      detail: { object_type_id: objectTypeId, previous: before.nominatedProperties.join(','), current: properties.join(',') }, service: 'siloes-capture',
    });
  });
  return loadSiloView(deps, ctx, siloId);
}

/** Stops capturing a type. What was captured stays until retention or a purge removes it. */
export async function removeCaptureType(deps: SiloesDeps, ctx: Context, siloId: string, objectTypeId: string): Promise<SiloView> {
  await requireSiloes(deps, ctx);
  person(ctx);
  await demand(deps, ctx, 'silo.manage', NOT_PERMITTED);
  await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    await loadSilo(db, siloId, 'capture');
    const before = await siloObjectTypeRepo.findLive(db, siloId, objectTypeId);
    if (before === undefined) throw new AppError('not_found', 'that object type is not in this Silo', { code: 'siloes.type_absent' });
    await siloObjectTypeRepo.update(db, before.id, { removedAt: new Date(deps.now()).toISOString() });
    await recordEvent(db, ctx.request, ctx.correlationId, {
      event: 'silo_concept_removed', resource: { type: 'silo', id: siloId }, detail: { object_type_id: objectTypeId }, service: 'siloes-capture',
    });
  });
  return loadSiloView(deps, ctx, siloId);
}

// ----------------------------------------------------------------------------- retention

/** Shortening destroys data, so it needs silo.purge; lengthening needs silo.manage (70.1). */
export async function changeRetention(deps: SiloesDeps, ctx: Context, siloId: string, retentionDays: number): Promise<SiloView> {
  await requireSiloes(deps, ctx);
  person(ctx);
  const pool = deps.databases.pool('control');
  const silo = await inTransaction(pool, ctx.request, async (db) => open(await loadSilo(db, siloId)), { readOnly: true });
  if (retentionDays === silo.retentionDays) return loadSiloView(deps, ctx, siloId);
  await demand(deps, ctx, retentionDays < silo.retentionDays ? 'silo.purge' : 'silo.manage', NOT_PERMITTED);
  await inTransaction(pool, ctx.request, async (db) => {
    await siloRepo.update(db, siloId, { retentionDays });
    // Read first by a reviewer: shortening a window destroys data.
    await recordEvent(db, ctx.request, ctx.correlationId, {
      event: 'retention_changed', resource: { type: 'silo', id: siloId },
      detail: { previous_days: silo.retentionDays, new_days: retentionDays }, service: 'siloes-capture',
    });
  });
  return loadSiloView(deps, ctx, siloId);
}
