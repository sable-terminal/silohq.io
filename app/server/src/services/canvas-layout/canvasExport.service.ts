// Exporting a canvas view (spec 29.10; contracts/canvas-layout/canvasView.contract.ts): the
// view opened for its exporter (their own access, never the owner's), its set run now as
// them, each object's state from the type's active rule, the layout computed as the canvas
// computes it, and a PDF drawn: printed with when it was computed, the state age of each
// source (from the answer's read times), its markings (those an export of its inputs
// carries), its flags (withheld elements, disputed values) and the count not placed. Files
// stores it under the Files rules: frozen permissions, provenance, lineage. A list layout
// prints as a table. The drawing is the canvas's own: laid out by canvasLayouts.service.ts, the
// module the web client lays out with, from the type's clone layout (stages, times and lanes,
// its Located property in its coordinate system, its containment link) and the links the
// layout follows, read as the exporter; a site plan prints under what it places, and a map
// without a base map says so. A PNG is the exporter's own browser's drawing (D225), of any layout
// it draws, 3D included, stamped here. A site plan or 3D model drawn in an export carries its own
// markings with the file, besides those its inputs carry (D228). A 3D view is not printed to PDF.

import { readResultPage, runObjectSet, type QueryResult, type ResultObject } from '../../contracts/executor/result.contract.ts';
import { createExport, previewExportMarkings, type FileView } from '../../contracts/files/file.contract.ts';
import type { NodeRef, Relation } from '../../contracts/lineage/lineage.contract.ts';
import { getManifest } from '../../contracts/ontology/manifest.contract.ts';
import type { QueryPlan } from '../../contracts/planner/plan.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { connectionRepo } from '../../repos/connect/index.repo.ts';
import { isAppError } from '../../utils/errors.util.ts';
import { exportDocument } from '../render/document.service.ts';
import { renderCanvasPdf, renderPdf, PDF_CONTENT_TYPE, type DrawnState } from '../render/pdf.service.ts';
import { pdfImageOf } from '../render/pdfImage.service.ts';
import { runPlan } from '../../contracts/executor/result.contract.ts';
import { layout as canvasLayout, type LayoutKind as CanvasKind } from './canvasLayouts.service.ts';
import * as cloneLayouts from './cloneLayouts.service.ts';
import { placeOnPlan, readableModel, readablePlan, readPlanImage, type SpatialDeps } from './spatial.service.ts';
import { open } from './canvasViews.service.ts';
import { member, recordEvent, type CanvasDeps, type Context } from './deps.service.ts';
import { compileStateRules, evaluateState, type InputState } from './stateEvaluation.service.ts';
import { active } from './stateRules.service.ts';

type Outcome =
  | { outcome: 'exported'; file: FileView; placed: number; notPlaced: number }
  | { outcome: 'refused'; code: string; reason: string };

/** What an image export prints (29.10), from the same run a PDF is drawn from: the markings by name and id, the sources' state age, the flags. */
export interface ExportStamp {
  outcome: 'stamp';
  markings: { id: string; name: string }[];
  computedAt: string;
  sources: { id: string; name: string; age: string }[];
  flags: string[];
}

/** PNG (D88): the renderer's image in place of the drawing, filed as a PDF is. */
/** The exporter's browser's image (D225), filed only if its inputs carry no marking beyond those it was told to print. */
export interface RenderedImage { png: Buffer; jobId: string; printedMarkingIds: readonly string[] }

const DRAWN: Readonly<Record<string, CanvasKind>> = {
  schematic: 'schematic', graph_force: 'graph_force', graph_layered: 'graph_layered', hierarchy: 'hierarchy', timeline: 'timeline', spatial_map: 'spatial_map',
};

const age = (from: number, to: number): string => {
  const seconds = Math.max(0, Math.round((to - from) / 1000));
  return seconds < 120 ? `${seconds}s` : seconds < 7200 ? `${Math.round(seconds / 60)}m` : `${Math.round(seconds / 3600)}h`;
};

export async function exportCanvas(deps: SpatialDeps, ctx: Context & { idempotencyKey?: string | undefined }, canvasViewId: string,
  input: {
    format: 'pdf' | 'png'; folderId?: string | undefined; rendered?: RenderedImage | undefined; stampOnly?: true;
    /** An image's: the plan or model the browser drew besides the set. */
    drawn?: { planId?: string | undefined; assetModelId?: string | undefined } | undefined;
  }): Promise<Outcome | ExportStamp> {
  const me = member(ctx);
  const options = { request: ctx.request, correlationId: ctx.correlationId };
  const opened = await open(deps, ctx, canvasViewId);
  const view = opened.view;
  if (view.objectSetId === null || opened.objectTypeId === null) {
    return { outcome: 'refused', code: 'canvas.export_needs_set', reason: 'only a canvas over an object set you may see is exported' };
  }
  const drawn = DRAWN[view.layoutKind];
  if (drawn === undefined && view.layoutKind !== 'list' && input.rendered === undefined && input.stampOnly === undefined) {
    return { outcome: 'refused', code: 'canvas.export_layout_unsupported', reason: `a ${view.layoutKind} canvas is not exported yet` };
  }

  // The set, now, as the exporter: the type's title and the rule's inputs, among what they may see.
  const manifest = await deps.services.call(getManifest, { query: {} }, options);
  const type = manifest.objectTypes.find((t) => t.id === opened.objectTypeId)!;
  const [rule] = await active(deps, ctx, [type.id]);
  const visible = new Set(opened.visibleProperties.map((p) => p.id));
  // The clone layout's properties, among those the exporter may see: what the canvas lays out by.
  const [config] = await cloneLayouts.list(deps, ctx, [type.id]);
  const apiOf = (identity: string | null | undefined) => (identity == null || !visible.has(identity) ? undefined : type.properties.find((p) => p.identityId === identity)?.apiName);
  const by = {
    label: apiOf(config?.labelPropertyId) ?? apiOf(type.titlePropertyIdentityId), stage: apiOf(config?.stagePropertyId), time: apiOf(config?.timePropertyId),
    lane: apiOf(config?.lanePropertyId), geo: apiOf(config?.geoPropertyId),
  };
  const wanted = [type.titlePropertyIdentityId, config?.labelPropertyId, config?.stagePropertyId, config?.timePropertyId, config?.lanePropertyId, config?.geoPropertyId,
    ...(rule?.inputs.map((i) => i.propertyIdentityId) ?? [])].filter((id): id is string => typeof id === 'string' && visible.has(id));
  const out = await deps.services.call(runObjectSet, { body: { objectSetId: view.objectSetId, select: [...new Set(wanted)], trigger: 'saved_view_run', useCache: true } }, options);
  if (out.outcome === 'refusal') return { outcome: 'refused', code: out.refusal.code, reason: out.refusal.reason };
  const result = out.result;
  const objects: ResultObject[] = [...result.page.objects];
  for (let page = 1; page < result.page.count; page++) {
    objects.push(...(await deps.services.call(readResultPage, { params: { queryId: result.queryId, page } }, options)).objects);
  }

  // States: the active rule over each object's values, at the time the answer was computed.
  const compiled = rule === undefined ? undefined : compileStateRules(rule.inputs, rule.rules, rule.freshnessWindowSeconds);
  const at = new Date(result.computedAt);
  const stateOf = (o: ResultObject): DrawnState => {
    if (compiled === undefined || !('compiled' in compiled)) return 'normal';
    const inputs: Record<string, InputState> = Object.fromEntries(compiled.compiled.inputs.map((i) => [i.propertyIdentityId, {
      value: o.values[i.apiName] ?? null, visible: visible.has(i.propertyIdentityId) && !o.masked.includes(i.apiName) && !o.redacted.includes(i.apiName),
    }]));
    return evaluateState(compiled.compiled, inputs, at).state;
  };
  const shown = objects.map((o) => ({ o, state: stateOf(o) })).filter((x) => view.stateFilter.length === 0 || view.stateFilter.includes(x.state));
  const label = (o: ResultObject): string => {
    const value = by.label === undefined ? undefined : o.values[by.label];
    return value === null || value === undefined ? o.id.slice(0, 8) : String(value);
  };

  // What travels with it: markings, sources and their age, flags.
  const sourceIds = [...new Set(result.lineage.flatMap((l) => l.sources.map((s) => s.connectionId)))];
  const names = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) =>
    new Map(await Promise.all(sourceIds.map(async (id) => [id, (await connectionRepo.findById(db, id))?.name ?? id] as const))), { readOnly: true });
  const computed = Date.parse(result.computedAt);
  const sources = sourceIds.map((id) => {
    const reads = result.lineage.flatMap((l) => l.sources.filter((s) => s.connectionId === id).map((s) => Date.parse(s.readAt)));
    return { name: names.get(id) ?? id, age: age(Math.min(...reads), computed) };
  });
  const inputs = lineageInputs(canvasViewId, type.id, result);
  // A site plan or a 3D model drawn in it carries its own markings (D228): the server's PDF draws the view's plan; an image, what the browser drew.
  const carrier = input.rendered !== undefined || input.stampOnly === true ? input.drawn : drawn === 'spatial_plan' && view.planId !== null ? { planId: view.planId } : undefined;
  let carriedMarkingIds: string[] = [];
  try {
    if (carrier?.planId !== undefined) carriedMarkingIds = (await readablePlan(deps, ctx, carrier.planId)).markingIds;
    else if (carrier?.assetModelId !== undefined) carriedMarkingIds = (await readableModel(deps, ctx, carrier.assetModelId)).markingIds;
  } catch (error) {
    if (isAppError(error)) return { outcome: 'refused', code: error.code, reason: `what is drawn in it cannot be exported by you: ${error.message}` };
    throw error;
  }
  const { markings } = await deps.services.call(previewExportMarkings, { body: { inputs, carriedMarkingIds } }, options);
  const flags: string[] = [];
  if (opened.statement !== null) flags.push(`${opened.withheld.properties} properties withheld from you`);
  const disputed = Object.values(result.coverage.disputed).reduce((a, b) => a + b, 0);
  if (disputed > 0) flags.push(`${disputed} disputed values`);
  if (view.stateFilter.length > 0) flags.push(`showing ${view.stateFilter.join(', ')} only`);
  if (input.stampOnly === true) {
    return { outcome: 'stamp', markings: markings.map((m) => ({ id: m.id, name: m.name })), computedAt: result.computedAt, sources: sourceIds.map((id, i) => ({ id, ...sources[i]! })), flags };
  }
  if (input.rendered !== undefined) {
    const printed = new Set(input.rendered.printedMarkingIds);
    const missing = markings.filter((m) => !printed.has(m.id));
    if (missing.length > 0) {
      return { outcome: 'refused', code: 'canvas.markings_changed', reason: `the canvas's inputs now carry ${missing.map((m) => m.name).join(', ')}, which the image does not print: export it again` };
    }
  }

  let bytes: Buffer;
  let placed = shown.length;
  let notPlaced = 0;
  if (input.rendered !== undefined) {
    // The exporter's own browser's image (D225): the canvas as they see it, printed with its stamp.
    bytes = input.rendered.png;
  } else if (drawn === undefined) {
    // A list: the table every export prints.
    bytes = renderPdf(exportDocument({
      name: view.name, markings: markings.map((m) => m.name), plan: { hops: [] } as unknown as QueryPlan,
      result: { ...result, total: shown.length } as QueryResult, rows: shown.map((x) => x.o),
    }));
  } else {
    const drawing = await draw(deps, ctx, { kind: drawn, planId: view.planId, type, manifest, config, by, shown, computedAt: result.computedAt, flags });
    placed = drawing.nodes.length;
    notPlaced = shown.length - drawing.nodes.length;
    bytes = renderCanvasPdf({ name: view.name, markings: markings.map((m) => m.name), computedAt: result.computedAt, sources, notPlaced, flags, ...drawing });
  }
  const file = await deps.services.call(createExport, {
    body: {
      name: `${view.name}.${input.rendered === undefined ? 'pdf' : 'png'}`,
      contentType: (input.rendered === undefined ? PDF_CONTENT_TYPE : 'image/png') as never, content: bytes.toString('base64'),
      source: { kind: 'canvas_view', canvasViewId }, runReference: result.queryId, ...(input.folderId === undefined ? {} : { folderId: input.folderId }),
      inputs, printedMarkingIds: markings.map((m) => m.id), carriedMarkingIds,
      fieldPolicies: result.columns.map((c) => ({ property: c.property, apiName: c.apiName, effect: c.effect })), connectionIds: sourceIds,
    },
  }, { ...options, idempotencyKey: `canvas.${input.rendered?.jobId ?? ctx.idempotencyKey ?? result.queryId}`, timeoutMs: 60_000 });
  await inTransaction(deps.databases.pool('control'), me.request, (db) => recordEvent(db, me, ctx.correlationId, {
    event: 'canvas_exported', resource: { type: 'canvas_view', id: canvasViewId }, detail: { file_id: file.id, format: input.format, placed, not_placed: notPlaced },
  }));
  return { outcome: 'exported', file, placed, notPlaced };
}

/** The drawing's inputs: the canvas view, the type version and every source read, so its markings are theirs. */
function lineageInputs(canvasViewId: string, objectTypeId: string, result: QueryResult): { node: NodeRef; relation: Relation }[] {
  const seen = new Map<string, { node: NodeRef; relation: Relation }>();
  const add = (node: NodeRef) => seen.set(`${node.kind}\u0000${node.refId}\u0000${node.version}`, { node, relation: 'exported_from' });
  add({ kind: 'view', refId: canvasViewId, version: result.planHash });
  for (const column of result.lineage) {
    add({ kind: 'object_type_version', refId: objectTypeId, version: column.objectTypeVersionId });
    for (const source of column.sources) add({ kind: 'connection', refId: source.connectionId, version: source.connectorVersion });
  }
  return [...seen.values()];
}

type Manifest = Awaited<ReturnType<typeof getManifestOf>>;
const getManifestOf = (deps: CanvasDeps, options: { request: Context['request']; correlationId: string }) => deps.services.call(getManifest, { query: {} }, options);

/**
 * The canvas as drawn: the links the layout follows (one hop along the containment link for a
 * hierarchy, along the type's own link for a graph or a schematic without stages), the plan's
 * placements and image for a site plan, and canvasLayouts.service.ts over all of it.
 */
async function draw(deps: SpatialDeps, ctx: Context, input: {
  kind: CanvasKind; planId: string | null; type: Manifest['objectTypes'][number]; manifest: Manifest; config: { containmentLinkTypeId: string | null; crs: string | null } | undefined;
  by: { label?: string | undefined; stage?: string | undefined; time?: string | undefined; lane?: string | undefined; geo?: string | undefined };
  shown: { o: ResultObject; state: DrawnState }[]; computedAt: string; flags: string[];
}) {
  const options = { request: ctx.request, correlationId: ctx.correlationId };
  const { type, manifest, by, shown } = input;
  const kind: CanvasKind = input.kind === 'spatial_map' && input.planId !== null ? 'spatial_plan' : input.kind;
  const ids = new Map(shown.map((x, i) => [x.o.id, i]));

  // Links, read as the exporter, between members of the set.
  const selfLink = manifest.linkTypes.find((l) => l.status !== 'retired' && l.fromTypeId === type.id && l.toTypeId === type.id);
  const link = kind === 'hierarchy' ? manifest.linkTypes.find((l) => l.id === input.config?.containmentLinkTypeId)
    : kind === 'graph_force' || kind === 'graph_layered' || (kind === 'schematic' && by.stage === undefined) ? selfLink : undefined;
  let edges: [number, number][] = [];
  const routeId = link?.defaultRouteId ?? link?.routes[0]?.id;
  if (link !== undefined && routeId !== undefined) {
    const out = await deps.services.call(runPlan, {
      body: {
        plan: { schemaVersion: '1', ontologyVersionId: manifest.version.id, nodes: [{ objectTypeId: link.fromTypeId, filters: [] }, { objectTypeId: link.toTypeId, filters: [] }], hops: [{ from: 0, to: 1, linkTypeId: link.id, routeId }], select: [] } as never,
        parameters: {}, trigger: 'saved_view_run', useCache: true,
      },
    }, options);
    if (out.outcome === 'answer') {
      edges = out.result.page.objects.flatMap((o) => (o.links['0'] ?? []).filter((l) => ids.has(o.id) && ids.has(l.id)).map((l) => [ids.get(o.id)!, ids.get(l.id)!] as [number, number]));
      if (out.result.page.count > 1) input.flags.push('links drawn from the first page of them only');
    } else input.flags.push(`links not drawn: ${out.refusal.reason}`);
  }

  // A site plan: where its rules place the members, and its image under them.
  let placements: Map<string, { x: number; y: number } | { reason: string }> | undefined;
  let background: { image: NonNullable<ReturnType<typeof pdfImageOf>>; width: number; height: number } | undefined;
  if (kind === 'spatial_plan') {
    const placedOn = await placeOnPlan(deps, ctx, input.planId!, {
      objectTypeId: type.id, objects: shown.slice(0, 20_000).map((x) => ({ ref: x.o.id, values: x.o.values })), ...(by.geo !== undefined ? { positionProperty: by.geo } : {}),
    });
    placements = new Map<string, { x: number; y: number } | { reason: string }>([
      ...placedOn.placements.map((p) => [p.ref, { x: p.x, y: p.y }] as const), ...placedOn.notPlaced.map((n) => [n.ref, { reason: n.reason }] as const)]);
    const img = await readPlanImage(deps, ctx, input.planId!);
    const image = pdfImageOf(Buffer.from(img.content, 'base64'));
    if (image === undefined) input.flags.push('the plan could not be printed under the drawing');
    else background = { image, width: img.widthPx, height: img.heightPx };
  }

  const toNumber = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : Number.NaN);
  const text = (v: unknown) => (v === null || v === undefined ? null : String(v));
  const laid = canvasLayout({
    kind, now: Date.parse(input.computedAt), crs: input.config?.crs ?? undefined,
    nodes: shown.map((x) => ({
      id: x.o.id,
      stage: by.stage === undefined ? undefined : text(x.o.values[by.stage]),
      time: by.time === undefined ? undefined : toNumber(x.o.values[by.time]),
      lane: by.lane === undefined ? undefined : text(x.o.values[by.lane]),
      position: by.geo === undefined ? undefined : x.o.values[by.geo],
      plan: placements?.get(x.o.id),
    })),
    edges,
    stageOrder: by.stage === undefined ? undefined : (type.properties.find((p) => p.apiName === by.stage)?.typeParams['values'] as string[] | undefined),
  });
  // Placed nodes in the drawing's own order; edges and back edges renumbered to them.
  const order = new Map<number, number>();
  const expected = new Set(laid.expected);
  const nodes = shown.flatMap((x, i) => {
    const p = laid.positions[i];
    if (p == null) return [];
    order.set(i, order.size);
    const value = by.label === undefined ? undefined : x.o.values[by.label];
    return [{ x: p[0], y: p[1], label: value === null || value === undefined ? x.o.id.slice(0, 8) : String(value), state: x.state, expected: expected.has(i) }];
  });
  const kept = edges.map((e, i) => ({ e, i })).filter(({ e }) => order.has(e[0]) && order.has(e[1]));
  const back = new Set(laid.backEdges);
  return {
    nodes,
    edges: kept.map(({ e }) => [order.get(e[0])!, order.get(e[1])!] as const),
    backEdges: kept.flatMap(({ i }, j) => (back.has(i) ? [j] : [])),
    guides: laid.guides, marks: laid.marks, regions: laid.regions, background,
    note: kind === 'spatial_map' ? 'Base map unavailable: no tile service is configured for this cell; objects are placed by their coordinates.' : undefined,
  };
}
