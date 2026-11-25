'use client';

// The Clone Canvas (spec 29, 30, 31.6). A saved set, opened under the opener's permissions,
// subscribed live; laid out by what the type's metadata supports (a site plan objects are
// anchored to, a 3D model, a map by a Located property, schematic by stage, hierarchy by
// containment, graph by links, timeline by time), every fitting layout offered beside the chosen
// one and the list always there as the floor. Members a layout cannot place are counted and
// listed with why. Drawn with WebGL through deck.gl (src/canvas); laid out in a worker; without
// WebGL, the list.
//
// Moves (29.6, 29.9): select one, or several by Shift-click, box (Shift and drag), lasso (Alt
// and drag), state ("select all failed") or Shift and an arrow; arrows move the selection to
// the nearest clone that way, following links first; Enter opens it; L expands its links one
// hop, each hop bounded and named where the bound stops it; F fades all but the selection's
// neighbourhood, one to three links deep; P pins; Escape clears.

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { canonicalJson } from '../../../../server/src/utils/canonicalJson.util.ts';
import { isApiError, type Output } from '../../api/client.api.ts';
import { DeckCanvas, type Expanded, type Placed } from '../../canvas/deck.canvas.tsx';
import { stampedImage, type ImageStamp } from '../../canvas/imageExport.canvas.ts';
import type { LayoutInput, LayoutKind, LayoutOutput } from '../../canvas/layouts.canvas.ts';
import { Live, type ServerFrame } from '../../canvas/live.canvas.ts';
import { SEVERITY, type State } from '../../canvas/lod.canvas.ts';
import { ModelCanvas } from '../../canvas/model.canvas.tsx';
import { nearest, within, type Direction } from '../../canvas/navigate.canvas.ts';
import { StateGlyph } from '../../canvas/stateGlyph.canvas.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { Dialog } from '../../components/dialog.component.tsx';
import { Checkbox, FormActions, SelectField, TextField } from '../../components/field.component.tsx';
import { Page, Section } from '../../components/page.component.tsx';
import { ErrorMessage, Loading } from '../../components/states.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useData, useMutation, usePermits, useQuery } from '../../data/query.data.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { hrefWith } from '../../utils/href.util.ts';
import { ObjectPanel } from '../explorer/object.view.tsx';
import { ScenarioOverlay, type Overlay } from './scenarioOverlay.view.tsx';
import { SelectionPanel } from './selection.view.tsx';
import { TimeBar, type PastView } from './timeBar.view.tsx';
import css from './clones.view.module.css';

type Opened = Output<'openCanvasView'>;
type Camera = Opened['view']['camera'];
type Manifest = Output<'readOntology'>;
type CloneLayout = Output<'listCloneLayouts'>['layouts'][number];
type Assets = Output<'listSpatialAssets'>;
interface Clone { id: string; values: Map<string, unknown>; ages: Map<string, number>; sources: Set<string>; state: State | undefined; reason: string | undefined }
interface Change { at: string; object: string; property: string; value: unknown; source: string }

const STATE_LABEL: Record<State, string> = { failed: 'Failed', warning: 'Warning', unknown: 'Unknown', stale: 'Stale', normal: 'Normal' };
const LAYOUT_LABEL: Record<LayoutKind, string> = {
  spatial_3d: '3D', spatial_plan: 'Site plan', spatial_map: 'Map', schematic: 'Schematic', hierarchy: 'Hierarchy', graph_force: 'Graph', graph_layered: 'Layered graph', timeline: 'Timeline', list: 'List',
};
/** Deterministic precedence (29.2): a deliberate customer act first, then archetype precedence, the list last. */
const PRECEDENCE: LayoutKind[] = ['spatial_3d', 'spatial_plan', 'spatial_map', 'schematic', 'hierarchy', 'graph_layered', 'graph_force', 'timeline', 'list'];
const LINKED: LayoutKind[] = ['hierarchy', 'graph_layered', 'graph_force', 'schematic'];
const ARROWS: Record<string, Direction> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
const RAIL_LIMIT = 5_000;
/** Above this, a graph, hierarchy, schematic or timeline is laid out by the server and held in the state plane (29.8). */
const SERVER_LAYOUT_ABOVE = 10_000;
const SERVER_LAYOUTS: readonly LayoutKind[] = ['graph_force', 'graph_layered', 'hierarchy', 'schematic', 'timeline'];

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const message = (e: unknown, fallback: string) => (isApiError(e) ? e.sentence : fallback);
export const show = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export function Canvas({ canvasViewId }: { canvasViewId: string }) {
  const { api } = useData();
  const [opened, setOpened] = useState<Opened | undefined>();
  const [manifest, setManifest] = useState<Manifest | undefined>();
  const [config, setConfig] = useState<CloneLayout | null | undefined>();
  const [assets, setAssets] = useState<Assets | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  useEffect(() => {
    void (async () => {
      try {
        const o = await api.call('openCanvasView', { params: { canvasViewId } });
        setOpened(o);
        setManifest(await api.call('readOntology', { query: {} }));
        setAssets(await api.call('listSpatialAssets', { query: {} }).catch(() => ({ plans: [], models: [], anchors: [], withheld: 0 })));
        if (o.objectTypeId !== null) {
          const layouts = await api.call('listCloneLayouts', { body: { objectTypeIds: [o.objectTypeId] } }).catch(() => ({ layouts: [] }));
          setConfig(layouts.layouts[0] ?? null);
        } else setConfig(null);
      } catch (e) {
        setProblem(message(e, 'The canvas could not be opened.'));
      }
    })();
  }, [canvasViewId, api]);
  if (problem !== undefined) return <Page title="Canvas" crumbs={[{ label: 'Clones' }, { label: 'Saved canvases', href: '/clones/saved/' }]}><Banner tone="danger" title="Not opened">{problem}</Banner></Page>;
  if (opened === undefined || manifest === undefined || config === undefined || assets === undefined) return <Loading label="Opening the canvas" />;
  if (opened.objectTypeId === null || opened.view.objectSetId === null) {
    return <Page title={opened.view.name} crumbs={[{ label: 'Clones' }]}><Banner tone="info">This canvas is over the estate. <Link href="/clones/estate/">Open the estate map</Link></Banner></Page>;
  }
  return <OpenCanvas key={config?.id ?? 'none'} opened={opened} manifest={manifest} config={config} assets={assets} onConfig={setConfig} />;
}

function OpenCanvas({ opened, manifest, config, assets, onConfig }: { opened: Opened; manifest: Manifest; config: CloneLayout | null; assets: Assets; onConfig: (config: CloneLayout) => void }) {
  const { api } = useData();
  const view = opened.view;
  const type = manifest.objectTypes.find((t) => t.id === opened.objectTypeId)!;
  const visible = new Set(opened.visibleProperties.map((p) => p.id));
  const apiOf = (identity: string | null | undefined) => (identity == null ? undefined : type.properties.find((p) => p.identityId === identity && visible.has(p.identityId))?.apiName);
  const label = apiOf(config?.labelPropertyId) ?? apiOf(type.titlePropertyIdentityId);
  const stage = apiOf(config?.stagePropertyId);
  const time = apiOf(config?.timePropertyId);
  const lane = apiOf(config?.lanePropertyId);
  const geo = apiOf(config?.geoPropertyId);
  const crs = config?.crs ?? undefined;
  const selfLink = manifest.linkTypes.find((l) => l.status !== 'retired' && l.fromTypeId === type.id && l.toTypeId === type.id);
  const containment = config?.containmentLinkTypeId == null ? undefined : manifest.linkTypes.find((l) => l.id === config.containmentLinkTypeId);
  // Plans this type's objects stand on: anchored to it, or georeferenced where the type is located in WGS 84.
  const plans = assets.plans.filter((p) => assets.anchors.some((a) => a.planId === p.id && a.objectTypeId === type.id) || (p.controlPoints !== null && geo !== undefined && (crs ?? 'EPSG:4326') === 'EPSG:4326'));
  const [planId, setPlanId] = useState<string | undefined>(view.planId !== null && plans.some((p) => p.id === view.planId) ? view.planId : plans[0]?.id);
  const plan = plans.find((p) => p.id === planId);
  // Models this type's objects stand on: anchored to their named nodes (29.5).
  const models = assets.models.filter((m) => assets.anchors.some((a) => a.assetModelId === m.id && a.objectTypeId === type.id));
  const [modelId, setModelId] = useState<string | undefined>(view.assetModelId !== null && models.some((m) => m.id === view.assetModelId) ? view.assetModelId : models[0]?.id);
  const model = models.find((m) => m.id === modelId);

  // Every fitting layout, the chosen one first (29.2).
  const offered = PRECEDENCE.filter((k) => k === 'list' || (k === 'spatial_3d' && models.length > 0) || (k === 'spatial_plan' && plans.length > 0) || (k === 'spatial_map' && geo !== undefined) || (k === 'schematic' && stage !== undefined)
    || (k === 'timeline' && time !== undefined) || (k === 'hierarchy' && containment !== undefined) || (k === 'graph_force' && selfLink !== undefined)
    || (k === 'graph_layered' && selfLink !== undefined && selfLink.cardinality !== 'many_to_many'));
  const saved: LayoutKind = view.layoutKind === 'spatial_map' && view.planId !== null && offered.includes('spatial_plan') ? 'spatial_plan' : view.layoutKind as LayoutKind;
  const [kind, setKind] = useState<LayoutKind>(offered.includes(saved) ? saved : offered[0]!);
  // The camera (29.6): the saved one belongs to the layout it was saved with; where it stands now is what Save stores.
  const camera = useRef<Camera>(view.camera);
  const savedCamera = kind === saved ? view.camera : undefined;
  const properties = useMemo(() => [...new Set([label, stage, time, lane, geo, ...type.properties.filter((p) => visible.has(p.identityId)).map((p) => p.apiName)].filter((p): p is string => p !== undefined))].slice(0, 256),
    [type.id]);

  const clones = useRef(new Map<string, Clone>());
  const rail = useRef<Change[]>([]);
  const changedAt = useRef(new Map<string, number>());
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const [subscription, setSubscription] = useState<Extract<ServerFrame, { type: 'subscribed' }> | undefined>();
  const [refused, setRefused] = useState<string | undefined>();
  const [connection, setConnection] = useState<{ open: boolean; final?: string | undefined }>({ open: false });
  const [sources, setSources] = useState<Extract<ServerFrame, { type: 'source_status' }>['sources']>([]);
  const [snapshotMode, setSnapshotMode] = useState(false);
  const [coalesced, setCoalesced] = useState(0);
  const pending = useRef<Map<string, Clone> | undefined>(undefined);

  useEffect(() => {
    const live = new Live({ ref: 'canvas', set: { kind: 'object_set', id: view.objectSetId! }, properties }, {
      connection: (open, final) => setConnection({ open, final }),
      frame: (f) => {
        switch (f.type) {
          case 'subscribed': setSubscription(f); setRefused(undefined); break;
          case 'refused': setRefused(f.reason === 'bound' ? `the set is larger than a live canvas may hold${f.limit !== undefined ? ` (${f.limit.toLocaleString('en-GB')})` : ''}` : f.reason === 'not_subscribable' ? 'its source has not passed the change-stream tests and no polling fallback is on' : f.reason === 'permission' ? 'you may not see it' : f.reason === 'unresolvable' ? 'the set no longer resolves' : 'the live service is unavailable'); break;
          case 'snapshot': {
            const into = f.page === 0 ? new Map<string, Clone>() : pending.current ?? new Map<string, Clone>();
            for (const o of f.objects) {
              into.set(o.object, {
                id: o.object, values: new Map(o.values.map((v) => [v.property, v.value])), ages: new Map(o.values.map((v) => [v.source, v.ageMs])),
                sources: new Set(o.values.map((v) => v.source)), state: o.state?.value as State | undefined, reason: o.state?.reason,
              });
            }
            pending.current = into;
            if (f.last) { clones.current = into; pending.current = undefined; bump(); }
            break;
          }
          case 'delta': {
            const c = clones.current.get(f.object) ?? { id: f.object, values: new Map(), ages: new Map(), sources: new Set(), state: undefined, reason: undefined };
            for (const ch of f.changes) {
              c.values.set(ch.property, ch.value);
              c.sources.add(ch.source);
              rail.current.push({ at: ch.receivedAt, object: f.object, property: ch.property, value: ch.value, source: ch.source });
            }
            if (f.state !== undefined) { c.state = f.state.value as State; c.reason = f.state.reason; }
            clones.current.set(f.object, c);
            if (rail.current.length > RAIL_LIMIT) rail.current.splice(0, rail.current.length - RAIL_LIMIT);
            if (f.coalesced > 0) setCoalesced((n) => n + f.coalesced);
            changedAt.current.set(f.object, Date.now());
            setTimeout(bump, 2_100);
            bump();
            break;
          }
          case 'membership':
            if (f.change === 'left') clones.current.delete(f.object);
            else if (!clones.current.has(f.object)) clones.current.set(f.object, { id: f.object, values: new Map(), ages: new Map(), sources: new Set(), state: undefined, reason: undefined });
            bump();
            break;
          case 'source_status': setSources(f.sources); break;
          case 'buffer_mode': setSnapshotMode(f.mode === 'snapshot'); break;
          case 'unsubscribe': if (f.reason === 'ended') setRefused('the subscription ended'); break;
          default: break;
        }
      },
    });
    return () => live.close();
  }, [view.objectSetId, properties, bump]);

  // What layout was offered and chosen, recorded once per choice (29.2): how people override the default teaches it.
  const recorded = useRef<string | undefined>(undefined);
  const asCanvasKind = (k: LayoutKind) => (k === 'spatial_plan' ? 'spatial_map' : k);
  useEffect(() => {
    if (clones.current.size === 0 || recorded.current === kind) return;
    recorded.current = kind;
    const chosen = asCanvasKind(saved);
    void api.call('recordRenderSelection', { body: {
      surface: 'canvas', resultRef: view.id, chosen, alternativesOffered: [...new Set(offered.map(asCanvasKind))],
      ...(asCanvasKind(kind) !== chosen ? { overriddenTo: asCanvasKind(kind) } : {}),
      resultStructure: {
        rowCount: clones.current.size, measureCount: 0, measureFromTwoSources: false, hasTimeField: time !== undefined, orderedByTime: false, hasEdges: selfLink !== undefined || containment !== undefined,
        edgesDirected: true, hasCycle: false, singleParent: containment !== undefined, sumsToWhole: false, deviationComputed: false,
        located: geo !== undefined, hasPlan: plans.length > 0, hasModel: models.length > 0,
      },
    } }).catch(() => undefined);
  }, [kind, version > 0]);

  const [stateFilter, setStateFilter] = useState<State[]>(view.stateFilter as State[]);
  const [selected, setSelected] = useState<string | undefined>();
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [pins, setPins] = useState<string[]>(opened.pinnedObjectRefs);
  const [asList, setAsList] = useState(false);
  // The person's own choice for this view, list or canvas, kept from last time (31.2).
  const preference = useQuery('readViewPreference', { query: { canvasViewId: view.id } });
  const [chosen, setChosen] = useState(false);
  useEffect(() => {
    if (chosen || preference.data === undefined) return;
    setAsList(preference.data.preferredRepresentation === 'list');
  }, [preference.data, chosen]);
  const [focus, setFocus] = useState(view.focus.depth !== undefined);
  const [depth, setDepth] = useState(view.focus.depth ?? 1);
  const [linksOn, setLinksOn] = useState(view.layers['links'] !== false);
  const [expanded, setExpanded] = useState<Expanded[]>([]);
  const [past, setPast] = useState<PastView | undefined>();
  const [overlay, setOverlay] = useState<Overlay | undefined>();
  const [scenarioId, setScenarioId] = useState<string | undefined>(view.scenarioId ?? undefined);
  const [hops, setHops] = useState<string[]>([]);
  const panel = useRef<HTMLElement>(null);
  const permits = usePermits();
  const [configuring, setConfiguring] = useState(false);
  const deckHolder = useRef<HTMLDivElement>(null);
  const members = useMemo(() => [...clones.current.values()], [version]);
  const counts = useMemo(() => Object.fromEntries(SEVERITY.map((s) => [s, members.filter((m) => (past === undefined ? m.state ?? 'unknown' : past.states.get(m.id)?.state ?? 'unknown') === s).length])) as Record<State, number>, [members, past]);
  // Scrubbed to a past time (30.8), a clone shows its state then; one not yet observed then is unknown, with why.
  const stateOf = (m: Clone): State => (past === undefined ? m.state ?? 'unknown' : past.states.get(m.id)?.state ?? 'unknown');
  const shown = members.filter((m) => stateFilter.length === 0 || stateFilter.includes(stateOf(m)));
  const labelOf = (id: string) => show(clones.current.get(id)?.values.get(label ?? '') ?? expanded.flatMap((e) => e.nodes).find((n) => n.id === id)?.text ?? id.slice(0, 8));

  // Edges, where the layout or the links layer needs them: one hop along the link, read under the opener's access.
  const [edges, setEdges] = useState<[string, string][]>([]);
  const [edgeProblem, setEdgeProblem] = useState<string | undefined>();
  const link = kind === 'hierarchy' ? containment : selfLink;
  const memberKey = members.map((m) => m.id).sort().join(',');
  const memberSet = useMemo(() => new Set(members.map((m) => m.id)), [memberKey]);
  useEffect(() => {
    if (link === undefined || (!LINKED.includes(kind) && !linksOn) || (kind === 'schematic' && stage !== undefined && !linksOn)) { setEdges([]); return; }
    const routeId = link.defaultRouteId ?? link.routes[0]?.id;
    if (routeId === undefined) { setEdgeProblem('the link has no route'); return; }
    let live = true;
    api.call('runStructuredPlan', { body: { plan: { schemaVersion: '1', ontologyVersionId: manifest.version.id, nodes: [{ objectTypeId: link.fromTypeId, filters: [] }, { objectTypeId: link.toTypeId, filters: [] }], hops: [{ from: 0, to: 1, linkTypeId: link.id, routeId }], select: [] }, parameters: {} } })
      .then((out) => {
        if (!live) return;
        if (out.outcome !== 'answer') { setEdgeProblem(out.outcome === 'refusal' ? out.refusal.reason : 'links could not be read'); setEdges([]); return; }
        const ids = new Set(members.map((m) => m.id));
        setEdges(out.result.page.objects.flatMap((o) => (o.links['0'] ?? []).filter((l) => ids.has(o.id) && ids.has(l.id)).map((l) => [o.id, l.id] as [string, string])));
        setEdgeProblem(undefined);
      }, (e: unknown) => live && setEdgeProblem(message(e, 'links could not be read')));
    return () => { live = false; };
  }, [link?.id, kind, linksOn, memberKey]);

  // A site plan: its image, and where the server places the members on it (by anchor, predicate or georeference).
  const [planImage, setPlanImage] = useState<{ image: ImageBitmap; width: number; height: number } | undefined>();
  const [planProblem, setPlanProblem] = useState<string | undefined>();
  const [placements, setPlacements] = useState<Map<string, { x: number; y: number } | { reason: string }> | undefined>();
  useEffect(() => {
    setPlanImage(undefined);
    if (kind !== 'spatial_plan' || plan === undefined) return;
    let live = true;
    api.call('readSpatialPlanImage', { params: { planId: plan.id } }).then(async (img) => {
      const bytes = Uint8Array.from(atob(img.content), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: img.contentType }));
      if (live) { setPlanImage({ image: bitmap, width: img.widthPx, height: img.heightPx }); setPlanProblem(undefined); }
    }, (e: unknown) => live && setPlanProblem(message(e, 'the plan could not be read')));
    return () => { live = false; };
  }, [kind, plan?.id]);
  const placedAt = useRef(0);
  useEffect(() => {
    if (kind !== 'spatial_plan' || plan === undefined || members.length === 0) return;
    // Values change live and a predicate may follow them: placed again on a change of membership, or at most every ten seconds.
    if (placements !== undefined && Date.now() - placedAt.current < 10_000) return;
    placedAt.current = Date.now();
    let live = true;
    api.call('placeOnSpatialPlan', {
      params: { planId: plan.id },
      body: { objectTypeId: type.id, objects: members.slice(0, 20_000).map((m) => ({ ref: m.id, values: Object.fromEntries(m.values) as never })), ...(geo !== undefined && plan.controlPoints !== null ? { positionProperty: geo } : {}) },
    }).then((out) => {
      if (!live) return;
      setPlacements(new Map<string, { x: number; y: number } | { reason: string }>([...out.placements.map((p) => [p.ref, { x: p.x, y: p.y }] as const), ...out.notPlaced.map((n) => [n.ref, { reason: n.reason }] as const)]));
    }, (e: unknown) => live && setPlanProblem(message(e, 'the objects could not be placed on the plan')));
    return () => { live = false; };
  }, [kind, plan?.id, memberKey, version]);
  useEffect(() => { setPlacements(undefined); placedAt.current = 0; }, [plan?.id, memberKey]);

  // A model: the node each member stands on, by its anchors (29.5); those no anchor places are named, with why.
  const [nodePlacements, setNodePlacements] = useState<Map<string, string> | undefined>();
  const [modelNotPlaced, setModelNotPlaced] = useState<{ id: string; reason: string }[]>([]);
  const [modelProblem, setModelProblem] = useState<string | undefined>();
  const [ownColours, setOwnColours] = useState(false);
  const projected = useRef<ReadonlyMap<string, [number, number]>>(new Map());
  const modelPlacedAt = useRef(0);
  useEffect(() => {
    if (kind !== 'spatial_3d' || model === undefined || members.length === 0) return;
    if (nodePlacements !== undefined && Date.now() - modelPlacedAt.current < 10_000) return;
    modelPlacedAt.current = Date.now();
    let live = true;
    api.call('placeOnAssetModel', {
      params: { assetModelId: model.id },
      body: { objectTypeId: type.id, objects: members.slice(0, 20_000).map((m) => ({ ref: m.id, values: Object.fromEntries(m.values) as never })) },
    }).then((out) => {
      if (!live) return;
      setNodePlacements(new Map(out.placements.map((p) => [p.ref, p.node])));
      setModelNotPlaced(out.notPlaced.map((n) => ({ id: n.ref, reason: n.reason })));
      setModelProblem(undefined);
    }, (e: unknown) => live && setModelProblem(message(e, 'the objects could not be placed on the model')));
    return () => { live = false; };
  }, [kind, model?.id, memberKey, version]);
  useEffect(() => { setNodePlacements(undefined); modelPlacedAt.current = 0; }, [model?.id, memberKey]);

  // Positions from the worker; the list places nothing.
  const [placed, setPlaced] = useState<Placed | undefined>();
  const worker = useRef<Worker | undefined>(undefined);
  useEffect(() => {
    worker.current = new Worker(new URL('../../canvas/layoutWorker.canvas.ts', import.meta.url), { type: 'module' });
    return () => worker.current?.terminate();
  }, []);
  const placementKey = placements === undefined ? '' : [...placements.entries()].map(([id, p]) => ('x' in p ? `${id}:${Math.round(p.x)},${Math.round(p.y)}` : id)).join(';');
  const [serverLayout, setServerLayout] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (kind === 'list' || kind === 'spatial_3d' || worker.current === undefined) { setPlaced(undefined); return; }
    if (members.length > SERVER_LAYOUT_ABOVE && SERVER_LAYOUTS.includes(kind)) {
      // Too large to lay out here: the server computes it once per set, layout and ontology version.
      let live = true;
      const ids = members.map((m) => m.id);
      const index = new Map(ids.map((id, i) => [id, i]));
      const pairs = edges.filter(([a, b]) => index.has(a) && index.has(b));
      setServerLayout('Laying out on the server…');
      void (async () => {
        try {
          const set = await api.call('readOntologyObjectSet', { params: { objectSetId: view.objectSetId! } });
          const hash = await sha256Hex(canonicalJson(set.definition));
          const lanes = new Map<string, number>();
          const begun = await api.call('precomputeLayout', { body: {
            layout: kind as 'graph_force', setDefinitionHash: hash, objectSetId: view.objectSetId!, ontologyVersion: view.ontologyVersion,
            nodes: members.map((m) => {
              const t = time === undefined ? undefined : Date.parse(String(m.values.get(time)));
              const l = lane === undefined ? undefined : String(m.values.get(lane) ?? '');
              if (l !== undefined && !lanes.has(l)) lanes.set(l, Math.min(lanes.size, 1_000));
              return { ref: m.id, ...(t !== undefined && Number.isFinite(t) ? { time: t } : {}), ...(l !== undefined ? { lane: lanes.get(l)! } : {}) };
            }),
            edges: pairs.map(([a, b]) => [index.get(a)!, index.get(b)!] as [number, number]),
          } }, { timeoutMs: 120_000 });
          const out = await api.call('getPrecomputedLayout', { params: { precomputationId: begun.id } }, { timeoutMs: 120_000 });
          if (!live) return;
          const positions = out.positions.map(([x, y]) => (x === null || y === null ? null : [x, y] as [number, number]));
          setPlaced({ kind, ids, edgeIds: pairs, output: {
            positions, clusters: positions.map(() => null), guides: [], backEdges: [], parents: positions.map(() => -1), regions: [], marks: [], expected: [],
            notPlaced: positions.flatMap((p, i) => (p === null ? [{ index: i, reason: 'the server could not place it' }] : [])),
          } });
          setServerLayout(undefined);
        } catch (e) {
          if (live) setServerLayout(`Not laid out on the server: ${message(e, 'it could not be computed')}. Shown as a list.`);
        }
      })();
      return () => { live = false; };
    }
    setServerLayout(undefined);
    const ids = members.map((m) => m.id);
    const index = new Map(ids.map((id, i) => [id, i]));
    const toNumber = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN);
    const pairs = edges.filter(([a, b]) => index.has(a) && index.has(b));
    const input: LayoutInput = {
      kind, crs, now: Date.now(),
      nodes: members.map((m) => ({
        id: m.id,
        stage: stage === undefined ? undefined : (m.values.get(stage) == null ? null : String(m.values.get(stage))),
        time: time === undefined ? undefined : toNumber(m.values.get(time)),
        lane: lane === undefined ? undefined : (m.values.get(lane) == null ? null : String(m.values.get(lane))),
        position: geo === undefined ? undefined : m.values.get(geo),
        plan: placements?.get(m.id),
      })),
      edges: pairs.map(([a, b]) => [index.get(a)!, index.get(b)!] as [number, number]),
      stageOrder: stage === undefined ? undefined : (type.properties.find((p) => p.apiName === stage)?.typeParams['values'] as string[] | undefined),
    };
    const id = Date.now() + Math.random();
    const w = worker.current;
    const onMessage = (event: MessageEvent<{ id: number; output: LayoutOutput }>) => { if (event.data.id === id) setPlaced({ kind, ids, edgeIds: pairs, output: event.data.output }); };
    w.addEventListener('message', onMessage);
    w.postMessage({ id, input });
    return () => w.removeEventListener('message', onMessage);
  }, [kind, memberKey, edges, placementKey]);

  const notPlaced = kind === 'spatial_3d' ? (nodePlacements === undefined ? [] : modelNotPlaced)
    : placed === undefined ? [] : placed.output.notPlaced.map((n) => ({ id: placed.ids[n.index]!, reason: n.reason }));
  const positions = useMemo(() => {
    const pos = new Map<string, [number, number]>();
    placed?.ids.forEach((id, i) => { const p = placed.output.positions[i]; if (p != null) pos.set(id, p); });
    return pos;
  }, [placed]);
  const allEdges = useMemo(() => [...edges, ...expanded.flatMap((e) => e.nodes.map((n) => [e.anchor, n.id] as [string, string]))], [edges, expanded]);
  const neighbourhood = useMemo(() => {
    const focal = [...(selected === undefined ? [] : [selected]), ...selection];
    if (focal.length === 0) return undefined;
    const out = new Set<string>();
    for (const f of focal) for (const id of within(f, allEdges, depth)) out.add(id);
    return out;
  }, [selected, selection, allEdges, depth]);
  // A container's counts per state over everything it contains (29.2), never one colour.
  const containerCounts = useMemo(() => {
    const out = new Map<string, Record<State, number>>();
    if (kind !== 'hierarchy' || placed === undefined) return out;
    const parents = placed.output.parents;
    placed.ids.forEach((id, i) => {
      const state = clones.current.get(id)?.state ?? 'unknown';
      for (let up = parents[i] ?? -1, hops = 0; up !== -1 && hops < 64; up = parents[up] ?? -1, hops += 1) {
        const key = placed.ids[up]!;
        const c = out.get(key) ?? { failed: 0, warning: 0, unknown: 0, stale: 0, normal: 0 };
        c[state] += 1;
        out.set(key, c);
      }
    });
    return out;
  }, [kind, placed, version]);

  useEffect(() => {
    if (selected === undefined || !clones.current.has(selected)) return;
    void api.call('recordCanvasInteraction', { body: { event: 'clone_opened', objectTypeId: type.id, objectId: selected, layout: kind === 'spatial_plan' ? 'spatial_map' : kind, canvasViewId: view.id } }).catch(() => undefined);
  }, [selected]);

  const select = useCallback((id: string, add: boolean) => {
    setSelected(id);
    setSelection((s) => {
      if (!add) return new Set();
      const next = new Set(s);
      if (next.size === 0 && selected !== undefined && selected !== id) next.add(selected);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, [selected]);
  const selectMany = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setSelection((s) => new Set([...s, ...ids]));
    setSelected((cur) => cur ?? ids[0]);
  }, []);

  /** Expand links (29.6): the selection's linked objects by link type, one hop, each hop's bound named where it stopped. */
  async function expandLinks() {
    if (selected === undefined || !clones.current.has(selected)) return;
    if (expanded.some((e) => e.anchor === selected)) {
      setExpanded((x) => x.filter((e) => e.anchor !== selected));
      setHops([]);
      return;
    }
    try {
      const read = await api.call('readObjectView', { body: { objectTypeId: type.id, object: { objectId: selected } } });
      if (read.outcome !== 'object') { setHops([`Links not expanded: ${read.outcome === 'refusal' ? read.refusal.reason : 'the object was not found'}.`]); return; }
      const inSet = new Set(members.map((m) => m.id));
      const nodes = read.view.links.flatMap((l) => l.objects.filter((o) => !inSet.has(o.id)).map((o) => ({ id: o.id, objectTypeId: o.objectTypeId, text: `${show(o.title ?? manifest.objectTypes.find((t) => t.id === o.objectTypeId)?.displayName)} (${l.name})` })));
      const unique = [...new Map(nodes.map((n) => [n.id, n])).values()];
      setExpanded((x) => [...x, { anchor: selected, nodes: unique }]);
      setHops(read.view.links.map((l) => (l.refusal !== null ? `${l.name}: not followed (${l.refusal.reason})` : l.count !== null && l.count > l.objects.length ? `${l.name}: ${l.count.toLocaleString('en-GB')} linked, the first ${l.objects.length} shown` : `${l.name}: ${l.count ?? l.objects.length} linked`)));
    } catch (e) {
      setHops([`Links not expanded: ${message(e, 'the object could not be read')}.`]);
    }
  }

  function step(direction: Direction, extend: boolean) {
    const order = asList || kind === 'list' ? shown.map((m) => m.id) : [];
    let next: string | undefined;
    if (order.length > 0) {
      const at = selected === undefined ? -1 : order.indexOf(selected);
      next = direction === 'down' || direction === 'right' ? order[Math.min(at + 1, order.length - 1)] : order[Math.max(at - 1, 0)];
    } else {
      // In 3D, where each clone is on screen now; elsewhere, where the layout put it.
      const at = kind === 'spatial_3d' ? projected.current : positions;
      const candidates = shown.filter((m) => at.has(m.id)).map((m) => ({ id: m.id, position: at.get(m.id)! }));
      const from = selected === undefined ? undefined : at.get(selected);
      if (from === undefined) next = [...candidates].sort((a, b) => a.position[1] - b.position[1] || a.position[0] - b.position[0])[0]?.id;
      else {
        const linked = LINKED.includes(kind) ? new Set(edges.filter(([a, b]) => a === selected || b === selected).flat()) : new Set<string>();
        next = nearest(from, direction, candidates.filter((c) => linked.has(c.id) && c.id !== selected)) ?? nearest(from, direction, candidates.filter((c) => c.id !== selected));
      }
    }
    if (next !== undefined) select(next, extend);
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, select, textarea, [aria-label="Selected object"]') !== null) return;
    const direction = ARROWS[e.key];
    if (direction !== undefined) { e.preventDefault(); step(direction, e.shiftKey); return; }
    if (e.key === 'Escape') { setSelected(undefined); setSelection(new Set()); }
    else if (e.key === 'Enter' && selected !== undefined && (e.target as HTMLElement).tagName !== 'BUTTON') { e.preventDefault(); panel.current?.focus(); }
    else if (e.key === 'f' || e.key === 'F') setFocus((x) => !x);
    else if (e.key === 'l' || e.key === 'L') void expandLinks();
    else if ((e.key === 'p' || e.key === 'P') && selected !== undefined) setPins((p) => (p.includes(selected) ? p.filter((x) => x !== selected) : [...p, selected].slice(0, 200)));
  };

  const webgl = useMemo(() => typeof document !== 'undefined' && document.createElement('canvas').getContext('webgl2') !== null, []);
  const showList = asList || kind === 'list' || !webgl || (serverLayout?.startsWith('Not') ?? false);
  const selectedClone = selected === undefined ? undefined : clones.current.get(selected);
  const selectedLinked = selected === undefined || selectedClone !== undefined ? undefined : expanded.flatMap((e) => e.nodes).find((n) => n.id === selected);
  const backCount = placed?.output.backEdges.length ?? 0;
  /** The canvas as drawn here, and what this browser knows to print with it (29.10). */
  const imageSource = () => {
    // The canvas's own drawing over what is drawn under it: a base map (with the attribution its data needs, D227) or a 3D model (D228).
    const canvases = showList ? [] : [...deckHolder.current?.querySelectorAll('canvas') ?? []];
    const beneath = (c: HTMLCanvasElement) => c.classList.contains('maplibregl-canvas') || c.dataset['under'] !== undefined;
    const drawn = canvases.find((c) => !beneath(c));
    if (drawn === undefined) return undefined;
    const layer = deckHolder.current?.querySelector<HTMLElement>('[data-attribution]');
    const under = canvases.find((c) => beneath(c) && c.closest<HTMLElement>('[data-attribution]')?.style.visibility !== 'hidden');
    const flags = [
      ...(overlay !== undefined ? [`${overlay.label} overlaid: simulated, not current`] : []),
      ...(past !== undefined ? [past.statement] : []),
      ...(subscription !== undefined && subscription.fields.withheld.length > 0 ? [`${subscription.fields.withheld.length} properties withheld from you`] : []),
      ...(stateFilter.length > 0 ? [`showing ${stateFilter.join(', ')} only`] : []),
      ...(snapshotMode ? ['updating in snapshots under load'] : []),
    ];
    return {
      canvas: drawn,
      under,
      drawnWith: kind === 'spatial_plan' && plan !== undefined ? { planId: plan.id } : kind === 'spatial_3d' && model !== undefined ? { assetModelId: model.id } : undefined,
      stamp: {
        attribution: under === undefined || layer === null || layer === undefined ? undefined : layer.dataset['attribution'],
        name: view.name, drawnAt: new Date().toISOString(), notPlaced: notPlaced.length, flags,
        sources: sources.map((x) => ({ id: x.source, name: x.source.slice(0, 8), age: x.ageMs === undefined ? x.status : `${Math.round(x.ageMs / 1000)}s, ${x.status}` })),
      },
    };
  };

  usePageContext({ scope: { kind: 'object_set', objectSetId: view.objectSetId! }, scopeLabel: view.name,
    status: subscription === undefined ? undefined : subscription.mode === 'polled' ? 'Polled, not live' : connection.open ? 'Live' : 'Reconnecting' });
  const status = subscription === undefined ? (refused === undefined ? 'Connecting…' : '') : subscription.mode === 'polled' ? `Polled every ${subscription.refreshEverySeconds ?? '?'} seconds, not live` : connection.open ? 'Live' : 'Reconnecting…';
  const togglePin = (id: string) => setPins((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(0, 200)));
  return (
    <Page title={<>{view.name} <span className={css.muted}>({members.length.toLocaleString('en-GB')} {type.pluralName.toLowerCase()})</span></>} documentTitle={view.name} width="full"
      crumbs={[{ label: 'Clones' }, { label: 'Saved canvases', href: '/clones/saved/' }]}
      actions={<>
        <SaveView opened={opened} kind={kind} camera={camera} planId={kind === 'spatial_plan' ? plan?.id : undefined} assetModelId={kind === 'spatial_3d' ? model?.id : undefined} scenarioId={scenarioId} stateFilter={stateFilter} pins={pins} links={linksOn} depth={focus ? depth : undefined} />
        <ExportView canvasViewId={view.id} image={imageSource} />
      </>}>
      <article aria-label={view.name} className={css.stack} onKeyDown={onKeyDown}>
        <div className={css.chips} role="group" aria-label="Layout">
          {offered.map((k) => <Button key={k} size="sm" variant={kind === k ? 'primary' : 'secondary'} aria-pressed={kind === k} onClick={() => setKind(k)}>{LAYOUT_LABEL[k]}</Button>)}
        </div>
        {overlay !== undefined ? <p className={css.scenarioHeader} role="note">{overlay.label} is overlaid: simulated, not current.</p> : null}
        {opened.statement !== null ? <Banner tone="info">{opened.statement}</Banner> : null}
        <TimeBar objectTypeId={type.id} ids={members.map((m) => m.id)} properties={properties} past={past} onChange={setPast} />
        {refused !== undefined ? <Banner tone="warn" title="Not live">{refused}. <Link href={hrefWith('/explorer/sets/', { set: view.objectSetId })}>Open it in Explorer</Link> to read it now.</Banner> : null}
        {connection.final !== undefined ? <Banner tone="warn">{connection.final}</Banner> : null}
        <p className={css.muted} role="status">
          {status}
          {sources.map((s) => ` · ${s.status}${s.ageMs !== undefined ? `, ${Math.round(s.ageMs / 1000)} s old` : ''}${s.reason !== undefined ? ` (${s.reason})` : ''}`).join('')}
          {snapshotMode ? ' · under load, updating in snapshots' : ''}
          {subscription !== undefined && subscription.fields.withheld.length > 0 ? ` · ${subscription.fields.withheld.length} propert${subscription.fields.withheld.length === 1 ? 'y' : 'ies'} withheld from you` : ''}
        </p>
        <div className={css.canvasBody}>
          <aside className={css.left} aria-label="Layers and filters">
            {kind === 'spatial_plan' && plans.length > 1 ? <SelectField label="Plan" value={plan?.id ?? ''} onChange={(e) => setPlanId(e.target.value)} options={plans.map((p) => ({ value: p.id, label: p.name }))} /> : null}
            {kind === 'spatial_plan' && planProblem !== undefined ? <Banner tone="warn">{planProblem}</Banner> : null}
            {kind === 'spatial_3d' && models.length > 1 ? <SelectField label="Model" value={model?.id ?? ''} onChange={(e) => setModelId(e.target.value)} options={models.map((m) => ({ value: m.id, label: m.name }))} /> : null}
            {kind === 'spatial_3d' && modelProblem !== undefined ? <Banner tone="warn">{modelProblem}</Banner> : null}
            <Section title="Layers">
              {kind === 'spatial_3d' ? <Checkbox label="The model's own colours" checked={ownColours} onChange={() => setOwnColours(!ownColours)} /> : null}
              <Checkbox label="Links" checked={linksOn} disabled={selfLink === undefined && containment === undefined} onChange={() => setLinksOn(!linksOn)} />
              <Checkbox label="Focus on the selection (F)" checked={focus} onChange={() => setFocus(!focus)} />
              {focus ? <SelectField label="Focus depth" value={String(depth)} onChange={(e) => setDepth(Number(e.target.value))} options={[1, 2, 3].map((d) => ({ value: String(d), label: d === 1 ? '1 link' : `${d} links` }))} /> : null}
              {backCount > 0 ? <p className={css.muted}>{backCount} {backCount === 1 ? 'link closes' : 'links close'} a cycle, drawn heavier in blue.</p> : null}
            </Section>
            <Section title="Filter by state">
              {SEVERITY.map((s) => (
                <div key={s} className={css.row}>
                  <Checkbox label={<span className={`${css[`state_${s}`]} ${css.stateName}`}><StateGlyph state={s} /> {STATE_LABEL[s]} {counts[s].toLocaleString('en-GB')}</span>}
                    checked={stateFilter.length === 0 || stateFilter.includes(s)} onChange={() => {
                      const shownNow = stateFilter.length === 0 || stateFilter.includes(s);
                      const now = stateFilter.length === 0 ? [...SEVERITY] : stateFilter;
                      const next = shownNow ? now.filter((x) => x !== s) : [...now, s];
                      setStateFilter(next.length === SEVERITY.length ? [] : next);
                    }} />
                  {counts[s] > 0 ? <Button size="sm" variant="link" onClick={() => selectMany(members.filter((m) => stateOf(m) === s).map((m) => m.id))}>Select all {s}</Button> : null}
                </div>
              ))}
            </Section>
            {notPlaced.length > 0 ? (
              <Section title="Not placed">
                <p className={css.muted}>{notPlaced.length} {notPlaced.length === 1 ? 'object lacks' : 'objects lack'} what this layout needs.</p>
                <ul className={css.plainList}>{notPlaced.slice(0, 50).map((n) => <li key={n.id}><Button size="sm" variant="link" onClick={() => select(n.id, false)}>{labelOf(n.id)}</Button> <span className={css.muted}>{n.reason}</span></li>)}</ul>
              </Section>
            ) : null}
            {edgeProblem !== undefined ? <p className={css.muted}>Links not shown: {edgeProblem}.</p> : null}
            {hops.length > 0 ? <Section title="Expanded links"><ul className={css.plainList}>{hops.map((h) => <li key={h}>{h}</li>)}</ul></Section> : null}
            <ScenarioOverlay canvasViewId={view.id} initialScenarioId={view.scenarioId} inSet={memberSet} labelOf={labelOf}
              onChange={(o, id) => {
                setOverlay(o);
                setScenarioId(id);
              }} />
            <Button onClick={() => {
              const next = !asList;
              setChosen(true);
              setAsList(next);
              void api.call('setViewPreference', { body: { canvasViewId: view.id, preferredRepresentation: next ? 'list' : 'canvas' } }).catch(() => undefined);
            }}>{asList ? 'View as canvas' : 'View as list'}</Button>
            <Button variant="ghost" blocked={permits('setCloneLayout')} onClick={() => setConfiguring(true)}>Layout settings</Button>
          </aside>
          <div className={css.centre}>
            {!webgl ? <Banner tone="info">This browser has no WebGL, so the set is shown as a list.</Banner> : null}
            {serverLayout !== undefined ? <Banner tone={serverLayout.startsWith('Not') ? 'warn' : 'info'}>{serverLayout}</Banner> : null}
            <div ref={deckHolder}>
              {showList ? <CloneList members={shown} label={label} properties={properties} selected={selected} selection={selection} onSelect={select} stateOf={stateOf} badges={overlay?.badges} changes={past?.changes} /> : kind === 'spatial_3d' && model !== undefined ? (
                <ModelCanvas model={{ id: model.id, name: model.name, levels: model.levels.length }} members={shown.map((m) => ({ id: m.id, state: stateOf(m), text: labelOf(m.id) }))} placements={nodePlacements}
                  camera={savedCamera} onCamera={(c) => { camera.current = c; }}
                  selected={selected} selection={selection} pins={pins} changedAt={changedAt.current} focus={focus ? neighbourhood : undefined}
                  badges={overlay?.badges} changes={past?.changes} ownColours={ownColours} version={version} onSelect={select} onSelectMany={selectMany}
                  onProjected={(m) => { projected.current = m; }} />
              ) : (
                <DeckCanvas kind={kind} members={shown.map((m) => ({ id: m.id, state: stateOf(m), text: labelOf(m.id) }))} placed={placed}
                  badges={overlay?.badges} changes={past?.changes}
                  edges={linksOn || LINKED.includes(kind) ? edges : []} selected={selected} selection={selection} pins={pins} changedAt={changedAt.current}
                  focus={focus ? neighbourhood : undefined} containerCounts={containerCounts} expanded={expanded} plan={kind === 'spatial_plan' ? planImage : undefined}
                  version={version} onSelect={select} onSelectMany={selectMany} camera={savedCamera} onCamera={(c) => { camera.current = c; }} />
              )}
            </div>
          </div>
          <aside ref={panel} tabIndex={-1} className={css.right} aria-label="Selected object">
            {selection.size > 1 ? (
              <SelectionPanel objectTypeId={type.id} typeName={type.pluralName.toLowerCase()} ids={[...selection]} labelOf={labelOf}
                hidden={[...selection].filter((id) => !shown.some((m) => m.id === id))} notPlaced={showList ? [] : [...selection].filter((id) => notPlaced.some((n) => n.id === id))}
                onClear={() => setSelection(new Set())} />
            ) : selected === undefined ? <p className={css.muted}>Select a clone to see its state, properties, links and Actions. Shift selects several.</p> : selectedLinked !== undefined ? (
              <>
                <p><strong>{selectedLinked.text}</strong> <span className={css.muted}>linked, not in this set, so not live</span></p>
                <ObjectPanel key={selected} address={{ objectTypeId: selectedLinked.objectTypeId, objectId: selected }} />
              </>
            ) : (
              <>
                <p>
                  <strong>{labelOf(selected)}</strong> {selectedClone?.state !== undefined ? <span className={css[`state_${selectedClone.state}`]}><StateGlyph state={selectedClone.state} /> {STATE_LABEL[selectedClone.state]}</span> : null}
                  {selectedClone?.reason !== undefined && past === undefined ? <span className={css.muted}>: {selectedClone.reason}</span> : null}
                  {past !== undefined && selectedClone !== undefined ? <span className={css.muted}> {past.states.get(selected) == null ? 'not yet observed then' : `then: ${STATE_LABEL[past.states.get(selected)!.state]}, ${past.states.get(selected)!.reason}`}</span> : null}
                  {overlay?.badges.get(selected) !== undefined ? <span className={css.scenarioBadge}> {overlay.badges.get(selected)}</span> : null}
                </p>
                <div className={css.row}>
                  <Button size="sm" variant="ghost" onClick={() => togglePin(selected)}>{pins.includes(selected) ? 'Unpin' : 'Pin'} (P)</Button>
                  <Button size="sm" variant="ghost" onClick={() => void expandLinks()}>{expanded.some((e) => e.anchor === selected) ? 'Collapse links' : 'Expand links'} (L)</Button>
                </div>
                <ObjectPanel key={selected} address={{ objectTypeId: type.id, objectId: selected }} />
              </>
            )}
          </aside>
        </div>
        <ChangeRail rail={rail.current} version={version} labelOf={labelOf} coalesced={coalesced} />
      </article>
      {configuring ? <LayoutSettings type={type} manifest={manifest} config={config} onClose={() => setConfiguring(false)} onSaved={onConfig} /> : null}
    </Page>
  );
}

/** How a type is drawn on every canvas (29.2): its label, stage, time, lane, location and containment. */
function LayoutSettings({ type, manifest, config, onClose, onSaved }: {
  type: Manifest['objectTypes'][number]; manifest: Manifest; config: CloneLayout | null; onClose: () => void; onSaved: (config: CloneLayout) => void;
}) {
  const save = useMutation('setCloneLayout', { invalidates: ['listCloneLayouts'] });
  const [label, setLabel] = useState(config?.labelPropertyId ?? type.titlePropertyIdentityId);
  const [stage, setStage] = useState(config?.stagePropertyId ?? '');
  const [time, setTime] = useState(config?.timePropertyId ?? '');
  const [lane, setLane] = useState(config?.lanePropertyId ?? '');
  const [geo, setGeo] = useState(config?.geoPropertyId ?? '');
  const [crs, setCrs] = useState(config?.crs ?? '');
  const [containment, setContainment] = useState(config?.containmentLinkTypeId ?? '');
  const props = type.properties.filter((p) => p.status !== 'retired').map((p) => ({ value: p.identityId, label: p.displayName }));
  const of = (kinds: readonly string[]) => type.properties.filter((p) => p.status !== 'retired' && kinds.includes(p.dataType)).map((p) => ({ value: p.identityId, label: p.displayName }));
  const links = manifest.linkTypes.filter((l) => l.status !== 'retired' && l.fromTypeId === type.id && l.toTypeId === type.id).map((l) => ({ value: l.id, label: l.forwardName }));
  return (
    <Dialog open onClose={onClose} title={`How ${type.pluralName.toLowerCase()} are drawn`} size="md" busy={save.pending}
      description="For every canvas of this type: what each clone is labelled, and what decides where it goes in each layout.">
      <form className={css.form} onSubmit={async (event) => {
        event.preventDefault();
        const r = await save.run({ params: { objectTypeId: type.id }, body: {
          labelPropertyId: label, ...(stage !== '' ? { stagePropertyId: stage } : {}), ...(time !== '' ? { timePropertyId: time } : {}), ...(lane !== '' ? { lanePropertyId: lane } : {}),
          ...(geo !== '' ? { geoPropertyId: geo, ...(crs.trim() !== '' ? { crs: crs.trim() } : {}) } : {}), ...(containment !== '' ? { containmentLinkTypeId: containment } : {}),
        } });
        if (r.ok) {
          onSaved(r.data);
          onClose();
        }
      }}>
        <SelectField label="Label" value={label} onChange={(e) => setLabel(e.target.value)} options={props} />
        <SelectField label="Stage (schematic columns)" value={stage} onChange={(e) => setStage(e.target.value)} placeholder="None" options={props} />
        <SelectField label="Time (timeline)" value={time} onChange={(e) => setTime(e.target.value)} placeholder="None" options={of(['date', 'timestamp'])} />
        <SelectField label="Lane (timeline rows)" value={lane} onChange={(e) => setLane(e.target.value)} placeholder="None" options={props} />
        <SelectField label="Location (map)" value={geo} onChange={(e) => setGeo(e.target.value)} placeholder="None" options={of(['geopoint', 'string', 'struct'])} />
        {geo !== '' ? <TextField label="Coordinate system (optional)" value={crs} onChange={(e) => setCrs(e.target.value)} placeholder="EPSG:4326, or EPSG:27700 for British grid references" /> : null}
        <SelectField label="Contained in (hierarchy)" value={containment} onChange={(e) => setContainment(e.target.value)} placeholder={links.length === 0 ? 'No link of this type to itself' : 'None'} options={links} />
        {save.error !== undefined ? <ErrorMessage error={save.error} /> : null}
        <FormActions><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" pending={save.pending} blocked={save.blocked}>Save</Button></FormActions>
      </form>
    </Dialog>
  );
}

function CloneList({ members, label, properties, selected, selection, onSelect, stateOf, badges, changes }: {
  members: Clone[]; label: string | undefined; properties: string[]; selected: string | undefined; selection: ReadonlySet<string>; onSelect: (id: string, add: boolean) => void;
  stateOf: (m: Clone) => State; badges: ReadonlyMap<string, string> | undefined; changes: ReadonlyMap<string, string> | undefined;
}) {
  const columns = properties.filter((p) => p !== label).slice(0, 5);
  return (
    <div className={css.tableScroll}>
      <table className={css.cloneTable}>
        <caption className={css.muted}>{members.length.toLocaleString('en-GB')} clones</caption>
        <thead><tr><th scope="col"><span className="visually-hidden">In the selection</span></th><th scope="col">Clone</th><th scope="col">State</th>{columns.map((c) => <th key={c} scope="col">{c.replaceAll('_', ' ')}</th>)}</tr></thead>
        <tbody>{members.slice(0, 2_000).map((m) => {
          const name = show(m.values.get(label ?? '') ?? m.id.slice(0, 8));
          return (
            <tr key={m.id} aria-selected={m.id === selected || selection.has(m.id)}>
              <td><input type="checkbox" aria-label={`Select ${name}`} checked={selection.has(m.id)} onChange={() => onSelect(m.id, true)} /></td>
              <td><Button size="sm" variant="link" onClick={(e) => onSelect(m.id, e.shiftKey)}>{name}</Button></td>
              <td className={css[`state_${stateOf(m)}`]}><StateGlyph state={stateOf(m)} /> {STATE_LABEL[stateOf(m)]}
                {changes?.get(m.id) !== undefined ? <span className={css.muted}> ({changes.get(m.id)})</span> : null}
                {badges?.get(m.id) !== undefined ? <span className={css.scenarioBadge}> {badges.get(m.id)}</span> : null}</td>
              {columns.map((c) => <td key={c}>{show(m.values.get(c))}</td>)}
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}

function ChangeRail({ rail, version, labelOf, coalesced }: { rail: Change[]; version: number; labelOf: (id: string) => string; coalesced: number }) {
  // The rail is a polite live region, rate-limited: a summary of what changed, at most every two seconds.
  const [announced, setAnnounced] = useState('');
  const last = useRef(0);
  useEffect(() => {
    if (Date.now() - last.current < 2_000 || rail.length === 0) return;
    last.current = Date.now();
    const c = rail[rail.length - 1]!;
    setAnnounced(`${labelOf(c.object)} ${c.property.replaceAll('_', ' ')} now ${show(c.value)}`);
  }, [version]);
  return (
    <section aria-label="Change rail" className={css.rail}>
      <p className="visually-hidden" aria-live="polite">{announced}</p>
      {rail.length === 0 ? <p className={css.muted}>No live change since this canvas opened.</p> : (
        <ol className={css.railList}>{rail.slice(-40).reverse().map((c, i) => (
          <li key={`${c.at}:${c.object}:${c.property}:${i}`}>{new Date(c.at).toLocaleTimeString('en-GB')} {labelOf(c.object)} {c.property.replaceAll('_', ' ')} → {show(c.value)} <span className={css.muted}>({c.source.slice(0, 8)})</span></li>
        ))}</ol>
      )}
      {coalesced > 0 ? <p className={css.muted}>{coalesced} updates coalesced.</p> : null}
    </section>
  );
}

/**
 * Export (29.10): a PDF in Files, drawn now for the exporter under their own access; or a PNG,
 * the canvas as this browser shows it (D225), printed with the markings the server says it
 * must carry, when it was drawn, each source's state age, the flags and how many are not
 * placed.
 */
function ExportView({ canvasViewId, image }: {
  canvasViewId: string; image: () => { canvas: HTMLCanvasElement; under: HTMLCanvasElement | undefined; drawnWith: { planId: string } | { assetModelId: string } | undefined; stamp: Omit<ImageStamp, 'markings' | 'sources'> & { sources: { id: string; name: string; age: string }[] } } | undefined;
}) {
  const { api } = useData();
  const say = useToast();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ text: string; ok: boolean } | undefined>(undefined);
  const done = (text: string, ok: boolean) => {
    setOutcome({ text, ok });
    say(text, { tone: ok ? 'ok' : 'info' });
  };
  async function exportPdf() {
    setBusy(true);
    try {
      const out = await api.call('exportCanvasView', { params: { canvasViewId }, body: { format: 'pdf' } }, { idempotencyKey: crypto.randomUUID() });
      if (out.outcome === 'exported') done(`Saved to Files as ${out.file.name}${out.notPlaced > 0 ? ` (${out.notPlaced} not placed, as printed)` : ''}.`, true);
      else done(out.outcome === 'refused' ? `Not exported: ${out.reason}` : 'Not exported.', false);
    } catch (e) {
      done(message(e, 'It could not be exported just now.'), false);
    } finally {
      setBusy(false);
    }
  }
  async function exportPng() {
    const source = image();
    if (source === undefined) {
      done('Not exported: the canvas is not drawn here; a list exports as a PDF.', false);
      return;
    }
    setBusy(true);
    try {
      const scale = Math.min(Math.max(source.canvas.width / Math.max(source.canvas.clientWidth, 1), 1), 4);
      const begun = await api.call('exportCanvasView', {
        params: { canvasViewId }, body: { format: 'png', ...(source.drawnWith === undefined ? {} : { drawn: source.drawnWith }), width: Math.max(64, Math.min(8192, source.canvas.clientWidth)), height: Math.max(64, Math.min(8192, source.canvas.clientHeight)), scale },
      }, { idempotencyKey: crypto.randomUUID() });
      if (begun.outcome !== 'awaiting_image') {
        done(begun.outcome === 'refused' ? `Not exported: ${begun.reason}` : 'Not exported.', false);
        return;
      }
      // Each source by its name, aged as this canvas has it live; one the canvas has no live age for, as the export's run read it.
      const named = new Map(begun.stamp.sources.map((x) => [x.id, x]));
      const live = source.stamp.sources.map((x) => ({ name: named.get(x.id)?.name ?? x.name, age: x.age }));
      const sourcesPrinted = [...live, ...begun.stamp.sources.filter((x) => !source.stamp.sources.some((l) => l.id === x.id)).map((x) => ({ name: x.name, age: `${x.age} when read` }))];
      const content = await stampedImage(source.canvas, source.under, { ...source.stamp, sources: sourcesPrinted, markings: begun.stamp.markings, flags: [...begun.stamp.flags, ...source.stamp.flags] });
      // The job holds the image until it is filed; its state is read back where it did not finish here.
      const finished = await api.call('completeCanvasImageExport', { params: { jobId: begun.job.id }, body: { content } });
      if (finished.outcome === 'exported') done(`Saved to Files as ${finished.file.name}.`, true);
      else {
        const job = await api.call('getRenderJob', { params: { jobId: begun.job.id } }).catch(() => undefined);
        done(`Not exported: ${finished.reason}${job !== undefined ? ` (${job.status.replaceAll('_', ' ')})` : ''}`, false);
      }
    } catch (e) {
      done(message(e, 'It could not be exported just now.'), false);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button pending={busy} onClick={() => void exportPdf()}>Export as PDF</Button>
      <Button disabled={busy} onClick={() => void exportPng()}>Export as PNG</Button>
      {outcome !== undefined ? <span role="status" className={css.muted}>{outcome.text}{outcome.ok ? <> <Link href="/files/all/">Open Files</Link></> : null}</span> : null}
    </>
  );
}

function SaveView({ opened, kind, camera, planId, assetModelId, scenarioId, stateFilter, pins, links, depth }: {
  opened: Opened; kind: LayoutKind; camera: { readonly current: Camera }; planId: string | undefined; assetModelId: string | undefined; scenarioId: string | undefined; stateFilter: State[]; pins: string[]; links: boolean; depth: number | undefined;
}) {
  const { api } = useData();
  const say = useToast();
  const [lock, setLock] = useState(opened.view.lockVersion);
  const [favourite, setFavourite] = useState(opened.view.favourited);
  const [saving, setSaving] = useState(false);
  const [said, setSaid] = useState<string | undefined>(undefined);
  const v = opened.view;
  async function save() {
    setSaving(true);
    try {
      // A site plan is the map layout with its plan (29.4).
      const layoutKind = kind === 'spatial_plan' ? 'spatial_map' : kind;
      const saved = await api.call('updateCanvasView', {
        params: { canvasViewId: v.id },
        body: { name: v.name, layoutKind, camera: camera.current, layers: { ...v.layers, links }, focus: depth === undefined ? {} : { depth }, stateFilter, pinnedObjectRefs: pins, lockVersion: lock, ...(planId !== undefined ? { planId } : {}), ...(assetModelId !== undefined ? { assetModelId } : {}), ...(scenarioId !== undefined ? { scenarioId } : {}) },
      });
      setLock(saved.lockVersion);
      setSaid('Saved.');
      say('Saved.');
    } catch (e) {
      setSaid(message(e, 'It could not be saved.'));
    } finally {
      setSaving(false);
    }
  }
  async function toggleFavourite() {
    try {
      if (favourite) await api.call('unfavouriteCanvasView', { params: { canvasViewId: v.id } });
      else await api.call('favouriteCanvasView', { params: { canvasViewId: v.id } });
      setFavourite(!favourite);
    } catch (e) {
      setSaid(message(e, 'That could not be done.'));
    }
  }
  return (
    <>
      {v.access === 'owner' ? <Button pending={saving} onClick={() => void save()}>Save the view</Button> : null}
      <Button icon="star" variant={favourite ? 'primary' : 'secondary'} aria-pressed={favourite} onClick={() => void toggleFavourite()}>{favourite ? 'Favourited' : 'Favourite'}</Button>
      {said !== undefined ? <span role="status" className={css.muted}>{said}</span> : null}
    </>
  );
}
