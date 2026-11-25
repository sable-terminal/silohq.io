'use client';

// Data pipelines (D235, D241): transform data on a schedule. Inputs are saved object sets with
// chosen properties (columns named by the properties' API names); steps transform them in order;
// the preview runs the steps over what the person may read now and names the step that fails; the
// output is an Import Silo source each run writes a CSV into, from where it is read like any other
// data. A schedule runs it unattended as its own principal, never exceeding its owner, pausing
// after failures in a row; runs are listed with what they wrote or why they failed, and a failed
// run's notification opens it here. Pipelines are their owner's alone.

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button, IconButton, LinkButton } from '../../components/button.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { Checkbox, FormActions, SelectField, TextField } from '../../components/field.component.tsx';
import { Menu } from '../../components/menu.component.tsx';
import { Page, Panel, Properties, Section } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage, Loading } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { TabPanel, Tabs, useTab, type TabDef } from '../../components/tabs.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useRefreshWhile } from '../../hooks/refresh.hook.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { useVocabulary } from '../../hooks/vocabulary.hook.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { formatNumber, plural } from '../../utils/format.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import { idFrom, NameDialog, NotFound, useDraft } from './kit.view.tsx';
import { Steps } from './steps.view.tsx';
import styles from './studio.view.module.css';

type Pipeline = Output<'getPipeline'>;
type Doc = Pipeline['document'];
type Input = Doc['inputs'][number];
type Run = Output<'listPipelineRuns'>['runs'][number];
type Tab = 'build' | 'preview' | 'schedule' | 'runs';
const pipelineHref = (id: string, extra: Record<string, string | undefined> = {}) => hrefWith('/studio/pipelines/', { pipeline: id, ...extra });
const INPUT_NAME = /^[a-z][a-z0-9_]{0,30}$/;
const PRESETS = [
  { value: '0 * * * *', label: 'Every hour' }, { value: '0 6 * * *', label: 'Every day at 06:00' },
  { value: '0 6 * * 1-5', label: 'Weekdays at 06:00' }, { value: '0 6 * * 1', label: 'Mondays at 06:00' },
];
const TABS: TabDef<Tab>[] = [{ id: 'build', label: 'Build' }, { id: 'preview', label: 'Preview' }, { id: 'schedule', label: 'Schedule' }, { id: 'runs', label: 'Runs' }];

/** /studio/pipelines/: the directory, a pipeline open, or a run a notification named. */
export function Pipelines() {
  const [params] = useParams();
  const open = params.get('pipeline');
  const run = params.get('run');
  if (open !== null) {
    const id = idFrom(open);
    return id === undefined ? <NotFound title="Pipelines" what="a pipeline" icon="arrowRight" href="/studio/pipelines/" /> : <PipelineEditor key={id} pipelineId={id} />;
  }
  if (run !== null) {
    const id = idFrom(run);
    return id === undefined ? <NotFound title="Pipelines" what="a run" icon="arrowRight" href="/studio/pipelines/" /> : <RunRedirect runId={id} />;
  }
  return <PipelineDirectory />;
}

/** A run by its id, sent on to its pipeline's runs. */
function RunRedirect({ runId }: { runId: string }) {
  const router = useRouter();
  const read = useQuery('getPipelineRun', { params: { runId } });
  useEffect(() => {
    if (read.data !== undefined) router.replace(pipelineHref(read.data.pipelineId, { tab: 'runs', run: read.data.id }) as never);
  }, [read.data, router]);
  return <Page title="Pipeline run" crumbs={[{ label: 'Studio' }, { label: 'Pipelines', href: '/studio/pipelines/' }]}><QueryView query={read} what="The run">{() => <Loading label="Opening its pipeline" />}</QueryView></Page>;
}

function scheduleText(s: Pipeline['schedule']): string {
  if (s === null) return 'Not scheduled';
  if (s.status === 'active') return `${PRESETS.find((p) => p.value === s.schedule)?.label ?? s.schedule} (${s.timeZone})`;
  return s.pausedReason === 'failures' ? `Paused after ${plural(s.failuresInARow, 'failed run')} in a row` : 'Paused: the pipeline is archived';
}

function PipelineDirectory() {
  const [params, set] = useParams();
  const [tab, setTab] = useTab<'active' | 'archived'>([{ id: 'active', label: 'Active' }, { id: 'archived', label: 'Archived' }], 'filter');
  const list = useQuery('listPipelines', { query: { archived: tab === 'archived' } }, { keepPrevious: true });
  const create = useMutation('createPipeline', { invalidates: ['listPipelines'] });
  usePageContext({ scope: { kind: 'page', page: 'studio' }, scopeLabel: 'Pipelines' });
  return (
    <Page title="Pipelines" description="Clean, join and reshape object sets, and write the result into an Import Silo, where it is data like any other."
      crumbs={[{ label: 'Studio' }]}
      actions={<Button variant="primary" icon="plus" blocked={create.blocked} onClick={() => set({ new: '1' })}>New pipeline</Button>}>
      <Tabs label="Which pipelines" tabs={[{ id: 'active', label: 'Active' }, { id: 'archived', label: 'Archived' }]} current={tab} onChange={setTab} />
      <TabPanel id={tab}>
        <QueryView query={list} what="Pipelines" isEmpty={(d) => d.pipelines.length === 0}
          empty={<EmptyState icon="arrowRight" title={tab === 'active' ? 'No pipelines yet' : 'None archived'}>{tab === 'active' ? 'A pipeline reads object sets, transforms them and writes the result into an Import Silo, by hand or on a schedule.' : 'Archived pipelines stay here, their schedules stopped.'}</EmptyState>}>
          {(d) => (
            <DataTable label="Pipelines" rows={d.pipelines} rowKey={(p) => p.id} rowHref={(p) => pipelineHref(p.id)} columns={[
              { id: 'name', header: 'Pipeline', primary: true, cell: (p) => p.name },
              { id: 'schedule', header: 'Schedule', cell: (p) => (p.schedule?.status === 'paused' && p.schedule.pausedReason === 'failures' ? <Badge tone="warn">{scheduleText(p.schedule)}</Badge> : scheduleText(p.schedule)) },
              { id: 'next', header: 'Next run', width: 'sm', cell: (p) => (p.schedule?.nextRunAt == null ? '—' : <Time value={p.schedule.nextRunAt} />) },
              { id: 'updated', header: 'Changed', width: 'sm', sortValue: (p) => p.updatedAt, cell: (p) => <Time value={p.updatedAt} /> },
            ]} />
          )}
        </QueryView>
      </TabPanel>
      {params.get('new') !== null ? <NewPipeline onClose={() => set({ new: undefined })} /> : null}
    </Page>
  );
}

function NewPipeline({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const create = useMutation('createPipeline', { invalidates: ['listPipelines'] });
  const [name, setName] = useState('');
  const [input, setInput] = useState<Input>({ id: 'input_1', objectSetId: '', propertyIds: [], limit: 10_000 });
  return (
    <Dialog open onClose={onClose} title="New pipeline" size="md" busy={create.pending} description="Start with one input; add more inputs, the steps and where it writes in the editor.">
      <form className={styles.form} onSubmit={async (e) => {
        e.preventDefault();
        const r = await create.run({ body: { name: name.trim(), document: { schemaVersion: '1', inputs: [input], steps: [] } } });
        if (r.ok) router.push(pipelineHref(r.data.id) as never);
      }}>
        <TextField label="Name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
        <InputEditor input={input} onChange={setInput} />
        {create.error !== undefined ? <ErrorMessage error={create.error} /> : null}
        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" pending={create.pending} blocked={create.blocked} disabled={name.trim() === '' || input.objectSetId === '' || input.propertyIds.length === 0}>Make the pipeline</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

function InputEditor({ input, onChange, onRemove }: { input: Input; onChange: (i: Input) => void; onRemove?: (() => void) | undefined }) {
  const { data: vocabulary } = useVocabulary();
  const sets = useQuery('listOntologyObjectSets', { query: {} });
  const type = vocabulary?.objectTypes.find((t) => t.id === sets.data?.objectSets.find((s) => s.id === input.objectSetId)?.baseTypeId);
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <strong className={styles.mono}>{input.id}</strong>
        {onRemove !== undefined ? <IconButton size="sm" icon="trash" label={`Remove ${input.id}`} onClick={onRemove} /> : null}
      </div>
      <div className={styles.fields}>
        <TextField label="Name" className={styles.mono} value={input.id} onChange={(e) => onChange({ ...input, id: e.target.value })}
          error={INPUT_NAME.test(input.id) ? undefined : 'Lower-case letters, digits and underscores, starting with a letter'} />
        <SelectField label="Object set" required value={input.objectSetId} placeholder={sets.data === undefined ? 'Listing…' : 'Choose a saved set'}
          onChange={(e) => onChange({ ...input, objectSetId: e.target.value, propertyIds: [] })} options={(sets.data?.objectSets ?? []).map((s) => ({ value: s.id, label: s.name }))}
          hint={sets.data !== undefined && sets.data.objectSets.length === 0 ? 'Save an object set in Explorer first.' : undefined} />
        <TextField label="At most" type="number" min={1} max={50_000} value={input.limit} onChange={(e) => onChange({ ...input, limit: Math.max(1, Math.min(50_000, Number(e.target.value) || 1)) })} />
      </div>
      {type !== undefined ? (
        <fieldset className={styles.fieldset}>
          <legend>Columns</legend>
          <div className={styles.checks}>{type.properties.map((p) => (
            <Checkbox key={p.identityId} label={<>{p.displayName} <span className={styles.mono}>{p.apiName}</span></>} checked={input.propertyIds.includes(p.identityId)}
              onChange={(e) => onChange({ ...input, propertyIds: e.target.checked ? [...input.propertyIds, p.identityId] : input.propertyIds.filter((x) => x !== p.identityId) })} />
          ))}</div>
        </fieldset>
      ) : null}
    </div>
  );
}

function PipelineEditor({ pipelineId }: { pipelineId: string }) {
  const router = useRouter();
  const say = useToast();
  const read = useQuery('getPipeline', { params: { pipelineId } });
  const save = useMutation('savePipeline', { invalidates: ['getPipeline', 'listPipelines'] });
  const run = useMutation('runPipeline', { invalidates: ['listPipelineRuns'] });
  const archive = useMutation('archivePipeline', { invalidates: ['getPipeline', 'listPipelines'] });
  const [tab, setTab] = useTab(TABS);
  const [dialog, setDialog] = useState<'rename' | 'archive' | undefined>();
  const p = read.data;
  const draft = useDraft<Doc>(p);
  usePageContext({ scope: { kind: 'page', page: 'studio' }, scopeLabel: p?.name ?? 'a pipeline' });
  if (p === undefined || draft.doc === undefined) {
    return <Page title="Pipeline" crumbs={[{ label: 'Studio' }, { label: 'Pipelines', href: '/studio/pipelines/' }]}><QueryView query={read} what="The pipeline">{() => null}</QueryView></Page>;
  }
  const doc = draft.doc;
  const archived = p.archivedAt !== null;
  const doSave = async (name?: string) => {
    const r = await save.run({ params: { pipelineId }, body: { ...(name === undefined ? {} : { name }), document: doc, lockVersion: draft.lockVersion } });
    if (!r.ok) return false;
    draft.saved(r.data);
    say('Saved');
    return true;
  };
  const runBlocked = archived ? 'Archived' : draft.edited ? 'Save it first' : doc.output === undefined ? 'Choose where it writes first' : run.blocked;
  return (
    <Page title={p.name} documentTitle={p.name} width="full" crumbs={[{ label: 'Studio' }, { label: 'Pipelines', href: '/studio/pipelines/' }]}
      meta={<span className={styles.row}>{archived ? <Badge>Archived</Badge> : null}<span className={styles.muted}>{scheduleText(p.schedule)}</span>{draft.edited ? <Badge tone="warn">Unsaved changes</Badge> : null}</span>}
      actions={
        <div className={styles.row}>
          {!archived ? <Button variant="primary" icon="check" pending={save.pending} disabled={!draft.edited} blocked={save.blocked} onClick={() => void doSave()}>Save</Button> : null}
          <Button icon="play" pending={run.pending} blocked={runBlocked} onClick={() => void run.run({ params: { pipelineId } }).then((r) => {
            if (!r.ok) return;
            say(r.data.status === 'failed' ? 'The run failed: see Runs' : 'Run started');
            setTab('runs');
          })}>Run it now</Button>
          <Menu label="More" items={[
            { label: 'Rename', icon: 'edit', disabled: archived, onSelect: () => setDialog('rename') },
            { separator: true },
            { label: 'Archive', icon: 'trash', tone: 'danger', disabled: archived, blocked: archive.blocked, onSelect: () => setDialog('archive') },
          ]} renderTrigger={(x) => <IconButton {...x} label="More" icon="more" />} />
        </div>
      }>
      <div className={styles.stack}>
        {archived ? <Banner tone="info" title="Archived">Its schedule is stopped; it can be read, not run.</Banner> : null}
        {draft.stale ? <Banner tone="warn" title="Saved elsewhere since you opened it">Saving now would be refused. Copy what you changed, then open it again.</Banner> : null}
        {save.error !== undefined ? <ErrorMessage error={save.error} /> : null}
        {run.error !== undefined ? <ErrorMessage error={run.error} /> : null}
        <Tabs label="Pipeline" tabs={TABS} current={tab} onChange={setTab} />
        <TabPanel id={tab}>
          {tab === 'build' ? (
            <fieldset className={styles.fieldset} disabled={archived} aria-label="The pipeline">
              <div className={styles.stack}>
                <Section title="Inputs" description="Saved object sets, read as whoever runs it; columns are named by the properties' API names. The first is what the steps start from; the others can be joined."
                  actions={doc.inputs.length < 5 ? <Button size="sm" icon="plus" onClick={() => draft.change({ ...doc, inputs: [...doc.inputs, { id: `input_${doc.inputs.length + 1}`, objectSetId: '', propertyIds: [], limit: 10_000 }] })}>Add an input</Button> : undefined}>
                  <div className={styles.stackTight}>{doc.inputs.map((input, i) => (
                    <InputEditor key={i} input={input} onChange={(x) => draft.change({ ...doc, inputs: doc.inputs.map((y, j) => (j === i ? x : y)) })}
                      onRemove={doc.inputs.length > 1 ? () => draft.change({ ...doc, inputs: doc.inputs.filter((_, j) => j !== i) }) : undefined} />
                  ))}</div>
                </Section>
                <Section title="Steps" description="Applied in order to the first input.">
                  <Steps steps={doc.steps} inputs={doc.inputs.slice(1).map((x) => x.id)} onChange={(steps) => draft.change({ ...doc, steps })} />
                </Section>
                <OutputEditor doc={doc} onChange={draft.change} />
              </div>
            </fieldset>
          ) : tab === 'preview' ? (
            <PreviewPanel pipelineId={pipelineId} doc={doc} edited={draft.edited} />
          ) : tab === 'schedule' ? (
            <ScheduleEditor pipeline={p} edited={draft.edited} />
          ) : (
            <Runs pipelineId={pipelineId} siloId={doc.output?.siloId} />
          )}
        </TabPanel>
      </div>
      <NameDialog key={`rename:${p.lockVersion}`} open={dialog === 'rename'} title="Rename the pipeline" initial={p.name} action="Rename" pending={save.pending} error={save.error}
        hint={draft.edited ? 'Renaming saves your other changes too.' : undefined}
        onClose={() => setDialog(undefined)} onSave={(n) => void doSave(n).then((ok) => ok && setDialog(undefined))} />
      <ConfirmDialog open={dialog === 'archive'} onClose={() => setDialog(undefined)} title={`Archive ${p.name}?`} confirmLabel="Archive" tone="danger"
        onConfirm={async () => {
          const r = await archive.run({ params: { pipelineId } });
          if (r.ok) {
            say('Archived: its schedule is stopped');
            router.push('/studio/pipelines/' as never);
          }
          return r;
        }}><p>Its schedule stops. What it already wrote stays in its Silo.</p></ConfirmDialog>
    </Page>
  );
}

function OutputEditor({ doc, onChange }: { doc: Doc; onChange: (d: Doc) => void }) {
  const siloes = useQuery('listSiloes', { query: {} });
  const source = useMutation('createSiloSource', { refresh: false });
  const out = doc.output;
  const imports = (siloes.data?.siloes ?? []).filter((s) => s.kind === 'import' && s.status === 'active');
  return (
    <Section title="Output" description="Each run writes a CSV into an Import Silo, from where it is read through the Silo like any other data. The Silo must carry every marking of what the inputs read.">
      <div className={styles.stackTight}>
        <div className={styles.fields}>
          <SelectField label="Import Silo" value={out?.siloId ?? ''} placeholder={siloes.data === undefined ? 'Listing…' : 'None yet'}
            hint={siloes.data !== undefined && imports.length === 0 ? 'Make an Import Silo in Siloes first.' : undefined}
            onChange={async (e) => {
              const siloId = e.target.value;
              if (siloId === '') {
                const { output: _o, ...rest } = doc;
                onChange(rest as Doc);
                return;
              }
              // A source of the pipeline's own in the Silo, so its files stand apart.
              const r = await source.run({ params: { siloId }, body: { kind: 'upload' } });
              if (r.ok) onChange({ ...doc, output: { siloId, sourceId: r.data.id, filename: out?.filename ?? 'pipeline.csv' } });
            }} options={imports.map((s) => ({ value: s.id, label: s.name }))} />
          {out !== undefined ? <TextField label="File name" value={out.filename} onChange={(e) => onChange({ ...doc, output: { ...out, filename: e.target.value } })} /> : null}
        </div>
        {source.pending ? <Loading label="Making its source in the Silo" block={false} /> : null}
        {source.error !== undefined ? <ErrorMessage error={source.error} /> : null}
      </div>
    </Section>
  );
}

function PreviewPanel({ pipelineId, doc, edited }: { pipelineId: string; doc: Doc; edited: boolean }) {
  const preview = useMutation('previewPipeline', { refresh: false });
  const shown = preview.data;
  return (
    <div className={styles.stack}>
      <div className={styles.row}>
        <Button variant="primary" icon="play" pending={preview.pending} blocked={preview.blocked} onClick={() => void preview.run({ params: { pipelineId }, body: { document: doc } })}>
          {shown === undefined ? 'Preview it' : 'Preview it again'}
        </Button>
        <span className={styles.muted}>Over what you may read now{edited ? ', with your unsaved changes' : ''}; nothing is written.</span>
      </div>
      {preview.error !== undefined ? <ErrorMessage error={preview.error} /> : null}
      {shown !== undefined ? (
        <>
          {shown.inputs.filter((i) => i.refused !== null).map((i) => <Banner key={i.id} tone="info" title={`${i.id} was not read for you`}>{i.refused}</Banner>)}
          <p className={styles.muted}>{shown.inputs.map((i) => `${i.id}: ${formatNumber(i.rows)} rows${i.truncated ? ' (cut at its limit)' : ''}${i.withheld > 0 ? `, ${plural(i.withheld, 'column')} withheld` : ''}`).join('; ')}</p>
          {shown.failedStep !== null ? <Banner tone="danger" title={`Step ${shown.failedStep.step} fails`}>{shown.failedStep.message}</Banner> : (
            <div className={styles.stackTight}>
              <p className={styles.muted}>{plural(shown.total, 'row')}; the first {formatNumber(shown.rows.length)} shown.</p>
              <div className={styles.tableWrap}>
                <table className={styles.dataTable}>
                  <thead><tr>{shown.columns.map((c) => <th key={c} scope="col" className={styles.mono}>{c}</th>)}</tr></thead>
                  <tbody>{shown.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j}>{v === null ? '' : String(v)}</td>)}</tr>)}</tbody>
                </table>
              </div>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

/** Its schedule (D241): set, changed, resumed after a pause, or removed; when it runs next. */
function ScheduleEditor({ pipeline, edited }: { pipeline: Pipeline; edited: boolean }) {
  const say = useToast();
  const s = pipeline.schedule;
  const set = useMutation('setPipelineSchedule', { invalidates: ['getPipeline', 'listPipelines'] });
  const resume = useMutation('resumePipelineSchedule', { invalidates: ['getPipeline', 'listPipelines'] });
  const remove = useMutation('removePipelineSchedule', { invalidates: ['getPipeline', 'listPipelines'] });
  const [expression, setExpression] = useState(s?.schedule ?? '0 6 * * *');
  const [pauseAfter, setPauseAfter] = useState(String(s?.pauseAfterFailures ?? 3));
  const [removing, setRemoving] = useState(false);
  const blocked = pipeline.archivedAt !== null ? 'Archived' : edited ? 'Save the pipeline first' : pipeline.document.output === undefined ? 'Choose where it writes first' : set.blocked;
  const error = set.error ?? resume.error ?? remove.error;
  return (
    <div className={styles.stack}>
      <p className={styles.muted}>It runs unattended as its own principal: it reads and writes only what you could at each run, and you are told when a run fails.</p>
      {s !== null ? (
        <Panel>
          <Properties items={[
            ['Runs', <span key="r"><span className={styles.mono}>{s.schedule}</span> ({s.timeZone})</span>],
            ['State', s.status === 'active' ? <Badge key="s" tone="ok">Active</Badge> : <Badge key="s" tone="warn">{scheduleText(s)}</Badge>],
            ['Next run', s.nextRunAt === null ? '—' : <Time key="n" value={s.nextRunAt} exact />],
            ['Last run', s.lastRunAt === null ? '—' : <Time key="l" value={s.lastRunAt} exact />],
            ['Pauses after', plural(s.pauseAfterFailures, 'failed run') + ' in a row'],
          ]} />
        </Panel>
      ) : null}
      {s?.status === 'paused' && s.pausedReason === 'failures' ? (
        <Banner tone="warn" title="Paused after failures" action={<Button pending={resume.pending} blocked={resume.blocked} onClick={() => void resume.run({ params: { pipelineId: pipeline.id } }).then((r) => r.ok && say('Resumed'))}>Resume</Button>}>
          See Runs for why they failed; resume once it is fixed.
        </Banner>
      ) : null}
      <form className={styles.form} aria-label="Schedule" onSubmit={(e) => {
        e.preventDefault();
        void set.run({ params: { pipelineId: pipeline.id }, body: { schedule: expression.trim(), pauseAfterFailures: Math.max(1, Math.min(20, Number(pauseAfter) || 3)) } })
          .then((r) => r.ok && say(s === null ? 'Scheduled' : 'Schedule changed'));
      }}>
        <div className={styles.fields}>
          <SelectField label="When" value={PRESETS.some((x) => x.value === expression) ? expression : ''} placeholder="Custom"
            onChange={(e) => {
              if (e.target.value !== '') setExpression(e.target.value);
            }} options={PRESETS} />
          <TextField label="Schedule" className={styles.mono} value={expression} maxLength={200} onChange={(e) => setExpression(e.target.value)}
            hint="Minute, hour, day of month, month, day of week; no more often than every fifteen minutes." />
          <TextField label="Pause after failures in a row" type="number" min={1} max={20} value={pauseAfter} onChange={(e) => setPauseAfter(e.target.value)} />
        </div>
        {error !== undefined ? <ErrorMessage error={error} /> : null}
        <FormActions>
          {s !== null ? <Button variant="ghost" blocked={remove.blocked} onClick={() => setRemoving(true)}>Remove the schedule</Button> : null}
          <Button type="submit" variant="primary" pending={set.pending} blocked={blocked}>{s === null ? 'Schedule it' : 'Change the schedule'}</Button>
        </FormActions>
      </form>
      <ConfirmDialog open={removing} onClose={() => setRemoving(false)} title="Remove the schedule?" confirmLabel="Remove" tone="danger"
        onConfirm={() => remove.run({ params: { pipelineId: pipeline.id } }).then((r) => {
          if (r.ok) say('Schedule removed');
          return r;
        })}><p>It runs only when someone runs it. Its principal is retired.</p></ConfirmDialog>
    </div>
  );
}

function Runs({ pipelineId, siloId }: { pipelineId: string; siloId: string | undefined }) {
  const [params] = useParams();
  const runs = useQuery('listPipelineRuns', { params: { pipelineId } });
  useRefreshWhile((runs.data?.runs ?? []).some((r) => r.status === 'running'), runs.refetch);
  const named = params.get('run');
  return (
    <QueryView query={runs} what="Runs" isEmpty={(d) => d.runs.length === 0} empty={<p className={styles.muted}>Not run yet.</p>}>
      {(d) => (
        <div className={styles.stack}>
          {d.runs.filter((r) => r.id === named && r.status === 'failed').map((r) => <Banner key={r.id} tone="danger" title="This run failed">{r.failure}</Banner>)}
          <DataTable label="Runs" rows={d.runs} rowKey={(r) => r.id} columns={[
            { id: 'when', header: 'Started', primary: true, cell: (r: Run) => <Time value={r.startedAt} exact /> },
            { id: 'by', header: 'By', width: 'sm', cell: (r: Run) => (r.trigger === 'schedule' ? 'Its schedule' : 'A person') },
            { id: 'state', header: 'Outcome', cell: (r: Run) => (r.status === 'completed' ? <Badge tone="ok">Wrote {plural(r.rows ?? 0, 'row')}</Badge> : r.status === 'running' ? <Badge tone="info">Running</Badge> : <Badge tone="danger">Failed</Badge>) },
            { id: 'why', header: 'Why it failed', cell: (r: Run) => r.failure ?? '' },
            { id: 'file', header: <span className="visually-hidden">File</span>, align: 'end', cell: (r: Run) => (r.siloFileId === null ? null : <LinkButton size="sm" variant="link" href={hrefWith('/siloes/import/', { silo: siloId, file: r.siloFileId })}>What it wrote</LinkButton>) },
          ]} />
        </div>
      )}
    </QueryView>
  );
}
