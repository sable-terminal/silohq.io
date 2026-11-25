// Object view layouts (spec 34.6): creating a custom layout's draft, and reading the layout a
// type's object view opens with. Review and approval are the app lifecycle's own
// (apps.service.ts): approving a layout version makes it the type's one active layout.
//
// Reading re-checks an active custom layout against main when the ontology has moved since
// it was last checked. One that no longer validates is marked invalid, with the event and a
// notification to its author, and the generated default is used: a broken layout never
// renders partially. One that still validates is stamped with main's version.

import type { AppVersionView, AppView } from '../../contracts/studio/app.contract.ts';
import { appDefinition } from '../../contracts/studio/definition.contract.ts';
import type { listObjectViewLayouts, ObjectViewLayoutView } from '../../contracts/studio/layout.contract.ts';
import type { z } from 'zod';
import { raiseNotification } from '../../contracts/notify/notification.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { appVersionRepo, objectViewLayoutRepo } from '../../repos/workspace/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { check, insertApp } from './apps.service.ts';
import { demand, mainManifest, member, recordServiceEvent, type Context, type StudioDeps } from './deps.service.ts';
import { generatedLayout, layoutDefinition, layoutFindings } from './layoutRules.service.ts';
import { renderFor } from './runtime.service.ts';

const WITHHELD = 'Part of this layout is not visible to you, so it is not shown.';

export async function createLayout(deps: StudioDeps, ctx: Context, input: {
  objectTypeId: string; name?: string | undefined; definition?: Record<string, unknown> | undefined; generatedBy?: 'ai_fde' | undefined;
}): Promise<{ app: AppView; draft: AppVersionView }> {
  const me = member(ctx);
  if (input.generatedBy !== undefined && ctx.caller !== 'fde-orchestrator') {
    throw new AppError('forbidden', 'only an accepted AI FDE proposal is marked as generated', { code: 'studio.generated_by_fde_only' });
  }
  await demand(deps, ctx, { permission: 'app.create' });
  const manifest = await mainManifest(deps, ctx);
  const type = manifest.objectTypes.find((t) => t.id === input.objectTypeId && t.status === 'active');
  if (type === undefined) throw new AppError('validation', 'a layout is for an active object type', { code: 'studio.layout_type' });
  return insertApp(deps, ctx, me, {
    name: input.name ?? `${type.displayName} layout`.slice(0, 200), requireFullClearance: false, generatedBy: input.generatedBy,
    definition: input.definition ?? layoutDefinition(type, manifest) as Record<string, unknown>, kind: 'object_view_layout', layoutFor: type.id,
  });
}

/** The custom layouts in force or broken and not yet replaced (ontology.view): metadata only. */
export async function listLayouts(deps: StudioDeps, ctx: Context): Promise<z.infer<typeof listObjectViewLayouts.response>> {
  await demand(deps, ctx, { permission: 'ontology.view' });
  const rows = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => objectViewLayoutRepo.customInForce(db), { readOnly: true });
  return {
    layouts: rows.map((r) => ({
      id: r.id, objectTypeId: r.objectTypeId, appId: r.appId, version: Number(r.version), status: r.status as 'active' | 'invalid',
      createdBy: r.createdBy, createdAt: r.createdAt, updatedAt: r.updatedAt,
    })),
  };
}

export async function getLayout(deps: StudioDeps, ctx: Context, objectTypeId: string): Promise<ObjectViewLayoutView> {
  await demand(deps, ctx, { permission: 'ontology.view' });
  const manifest = await mainManifest(deps, ctx);
  const type = manifest.objectTypes.find((t) => t.id === objectTypeId);
  if (type === undefined) throw new AppError('not_found', 'no such object type', { code: 'studio.layout_type' });
  const generated = (): ObjectViewLayoutView => ({ objectTypeId, generated: true, layout: generatedLayout(type, manifest), custom: null });

  const pool = deps.databases.pool('control');
  const found = await inTransaction(pool, ctx.request, async (db) => {
    const row = await objectViewLayoutRepo.activeFor(db, objectTypeId);
    const version = row?.appVersionId == null ? undefined : await appVersionRepo.findById(db, row.appVersionId);
    return row === undefined || version === undefined ? undefined : { row, version };
  }, { readOnly: true });
  if (found === undefined) return generated();
  const { row, version } = found;
  const definition = version.definition as Record<string, unknown>;
  const main = manifest.version.sequence;

  if (Number(row.ontologyVersion) !== main) {
    const checked = await check(deps, ctx, { ...definition, ontologyVersion: main });
    const findings = [...checked.findings, ...layoutFindings(definition, objectTypeId)];
    const invalid = findings.length > 0;
    const marked = await inTransaction(pool, ctx.request, async (db) => {
      const locked = await objectViewLayoutRepo.activeFor(db, objectTypeId, true);
      if (locked?.id !== row.id) return false;
      if (!invalid) {
        await objectViewLayoutRepo.update(db, row.id, { ontologyVersion: String(main) });
        return false;
      }
      await objectViewLayoutRepo.update(db, row.id, { status: 'invalid' });
      await recordServiceEvent(db, row.organisationId, ctx.correlationId, {
        event: 'object_view_layout_invalidated', resource: { type: 'object_view_layout', id: row.id }, subjectMembershipId: row.createdBy,
        detail: { object_type_id: objectTypeId, app_id: version.appId, version: version.version, ontology_version: main, findings: findings.length,
          codes: [...new Set(findings.map((f) => f.code))].slice(0, 10).join(',') },
      });
      return true;
    });
    if (invalid) {
      if (marked && row.createdBy !== null) {
        // The invalidation stands, and is audited, if the author cannot be told now: the read is not refused for it.
        await deps.services.call(raiseNotification, {
          body: { recipientMembershipId: row.createdBy, kind: 'object_view_layout_invalidated', source: { objectViewLayoutId: row.id } },
        }, { request: { organisationId: row.organisationId }, correlationId: ctx.correlationId }).catch((error: unknown) => {
          deps.logger.failure('the author of an invalidated layout could not be told', error, {
            event: 'studio.layout_notify_failed', organisationId: row.organisationId, resourceId: row.id,
          });
        });
      }
      return generated();
    }
  }

  const parsed = appDefinition.safeParse({ ...definition, ontologyVersion: main });
  if (!parsed.success) return generated();
  const rendered = await renderFor(deps, ctx, parsed.data, version.markings, false);
  // A viewer who may not see what the layout is built on gets the generated default, which policy reduces itself.
  if (rendered === undefined) return generated();
  return {
    objectTypeId, generated: false, layout: null,
    custom: {
      layoutId: row.id, appId: version.appId, version: version.version, definition: { ...parsed.data, pages: rendered.pages } as never,
      widgets: rendered.widgets, withheld: rendered.withheld, statement: rendered.reduced ? WITHHELD : null,
    },
  };
}
