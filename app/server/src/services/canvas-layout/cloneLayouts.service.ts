// Clone layouts (spec 29.2, 32.6): per object type, the properties that drive each canvas
// layout. Checked against main's head: every property is an active property of the type, of
// a type the layout can use (a Located property is a geopoint or geoshape, a time property
// a date or timestamp), and the containment link has the type at one end. A change
// supersedes the live row, never edits it; ontology.manage on the type decides it.

import type { CloneLayoutView } from '../../contracts/canvas-layout/layout.contract.ts';
import type { ObjectTypeView, OntologyManifest } from '../../contracts/ontology/manifest.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { CloneLayout } from '../../models/clone/cloneLayout.model.ts';
import { cloneLayoutRepo } from '../../repos/clone/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { actor, demand, mainManifest, member, recordEvent, type CanvasDeps, type Context } from './deps.service.ts';

export interface LayoutInput {
  labelPropertyId: string;
  geoPropertyId?: string | undefined;
  crs?: string | undefined;
  containmentLinkTypeId?: string | undefined;
  stagePropertyId?: string | undefined;
  timePropertyId?: string | undefined;
  lanePropertyId?: string | undefined;
}

export function layoutView(row: CloneLayout): CloneLayoutView {
  return {
    id: row.id, objectTypeId: row.objectTypeId, geoPropertyId: row.geoPropertyId, crs: row.crs, containmentLinkTypeId: row.containmentLinkTypeId,
    stagePropertyId: row.stagePropertyId, timePropertyId: row.timePropertyId, lanePropertyId: row.lanePropertyId,
    labelPropertyId: row.labelPropertyId, ontologyVersion: Number(row.ontologyVersion), createdBy: row.createdBy, createdAt: row.createdAt,
  };
}

const refuse = (message: string, field: string): AppError =>
  new AppError('validation', message, { code: 'clone.layout_invalid', details: { field } });

function property(type: ObjectTypeView, id: string, field: string, types?: readonly string[]): void {
  const found = type.properties.find((p) => p.identityId === id && p.status === 'active');
  if (!found) throw refuse('not an active property of the type', field);
  if (types !== undefined && !types.includes(found.dataType)) throw refuse(`must be a ${types.join(' or ')} property`, field);
}

/** The configuration checked against the manifest; refused naming the first field that does not fit. */
export function checkLayout(manifest: OntologyManifest, objectTypeId: string, input: LayoutInput): void {
  const type = manifest.objectTypes.find((t) => t.id === objectTypeId && t.status === 'active');
  if (!type) throw new AppError('validation', 'no such object type on main', { code: 'clone.object_type_unknown' });
  property(type, input.labelPropertyId, 'labelPropertyId');
  if (input.geoPropertyId !== undefined) property(type, input.geoPropertyId, 'geoPropertyId', ['geopoint', 'geoshape']);
  if (input.timePropertyId !== undefined) property(type, input.timePropertyId, 'timePropertyId', ['date', 'timestamp']);
  if (input.stagePropertyId !== undefined) property(type, input.stagePropertyId, 'stagePropertyId');
  if (input.lanePropertyId !== undefined) property(type, input.lanePropertyId, 'lanePropertyId');
  if (input.containmentLinkTypeId !== undefined) {
    const link = manifest.linkTypes.find((l) => l.id === input.containmentLinkTypeId && l.status === 'active');
    if (!link || (link.fromTypeId !== objectTypeId && link.toTypeId !== objectTypeId)) {
      throw refuse('the containment link must be an active link type with this type at one end', 'containmentLinkTypeId');
    }
    if (link.cardinality === 'many_to_many') throw refuse('containment gives each member at most one parent', 'containmentLinkTypeId');
  }
}

export async function set(deps: CanvasDeps, ctx: Context, objectTypeId: string, input: LayoutInput): Promise<CloneLayoutView> {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'ontology.manage', resource: { type: 'object_type', id: objectTypeId } });
  const manifest = await mainManifest(deps, ctx);
  checkLayout(manifest, objectTypeId, input);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const replaced = await cloneLayoutRepo.supersedeLive(db, objectTypeId, new Date().toISOString());
    const row = await cloneLayoutRepo.insert(db, {
      id: uuidv7(), organisationId: me.organisationId, objectTypeId, labelPropertyId: input.labelPropertyId,
      geoPropertyId: input.geoPropertyId ?? null, crs: input.crs ?? null, containmentLinkTypeId: input.containmentLinkTypeId ?? null,
      stagePropertyId: input.stagePropertyId ?? null, timePropertyId: input.timePropertyId ?? null, lanePropertyId: input.lanePropertyId ?? null,
      ontologyVersion: String(manifest.version.sequence), createdBy: me.membershipId,
    });
    await recordEvent(db, me, ctx.correlationId, {
      event: 'clone_layout_set', resource: { type: 'object_type', id: objectTypeId },
      detail: { replaced, located: input.geoPropertyId !== undefined, containment: input.containmentLinkTypeId !== undefined,
        timed: input.timePropertyId !== undefined, staged: input.stagePropertyId !== undefined },
    });
    return layoutView(row);
  });
}

export async function list(deps: CanvasDeps, ctx: Context, objectTypeIds: readonly string[]): Promise<CloneLayoutView[]> {
  const who = actor(ctx);
  const rows = await inTransaction(deps.databases.pool('control'), who.request, (db) => cloneLayoutRepo.liveFor(db, [...new Set(objectTypeIds)]),
    { readOnly: true });
  return rows.map(layoutView);
}
