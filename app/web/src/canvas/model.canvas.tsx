'use client';

// The 3D asset view (spec 29.5, 29.7, 29.8; D228): the customer's glTF model, read from its Silo
// through the gateway in parts and drawn with three.js, each clone on the named node it is
// anchored to; a node no anchor names carries no state. The model is drawn in quiet neutrals
// (its own colours are a layer, off at first), so state is told only by the clones' glyphs,
// drawn over it in screen space with their labels, as every layout draws them; the accent marks
// the selection and, for two seconds, a live change. Orbit, pan, zoom and framing only: the
// same panel, rail and moves as every layout (click, Shift-click, box with Shift, lasso with
// Alt, arrows over what is on screen). The canvas is the picture a PNG export takes: the model
// under, the glyphs and labels over.

import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.api.ts';
import { Button } from '../components/button.component.tsx';
import css from './canvas.canvas.module.css';
import { stateAtlas } from './glyphs.canvas.ts';
import { countsText, type State } from './lod.canvas.ts';
import { fittingLabels, frameDistance, nodeGroups, type NodeGroup } from './modelScene.canvas.ts';
import { enclosed } from './navigate.canvas.ts';
import type { DeckMember } from './deck.canvas.tsx';

export interface ModelProps {
  /** levels: how many the model is served at (29.5; D249), the full one first; 1 where it has none coarser. */
  model: { id: string; name: string; levels?: number | undefined };
  members: DeckMember[];
  /** Each placed clone's node, by the anchors' names; undefined while the server places them. */
  placements: ReadonlyMap<string, string> | undefined;
  selected: string | undefined;
  selection: ReadonlySet<string>;
  pins: readonly string[];
  changedAt: ReadonlyMap<string, number>;
  focus: ReadonlySet<string> | undefined;
  badges?: ReadonlyMap<string, string> | undefined;
  changes?: ReadonlyMap<string, string> | undefined;
  ownColours: boolean;
  version: number;
  onSelect: (id: string, add: boolean) => void;
  onSelectMany: (ids: string[]) => void;
  /** Where each placed clone is on screen now, for the arrow keys. */
  onProjected: (at: ReadonlyMap<string, [number, number]>) => void;
  /** The view's saved camera (29.6): where it stands and what it looks at, taken instead of framing the model the first time. */
  camera?: { position?: readonly [number, number, number] | undefined; target?: readonly [number, number, number] | undefined } | undefined;
  /** Where the camera is now, each time it moves or is framed: what saving the view stores. */
  onCamera?: ((camera: { position: [number, number, number]; target: [number, number, number] }) => void) | undefined;
}

type Three = typeof import('three');
type Rgb = [number, number, number];
interface Scene {
  T: Three;
  renderer: import('three').WebGLRenderer;
  scene: import('three').Scene;
  camera: import('three').PerspectiveCamera;
  controls: { target: import('three').Vector3; update: () => void; dispose: () => void; addEventListener: (e: 'change', f: () => void) => void };
  root: import('three').Object3D;
  /** Each anchored-to name's objects: a name may be on several nodes, and all of them stand for it. */
  nodes: Map<string, import('three').Object3D[]>;
  centres: Map<string, import('three').Vector3>;
  meshes: { mesh: import('three').Mesh; own: import('three').Material | import('three').Material[]; node: string | undefined }[];
  /** The levels read so far (D249), and the one drawn: the parts above are its. */
  levels: Map<number, Parts>;
  level: number;
  dispose: () => void;
}

/** One level of the model as drawn: its root and what the canvas reads from it. */
type Parts = Pick<Scene, 'root' | 'nodes' | 'centres' | 'meshes'>;

function rgb(token: string): Rgb {
  const probe = document.createElement('span');
  probe.style.color = `var(${token})`;
  document.body.appendChild(probe);
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(probe).color);
  probe.remove();
  return m === null ? [128, 128, 128] : [Number(m[1]), Number(m[2]), Number(m[3])];
}
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((i) => Math.round(a[i]! + (b[i]! - a[i]!) * t)) as Rgb;
const cssOf = (c: Rgb, alpha = 1) => `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;

// The last model's levels read, kept for the page: a layout change and back does not read them again.
let cached: { id: string; levels: Map<number, ArrayBuffer> } | undefined;

/** A level of the model's bytes (0 the full model), read in parts through the gateway, each part checked as the reader. */
async function readModel(id: string, level: number, signal: AbortSignal, progress: (read: number, total: number) => void): Promise<ArrayBuffer> {
  if (cached?.id !== id) cached = { id, levels: new Map() };
  const held = cached.levels.get(level);
  if (held !== undefined) return held;
  let out: Uint8Array | undefined;
  let offset = 0;
  let total = 1;
  while (offset < total) {
    const part = await api.call('readAssetModel', { params: { assetModelId: id }, query: { offset, level } }, { signal });
    total = part.bytes;
    out ??= new Uint8Array(total);
    const binary = atob(part.content);
    if (binary.length === 0) throw new Error('the model ended early');
    for (let i = 0; i < binary.length; i++) out[offset + i] = binary.charCodeAt(i);
    offset += binary.length;
    progress(offset, total);
  }
  const buffer = out!.buffer as ArrayBuffer;
  if (cached.id === id) cached.levels.set(level, buffer);
  return buffer;
}

/** The extensions a .glb names, from its JSON chunk: which decoders to load. */
function extensionsUsed(buffer: ArrayBuffer): string[] {
  const view = new DataView(buffer);
  const length = view.getUint32(12, true);
  const doc = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, length))) as { extensionsUsed?: string[] };
  return doc.extensionsUsed ?? [];
}

/** One level parsed: its root, its named nodes and their centres, its meshes. */
async function parse(T: Three, renderer: import('three').WebGLRenderer, buffer: ArrayBuffer): Promise<Parts> {
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const loader = new GLTFLoader();
  // Compressed meshes and textures, decoded here with three's own decoders, served from this origin.
  const used = extensionsUsed(buffer);
  if (used.includes('KHR_draco_mesh_compression')) {
    const { DRACOLoader } = await import('three/addons/loaders/DRACOLoader.js');
    loader.setDRACOLoader(new DRACOLoader().setDecoderPath('/three/draco/'));
  }
  if (used.includes('KHR_texture_basisu')) {
    const { KTX2Loader } = await import('three/addons/loaders/KTX2Loader.js');
    loader.setKTX2Loader(new KTX2Loader().setTranscoderPath('/three/basis/').detectSupport(renderer));
  }
  if (used.includes('EXT_meshopt_compression')) {
    const { MeshoptDecoder } = await import('three/addons/libs/meshopt_decoder.module.js');
    loader.setMeshoptDecoder(MeshoptDecoder);
  }
  const gltf = await loader.parseAsync(buffer, '');
  const root = gltf.scene;

  // Named nodes by their name in the file (three renames them for animation bindings).
  const json = gltf.parser.json as { nodes?: { name?: string }[] };
  const nodes = new Map<string, import('three').Object3D[]>();
  const nameOf = new Map<import('three').Object3D, string>();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const index = gltf.parser.associations.get(o)?.nodes;
    const name = index === undefined ? undefined : json.nodes?.[index]?.name;
    if (typeof name !== 'string' || name.trim() === '') return;
    nameOf.set(o, name);
    nodes.set(name, [...(nodes.get(name) ?? []), o]);
  });
  const centres = new Map<string, import('three').Vector3>();
  for (const [name, objects] of nodes) {
    const box = new T.Box3();
    for (const o of objects) box.expandByObject(o);
    centres.set(name, box.isEmpty() ? objects[0]!.getWorldPosition(new T.Vector3()) : box.getCenter(new T.Vector3()));
  }
  const meshes: Scene['meshes'] = [];
  root.traverse((o) => {
    if (!(o as import('three').Mesh).isMesh) return;
    let node: string | undefined;
    for (let p: import('three').Object3D | null = o; p !== null && node === undefined; p = p.parent) node = nameOf.get(p);
    const mesh = o as import('three').Mesh;
    meshes.push({ mesh, own: mesh.material, node });
  });
  return { root, nodes, centres, meshes };
}

async function build(container: HTMLDivElement, overlay: HTMLCanvasElement, buffer: ArrayBuffer, level: number): Promise<Scene> {
  const [T, { OrbitControls }] = await Promise.all([import('three'), import('three/addons/controls/OrbitControls.js')]);
  const renderer = new T.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.domElement.dataset['under'] = 'model';
  renderer.domElement.dataset['level'] = String(level);
  renderer.domElement.className = css.modelLayer!;
  container.insertBefore(renderer.domElement, overlay);
  const parts = await parse(T, renderer, buffer);
  const scene = new T.Scene();
  scene.add(parts.root);
  scene.add(new T.HemisphereLight(0xffffff, 0x8a8f98, 2.2));
  const camera = new T.PerspectiveCamera(45, 1, 0.01, 1000);
  const key = new T.DirectionalLight(0xffffff, 1.4);
  key.position.set(0.5, 1, 1);
  camera.add(key);
  scene.add(camera);
  const controls = new OrbitControls(camera, overlay);
  controls.enableDamping = false;
  controls.zoomToCursor = true;
  const levels = new Map([[level, parts]]);
  return {
    T, renderer, scene, camera, controls, ...parts, levels, level,
    dispose: () => {
      controls.dispose();
      for (const held of levels.values()) {
        held.root.traverse((o) => {
          const mesh = o as import('three').Mesh;
          mesh.geometry?.dispose();
          for (const m of [mesh.material].flat()) (m as import('three').Material | undefined)?.dispose();
        });
      }
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

/** Draws another level in place of the one drawn: the camera stays where it is. */
function swapTo(s: Scene, level: number): void {
  const parts = s.levels.get(level);
  if (parts === undefined || s.level === level) return;
  s.scene.remove(s.root);
  s.scene.add(parts.root);
  Object.assign(s, parts, { level });
  s.renderer.domElement.dataset['level'] = String(level);
}

/**
 * The level the camera wants (D249): the full model while the model fills a good part of the
 * view, a coarser one as it shrinks on screen, never one the model does not have.
 */
function wantedLevel(s: Scene, count: number): number {
  if (count <= 1) return 0;
  const sphere = new s.T.Box3().expandByObject(s.root).getBoundingSphere(new s.T.Sphere());
  const distance = Math.max(s.camera.position.distanceTo(sphere.center), 1e-6);
  const share = sphere.radius / (distance * Math.tan((s.camera.fov * Math.PI) / 360));
  return Math.min(count - 1, share > 0.35 ? 0 : share > 0.12 ? 1 : 2);
}

export function ModelCanvas(props: ModelProps) {
  const container = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const lasso = useRef<SVGPolygonElement>(null);
  const built = useRef<Scene | undefined>(undefined);
  const latest = useRef(props);
  latest.current = props;
  const screen = useRef<{ group: NodeGroup; x: number; y: number }[]>([]);
  const [loading, setLoading] = useState<string | undefined>('Reading the model…');
  const [problem, setProblem] = useState<string | undefined>();
  const [ready, setReady] = useState(0);
  /** Counts each level drawn in place of another: what reads the meshes runs again, the camera stays. */
  const [swapped, setSwapped] = useState(0);
  const fetching = useRef(new Set<number>());

  /** Draws the level the camera wants: read first where it is not yet held. */
  const followLevel = () => {
    const s = built.current;
    const count = latest.current.model.levels ?? 1;
    if (s === undefined || count <= 1) return;
    const want = wantedLevel(s, count);
    if (want === s.level) return;
    if (s.levels.has(want)) {
      swapTo(s, want);
      setSwapped((n) => n + 1);
      return;
    }
    if (fetching.current.has(want)) return;
    fetching.current.add(want);
    void (async () => {
      try {
        const buffer = await readModel(latest.current.model.id, want, new AbortController().signal, () => undefined);
        if (built.current !== s) return;
        s.levels.set(want, await parse(s.T, s.renderer, buffer));
        followLevel();
      } catch {
        // The level drawn stays: a coarser or finer one is a nicety, never a refusal.
      } finally {
        fetching.current.delete(want);
      }
    })();
  };

  /** Draws the model, then the clones over it; reports where each clone is on screen. */
  const render = () => {
    const s = built.current;
    const o = overlay.current;
    if (s === undefined || o === null) return;
    const p = latest.current;
    s.renderer.render(s.scene, s.camera);
    const g = o.getContext('2d')!;
    const ratio = window.devicePixelRatio;
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, o.width, o.height);
    if (p.placements === undefined) return;
    const colour = { normal: rgb('--text-muted'), warning: rgb('--warn'), failed: rgb('--danger'), unknown: rgb('--text'), stale: rgb('--text-muted') } as Record<State, Rgb>;
    const [accent, text, surface] = [rgb('--accent'), rgb('--text'), rgb('--surface')];
    const atlas = stateAtlas(colour, rgb('--surface-raised'));
    const now = Date.now();
    const state = new Map(p.members.map((m) => [m.id, m]));
    const groups = nodeGroups(p.members, p.placements);
    const [w, h] = [o.clientWidth, o.clientHeight];
    const v = new s.T.Vector3();
    const at: { group: NodeGroup; x: number; y: number }[] = [];
    for (const group of groups) {
      const c = s.centres.get(group.node);
      if (c === undefined) continue;
      v.copy(c).project(s.camera);
      if (v.z > 1 || v.z < -1) continue;
      at.push({ group, x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h });
    }
    screen.current = at;
    const projected = new Map<string, [number, number]>();
    for (const a of at) for (const id of a.group.ids) projected.set(id, [a.x, a.y]);
    p.onProjected(projected);

    const highlighted = (id: string) => id === p.selected || p.selection.has(id) || now - (p.changedAt.get(id) ?? 0) < 2_000 || p.changes?.has(id) === true;
    const faded = (grp: NodeGroup) => p.focus !== undefined && !grp.ids.some((id) => p.focus!.has(id));
    const labelOf = (grp: NodeGroup) => (grp.ids.length === 1 ? state.get(grp.ids[0]!)!.text : `${grp.ids.length} · ${countsText(grp.states)}`);
    g.font = '12px system-ui, sans-serif';
    const boxes = at.map((a, i) => {
      const width = g.measureText(labelOf(a.group)).width + 4;
      const keep = a.group.ids.some((id) => id === p.selected || p.selection.has(id) || p.pins.includes(id));
      return { id: String(i), x: a.x - width / 2, y: a.y - (a.group.ids.length > 1 ? 36 : 30), width, height: 16, keep, rank: ['failed', 'warning', 'unknown', 'stale', 'normal'].indexOf(a.group.worst) };
    });
    const labelled = fittingLabels(boxes);
    at.forEach((a, i) => {
      const grp = a.group;
      g.globalAlpha = faded(grp) ? 0.25 : 1;
      const lit = grp.ids.some(highlighted);
      const pinned = grp.ids.some((id) => p.pins.includes(id));
      if (lit || pinned) {
        g.beginPath();
        g.arc(a.x, a.y, 12, 0, Math.PI * 2);
        g.strokeStyle = cssOf(lit ? accent : text, lit ? 1 : 0.8);
        g.lineWidth = lit ? 3 : 2;
        g.stroke();
      }
      const shown: State = grp.ids.length === 1 ? state.get(grp.ids[0]!)!.state : grp.worst;
      const m = atlas.mapping[shown];
      g.drawImage(atlas.atlas, m.x, m.y, m.width, m.height, a.x - 8, a.y - 8, 16, 16);
      if (grp.ids.length > 1) {
        g.beginPath();
        g.arc(a.x + 10, a.y - 10, 7, 0, Math.PI * 2);
        g.fillStyle = cssOf(surface);
        g.fill();
        g.strokeStyle = cssOf(text, 0.7);
        g.lineWidth = 1;
        g.stroke();
        g.fillStyle = cssOf(text);
        g.font = '600 9px system-ui, sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(grp.ids.length > 99 ? '99+' : String(grp.ids.length), a.x + 10, a.y - 10);
        g.font = '12px system-ui, sans-serif';
      }
      g.textAlign = 'center';
      g.textBaseline = 'alphabetic';
      if (labelled.has(String(i))) {
        // A halo in the surface colour keeps a label readable over any part of the model; above a count's badge where there is one.
        const y = a.y - (grp.ids.length > 1 ? 22 : 16);
        g.lineWidth = 3;
        g.lineJoin = 'round';
        g.miterLimit = 2;
        g.strokeStyle = cssOf(surface, 0.9);
        g.strokeText(labelOf(grp), a.x, y);
        g.fillStyle = cssOf(text);
        g.fillText(labelOf(grp), a.x, y);
      }
      // A scenario's badge, boxed below the clone, and what changed between two times below that.
      const one = grp.ids.length === 1 ? grp.ids[0]! : undefined;
      let below = 26;
      for (const note of [one === undefined ? undefined : p.badges?.get(one), one === undefined ? undefined : p.changes?.get(one)]) {
        if (note === undefined) continue;
        const width = g.measureText(note).width + 8;
        if (note === p.badges?.get(one!)) {
          g.fillStyle = cssOf(surface, 0.95);
          g.fillRect(a.x - width / 2, a.y + below - 12, width, 16);
          g.strokeStyle = cssOf(text, 0.7);
          g.lineWidth = 1;
          g.strokeRect(a.x - width / 2, a.y + below - 12, width, 16);
        }
        g.fillStyle = cssOf(text);
        g.fillText(note, a.x, a.y + below);
        below += 18;
      }
    });
    g.globalAlpha = 1;
  };

  // The model: read, built, framed. Its materials are the quiet neutrals until its own colours are asked for.
  useEffect(() => {
    const el = container.current;
    const o = overlay.current;
    if (el === null || o === null) return;
    const abort = new AbortController();
    let scene: Scene | undefined;
    setProblem(undefined);
    setLoading('Reading the model…');
    void (async () => {
      try {
        // The coarsest level first, so a large model is seen at once; the full one follows (D249).
        const first = Math.max(0, (props.model.levels ?? 1) - 1);
        const buffer = await readModel(props.model.id, first, abort.signal, (read, total) =>
          setLoading(`Reading the model: ${(read / 1_048_576).toFixed(1)} of ${(total / 1_048_576).toFixed(1)} MB…`));
        if (abort.signal.aborted) return;
        setLoading('Drawing the model…');
        scene = await build(el, o, buffer, first);
        if (abort.signal.aborted) { scene.dispose(); return; }
        built.current = scene;
        scene.controls.addEventListener('change', render);
        scene.controls.addEventListener('change', () => reportCamera());
        scene.controls.addEventListener('change', () => followLevel());
        setLoading(undefined);
        setReady((n) => n + 1);
        if (first > 0) {
          const full = await readModel(props.model.id, 0, abort.signal, () => undefined);
          if (abort.signal.aborted || built.current !== scene) return;
          scene.levels.set(0, await parse(scene.T, scene.renderer, full));
          if (abort.signal.aborted || built.current !== scene) return;
          followLevel();
        }
      } catch (e) {
        if (!abort.signal.aborted) {
          setLoading(undefined);
          setProblem(`The model could not be drawn here (${e instanceof Error ? e.message : 'it could not be read'}); the list holds the same set.`);
        }
      }
    })();
    return () => { abort.abort(); built.current = undefined; scene?.dispose(); };
  }, [props.model.id]);

  // Size: the drawing buffer follows the element.
  useEffect(() => {
    const el = container.current;
    const o = overlay.current;
    if (el === null || o === null) return;
    const resize = () => {
      const [w, h] = [Math.max(el.clientWidth, 1), Math.max(el.clientHeight, 1)];
      o.width = Math.round(w * window.devicePixelRatio);
      o.height = Math.round(h * window.devicePixelRatio);
      const s = built.current;
      if (s !== undefined) {
        s.renderer.setSize(w, h, false);
        s.camera.aspect = w / h;
        s.camera.updateProjectionMatrix();
      }
      render();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    resize();
    return () => observer.disconnect();
  }, [ready]);

  /** Frames the chosen clones' nodes, or the whole model; one step, never animated. */
  const frame = (ids?: readonly string[]) => {
    const s = built.current;
    const el = container.current;
    if (s === undefined || el === null) return;
    const box = new s.T.Box3();
    if (ids === undefined) box.expandByObject(s.root);
    else {
      const names = new Set(ids.map((id) => latest.current.placements?.get(id)).filter((n): n is string => n !== undefined));
      for (const name of names) for (const o of s.nodes.get(name) ?? []) box.expandByObject(o);
      for (const name of names) if (s.centres.has(name)) box.expandByPoint(s.centres.get(name)!);
    }
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new s.T.Sphere());
    const distance = frameDistance(sphere.radius, s.camera.fov, el.clientWidth / Math.max(el.clientHeight, 1));
    const direction = s.camera.position.clone().sub(s.controls.target);
    if (direction.lengthSq() === 0) direction.set(1, 0.8, 1.2);
    s.controls.target.copy(sphere.center);
    s.camera.position.copy(sphere.center).add(direction.normalize().multiplyScalar(distance));
    s.camera.near = Math.max(distance / 1000, 1e-4);
    s.camera.far = distance * 100 + sphere.radius * 10;
    s.camera.updateProjectionMatrix();
    s.controls.update();
    render();
  };
  /** Tells the canvas where the camera stands and looks, rounded to what a saved view keeps. */
  const reportCamera = () => {
    const s = built.current;
    if (s === undefined) return;
    const round = (v: { x: number; y: number; z: number }): [number, number, number] => [v.x, v.y, v.z].map((n) => Math.round(n * 1e6) / 1e6) as [number, number, number];
    latest.current.onCamera?.({ position: round(s.camera.position), target: round(s.controls.target) });
  };
  /** The view's saved camera, the first time the model is drawn: where it stood, what it looked at, framed depth kept. */
  const savedTaken = useRef(false);
  const takeSaved = (): boolean => {
    const s = built.current;
    const saved = latest.current.camera;
    if (savedTaken.current || s === undefined || saved?.position === undefined || saved.target === undefined) return false;
    savedTaken.current = true;
    s.controls.target.set(...saved.target);
    s.camera.position.set(...saved.position);
    const distance = Math.max(s.camera.position.distanceTo(s.controls.target), 1e-3);
    const radius = new s.T.Box3().expandByObject(s.root).getBoundingSphere(new s.T.Sphere()).radius;
    s.camera.near = Math.max(distance / 1000, 1e-4);
    s.camera.far = distance * 100 + radius * 10;
    s.camera.updateProjectionMatrix();
    s.controls.update();
    render();
    return true;
  };
  useEffect(() => {
    if (ready === 0) return;
    if (!takeSaved()) { savedTaken.current = true; frame(); }
    reportCamera();
  }, [ready]);

  // The model's materials: neutrals, a step stronger where an anchor names the part, the accent on the selection's parts.
  useEffect(() => {
    const s = built.current;
    if (s === undefined) return;
    const p = props;
    const base = mix(rgb('--surface-raised'), rgb('--text'), 0.22);
    const anchoredColour = mix(rgb('--surface-raised'), rgb('--text'), 0.38);
    const chosen = mix(base, rgb('--accent'), 0.3);
    const anchored = new Set(p.placements === undefined ? [] : p.placements.values());
    const selectedNodes = new Set([p.selected, ...p.selection].map((id) => (id === undefined ? undefined : p.placements?.get(id))).filter((n): n is string => n !== undefined));
    const material = (c: Rgb) => new s.T.MeshStandardMaterial({ color: new s.T.Color(`rgb(${c.join(',')})`), roughness: 0.85, metalness: 0 });
    const [plain, strong, lit] = [material(base), material(anchoredColour), material(chosen)];
    for (const m of s.meshes) {
      const sides = [m.own].flat().map((x) => x.side);
      const pick = m.node !== undefined && selectedNodes.has(m.node) ? lit : p.ownColours ? undefined : m.node !== undefined && anchored.has(m.node) ? strong : plain;
      if (pick === undefined) { m.mesh.material = m.own; continue; }
      pick.side = sides[0] ?? s.T.FrontSide;
      m.mesh.material = pick;
    }
    render();
    return () => { plain.dispose(); strong.dispose(); lit.dispose(); };
  }, [ready, swapped, props.ownColours, props.placements, props.selected, props.selection]);

  // The clones over it: redrawn as state, selection, focus and overlays change; a live change's accent ends after two seconds.
  useEffect(() => {
    render();
    const recent = [...props.changedAt.values()].some((t) => Date.now() - t < 2_000);
    if (!recent) return;
    const timer = setTimeout(render, 2_100);
    return () => clearTimeout(timer);
  }, [ready, swapped, props.members, props.placements, props.selected, props.selection, props.pins, props.focus, props.version, props.badges, props.changes]);

  // Clicks select (a glyph first, then a part an anchor names); Shift-drag boxes and Alt-drag lassoes, before orbiting sees them.
  useEffect(() => {
    const el = container.current;
    const o = overlay.current;
    if (el === null || o === null) return;
    let path: [number, number][] | undefined;
    let mode: 'box' | 'lasso' = 'box';
    let downAt: [number, number] | undefined;
    const at = (e: PointerEvent): [number, number] => { const r = el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const polygon = (): [number, number][] => {
      if (path === undefined || path.length === 0) return [];
      if (mode === 'lasso') return path;
      const [a, b] = [path[0]!, path[path.length - 1]!];
      return [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]];
    };
    const draw = () => lasso.current?.setAttribute('points', polygon().map((p) => p.join(',')).join(' '));
    const down = (e: PointerEvent) => {
      downAt = at(e);
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
      const here = at(e);
      const shape = polygon();
      const wasPath = path !== undefined;
      if (wasPath) { e.stopPropagation(); path = undefined; draw(); }
      const moved = downAt === undefined ? 99 : Math.hypot(here[0] - downAt[0], here[1] - downAt[1]);
      downAt = undefined;
      if (wasPath && moved >= 6 && shape.length >= 3) {
        const points = screen.current.flatMap((a) => a.group.ids.map((id) => ({ id, screen: [a.x, a.y] as [number, number] })));
        latest.current.onSelectMany(enclosed(shape, points));
        return;
      }
      if (moved >= 4) return;
      const hit = screen.current.map((a) => ({ a, d: Math.hypot(a.x - here[0], a.y - here[1]) })).filter((x) => x.d <= 14).sort((x, y) => x.d - y.d)[0]?.a.group
        ?? partAt(here);
      if (hit === undefined) return;
      if (hit.ids.length === 1) latest.current.onSelect(hit.ids[0]!, e.shiftKey);
      else latest.current.onSelectMany(hit.ids);
    };
    const partAt = (here: [number, number]): NodeGroup | undefined => {
      const s = built.current;
      const p = latest.current;
      if (s === undefined || p.placements === undefined) return undefined;
      const ray = new s.T.Raycaster();
      ray.setFromCamera(new s.T.Vector2((here[0] / el.clientWidth) * 2 - 1, -(here[1] / el.clientHeight) * 2 + 1), s.camera);
      const owner = new Map(s.meshes.map((m) => [m.mesh as import('three').Object3D, m.node]));
      const node = ray.intersectObject(s.root, true).map((i) => owner.get(i.object)).find((n) => n !== undefined);
      return node === undefined ? undefined : nodeGroups(p.members, p.placements).find((g) => g.node === node);
    };
    el.addEventListener('pointerdown', down, true);
    el.addEventListener('pointermove', move, true);
    el.addEventListener('pointerup', up, true);
    return () => { el.removeEventListener('pointerdown', down, true); el.removeEventListener('pointermove', move, true); el.removeEventListener('pointerup', up, true); };
  }, []);

  const chosen = [...new Set([...(props.selected === undefined ? [] : [props.selected]), ...props.selection])].filter((id) => props.placements?.has(id));
  return (
    <div className={css.modelWrap}>
      <div className={css.controls} role="group" aria-label="Camera">
        <Button size="sm" onClick={() => frame()} disabled={loading !== undefined || problem !== undefined}>Frame all</Button>
        <Button size="sm" onClick={() => frame(chosen)} disabled={chosen.length === 0 || loading !== undefined}>Frame the selection</Button>
      </div>
      <div ref={container} className={css.deck} role="img" tabIndex={0}
        aria-label={`3D model ${props.model.name} with ${props.members.length} clones; the list view holds the same set. Drag to orbit, right-drag to pan, scroll to zoom. Arrows move the selection, Enter opens it, F focuses, P pins, Escape clears.`}>
        <canvas ref={overlay} className={css.modelOverlay} />
        {loading !== undefined && <p className={css.note} role="status">{loading}</p>}
        {problem !== undefined && <p className={css.note} role="alert">{problem}</p>}
        <svg className={css.overlay} aria-hidden="true"><polygon ref={lasso} className={css.lasso} points="" /></svg>
      </div>
    </div>
  );
}
