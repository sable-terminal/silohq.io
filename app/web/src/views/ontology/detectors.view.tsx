'use client';

// Detectors (spec 38): what recognition looks for in a type's objects (outliers, gaps, duplicates,
// drift, stale records and the rest), each configured per type with the properties and time field
// it reads, switched on or off, and run on demand. Findings go to Explorer's Findings, never as a
// judgement: each states what was observed.

import Link from 'next/link';
import { useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge, Status } from '../../components/badge.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { Dialog } from '../../components/dialog.component.tsx';
import { Checkbox, FormActions, SelectField, Switch } from '../../components/field.component.tsx';
import { Page, Panel, Section, Toolbar } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { formatNumber, plural } from '../../utils/format.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import type { ObjectType } from './words.view.ts';
import styles from './ontology.view.module.css';

type Detector = Output<'listRecognitionDetectors'>['detectors'][number];
type Configuration = Output<'listRecognitionConfigurations'>['configurations'][number];
type RunResult = Output<'runRecognitionDetectors'>['runs'][number];

const RUN_STATE: Record<RunResult['state'], { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' | 'info' }> = {
  ran: { label: 'Ran', tone: 'ok' }, accumulating_baseline: { label: 'Building its baseline', tone: 'info' }, bounded: { label: 'Too large to read', tone: 'warn' },
  history_unavailable: { label: 'No history kept', tone: 'warn' }, not_configured: { label: 'Not configured', tone: 'neutral' }, source_unreachable: { label: 'A system did not answer', tone: 'danger' },
};

function ConfigureDialog({ type, detector, configuration, open, onClose }: { type: ObjectType; detector: Detector; configuration: Configuration | undefined; open: boolean; onClose: () => void }) {
  const say = useToast();
  const configure = useMutation('configureRecognitionDetector', { invalidates: ['listRecognitionConfigurations'] });
  const [properties, setProperties] = useState<Set<string>>(new Set(configuration?.properties ?? []));
  const [timeField, setTimeField] = useState(configuration?.timeField ?? '');
  const temporal = type.properties.filter((p) => p.dataType === 'date' || p.dataType === 'timestamp');
  return (
    <Dialog open={open} onClose={onClose} title={`${detector.name} on ${type.pluralName}`} size="md" busy={configure.pending} description={detector.description}>
      <form className={styles.form} onSubmit={async (event) => {
        event.preventDefault();
        const r = await configure.run({ params: { objectTypeId: type.id, detector: detector.key }, body: {
          properties: [...properties], timeField: timeField === '' ? null : timeField, enabled: true, ...(configuration !== undefined ? { version: configuration.version } : {}),
        } });
        if (r.ok) {
          say(`${detector.name} configured and on`);
          onClose();
        }
      }}>
        {detector.requiresProperty ? (
          <fieldset className={styles.choices}>
            <legend>Properties it reads</legend>
            {type.properties.filter((p) => p.status !== 'retired').map((p) => (
              <Checkbox key={p.identityId} label={p.displayName} checked={properties.has(p.identityId)} onChange={() => {
                const next = new Set(properties);
                if (next.has(p.identityId)) next.delete(p.identityId);
                else next.add(p.identityId);
                setProperties(next);
              }} />
            ))}
          </fieldset>
        ) : null}
        {detector.requiresTimeField || temporal.length > 0 ? (
          <SelectField label="Time field" required={detector.requiresTimeField} value={timeField} onChange={(e) => setTimeField(e.target.value)} placeholder="None"
            options={temporal.map((p) => ({ value: p.identityId, label: p.displayName }))} />
        ) : null}
        {detector.minimumBaseline !== null ? <p className={styles.muted}>It needs {detector.minimumBaseline.amount} {detector.minimumBaseline.unit} of history before it reports.</p> : null}
        {configure.error !== undefined ? <ErrorMessage error={configure.error} /> : null}
        <FormActions><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" pending={configure.pending} blocked={configure.blocked}
          disabled={(detector.requiresProperty && properties.size === 0) || (detector.requiresTimeField && timeField === '')}>Save and switch on</Button></FormActions>
      </form>
    </Dialog>
  );
}

function TypeDetectors({ type }: { type: ObjectType }) {
  const say = useToast();
  const detectors = useQuery('listRecognitionDetectors', {}, { staleMs: 10 * 60_000 });
  const configurations = useQuery('listRecognitionConfigurations', { params: { objectTypeId: type.id } });
  const configure = useMutation('configureRecognitionDetector', { invalidates: ['listRecognitionConfigurations'] });
  const run = useMutation('runRecognitionDetectors');
  const [editing, setEditing] = useState<Detector | undefined>(undefined);
  const configOf = (key: string) => configurations.data?.configurations.find((c) => c.detector === key);
  const prop = (id: string) => type.properties.find((p) => p.identityId === id)?.displayName ?? 'a property';
  return (
    <div className={styles.stack}>
      <Panel>
        <div className={styles.next}>
          <p className={styles.muted}>Recognition runs on its schedule; run it now to see what it finds today. Findings appear in <Link href={hrefWith('/explorer/findings/', { type: type.id })}>Findings</Link>.</p>
          <Button variant="primary" icon="play" pending={run.pending} blocked={run.blocked} onClick={async () => {
            const r = await run.run({ body: { objectTypeId: type.id } }, { timeoutMs: 180_000 });
            if (r.ok) say(`${plural(r.data.runs.reduce((n, x) => n + x.findingsCount, 0), 'finding')} from ${plural(r.data.runs.length, 'detector')}`);
          }}>Run the detectors</Button>
        </div>
        {run.error !== undefined ? <ErrorMessage error={run.error} /> : null}
      </Panel>
      {run.data !== undefined ? (
        <Section title="This run">
          <DataTable label="Detector runs" rows={run.data.runs} rowKey={(r) => r.runId} dense columns={[
            { id: 'd', header: 'Detector', primary: true, cell: (r) => detectors.data?.detectors.find((d) => d.key === r.detector)?.name ?? r.detector },
            { id: 'state', header: 'State', width: 'md', cell: (r) => <Status tone={RUN_STATE[r.state].tone}>{RUN_STATE[r.state].label}</Status> },
            { id: 'pop', header: 'Objects', width: 'sm', align: 'end', cell: (r) => (r.populationCount === null ? '—' : formatNumber(r.populationCount)) },
            { id: 'found', header: 'Findings', width: 'sm', align: 'end', cell: (r) => formatNumber(r.findingsCount) },
            { id: 'base', header: 'Baseline', width: 'md', cell: (r) => (r.baseline === null ? '—' : `${r.baseline.have} of ${r.baseline.need} ${r.baseline.unit}`) },
          ]} />
        </Section>
      ) : null}
      <QueryView query={detectors} what="Detectors">
        {(d) => (
          <DataTable label="Detectors" rows={d.detectors} rowKey={(x) => x.key} columns={[
            { id: 'name', header: 'Detector', primary: true, cell: (x) => <span className={styles.stackTight}>{x.name}<span className={styles.muted}>{x.description}</span></span> },
            { id: 'reads', header: 'Reads', width: 'md', cell: (x) => {
              const c = configOf(x.key);
              return c === undefined ? <span className={styles.muted}>Not configured</span> : [...c.properties.map(prop), ...(c.timeField !== null ? [`time: ${prop(c.timeField)}`] : [])].join(', ') || 'Every object';
            } },
            { id: 'mode', header: 'From', width: 'sm', cell: (x) => (x.executionMode === 'history' ? 'History' : 'Live') },
            { id: 'on', header: 'On', width: 'sm', cell: (x) => {
              const c = configOf(x.key);
              return c === undefined ? <Badge>Off</Badge> : (
                <Switch label={`${x.name} on`} checked={c.enabled} blocked={configure.blocked?.message} onChange={async (enabled) => {
                  const r = await configure.run({ params: { objectTypeId: type.id, detector: x.key }, body: { enabled, version: c.version } });
                  if (r.ok) say(enabled ? `${x.name} on` : `${x.name} off`);
                }} />
              );
            } },
            { id: 'act', header: <span className="visually-hidden">Configure</span>, width: 'sm', align: 'end', cell: (x) => <Button size="sm" variant="ghost" blocked={configure.blocked} onClick={() => setEditing(x)}>Configure</Button> },
          ]} />
        )}
      </QueryView>
      {editing !== undefined ? <ConfigureDialog type={type} detector={editing} configuration={configOf(editing.key)} open onClose={() => setEditing(undefined)} /> : null}
    </div>
  );
}

export function Detectors() {
  const [params, set] = useParams();
  const manifest = useQuery('readOntology', { query: {} });
  usePageContext({ scope: { kind: 'page', page: 'ontology' }, scopeLabel: 'Detectors' });
  const types = (manifest.data?.objectTypes ?? []).filter((t) => t.status !== 'retired');
  const type = types.find((t) => t.id === params.get('type')) ?? types[0];
  return (
    <Page title="Detectors" description="What recognition looks for in each type's objects. Each finding states what was observed, never a judgement." crumbs={[{ label: 'Ontology' }]}>
      <QueryView query={manifest} what="The model" isEmpty={() => types.length === 0} empty={<EmptyState icon="eye" title="No object type yet">Derive or define types first.</EmptyState>}>
        {() => (type === undefined ? null : (
          <>
            <Toolbar><SelectField label="Object type" value={type.id} onChange={(e) => set({ type: e.target.value })} options={types.map((t) => ({ value: t.id, label: t.displayName }))} /></Toolbar>
            <TypeDetectors key={type.id} type={type} />
          </>
        ))}
      </QueryView>
    </Page>
  );
}
