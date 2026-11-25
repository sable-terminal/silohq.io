'use client';

// The Studio widgets of the canvas and scenario stages (spec 35.5): a Clone Canvas embed (a canvas
// layout over an object set variable, emitting selection), a map (the spatial layout over a set
// with a geographic property, read only), a scenario control (select, create or switch a scenario
// branch, its staged Actions shown, never executed here) and Ask scoped to the app. An app's set is
// a definition run for the viewer, not a saved set, so the embed and the map draw from that run,
// not a live subscription, and say so; states come from the type's active rule over the values the
// viewer read. The drawing is the Clone Canvas's own: the same layouts, glyphs and level of detail.

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { DeckCanvas, type Placed } from '../../canvas/deck.canvas.tsx';
import type { LayoutInput, LayoutKind, LayoutOutput } from '../../canvas/layouts.canvas.ts';
import type { State } from '../../canvas/lod.canvas.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Button, LinkButton } from '../../components/button.component.tsx';
import { SelectField, TextField } from '../../components/field.component.tsx';
import { EmptyState, ErrorMessage, Loading } from '../../components/states.component.tsx';
import { useData, useMutation, useQuery } from '../../data/query.data.ts';
import { scenarioHref } from '../../navigation/links.navigation.ts';
import { formatNumber, humanise, plural } from '../../utils/format.util.ts';
import { ThreadView } from '../ask/thread.view.tsx';
import { useRows, useRuntime, type Of, type ResultObject } from './runtime.view.ts';
import { Unanswered } from './widgets.view.tsx';
import styles from './studio.view.module.css';

const show = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const LINKED: LayoutKind[] = ['hierarchy', 'graph_layered', 'graph_force'];

/** Each object's state now, from the type's active rule over the values the viewer read plainly (masked and redacted ones withheld). */
function useStates(objectTypeId: string | undefined, objects: ResultObject[] | undefined): Map<string, State> | undefined {
  const { api } = useData();
  const [states, setStates] = useState<Map<string, State> | undefined>();
  const key = objects?.map((o) => o.id).join(',') ?? '';
  useEffect(() => {
    if (objectTypeId === undefined || objects === undefined) return;
    let live = true;
    const plain = (o: ResultObject) => Object.fromEntries(Object.entries(o.values).filter(([k]) => !o.masked.includes(k) && !o.redacted.includes(k)));
    api.call('evaluateCloneStates', { body: { objectTypeId, objects: objects.slice(0, 20_000).map((o) => ({ ref: o.id, values: plain(o) as never })) } })
      .then((out) => live && setStates(new Map(out.states.map((s) => [s.ref, s.state as State]))), () => live && setStates(new Map()));
    return () => {
      live = false;
    };
    // The key carries the members.
  }, [objectTypeId, key, api]);
  return states;
}

/** Positions from the canvas's layout worker. */
function usePlaced(input: LayoutInput | undefined, ids: string[], edgeIds: [string, string][]): Placed | undefined {
  const worker = useRef<Worker | undefined>(undefined);
  const [placed, setPlaced] = useState<Placed | undefined>();
  useEffect(() => {
    worker.current = new Worker(new URL('../../canvas/layoutWorker.canvas.ts', import.meta.url), { type: 'module' });
    return () => worker.current?.terminate();
  }, []);
  const key = input === undefined ? '' : JSON.stringify([input.kind, ids, input.edges, input.nodes.map((n) => [n.stage, n.time, n.lane, n.position])]);
  useEffect(() => {
    const w = worker.current;
    if (input === undefined || w === undefined) {
      setPlaced(undefined);
      return;
    }
    const id = Date.now() + Math.random();
    const onMessage = (event: MessageEvent<{ id: number; output: LayoutOutput }>) => {
      if (event.data.id === id) setPlaced({ kind: input.kind, ids, edgeIds, output: event.data.output });
    };
    w.addEventListener('message', onMessage);
    w.postMessage({ id, input });
    return () => w.removeEventListener('message', onMessage);
    // The key carries the input.
  }, [key]);
  return placed;
}

/** The canvas over an app's set: layout, links, states and the drawing; shared by the embed and the map. */
function SetCanvas({ source, kind, geoPropertyId, selected, onSelect }: {
  source: string; kind: LayoutKind; geoPropertyId?: string | undefined; selected: string | undefined; onSelect: ((id: string) => void) | undefined;
}) {
  const r = useRuntime();
  const { api } = useData();
  const variable = r.definition.variables[source];
  const objectTypeId = variable?.kind === 'objectSet' ? variable.objectTypeId : undefined;
  const layouts = useQuery('listCloneLayouts', objectTypeId === undefined ? null : { body: { objectTypeIds: [objectTypeId] } });
  const rules = useQuery('getActiveStateRules', objectTypeId === undefined ? null : { body: { objectTypeIds: [objectTypeId] } });
  const manifest = useQuery('readOntology', { query: {} }, { staleMs: 5 * 60_000 });
  const ready = layouts.status !== 'loading' && rules.status !== 'loading' && manifest.data !== undefined;
  const config = layouts.data?.layouts[0] ?? null;
  const inputs = rules.data?.rules[0]?.inputs.map((i) => i.propertyIdentityId) ?? [];
  const type = manifest.data?.objectTypes.find((t) => t.id === objectTypeId);
  const geoId = geoPropertyId ?? config?.geoPropertyId ?? undefined;
  const wanted = [config?.labelPropertyId ?? type?.titlePropertyIdentityId, config?.stagePropertyId, config?.timePropertyId, config?.lanePropertyId, geoId, ...inputs]
    .filter((x): x is string => typeof x === 'string');
  const rows = useRows(source, ready ? [...new Set(wanted)] : [], r.refreshOf(source));
  const objects = rows.state === 'answer' ? rows.objects : undefined;
  const states = useStates(objectTypeId, objects);
  const apiOf = (id: string | null | undefined) => (id == null || rows.state !== 'answer' ? undefined : rows.columns.find((c) => c.property === id)?.apiName);
  const label = apiOf(config?.labelPropertyId ?? type?.titlePropertyIdentityId);

  // Links the layout follows, between members of the set, read as the viewer.
  const [edges, setEdges] = useState<[string, string][]>([]);
  const link = kind === 'hierarchy' ? manifest.data?.linkTypes.find((l) => l.id === config?.containmentLinkTypeId)
    : manifest.data?.linkTypes.find((l) => l.status !== 'retired' && l.fromTypeId === objectTypeId && l.toTypeId === objectTypeId);
  const memberKey = objects?.map((o) => o.id).join(',') ?? '';
  useEffect(() => {
    const routeId = link?.defaultRouteId ?? link?.routes[0]?.id;
    const m = manifest.data;
    if (!LINKED.includes(kind) || link === undefined || routeId === undefined || m === undefined || objects === undefined) {
      setEdges([]);
      return;
    }
    let live = true;
    api.call('runStructuredPlan', { body: { plan: { schemaVersion: '1', ontologyVersionId: m.version.id, nodes: [{ objectTypeId: link.fromTypeId, filters: [] }, { objectTypeId: link.toTypeId, filters: [] }],
      hops: [{ from: 0, to: 1, linkTypeId: link.id, routeId }], select: [] }, parameters: {} } })
      .then((out) => {
        if (!live || out.outcome !== 'answer') return;
        const ids = new Set(objects.map((o) => o.id));
        setEdges(out.result.page.objects.flatMap((o) => (o.links['0'] ?? []).filter((l) => ids.has(o.id) && ids.has(l.id)).map((l) => [o.id, l.id] as [string, string])));
      }, () => undefined);
    return () => {
      live = false;
    };
    // The member key carries the objects.
  }, [link?.id, kind, memberKey, manifest.data?.version.id, api]);

  const ids = useMemo(() => objects?.map((o) => o.id) ?? [], [memberKey]);
  const index = new Map(ids.map((id, i) => [id, i]));
  const pairs = edges.filter(([a, b]) => index.has(a) && index.has(b));
  const stage = apiOf(config?.stagePropertyId);
  const time = apiOf(config?.timePropertyId);
  const lane = apiOf(config?.lanePropertyId);
  const geo = apiOf(geoId);
  const input: LayoutInput | undefined = objects === undefined || !ready ? undefined : {
    kind, now: Date.now(), crs: geoId === config?.geoPropertyId ? config?.crs ?? undefined : undefined,
    nodes: objects.map((o) => ({
      id: o.id,
      stage: stage === undefined ? undefined : (o.values[stage] == null ? null : String(o.values[stage])),
      time: time === undefined ? undefined : (typeof o.values[time] === 'number' ? o.values[time] as number : Date.parse(String(o.values[time]))),
      lane: lane === undefined ? undefined : (o.values[lane] == null ? null : String(o.values[lane])),
      position: geo === undefined ? undefined : o.values[geo],
    })),
    edges: pairs.map(([a, b]) => [index.get(a)!, index.get(b)!] as [number, number]),
  };
  const placed = usePlaced(input, ids, pairs);

  if (objectTypeId === undefined) return <p className={styles.muted}>This widget&apos;s source is not an object set.</p>;
  if (manifest.status === 'error') return <ErrorMessage error={manifest.error} onRetry={manifest.refetch} />;
  if (!ready) return <Loading label="Setting up the canvas" block={false} />;
  if (rows.state !== 'answer') return <Unanswered rows={rows} />;
  const notPlaced = placed?.output.notPlaced.length ?? 0;
  const text = (o: ResultObject) => show(label === undefined ? o.id.slice(0, 8) : o.values[label]);
  return (
    <div className={styles.stackTight}>
      <DeckCanvas kind={kind} members={rows.objects.map((o) => ({ id: o.id, state: states?.get(o.id) ?? 'unknown', text: text(o) }))} placed={placed} edges={pairs}
        selected={selected} selection={new Set()} pins={[]} changedAt={new Map()} focus={undefined} containerCounts={new Map()} expanded={[]} plan={undefined}
        version={states?.size ?? 0}
        onSelect={(id) => onSelect?.(id)} onSelectMany={(chosen) => {
          if (chosen[0] !== undefined) onSelect?.(chosen[0]);
        }} />
      <p className={styles.muted}>
        {formatNumber(rows.total)} {type?.pluralName.toLowerCase() ?? 'objects'} as read for you just now, not live{notPlaced > 0 ? `; ${formatNumber(notPlaced)} not placed by this layout` : ''}.{' '}
        <Link href="/clones/canvas/">Open the Clone Canvas</Link> for live state.
      </p>
    </div>
  );
}

export function CanvasEmbed({ w }: { w: Of<'canvasEmbed'> }) {
  const r = useRuntime();
  const [selected, setSelected] = useState<string | undefined>();
  if (w.layout === 'spatial_3d' || w.layout === 'list') {
    return <p className={styles.muted}>{w.layout === 'list' ? 'A list layout is drawn by the object table widget.' : 'The 3D asset view opens in the Clone Canvas.'}</p>;
  }
  return <SetCanvas source={w.source} kind={w.layout as LayoutKind} selected={selected} onSelect={(id) => {
    setSelected(id);
    if (w.emits?.selectionChanged !== undefined) r.emit(w, 'selectionChanged', [id]);
  }} />;
}

export function MapWidget({ w }: { w: Of<'map'> }) {
  return <SetCanvas source={w.source} kind="spatial_map" geoPropertyId={w.geoPropertyId} selected={undefined} onSelect={undefined} />;
}

type Branch = Output<'listSimulationBranches'>['branches'][number];

/** Select, create or switch a scenario branch, held in the app's scenario variable; its staged Actions shown, never executed here. */
export function ScenarioControl({ w }: { w: Of<'scenarioControl'> }) {
  const r = useRuntime();
  const current = r.parameters[w.variable];
  const mine = useQuery('listSimulationScenarios', { query: { filter: 'mine' } });
  const shared = useQuery('listSimulationScenarios', { query: { filter: 'shared' } });
  const [scenarioId, setScenarioId] = useState('');
  const branches = useQuery('listSimulationBranches', scenarioId === '' ? null : { params: { scenarioId } });
  const create = useMutation('createSimulationBranch', { invalidates: ['listSimulationBranches'] });
  const [name, setName] = useState('');
  const scenarios = [...(mine.data?.scenarios ?? []), ...(shared.data?.scenarios ?? []).filter((s) => !(mine.data?.scenarios ?? []).some((m) => m.id === s.id))];
  const branch: Branch | undefined = branches.data?.branches.find((b) => b.id === current);
  return (
    <section aria-label="Scenario control" className={styles.stackTight}>
      {mine.error !== undefined ? <ErrorMessage error={mine.error} onRetry={mine.refetch} /> : null}
      <SelectField label="Scenario" value={scenarioId} placeholder={mine.data === undefined ? 'Listing…' : 'Choose a scenario'}
        onChange={(e) => setScenarioId(e.target.value)} options={scenarios.map((s) => ({ value: s.id, label: s.name }))} />
      {scenarioId !== '' && branches.data !== undefined ? (
        <>
          <SelectField label="Branch" value={typeof current === 'string' ? current : ''} placeholder="None"
            onChange={(e) => r.setParameter(w.variable, e.target.value === '' ? null : e.target.value)}
            options={branches.data.branches.map((b) => ({ value: b.id, label: `${b.label} (${humanise(b.status).toLowerCase()})` }))} />
          <form className={styles.rowEnd} aria-label="New branch" onSubmit={async (event) => {
            event.preventDefault();
            if (name.trim() === '') return;
            const out = await create.run({ body: { name: name.trim(), from: { kind: 'scenario', scenarioId } } });
            if (out.ok) {
              r.setParameter(w.variable, out.data.id);
              setName('');
            }
          }}>
            <TextField label="New branch" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
            <Button type="submit" pending={create.pending} blocked={create.blocked} disabled={name.trim() === ''}>Create</Button>
          </form>
          {create.error !== undefined ? <ErrorMessage error={create.error} /> : null}
        </>
      ) : null}
      {branches.error !== undefined ? <ErrorMessage error={branches.error} onRetry={branches.refetch} /> : null}
      {branch !== undefined ? (
        <div className={styles.stackTight}>
          <p className={styles.row}><strong>{branch.label}</strong><Badge tone="info">Staged, not executed</Badge></p>
          <p className={styles.muted}>{formatNumber(branch.counts.clean)} clean, {formatNumber(branch.counts.conflicted)} conflicted, {formatNumber(branch.counts.promoted)} promoted.</p>
          {branch.stagedActions.length === 0 ? <p className={styles.muted}>Nothing staged on this branch.</p> : (
            <ul className={styles.plainList}>{branch.stagedActions.map((a) => (
              <li key={a.id}>{humanise(a.operation)} on {plural(a.targets, 'object')}: {a.properties.join(', ') || 'no properties'} <span className={styles.muted}>({humanise(a.staleness).toLowerCase()})</span>{a.statement !== null ? `: ${a.statement}` : ''}</li>
            ))}</ul>
          )}
          <LinkButton href={scenarioHref(scenarioId)} variant="link">Open the scenario to compare, resolve and promote</LinkButton>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Ask scoped to the app (35.5, 36.8): the viewer's own thread scoped to this app, found again on
 * the next visit, or begun when they first ask; private to them, like every thread. Answers are
 * drawn from the viewer's own access.
 */
export function AskPanel({ w }: { w: Of<'askPanel'> }) {
  const r = useRuntime();
  const threads = useQuery('listAskThreads', { query: {} });
  const begin = useMutation('createAskThread', { invalidates: ['listAskThreads'] });
  if (threads.data === undefined) return threads.status === 'error' ? <ErrorMessage error={threads.error} onRetry={threads.refetch} /> : <Loading label="Reading your threads" block={false} />;
  const mine = threads.data.threads.find((t) => t.archivedAt === null && t.scope?.kind === 'app' && t.scope.appId === r.appId);
  return (
    <section aria-label="Ask about this app" className={styles.stackTight}>
      <p className={styles.muted}>Ask about this app{w.scope.length > 0 ? `, over ${w.scope.join(', ')}` : ''}. Your thread is yours alone.</p>
      {mine === undefined ? (
        <EmptyState icon="ask" title="No thread yet" action={
          <Button variant="primary" pending={begin.pending} blocked={begin.blocked} onClick={() => void begin.run({ body: { scope: { kind: 'app', appId: r.appId } } })}>Begin a thread</Button>
        }>Questions you ask here are scoped to this app.</EmptyState>
      ) : <ThreadView threadId={mine.id} compact />}
      {begin.error !== undefined ? <ErrorMessage error={begin.error} /> : null}
    </section>
  );
}
