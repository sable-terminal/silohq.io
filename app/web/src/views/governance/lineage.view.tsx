'use client';

// Lineage (spec 48): where anything came from and what depends on it, from a source field to a
// saved answer, an export or a change. Choose a starting point (a connection, a type, a saved
// view, a report, a receipt and the rest); read what it is built from (upstream) and what is
// built on it (downstream), each node with the markings it carries and why, who could see what
// depends on it, and export the graph to Files. What the reader may not see is counted, never
// shown.

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { Input, Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { SelectField, TextField } from '../../components/field.component.tsx';
import { Page, Panel, Properties, Section, Toolbar } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage } from '../../components/states.component.tsx';
import { TabPanel, Tabs, useTab, type TabDef } from '../../components/tabs.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { useVocabulary } from '../../hooks/vocabulary.hook.ts';
import { connectionHref, typeHref, viewHref } from '../../navigation/links.navigation.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { formatNumber, plural } from '../../utils/format.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import styles from './governance.view.module.css';

type Kind = Input<'readLineage'>['query']['kind'];
type Graph = Output<'readLineage'>;
type GraphNode = Graph['nodes'][number];

const KIND: Record<Kind, string> = {
  connection: 'Connection', connector_version: 'Connector version', source_field: 'Source field', object_type_version: 'Object type', link_type_version: 'Link type',
  property: 'Property', function_version: 'Function', action_type_version: 'Action type', action: 'Change', receipt: 'Receipt', view: 'Saved view', object_set: 'Object set',
  ask_prompt: 'Ask question', app_version: 'App', workbook: 'Workbook', report: 'Report', notebook: 'Notebook', process_analysis: 'Process analysis', export: 'Export',
  import_file: 'Imported file', silo: 'Silo', finding: 'Finding', scenario: 'Scenario', simulation_result: 'Simulation result',
};
const RELATION: Record<Graph['edges'][number]['relation'], string> = {
  compiles_to: 'compiles to', derives: 'derives', exported_from: 'exported from', filters_on: 'filters on', maps_to: 'maps to', member_of: 'member of', read_via: 'read via',
  receipted_by: 'receipted by', reverts: 'reverts', simulates: 'simulates', traverses: 'traverses', uses: 'uses', writes: 'writes',
};
/** The starting points people choose from a list; others are named by id. */
const PICKABLE: readonly Kind[] = ['connection', 'object_type_version', 'view', 'object_set', 'report', 'workbook', 'notebook', 'receipt', 'export', 'finding', 'scenario'];

function nodeLink(n: GraphNode): string | undefined {
  if (n.kind === 'connection') return connectionHref(n.refId);
  if (n.kind === 'view') return viewHref(n.refId);
  if (n.kind === 'object_type_version') return typeHref(n.refId);
  if (n.kind === 'receipt') return hrefWith('/governance/changes/', { receipt: n.refId });
  if (n.kind === 'finding') return hrefWith('/explorer/findings/', { finding: n.refId });
  return undefined;
}

function useMarkingNames() {
  const markings = useQuery('listMarkings', {}, { staleMs: 10 * 60_000 });
  return (id: string) => markings.data?.markings.find((m) => m.id === id)?.name ?? 'a marking';
}

function GraphTable({ graph, label }: { graph: Graph; label: string }) {
  const marking = useMarkingNames();
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const describe = (n: GraphNode | undefined) => (n === undefined ? 'something you cannot see' : `${KIND[n.kind]} ${n.refId.slice(0, 8)}`);
  return (
    <div className={styles.stack}>
      {graph.withheld > 0 ? <Banner tone="info">{plural(graph.withheld, 'item')} you may not see {graph.withheld === 1 ? 'is' : 'are'} counted but not shown.</Banner> : null}
      <DataTable label={label} rows={graph.nodes} rowKey={(n) => n.id} rowHref={nodeLink} columns={[
        { id: 'node', header: 'What', primary: true, sortValue: (n) => n.depth, cell: (n) => <span className={styles.stackTight}>{KIND[n.kind]}<span className={styles.mono}>{n.refId}{n.version !== '' ? ` v${n.version}` : ''}</span></span> },
        { id: 'depth', header: 'Steps away', width: 'sm', align: 'end', sortValue: (n) => n.depth, cell: (n) => String(n.depth) },
        { id: 'markings', header: 'Markings', width: 'md', cell: (n) => (n.markingIds.length === 0 ? '—' : <span className={styles.row}>{n.markingIds.map((m) => <Badge key={m} icon="shield">{marking(m)}</Badge>)}</span>) },
        { id: 'at', header: 'Since', width: 'sm', cell: (n) => <Time value={n.createdAt} /> },
      ]} />
      {graph.edges.length > 0 ? (
        <details className={styles.details}>
          <summary>How they connect ({plural(graph.edges.length, 'link')})</summary>
          <ul className={styles.plainList}>{graph.edges.map((e, i) => <li key={i}>{describe(byId.get(e.from))} {RELATION[e.relation]} {describe(byId.get(e.to))}</li>)}</ul>
        </details>
      ) : null}
    </div>
  );
}

function RootPicker({ kind, refId, onPick }: { kind: Kind; refId: string; onPick: (kind: Kind, refId: string) => void }) {
  const { data: vocabulary } = useVocabulary();
  const connections = useQuery('listConnections', kind === 'connection' ? { query: { limit: 500 } } : null);
  const views = useQuery('listWorkspaceViews', kind === 'view' ? {} : null);
  const sets = useQuery('listOntologyObjectSets', kind === 'object_set' ? { query: { limit: 200 } } : null);
  const [text, setText] = useState(refId);
  const options = kind === 'connection' ? (connections.data?.connections ?? []).map((c) => ({ value: c.id, label: c.name }))
    : kind === 'object_type_version' ? (vocabulary?.objectTypes ?? []).map((t) => ({ value: t.id, label: t.displayName }))
    : kind === 'view' ? (views.data?.views ?? []).map((v) => ({ value: v.id, label: v.name }))
    : kind === 'object_set' ? (sets.data?.objectSets ?? []).map((s) => ({ value: s.id, label: s.name }))
    : undefined;
  return (
    <Toolbar>
      <SelectField label="Start from" value={kind} onChange={(e) => onPick(e.target.value as Kind, '')} options={(Object.keys(KIND) as Kind[]).map((k) => ({ value: k, label: KIND[k] }))} />
      {options !== undefined ? (
        <SelectField label={KIND[kind]} value={refId} onChange={(e) => onPick(kind, e.target.value)} placeholder="Choose" options={options} />
      ) : (
        <form className={styles.row} onSubmit={(e) => {
          e.preventDefault();
          onPick(kind, text.trim());
        }}>
          <TextField label={`${KIND[kind]} id`} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} hint={PICKABLE.includes(kind) ? 'Open it from its own page to start here.' : undefined} />
          <Button type="submit" disabled={text.trim() === ''}>Trace it</Button>
        </form>
      )}
    </Toolbar>
  );
}

export function Lineage() {
  const say = useToast();
  const [params, set] = useParams();
  const kind = (params.get('kind') ?? 'connection') as Kind;
  const refId = params.get('ref') ?? '';
  const version = params.get('version') ?? undefined;
  const root = refId === '' ? null : { kind, refId, ...(version !== undefined ? { version } : {}) };
  const tabs: readonly TabDef<'graph' | 'upstream' | 'downstream' | 'markings' | 'access'>[] = [
    { id: 'graph', label: 'Overview' }, { id: 'upstream', label: 'Built from' }, { id: 'downstream', label: 'Built on it' }, { id: 'markings', label: 'Markings' }, { id: 'access', label: 'Who could see what depends on it' },
  ];
  const [tab, setTab] = useTab(tabs);
  const graph = useQuery('readLineage', root !== null && tab === 'graph' ? { query: { ...root, depth: 3 } } : null);
  const upstream = useQuery('reviewLineageUpstream', root !== null && tab === 'upstream' ? { query: { ...root, depth: 6 } } : null);
  const downstream = useQuery('reviewLineageDownstream', root !== null && tab === 'downstream' ? { query: { ...root, depth: 6 } } : null);
  const markings = useQuery('explainLineageMarkings', root !== null && tab === 'markings' ? { query: root } : null);
  const access = useQuery('reviewLineageAccess', root !== null && tab === 'access' ? { query: { kind, refId } } : null);
  const exporting = useMutation('exportLineageGraph');
  const [direction, setDirection] = useState<'upstream' | 'downstream'>('downstream');
  const markingName = useMarkingNames();
  usePageContext({ scope: { kind: 'page', page: 'governance' }, scopeLabel: 'Lineage' });
  const exported = exporting.data;
  const heading = useMemo(() => (root === null ? undefined : `${KIND[kind]} ${refId.slice(0, 8)}`), [root, kind, refId]);
  return (
    <Page title="Lineage" description="Where anything came from and what depends on it, with the markings each part carries. What you may not see is counted, never shown."
      crumbs={[{ label: 'Governance' }]}>
      <RootPicker key={kind} kind={kind} refId={refId} onPick={(k, r) => set({ kind: k, ref: r, version: undefined })} />
      {root === null ? <EmptyState icon="branch" title="Choose where to start">Pick a connection, a type, a saved view or anything else, or open Lineage from its own page.</EmptyState> : (
        <>
          <Tabs label="Lineage" tabs={tabs} current={tab} onChange={setTab} />
          <TabPanel id={tab}>
            {tab === 'graph' ? <QueryView query={graph} what="Its lineage">{(g) => <GraphTable graph={g} label={`Lineage of ${heading ?? ''}`} />}</QueryView> : null}
            {tab === 'upstream' ? <QueryView query={upstream} what="What it is built from">{(g) => <GraphTable graph={g} label="Built from" />}</QueryView> : null}
            {tab === 'downstream' ? <QueryView query={downstream} what="What is built on it">{(g) => <GraphTable graph={g} label="Built on it" />}</QueryView> : null}
            {tab === 'markings' ? (
              <QueryView query={markings} what="Its markings" isEmpty={(m) => m.markings.length === 0} empty={<p className={styles.muted}>It carries no marking.</p>}>
                {(m) => (
                  <ul className={styles.plainList}>{m.markings.map((x) => (
                    <li key={x.markingId}><Badge icon="shield">{markingName(x.markingId)}</Badge>{' '}
                      {x.origin === 'direct' ? 'applied to it directly' : x.origin === 'pending' ? 'about to apply' : `inherited through ${x.path.map((p) => KIND[p.kind]).join(' → ')}`}</li>
                  ))}</ul>
                )}
              </QueryView>
            ) : null}
            {tab === 'access' ? (
              <QueryView query={access} what="Who could see it">
                {(a) => <Properties columns={3} items={[['Things built on it', formatNumber(a.artefacts)], ['People who can open them', formatNumber(a.memberships)], ['Not visible to you', formatNumber(a.withheld)]]} />}
              </QueryView>
            ) : null}
          </TabPanel>
          <Section title="Export the graph" description="As a file in Files, carrying the markings of what it includes.">
            <Panel>
              <div className={styles.next}>
                <SelectField label="Direction" value={direction} onChange={(e) => setDirection(e.target.value as typeof direction)} options={[{ value: 'downstream', label: 'What is built on it' }, { value: 'upstream', label: 'What it is built from' }]} />
                <Button pending={exporting.pending} blocked={exporting.blocked} onClick={async () => {
                  const r = await exporting.run({ body: { ...root, direction, format: 'csv' } });
                  if (r.ok) say(`Exported: ${plural(r.data.nodes, 'item')}`);
                }}>Export</Button>
              </div>
              {exported !== undefined ? <p className={styles.muted}>Saved as <Link href={hrefWith('/files/all/', { file: exported.file.id })}>{exported.file.name}</Link>{exported.withheld > 0 ? `; ${plural(exported.withheld, 'item')} left out` : ''}.</p> : null}
              {exporting.error !== undefined ? <ErrorMessage error={exporting.error} /> : null}
            </Panel>
          </Section>
        </>
      )}
    </Page>
  );
}
