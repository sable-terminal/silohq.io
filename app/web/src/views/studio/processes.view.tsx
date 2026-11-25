'use client';

// Process analyses (D234): how work actually flows, mined from history. An analysis reads events
// (an object set of event records, or a state property's captured changes) as whoever opens it,
// and shows how cases moved: the process map (activities and the steps between them, how often
// and how long, laid out by the canvas's own layered-graph engine), the variants, case durations
// and rework; and, against a reference model the owner writes as steps, which cases conform and
// which steps deviate. The owner changes its source and model, renames, shares and archives; a
// copy share copies; anyone it reaches exports it into Files.

import { useRouter } from 'next/navigation';
import { useId, useMemo, useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { layout } from '../../canvas/layouts.canvas.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button, IconButton } from '../../components/button.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { FormActions, SelectField, TextArea, TextField } from '../../components/field.component.tsx';
import { Menu } from '../../components/menu.component.tsx';
import { Page, Section } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { ShareDialog } from '../../components/share.component.tsx';
import { ErrorMessage } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { useTab } from '../../components/tabs.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { useVocabulary } from '../../hooks/vocabulary.hook.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { formatDate, formatNumber, plural } from '../../utils/format.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import { Directory, DOCUMENT_ACCESS, FILTERS, HELD, idFrom, NameDialog, NotFound, sharesFor } from './kit.view.tsx';
import css from './process.view.module.css';
import styles from './studio.view.module.css';

type Doc = Output<'getProcess'>['document'];
type Source = Doc['source'];
type Analysis = Output<'readProcessAnalysis'>;
const processHref = (id: string) => hrefWith('/studio/processes/', { process: id });

export function duration(s: number | null): string {
  if (s === null) return '—';
  if (s < 120) return `${s}s`;
  if (s < 7200) return `${Math.round(s / 60)}m`;
  if (s < 172_800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

const complete = (s: Source | undefined): s is Source =>
  s !== undefined && (s.kind === 'events' ? s.objectSetId !== '' && s.caseProperty !== '' && s.activityProperty !== '' && s.timeProperty !== '' : s.objectTypeId !== '' && s.propertyId !== '');

/** /studio/processes/: the directory, or an analysis open. */
export function Processes() {
  const [params] = useParams();
  const open = params.get('process');
  if (open === null) return <ProcessDirectory />;
  const id = idFrom(open);
  return id === undefined ? <NotFound title="Processes" what="an analysis" icon="branch" href="/studio/processes/" /> : <ProcessEditor key={id} processId={id} />;
}

function ProcessDirectory() {
  const [filter, setFilter] = useTab(FILTERS, 'filter');
  const list = useQuery('listProcesses', { query: { filter } }, { keepPrevious: true });
  const create = useMutation('createProcess', { invalidates: ['listProcesses'] });
  usePageContext({ scope: { kind: 'page', page: 'studio' }, scopeLabel: 'Processes' });
  return (
    <Directory title="Processes" what="analysis" icon="branch" description="How cases actually move through your processes, mined from events and captured changes."
      filter={filter} onFilter={setFilter} query={list} rows={(d) => d.processes} hrefOf={processHref} createBlocked={create.blocked}
      renderNew={(close) => <NewProcess onClose={close} />}
      emptyMine="An analysis reads events or captured changes and draws how cases really flowed, with the variants, durations and rework." />
  );
}

/** A new analysis needs its source as well as its name. */
function NewProcess({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const create = useMutation('createProcess', { invalidates: ['listProcesses'] });
  const [name, setName] = useState('');
  const [source, setSource] = useState<Source | undefined>({ kind: 'events', objectSetId: '', caseProperty: '', activityProperty: '', timeProperty: '', limit: 10_000 });
  return (
    <Dialog open onClose={onClose} title="New analysis" size="md" busy={create.pending}>
      <form className={styles.form} onSubmit={async (e) => {
        e.preventDefault();
        if (!complete(source)) return;
        const r = await create.run({ body: { name: name.trim(), document: { schemaVersion: '1', source } } });
        if (r.ok) router.push(processHref(r.data.id) as never);
      }}>
        <TextField label="Name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
        <SourceForm value={source} onChange={setSource} />
        {create.error !== undefined ? <ErrorMessage error={create.error} /> : null}
        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" pending={create.pending} blocked={create.blocked} disabled={name.trim() === '' || !complete(source)}>Make the analysis</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

/** The source: which set or type, and which properties are the case, the activity and the time, or the state. */
function SourceForm({ value, onChange }: { value: Source | undefined; onChange: (s: Source | undefined) => void }) {
  const { data: vocabulary } = useVocabulary();
  const sets = useQuery('listOntologyObjectSets', { query: {} });
  const kind = value?.kind ?? 'events';
  const type = value?.kind === 'changes' ? vocabulary?.objectTypes.find((t) => t.id === value.objectTypeId)
    : vocabulary?.objectTypes.find((t) => t.id === sets.data?.objectSets.find((s) => s.id === (value?.kind === 'events' ? value.objectSetId : ''))?.baseTypeId);
  const props = (type?.properties ?? []).map((p) => ({ value: p.identityId, label: p.displayName }));
  const pick = (label: string, current: string, set: (id: string) => void) => (
    <SelectField label={label} required value={current} placeholder="Choose a property" onChange={(e) => set(e.target.value)} options={props} />
  );
  return (
    <div className={styles.fields}>
      <SelectField label="Events from" value={kind} onChange={(e) => onChange(e.target.value === 'changes'
        ? { kind: 'changes', objectTypeId: vocabulary?.objectTypes[0]?.id ?? '', propertyId: '', limit: 10_000 }
        : { kind: 'events', objectSetId: '', caseProperty: '', activityProperty: '', timeProperty: '', limit: 10_000 })}
        options={[{ value: 'events', label: 'An object set of events' }, { value: 'changes', label: "A state property's captured changes" }]} />
      {value?.kind === 'events' ? (
        <>
          <SelectField label="Object set" required value={value.objectSetId} placeholder={sets.data === undefined ? 'Listing…' : 'Choose a saved set'}
            onChange={(e) => onChange({ ...value, objectSetId: e.target.value, caseProperty: '', activityProperty: '', timeProperty: '' })}
            options={(sets.data?.objectSets ?? []).map((s) => ({ value: s.id, label: s.name }))} />
          {pick('Case', value.caseProperty, (id) => onChange({ ...value, caseProperty: id }))}
          {pick('Activity', value.activityProperty, (id) => onChange({ ...value, activityProperty: id }))}
          {pick('Time', value.timeProperty, (id) => onChange({ ...value, timeProperty: id }))}
        </>
      ) : null}
      {value?.kind === 'changes' ? (
        <>
          <SelectField label="Object type" value={value.objectTypeId} onChange={(e) => onChange({ ...value, objectTypeId: e.target.value, propertyId: '' })}
            options={(vocabulary?.objectTypes ?? []).map((t) => ({ value: t.id, label: t.pluralName }))} />
          {pick('State property', value.propertyId, (id) => onChange({ ...value, propertyId: id }))}
        </>
      ) : null}
      {value !== undefined ? (
        <TextField label="Events read, at most" type="number" min={1} max={100_000} value={value.limit} onChange={(e) => onChange({ ...value, limit: Math.max(1, Number(e.target.value) || 1) })} />
      ) : null}
    </div>
  );
}

function referenceText(r: Doc['reference']): string {
  if (r === undefined) return '';
  return [...r.transitions.map(([a, b]) => `${a} -> ${b}`), ...r.starts.map((s) => `start: ${s}`), ...r.ends.map((e) => `end: ${e}`)].join('\n');
}

function parseReference(text: string): Doc['reference'] {
  const transitions: [string, string][] = [];
  const starts: string[] = [];
  const ends: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const start = /^start:\s*(.+)$/i.exec(line);
    const end = /^end:\s*(.+)$/i.exec(line);
    const step = /^(.+?)\s*->\s*(.+)$/.exec(line);
    if (start !== null) starts.push(start[1]!.trim());
    else if (end !== null) ends.push(end[1]!.trim());
    else if (step !== null) transitions.push([step[1]!.trim(), step[2]!.trim()]);
  }
  return transitions.length + starts.length + ends.length === 0 ? undefined : { transitions, starts, ends };
}

function ProcessEditor({ processId }: { processId: string }) {
  const router = useRouter();
  const say = useToast();
  const read = useQuery('getProcess', { params: { processId } });
  const analysis = useQuery('readProcessAnalysis', { params: { processId } });
  const save = useMutation('saveProcess', { invalidates: ['getProcess', 'listProcesses', 'readProcessAnalysis'] });
  const exportIt = useMutation('exportProcess');
  const copy = useMutation('copyProcess', { invalidates: ['listProcesses'] });
  const archive = useMutation('archiveProcess', { invalidates: ['listProcesses', 'getProcess'] });
  const shares = useQuery('listProcessShares', read.data?.access === 'owner' ? { params: { processId } } : null);
  const share = useMutation('shareProcess', { invalidates: ['listProcessShares', 'getProcess'] });
  const revoke = useMutation('revokeProcessShare', { invalidates: ['listProcessShares', 'getProcess'] });
  const [dialog, setDialog] = useState<'share' | 'copy' | 'archive' | 'rename' | 'setup' | undefined>();
  const p = read.data;
  usePageContext({ scope: { kind: 'page', page: 'studio' }, scopeLabel: p?.name ?? 'an analysis' });
  if (p === undefined) {
    return <Page title="Analysis" crumbs={[{ label: 'Studio' }, { label: 'Processes', href: '/studio/processes/' }]}><QueryView query={read} what="The analysis">{() => null}</QueryView></Page>;
  }
  const owner = p.access === 'owner';
  const archived = p.archivedAt !== null;
  const editable = owner && !archived;
  return (
    <Page title={p.name} documentTitle={p.name} width="full" crumbs={[{ label: 'Studio' }, { label: 'Processes', href: '/studio/processes/' }]}
      meta={<span className={styles.row}>{archived ? <Badge>Archived</Badge> : null}{!owner ? <Badge tone="info">{HELD[p.access]}</Badge> : null}</span>}
      actions={
        <div className={styles.row}>
          {editable ? <Button icon="edit" blocked={save.blocked} onClick={() => setDialog('setup')}>Source and model</Button> : null}
          {owner ? <Button icon="share" blocked={share.blocked} onClick={() => setDialog('share')}>Share</Button> : null}
          <Menu label="More" items={[
            { label: 'Rename', icon: 'edit', disabled: !editable, onSelect: () => setDialog('rename') },
            { label: 'Make a copy', icon: 'copy', disabled: !(owner || p.access === 'copy'), blocked: copy.blocked, onSelect: () => setDialog('copy') },
            { label: 'Export as PDF to Files', icon: 'download', blocked: exportIt.blocked,
              onSelect: () => void exportIt.run({ params: { processId }, body: {} }).then((r) => r.ok && say(`Saved to Files as ${r.data.file.name}`)) },
            { label: 'Read the events again', icon: 'refresh', onSelect: analysis.refetch },
            { separator: true },
            { label: 'Archive', icon: 'trash', tone: 'danger', disabled: !owner || archived, blocked: archive.blocked, onSelect: () => setDialog('archive') },
          ]} renderTrigger={(x) => <IconButton {...x} label="More" icon="more" />} />
        </div>
      }>
      <div className={styles.stack}>
        {archived ? <Banner tone="info" title="Archived">It can be read and exported, not changed.</Banner> : null}
        {exportIt.error !== undefined ? <ErrorMessage error={exportIt.error} /> : null}
        <QueryView query={analysis} what="The analysis">
          {(a) => a.refused !== null ? <Banner tone="info" title="Not computed for you">{a.refused}</Banner> : <AnalysisView a={a} />}
        </QueryView>
      </div>
      {dialog === 'setup' ? (
        <Setup document={p.document} pending={save.pending} error={save.error} onClose={() => setDialog(undefined)}
          onSave={(document) => void save.run({ params: { processId }, body: { document, lockVersion: p.lockVersion } }).then((r) => {
            if (!r.ok) return;
            setDialog(undefined);
            say('Saved: the events are read again');
          })} />
      ) : null}
      <ShareDialog open={dialog === 'share'} onClose={() => setDialog(undefined)} title={`Share ${p.name}`} what="this analysis" access={DOCUMENT_ACCESS}
        shares={sharesFor(shares.data?.shares)} shareBlocked={share.blocked} revokeBlocked={revoke.blocked}
        onShare={(grantee, access) => share.run({ params: { processId }, body: { grantee, access } })}
        onRevoke={(shareId) => revoke.run({ params: { processId, shareId } })} />
      <NameDialog key={`rename:${p.lockVersion}`} open={dialog === 'rename'} title="Rename the analysis" initial={p.name} action="Rename" pending={save.pending} error={save.error}
        onClose={() => setDialog(undefined)}
        onSave={(name) => void save.run({ params: { processId }, body: { name, document: p.document, lockVersion: p.lockVersion } }).then((r) => r.ok && setDialog(undefined))} />
      <NameDialog open={dialog === 'copy'} title="Copy the analysis" initial={`${p.name} (copy)`.slice(0, 200)} action="Make the copy" pending={copy.pending} error={copy.error}
        onClose={() => setDialog(undefined)}
        onSave={(name) => void copy.run({ params: { processId }, body: { name } }).then((r) => {
          if (!r.ok) return;
          setDialog(undefined);
          router.push(processHref(r.data.id) as never);
        })} />
      <ConfirmDialog open={dialog === 'archive'} onClose={() => setDialog(undefined)} title={`Archive ${p.name}?`} confirmLabel="Archive" tone="danger"
        onConfirm={async () => {
          const r = await archive.run({ params: { processId } });
          if (r.ok) say('Archived');
          return r;
        }}><p>It stays readable under Archived; its shares stop granting access.</p></ConfirmDialog>
    </Page>
  );
}

function Setup({ document, pending, error, onClose, onSave }: { document: Doc; pending: boolean; error: unknown; onClose: () => void; onSave: (d: Doc) => void }) {
  const [source, setSource] = useState<Source | undefined>(document.source);
  const [reference, setReference] = useState(referenceText(document.reference));
  return (
    <Dialog open onClose={onClose} title="Source and reference model" size="lg" busy={pending}>
      <form className={styles.form} onSubmit={(e) => {
        e.preventDefault();
        if (!complete(source)) return;
        const ref = parseReference(reference);
        onSave({ schemaVersion: '1', source, ...(ref === undefined ? {} : { reference: ref }) });
      }}>
        <SourceForm value={source} onChange={setSource} />
        <TextArea label="Reference model (optional)" rows={6} className={styles.mono} value={reference} onChange={(e) => setReference(e.target.value)}
          hint="A step per line, such as received -> approved; and start: and end: lines naming where cases may begin and finish." />
        {error !== undefined ? <ErrorMessage error={error} /> : null}
        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" pending={pending} disabled={!complete(source)}>Save</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

function AnalysisView({ a }: { a: Analysis }) {
  return (
    <div className={styles.stack}>
      <p role="status">
        {plural(a.cases, 'case')}, {plural(a.events, 'event')}{a.skipped > 0 ? `, ${formatNumber(a.skipped)} skipped (no case, activity or time)` : ''}{a.truncated ? ', over the first events read' : ''}.
        {' '}Case duration: median {duration(a.caseDuration.medianSeconds)}, 90th percentile {duration(a.caseDuration.p90Seconds)}.{a.capturedFrom !== null ? ` History from ${formatDate(a.capturedFrom)}.` : ''}
      </p>
      <ProcessMap a={a} />
      {a.conformance !== null ? (
        <Section title="Conformance" description={`${formatNumber(a.conformance.fitting)} of ${plural(a.cases, 'case')} follow the reference model; ${formatNumber(a.conformance.deviating)} deviate.`}>
          <div className={styles.stackTight}>
            {a.conformance.deviations.length > 0 ? (
              <DataTable label="Steps not in the model" rows={a.conformance.deviations} rowKey={(d) => `${d.from}>${d.to}`} columns={[
                { id: 'step', header: 'Step', primary: true, cell: (d) => `${d.from} → ${d.to}` },
                { id: 'cases', header: 'Cases', align: 'end', cell: (d) => formatNumber(d.cases) },
              ]} />
            ) : null}
            {[...a.conformance.badStarts.map((s) => `${plural(s.cases, 'case')} start at ${s.activity}`), ...a.conformance.badEnds.map((e) => `${plural(e.cases, 'case')} end at ${e.activity}`)]
              .map((t) => <p key={t} className={styles.muted}>{t}, which the model does not allow.</p>)}
          </div>
        </Section>
      ) : null}
      <Section title="Variants" description="Each distinct path a case took, most common first.">
        <DataTable label="Variants" rows={a.variants} rowKey={(v) => v.path.join('>')} columns={[
          { id: 'path', header: 'Path', primary: true, cell: (v) => v.path.join(' → ') },
          { id: 'cases', header: 'Cases', width: 'sm', align: 'end', cell: (v) => formatNumber(v.cases) },
          { id: 'share', header: 'Share', width: 'sm', align: 'end', cell: (v) => `${Math.round(v.share * 100)}%` },
          { id: 'median', header: 'Median', width: 'sm', align: 'end', cell: (v) => duration(v.medianSeconds) },
        ]} />
      </Section>
      <Section title="Steps">
        <DataTable label="Steps" rows={a.edges} rowKey={(e) => `${e.from}>${e.to}`} columns={[
          { id: 'from', header: 'From', primary: true, cell: (e) => e.from },
          { id: 'to', header: 'To', cell: (e) => e.to },
          { id: 'times', header: 'Times', width: 'sm', align: 'end', cell: (e) => formatNumber(e.count) },
          { id: 'cases', header: 'Cases', width: 'sm', align: 'end', cell: (e) => formatNumber(e.cases) },
          { id: 'median', header: 'Median', width: 'sm', align: 'end', cell: (e) => duration(e.medianSeconds) },
          { id: 'p90', header: '90th percentile', width: 'sm', align: 'end', cell: (e) => duration(e.p90Seconds) },
        ]} />
      </Section>
      {a.rework.length > 0 ? <p className={styles.muted}>Done more than once in a case: {a.rework.map((r) => `${r.activity} (${plural(r.cases, 'case')})`).join(', ')}.</p> : null}
    </div>
  );
}

/** The process map: activities placed by the layered-graph layout, steps drawn thicker as they are taken more often. */
function ProcessMap({ a }: { a: Analysis }) {
  const marker = useId().replaceAll(':', '');
  const drawn = useMemo(() => {
    const names = a.activities.map((x) => x.name);
    const index = new Map(names.map((n, i) => [n, i]));
    const edges = a.edges.filter((e) => index.has(e.from) && index.has(e.to));
    const out = layout({ kind: 'graph_layered', nodes: names.map((id) => ({ id })), edges: edges.map((e) => [index.get(e.from)!, index.get(e.to)!] as [number, number]) });
    const at: [number, number][] = out.positions.map((p) => (p === null ? [0, 0] : [p[0], p[1]]));
    // Scaled to room for a labelled box per activity.
    const xs = at.map((p) => p[0]);
    const ys = at.map((p) => p[1]);
    const [minX, maxX, minY, maxY] = [Math.min(...xs, 0), Math.max(...xs, 1), Math.min(...ys, 0), Math.max(...ys, 1)];
    const sx = names.length <= 1 ? 1 : Math.max(1, 220 / Math.max(1, (maxX - minX) / Math.max(1, Math.sqrt(names.length))));
    const sy = names.length <= 1 ? 1 : Math.max(1, 110 / Math.max(1, (maxY - minY) / Math.max(1, Math.sqrt(names.length))));
    const place = at.map(([x, y]) => [(x - minX) * sx + 100, (y - minY) * sy + 40] as [number, number]);
    const width = Math.max(...place.map((p) => p[0]), 0) + 120;
    const height = Math.max(...place.map((p) => p[1]), 0) + 60;
    return { names, place, edges, width, height, index, max: Math.max(1, ...edges.map((e) => e.count)) };
  }, [a]);
  if (drawn.names.length === 0) return <p className={styles.muted}>No activities to draw.</p>;
  return (
    <figure className={css.map}>
      <svg viewBox={`0 0 ${drawn.width} ${drawn.height}`} role="img" aria-label={`Process map: ${plural(drawn.names.length, 'activity', 'activities')}, ${plural(drawn.edges.length, 'step')}`} className={css.svg}>
        <defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="10" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" className={css.arrow} /></marker></defs>
        {drawn.edges.map((e, i) => {
          const [x1, y1] = drawn.place[drawn.index.get(e.from)!]!;
          const [x2, y2] = drawn.place[drawn.index.get(e.to)!]!;
          if (e.from === e.to) return <path key={i} d={`M${x1 + 60},${y1 - 6} c40,-40 40,30 0,12`} className={css.edge} strokeWidth={1 + (5 * e.count) / drawn.max} markerEnd={`url(#${marker})`} />;
          const dx = x2 - x1;
          const dy = y2 - y1;
          const len = Math.max(1, Math.hypot(dx, dy));
          const [sx, sy, ex, ey] = [x1 + (dx / len) * 62, y1 + (dy / len) * 20, x2 - (dx / len) * 62, y2 - (dy / len) * 20];
          return (
            <g key={i}>
              <line x1={sx} y1={sy} x2={ex} y2={ey} className={css.edge} strokeWidth={1 + (5 * e.count) / drawn.max} markerEnd={`url(#${marker})`} />
              <text x={(sx + ex) / 2} y={(sy + ey) / 2 - 4} className={css.edgeLabel} textAnchor="middle">{e.count} · {duration(e.medianSeconds)}</text>
            </g>
          );
        })}
        {drawn.names.map((n, i) => {
          const [x, y] = drawn.place[i]!;
          const act = a.activities[i]!;
          return (
            <g key={n}>
              <rect x={x - 60} y={y - 18} width={120} height={36} rx={4} className={css.node} />
              <text x={x} y={y - 2} className={css.nodeLabel} textAnchor="middle">{n.length > 18 ? `${n.slice(0, 17)}…` : n}</text>
              <text x={x} y={y + 12} className={css.nodeCount} textAnchor="middle">{act.events} in {plural(act.cases, 'case')}</text>
            </g>
          );
        })}
      </svg>
      <figcaption className={styles.muted}>Each step&apos;s line is as thick as it is common; its label is how often, then its median time.</figcaption>
    </figure>
  );
}
