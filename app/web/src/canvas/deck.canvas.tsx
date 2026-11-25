'use client';

// The canvas's drawing (spec 29.7, 29.8, 31.6): WebGL through deck.gl, an orthographic view over
// layout units. Normal clones are neutral, so warning, failed, unknown and stale are seen first;
// the accent marks the selection and, for two seconds, a live change, and nothing else. Level of
// detail folds what is too dense into clusters with their counts per state, and draws labels
// only where they do not collide. A layout change repositions in one step, never animated.
//
// Selecting: a click selects one clone; with Shift it adds to the selection. Shift and drag
// draws a box, Alt and drag a lasso, either adding what it encloses. A cluster's click zooms in.

import { useEffect, useMemo, useRef, useState } from 'react';
import css from './canvas.canvas.module.css';
import type { LayoutKind, LayoutOutput } from './layouts.canvas.ts';
import { clusterText, countsText, levelOfDetail, type Cluster, type Drawn, type State } from './lod.canvas.ts';
import { stateAtlas } from './glyphs.canvas.ts';
import { enclosed } from './navigate.canvas.ts';
import { baseMapAvailability, mountBaseMap, type MountedBaseMap } from './baseMapView.canvas.ts';

/** A layout's placement, for the layout it was made for: until the next arrives, the last is not drawn as it. */
export interface Placed { kind: LayoutKind; ids: string[]; edgeIds: [string, string][]; output: LayoutOutput }
export interface Expanded { anchor: string; nodes: { id: string; objectTypeId: string; text: string }[] }
export interface DeckMember { id: string; state: State; text: string }

export interface DeckProps {
  kind: LayoutKind;
  members: DeckMember[];
  placed: Placed | undefined;
  edges: [string, string][];
  selected: string | undefined;
  selection: ReadonlySet<string>;
  pins: readonly string[];
  changedAt: ReadonlyMap<string, number>;
  focus: ReadonlySet<string> | undefined;
  /** Hierarchy: a container's count per state over everything it contains. */
  containerCounts: ReadonlyMap<string, Record<State, number>>;
  expanded: readonly Expanded[];
  plan: { image: ImageBitmap; width: number; height: number } | undefined;
  /** A scenario overlay's badge per affected clone, carrying the scenario's label (30.9). */
  badges?: ReadonlyMap<string, string> | undefined;
  /** Compare (30.8): what changed per clone between the two times. */
  changes?: ReadonlyMap<string, string> | undefined;
  version: number;
  onSelect: (id: string, add: boolean) => void;
  onSelectMany: (ids: string[]) => void;
  /** The view's saved camera (29.6), for this layout: taken instead of fitting, the first time it is laid out. */
  camera?: { centre?: readonly [number, number] | undefined; zoom?: number | undefined } | undefined;
  /** Where the camera is now, each time it moves or is fitted: what saving the view stores. */
  onCamera?: ((camera: { centre: [number, number]; zoom: number }) => void) | undefined;
}

type Modules = { layers: typeof import('@deck.gl/layers'); core: typeof import('@deck.gl/core') };
type ViewState = { target: [number, number, number]; zoom: number };
type Deck = { setProps: (p: Record<string, unknown>) => void; finalize: () => void };

/** A colour token as deck.gl takes it: read from the theme, so light and dark both hold. */
function rgb(token: string): [number, number, number] {
  const probe = document.createElement('span');
  probe.style.color = `var(${token})`;
  document.body.appendChild(probe);
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(probe).color);
  probe.remove();
  return m === null ? [128, 128, 128] : [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Graticule steps, in degrees, for the plain grid a map is drawn on without a base map (32.8). */
const STEPS = [30, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001];

export function DeckCanvas(given: DeckProps) {
  // A placement made for another layout is not this one's: the canvas is laying out until its own arrives.
  const props = given.placed === undefined || given.placed.kind === given.kind ? given : { ...given, placed: undefined };
  const container = useRef<HTMLDivElement>(null);
  const overlay = useRef<SVGPolygonElement>(null);
  const deck = useRef<Deck | undefined>(undefined);
  const modules = useRef<Modules | undefined>(undefined);
  const view = useRef<ViewState>({ target: [0, 0, 0], zoom: 0 });
  const fitted = useRef<string | undefined>(undefined);
  const savedTaken = useRef(false);
  const mapLayer = useRef<HTMLDivElement>(null);
  const baseMap = useRef<MountedBaseMap | undefined>(undefined);
  /** The base map under a map layout: its attribution while it is drawn, or why it is not. */
  const [mapState, setMapState] = useState<{ attribution: string } | { unavailable: string } | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [zoom, setZoom] = useState(0);
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    let disposed = false;
    void (async () => {
      const [core, layers] = await Promise.all([import('@deck.gl/core'), import('@deck.gl/layers')]);
      if (disposed || container.current === null) return;
      modules.current = { core, layers };
      deck.current = new core.Deck({
        parent: container.current,
        views: new core.OrthographicView({ id: 'canvas' }),
        initialViewState: view.current,
        controller: true,
        layers: [],
        onViewStateChange: ({ viewState }: { viewState: { target?: number[] | undefined; zoom?: number | number[] | undefined } }) => {
          const z = typeof viewState.zoom === 'number' ? viewState.zoom : viewState.zoom?.[0] ?? 0;
          view.current = { target: [viewState.target?.[0] ?? 0, viewState.target?.[1] ?? 0, 0], zoom: z };
          baseMap.current?.follow(view.current);
          latest.current.onCamera?.({ centre: [view.current.target[0], view.current.target[1]], zoom: z });
          setZoom(Math.round(z * 4) / 4);
        },
        onClick: (info: { object?: { id?: string; cluster?: Cluster } | null }, event: { srcEvent?: { shiftKey?: boolean } }) => {
          const o = info.object;
          if (o?.cluster !== undefined) {
            const next = { target: [o.cluster.position[0], o.cluster.position[1], 0] as [number, number, number], zoom: view.current.zoom + 2 };
            view.current = next;
            baseMap.current?.follow(next);
            setZoom(next.zoom);
            deck.current?.setProps({ initialViewState: { ...next } });
          } else if (o?.id !== undefined) latest.current.onSelect(o.id, event.srcEvent?.shiftKey === true);
        },
        getCursor: ({ isHovering }: { isHovering: boolean }) => (isHovering ? 'pointer' : 'grab'),
      }) as unknown as Deck;
      setReady(true);
    })();
    return () => { disposed = true; deck.current?.finalize(); deck.current = undefined; };
  }, []);

  // The base map (29.3; D227): mounted under a map layout, removed with it.
  useEffect(() => {
    if (props.kind !== 'spatial_map' || !ready) return;
    let disposed = false;
    setMapState(undefined);
    void (async () => {
      const available = await baseMapAvailability();
      if (disposed || mapLayer.current === null) return;
      if ('unavailable' in available) { setMapState(available); return; }
      const colours = { surface: rgb('--surface'), sunken: rgb('--surface-sunken'), border: rgb('--border'), strong: rgb('--border-strong'), text: rgb('--text'), info: rgb('--info'), ok: rgb('--ok') };
      try {
        const mounted = await mountBaseMap(mapLayer.current, available.source, colours, view.current, (reason) => {
          if (baseMap.current === mounted) { baseMap.current = undefined; mounted.remove(); }
          if (!disposed) setMapState({ unavailable: reason });
        });
        if (disposed) { mounted.remove(); return; }
        baseMap.current = mounted;
        mounted.follow(view.current);
        setMapState({ attribution: available.source.attribution });
      } catch {
        if (!disposed) setMapState({ unavailable: 'it could not be drawn in this browser' });
      }
    })();
    return () => { disposed = true; baseMap.current?.remove(); baseMap.current = undefined; };
  }, [props.kind, ready]);

  const positions = useMemo(() => {
    const pos = new Map<string, [number, number]>();
    props.placed?.ids.forEach((id, i) => { const p = props.placed!.output.positions[i]; if (p != null) pos.set(id, p); });
    return pos;
  }, [props.placed]);
  const clusterOf = useMemo(() => {
    const c = new Map<string, number | null>();
    props.placed?.ids.forEach((id, i) => c.set(id, props.placed!.output.clusters[i] ?? null));
    return (id: string) => c.get(id) ?? null;
  }, [props.placed]);

  // A box (Shift) or lasso (Alt) drawn over the canvas, caught before deck.gl's own panning sees it.
  useEffect(() => {
    const el = container.current;
    if (el === null) return;
    let path: [number, number][] | undefined;
    let mode: 'box' | 'lasso' = 'box';
    const at = (e: PointerEvent): [number, number] => { const r = el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const polygon = (): [number, number][] => {
      if (path === undefined || path.length === 0) return [];
      if (mode === 'lasso') return path;
      const [a, b] = [path[0]!, path[path.length - 1]!];
      return [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]];
    };
    const draw = () => overlay.current?.setAttribute('points', polygon().map((p) => p.join(',')).join(' '));
    const down = (e: PointerEvent) => {
      if (!e.shiftKey && !e.altKey) return;
      mode = e.altKey ? 'lasso' : 'box';
      path = [at(e)];
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (path === undefined) return;
      e.stopPropagation();
      path.push(at(e));
      draw();
    };
    const up = (e: PointerEvent) => {
      if (path === undefined) return;
      e.stopPropagation();
      const shape = polygon();
      path = undefined;
      draw();
      if (shape.length < 3 || Math.abs(shape[0]![0] - shape[2]![0]) + Math.abs(shape[0]![1] - shape[2]![1]) < 6) return;
      const w = el.clientWidth;
      const h = el.clientHeight;
      const scale = 2 ** view.current.zoom;
      const [tx, ty] = view.current.target;
      const screen = [...positions.entries()].map(([id, p]) => ({ id, screen: [(p[0] - tx) * scale + w / 2, (p[1] - ty) * scale + h / 2] as [number, number] }));
      const shown = new Set(latest.current.members.map((m) => m.id));
      latest.current.onSelectMany(enclosed(shape, screen.filter((s) => shown.has(s.id))));
    };
    el.addEventListener('pointerdown', down, true);
    el.addEventListener('pointermove', move, true);
    el.addEventListener('pointerup', up, true);
    return () => { el.removeEventListener('pointerdown', down, true); el.removeEventListener('pointermove', move, true); el.removeEventListener('pointerup', up, true); };
  }, [positions]);

  useEffect(() => {
    const d = deck.current;
    const m = modules.current;
    if (!ready || d === undefined || m === undefined || props.placed === undefined) return;
    // Normal is neutral and unknown is never the accent, which marks the selection and a live change only (29.7).
    const colour = { normal: rgb('--text-muted'), warning: rgb('--warn'), failed: rgb('--danger'), unknown: rgb('--text'), stale: rgb('--text-muted') } as Record<State, [number, number, number]>;
    const accent = rgb('--accent');
    const textColour = rgb('--text');
    const line = rgb('--border-strong');
    const info = rgb('--info');
    const surface = rgb('--surface');
    const glyphs = stateAtlas(colour, rgb('--surface-raised'));
    const now = Date.now();
    const faded = (id: string) => props.focus !== undefined && !props.focus.has(id);
    const highlighted = (id: string) => id === props.selected || props.selection.has(id) || now - (props.changedAt.get(id) ?? 0) < 2_000 || props.changes?.has(id) === true;
    const expected = new Set(props.placed.output.expected.map((i) => props.placed!.ids[i]!));
    const members = props.members.filter((c) => positions.has(c.id));

    // Fit the camera once per layout and membership: a layout change repositions in one step, never animated.
    const key = `${props.kind}:${props.placed.ids.length}:${props.placed.ids[0] ?? ''}:${props.plan?.width ?? ''}`;
    if (fitted.current !== key && container.current !== null && (members.length > 0 || props.plan !== undefined)) {
      const xs = props.plan !== undefined ? [0, props.plan.width] : members.map((n) => positions.get(n.id)![0]);
      const ys = props.plan !== undefined ? [0, props.plan.height] : members.map((n) => positions.get(n.id)![1]);
      const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      const w = container.current.clientWidth || 800;
      const h = container.current.clientHeight || 500;
      // Room at the edges for labels, which run either side of a clone and above it.
      const z = Math.log2(Math.min(Math.max(w - 240, 80) / Math.max(maxX - minX, 1), Math.max(h - 100, 80) / Math.max(maxY - minY, 1)));
      view.current = { target: [(minX + maxX) / 2, (minY + maxY) / 2, 0], zoom: Math.min(Math.max(z, -20), 6) };
      // The view's saved camera, where it has one for this layout, the first time only (29.6).
      const saved = props.camera;
      if (!savedTaken.current && saved?.centre !== undefined && saved.zoom !== undefined) {
        view.current = { target: [saved.centre[0], saved.centre[1], 0], zoom: Math.min(Math.max(saved.zoom, -20), 20) };
      }
      savedTaken.current = true;
      props.onCamera?.({ centre: [view.current.target[0], view.current.target[1]], zoom: view.current.zoom });
      d.setProps({ initialViewState: { ...view.current } });
      baseMap.current?.follow(view.current);
      fitted.current = key;
      if (Math.round(view.current.zoom * 4) / 4 !== zoom) { setZoom(Math.round(view.current.zoom * 4) / 4); return; }
    }

    const keep = new Set([...(props.selected === undefined ? [] : [props.selected]), ...props.selection, ...props.pins, ...props.expanded.map((e) => e.anchor)]);
    const drawn: Drawn[] = members.map((c) => {
      const counts = props.kind === 'hierarchy' ? props.containerCounts.get(c.id) : undefined;
      const text = `${c.text}${expected.has(c.id) ? ' (expected)' : ''}${counts !== undefined ? ` — ${countsText(counts)}` : ''}`;
      return { id: c.id, position: positions.get(c.id)!, state: c.state, text, keep: keep.has(c.id) };
    });
    const detail = levelOfDetail({ nodes: drawn, clusterOf, kind: props.kind, zoom: view.current.zoom });
    const scale = 2 ** view.current.zoom;

    // Linked objects expanded one hop at a time (29.6): around the clone they were expanded from, at a fixed distance on screen.
    const extra = props.expanded.flatMap((e) => {
      const from = positions.get(e.anchor);
      if (from === undefined) return [];
      return e.nodes.map((n, i) => {
        const angle = (2 * Math.PI * i) / Math.max(e.nodes.length, 1) - Math.PI / 2;
        const r = (70 + 6 * Math.min(e.nodes.length, 20)) / scale;
        return { ...n, anchor: e.anchor, position: [from[0] + r * Math.cos(angle), from[1] + r * Math.sin(angle)] as [number, number] };
      });
    });

    const back = new Set(props.placed.output.backEdges.map((i) => props.placed!.edgeIds[i]).filter((e) => e !== undefined).map((e) => `${e[0]}>${e[1]}`));
    const edges = props.edges.filter(([a, b]) => positions.has(a) && positions.has(b));
    const layers: unknown[] = [];

    if (props.plan !== undefined) {
      layers.push(new m.layers.BitmapLayer({ id: 'plan', image: props.plan.image, bounds: [0, props.plan.height, props.plan.width, 0] }));
    }
    // Without a base map, a plain coordinate grid (29.12), until the tiles are drawn.
    if (props.kind === 'spatial_map' && (mapState === undefined || 'unavailable' in mapState)) layers.push(...graticule(m, container.current, view.current, line, textColour));
    if (props.kind === 'hierarchy' && props.placed.output.regions.length > 0) {
      layers.push(new m.layers.PolygonLayer({
        id: 'regions', data: props.placed.output.regions, stroked: true, filled: true, lineWidthUnits: 'pixels', getLineWidth: 1,
        getPolygon: (r: { x0: number; y0: number; x1: number; y1: number }) => [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]],
        getFillColor: (r: { depth: number }) => [...surface, 60 + 30 * r.depth], getLineColor: [...line, 160],
      }));
    }
    layers.push(
      new m.layers.LineLayer({
        id: 'edges', data: edges.filter(([a, b]) => !back.has(`${a}>${b}`)), getSourcePosition: (e: [string, string]) => positions.get(e[0])!, getTargetPosition: (e: [string, string]) => positions.get(e[1])!,
        getColor: (e: [string, string]) => [...line, faded(e[0]) && faded(e[1]) ? 40 : 160], getWidth: 1, updateTriggers: { getColor: [props.focus?.size, props.version] },
      }),
      // An edge that closes a cycle, drawn distinctly: heavier and in the information colour, and counted beside the canvas.
      new m.layers.LineLayer({
        id: 'back-edges', data: edges.filter(([a, b]) => back.has(`${a}>${b}`)), getSourcePosition: (e: [string, string]) => positions.get(e[0])!, getTargetPosition: (e: [string, string]) => positions.get(e[1])!,
        getColor: [...info, 220], getWidth: 2.5,
      }),
      new m.layers.LineLayer({
        id: 'expanded-links', data: extra, getSourcePosition: (n: { anchor: string }) => positions.get(n.anchor)!, getTargetPosition: (n: { position: [number, number] }) => n.position,
        getColor: [...line, 200], getWidth: 1,
      }),
      new m.layers.LineLayer({
        id: 'marks', data: props.placed.output.marks, getSourcePosition: (k: { x0: number; y0: number }) => [k.x0, k.y0], getTargetPosition: (k: { x1: number; y1: number }) => [k.x1, k.y1],
        getColor: [...textColour, 200], getWidth: 1.5,
      }),
      new m.layers.ScatterplotLayer({
        id: 'clusters', data: detail.clusters.map((c) => ({ cluster: c })), pickable: true, stroked: true, radiusUnits: 'pixels', lineWidthUnits: 'pixels',
        getPosition: (o: { cluster: Cluster }) => o.cluster.position, getRadius: (o: { cluster: Cluster }) => Math.min(10 + 4 * Math.log2(o.cluster.count), 30),
        getFillColor: (o: { cluster: Cluster }) => [...colour[o.cluster.worst], 200], getLineColor: [...textColour, 120], getLineWidth: 1,
      }),
      // The selection, a live change (two seconds) and the pins: a ring around the glyph, the accent for the first two only.
      new m.layers.ScatterplotLayer({
        id: 'rings', data: detail.points.filter((n) => highlighted(n.id) || props.pins.includes(n.id)), stroked: true, filled: false, radiusUnits: 'pixels', lineWidthUnits: 'pixels', getRadius: 12,
        getPosition: (n: Drawn) => n.position,
        getLineColor: (n: Drawn) => (highlighted(n.id) ? [...accent, 255] : [...textColour, 200]),
        getLineWidth: (n: Drawn) => (highlighted(n.id) ? 3 : 2),
        updateTriggers: { getLineColor: [props.selected, props.selection.size, props.version, props.pins.length], getLineWidth: [props.selected, props.selection.size, props.version, props.pins.length] },
      }),
      // Each clone as its state's glyph (28.4): shape and colour together, readable in greyscale.
      new m.layers.IconLayer({
        id: 'clones', data: detail.points, pickable: true, iconAtlas: glyphs.atlas as never, iconMapping: glyphs.mapping, sizeUnits: 'pixels', getSize: 16,
        getPosition: (n: Drawn) => n.position, getIcon: (n: Drawn) => n.state,
        getColor: (n: Drawn) => [255, 255, 255, faded(n.id) ? 60 : 255],
        updateTriggers: { getColor: [props.focus?.size, props.version], getIcon: [props.version] },
      }),
      new m.layers.ScatterplotLayer({
        id: 'expanded', data: extra, pickable: true, stroked: true, filled: true, radiusUnits: 'pixels', lineWidthUnits: 'pixels', getRadius: 5,
        getPosition: (n: { position: [number, number] }) => n.position, getFillColor: [...surface, 255], getLineColor: (n: { id: string }) => (n.id === props.selected ? [...accent, 255] : [...textColour, 200]),
        getLineWidth: (n: { id: string }) => (n.id === props.selected ? 3 : 1.5), updateTriggers: { getLineColor: [props.selected], getLineWidth: [props.selected] },
      }),
      new m.layers.TextLayer({
        id: 'labels', data: detail.labels, characterSet: 'auto', getPosition: (n: Drawn) => n.position, getText: (n: Drawn) => n.text,
        getColor: (n: Drawn) => [...textColour, faded(n.id) ? 60 : 255], getSize: 12, getPixelOffset: [0, -14], sizeUnits: 'pixels', updateTriggers: { getColor: [props.focus?.size] },
      }),
      new m.layers.TextLayer({
        id: 'expanded-labels', data: extra, characterSet: 'auto', getPosition: (n: { position: [number, number] }) => n.position, getText: (n: { text: string }) => n.text,
        getColor: [...textColour, 230], getSize: 11, getPixelOffset: [0, -12], sizeUnits: 'pixels',
      }),
      // A scenario's badge, distinct from state: boxed, below the clone, never in the live state layer.
      new m.layers.TextLayer({
        id: 'scenario-badges', data: props.badges === undefined ? [] : detail.points.filter((n) => props.badges!.has(n.id)), characterSet: 'auto',
        getPosition: (n: Drawn) => n.position, getText: (n: Drawn) => props.badges!.get(n.id)!, getSize: 11, sizeUnits: 'pixels', getPixelOffset: [0, 18],
        getColor: [...textColour, 255], background: true, getBackgroundColor: [...surface, 240], backgroundPadding: [4, 2], getBorderColor: [...textColour, 180], getBorderWidth: 1,
        updateTriggers: { getText: [props.badges?.size] },
      }),
      new m.layers.TextLayer({
        id: 'changes', data: props.changes === undefined ? [] : detail.points.filter((n) => props.changes!.has(n.id)), characterSet: 'auto',
        getPosition: (n: Drawn) => n.position, getText: (n: Drawn) => props.changes!.get(n.id)!, getSize: 11, sizeUnits: 'pixels', getPixelOffset: [0, props.badges === undefined ? 18 : 34],
        getColor: [...textColour, 230], updateTriggers: { getText: [props.changes?.size] },
      }),
      new m.layers.TextLayer({
        id: 'cluster-labels', data: detail.clusters, characterSet: 'auto', getPosition: (c: Cluster) => c.position, getText: (c: Cluster) => clusterText(c),
        getColor: [...textColour, 255], getSize: 12, getPixelOffset: [0, -24], sizeUnits: 'pixels',
      }),
      new m.layers.TextLayer({
        id: 'guides', data: [...props.placed.output.guides, ...props.placed.output.marks.map((k) => ({ x: k.x0, y: k.y0 - 12, text: k.text }))],
        getPosition: (g: { x: number; y: number }) => [g.x, g.y], getText: (g: { text: string }) => g.text, getColor: [...textColour, 200], getSize: 13, sizeUnits: 'pixels', characterSet: 'auto',
      }),
    );
    d.setProps({ layers });
  }, [ready, zoom, positions, props.members, props.placed, props.edges, props.selected, props.selection, props.pins, props.focus, props.version, props.expanded, props.plan, props.containerCounts, props.badges, props.changes, mapState]);

  return (
    <div ref={container} className={css.deck} role="img" tabIndex={0}
      aria-label={`Canvas of ${props.members.length} clones; the list view holds the same set. Arrows move the selection, Enter opens it, L expands its links, F focuses, P pins, Escape clears.`}>
      {props.kind === 'spatial_map' && <div ref={mapLayer} className={css.mapLayer} aria-hidden="true" data-attribution={mapState !== undefined && 'attribution' in mapState ? mapState.attribution : undefined} />}
      {props.placed === undefined && <p className={css.note} role="status">Laying out…</p>}
      {props.kind === 'spatial_map' && mapState !== undefined && 'unavailable' in mapState && (
        <p className={css.baseMap}>Base map unavailable: {mapState.unavailable}, so objects are drawn on a plain coordinate grid.</p>
      )}
      {props.kind === 'spatial_map' && mapState !== undefined && 'attribution' in mapState && <p className={css.attribution}>{mapState.attribution}</p>}
      <svg className={css.overlay} aria-hidden="true"><polygon ref={overlay} className={css.lasso} points="" /></svg>
    </div>
  );
}

/** A plain coordinate grid under the map, in degrees, sized to what is in view. */
function graticule(m: Modules, el: HTMLDivElement | null, v: ViewState, line: [number, number, number], text: [number, number, number]): unknown[] {
  const w = el?.clientWidth ?? 800;
  const h = el?.clientHeight ?? 500;
  const scale = 2 ** v.zoom;
  const WORLD = 1_000_000;
  const toLon = (x: number) => (x / WORLD) * 360;
  const toLat = (y: number) => (Math.atan(Math.sinh((-y / WORLD) * 2 * Math.PI)) * 180) / Math.PI;
  const toY = (lat: number) => -(Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / (2 * Math.PI)) * WORLD;
  const [x0, x1] = [v.target[0] - w / 2 / scale, v.target[0] + w / 2 / scale];
  const [y0, y1] = [v.target[1] - h / 2 / scale, v.target[1] + h / 2 / scale];
  const [west, east] = [Math.max(toLon(x0), -180), Math.min(toLon(x1), 180)];
  const [north, south] = [Math.min(toLat(y0), 85), Math.max(toLat(y1), -85)];
  const step = STEPS.find((s) => (east - west) / s >= 4) ?? STEPS[STEPS.length - 1]!;
  const lines: { from: [number, number]; to: [number, number]; text: string }[] = [];
  for (let lon = Math.ceil(west / step) * step; lon <= east && lines.length < 60; lon += step) {
    lines.push({ from: [(lon / 360) * WORLD, toY(north)], to: [(lon / 360) * WORLD, toY(south)], text: `${Number(lon.toFixed(4))}°` });
  }
  for (let lat = Math.ceil(south / step) * step; lat <= north && lines.length < 120; lat += step) {
    lines.push({ from: [(west / 360) * WORLD, toY(lat)], to: [(east / 360) * WORLD, toY(lat)], text: `${Number(lat.toFixed(4))}°` });
  }
  return [
    new m.layers.LineLayer({ id: 'graticule', data: lines, getSourcePosition: (l: { from: [number, number] }) => l.from, getTargetPosition: (l: { to: [number, number] }) => l.to, getColor: [...line, 70], getWidth: 1 }),
    new m.layers.TextLayer({ id: 'graticule-labels', data: lines, getPosition: (l: { from: [number, number] }) => l.from, getText: (l: { text: string }) => l.text, getColor: [...text, 140], getSize: 10, sizeUnits: 'pixels', getPixelOffset: [4, 4], getTextAnchor: 'start', getAlignmentBaseline: 'top', characterSet: 'auto' }),
  ];
}
