// The render layer's record (spec 31.4, 31.9, 29.2): which archetype or layout the client
// chose for a result, what it offered beside it, and any override; and each person's
// preferred representation per view. Decisions about presentation, never results.
//
// Checked here: the floor is always offered (table for a view, list for a canvas), the
// choice is not offered twice, and an override names a layout that was offered. The
// override, with the structure and both choices, is the only feedback that shows
// precedence is wrong, so it is audited in the standard class; plain selections are
// high-volume telemetry.

import type { Archetype, CanvasLayout } from '../../contracts/canvas-layout/layout.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { canvasViewRepo, renderSelectionRepo, viewPreferenceRepo } from '../../repos/clone/index.repo.ts';
import { savedViewRepo } from '../../repos/workspace/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { accessTo as savedViewAccess } from '../workspace/sharing.service.ts';
import { accessTo as canvasViewAccess } from './canvasViews.service.ts';
import { member, notFound, recordEvent, type CanvasDeps, type Context } from './deps.service.ts';

export type Selection =
  | { surface: 'view'; resultRef: string; resultStructure: Record<string, number | boolean>; chosen: Archetype; alternativesOffered: Archetype[]; overriddenTo?: Archetype | undefined }
  | { surface: 'canvas'; resultRef: string; resultStructure: Record<string, number | boolean>; chosen: CanvasLayout; alternativesOffered: CanvasLayout[]; overriddenTo?: CanvasLayout | undefined };

export async function record(deps: CanvasDeps, ctx: Context, input: Selection): Promise<{ id: string; recordedAt: string; userOverride: boolean }> {
  const me = member(ctx);
  const offered = new Set<string>(input.alternativesOffered);
  if (offered.has(input.chosen)) throw new AppError('validation', 'the chosen one is not also an alternative', { code: 'render.chosen_offered' });
  const floor = input.surface === 'view' ? 'table' : 'list';
  if (input.chosen !== floor && !offered.has(floor)) {
    throw new AppError('validation', `the floor (${floor}) renders any result and is always offered`, { code: 'render.floor_missing' });
  }
  if (input.overriddenTo !== undefined && !offered.has(input.overriddenTo)) {
    throw new AppError('validation', 'an override names an alternative that was offered', { code: 'render.override_not_offered' });
  }
  const userOverride = input.overriddenTo !== undefined;
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const row = await renderSelectionRepo.insert(db, {
      id: uuidv7(), organisationId: me.organisationId, resultRef: input.resultRef, resultStructure: input.resultStructure, surface: input.surface,
      chosen: input.chosen, alternativesOffered: [...offered].sort(), userOverride, overriddenTo: input.overriddenTo ?? null, membershipId: me.membershipId,
    });
    const resource = { type: 'result', id: input.resultRef };
    const structure = Object.fromEntries(Object.entries(input.resultStructure).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), v]));
    await recordEvent(db, me, ctx.correlationId, {
      event: input.surface === 'view' ? 'archetype_selected' : 'layout_selected', resource,
      detail: { chosen: input.chosen, alternatives: offered.size },
    });
    if (userOverride) {
      await recordEvent(db, me, ctx.correlationId, {
        event: input.surface === 'view' ? 'archetype_overridden' : 'layout_overridden', resource,
        detail: { chosen: input.chosen, overridden_to: input.overriddenTo!, ...structure },
      });
    }
    return { id: row.id, recordedAt: row.recordedAt, userOverride };
  });
}

/** The member's own preferred representation of a view they may open (31.2); null where they have set none. */
export async function readPreference(deps: CanvasDeps, ctx: Context, input: { savedViewId?: string | undefined; canvasViewId?: string | undefined })
  : Promise<{ preferredRepresentation: 'prose' | 'view' | 'data' | 'canvas' | 'list' | null; updatedAt: string | null }> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    // As for setting one: only a view the member may open, so a read never confirms a view exists.
    if (input.savedViewId !== undefined) {
      const view = await savedViewRepo.findById(db, input.savedViewId);
      if (!view || await savedViewAccess(db, view, me.membershipId) === undefined) throw notFound('view', 'render.view_not_found');
    } else {
      const view = await canvasViewRepo.findById(db, input.canvasViewId!);
      if (!view || view.deletedAt !== null || await canvasViewAccess(db, view, me.membershipId) === undefined) throw notFound('view', 'render.view_not_found');
    }
    const row = await viewPreferenceRepo.readFor(db, me.membershipId, input.savedViewId !== undefined ? { savedViewId: input.savedViewId } : { canvasViewId: input.canvasViewId! });
    return row === undefined ? { preferredRepresentation: null, updatedAt: null }
      : { preferredRepresentation: row.preferredRepresentation as 'prose' | 'view' | 'data' | 'canvas' | 'list', updatedAt: row.updatedAt };
  }, { readOnly: true });
}

export async function setPreference(deps: CanvasDeps, ctx: Context, input:
  | { savedViewId: string; preferredRepresentation: 'prose' | 'view' | 'data' }
  | { canvasViewId: string; preferredRepresentation: 'canvas' | 'list' }): Promise<{ preferredRepresentation: 'prose' | 'view' | 'data' | 'canvas' | 'list'; updatedAt: string }> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    // Only a view the member may open: a preference never confirms a view exists.
    if ('savedViewId' in input) {
      const view = await savedViewRepo.findById(db, input.savedViewId);
      if (!view || await savedViewAccess(db, view, me.membershipId) === undefined) throw notFound('view', 'render.view_not_found');
    } else {
      const view = await canvasViewRepo.findById(db, input.canvasViewId);
      if (!view || view.deletedAt !== null || await canvasViewAccess(db, view, me.membershipId) === undefined) throw notFound('view', 'render.view_not_found');
    }
    const key = 'savedViewId' in input ? { savedViewId: input.savedViewId } : { canvasViewId: input.canvasViewId };
    const existing = await viewPreferenceRepo.findFor(db, me.membershipId, key);
    const row = existing
      ? (await viewPreferenceRepo.update(db, existing.id, { preferredRepresentation: input.preferredRepresentation }))!
      : await viewPreferenceRepo.insert(db, {
        id: uuidv7(), organisationId: me.organisationId, membershipId: me.membershipId, preferredRepresentation: input.preferredRepresentation,
        savedViewId: 'savedViewId' in input ? input.savedViewId : null, canvasViewId: 'canvasViewId' in input ? input.canvasViewId : null,
      });
    if (existing?.preferredRepresentation !== input.preferredRepresentation) {
      await recordEvent(db, me, ctx.correlationId, {
        event: 'representation_switched', resource: { type: 'savedViewId' in input ? 'view' : 'canvas_view', id: 'savedViewId' in input ? input.savedViewId : input.canvasViewId },
        detail: { from: existing?.preferredRepresentation ?? null, to: input.preferredRepresentation },
      });
    }
    return { preferredRepresentation: row.preferredRepresentation as 'prose' | 'view' | 'data' | 'canvas' | 'list', updatedAt: row.updatedAt };
  });
}
