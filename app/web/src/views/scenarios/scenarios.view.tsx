'use client';

// Scenarios (spec 39): "if this breaks, what happens downstream", walked over the dependency graph
// the organisation confirms. A person's own scenarios and those shared with them; a new failure
// scenario on named objects (unavailable, delayed, out for a period, or at reduced capacity),
// deterministic or over observed history; one scenario with its latest run, run again on current
// data and the current graph, any two of its runs compared (like for like only where the graph
// did not change), shared, copied, and its branches. A run a notification names opens here.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button, IconButton, LinkButton } from '../../components/button.component.tsx';
import { Dialog } from '../../components/dialog.component.tsx';
import { Checkbox, FormActions, SelectField, TextField } from '../../components/field.component.tsx';
import { Menu } from '../../components/menu.component.tsx';
import { Page, Panel, Properties, Section } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { ShareDialog, sharesFor } from '../../components/share.component.tsx';
import { EmptyState, ErrorMessage, Loading } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { type TabDef, TabPanel, Tabs, useTab } from '../../components/tabs.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { useVocabulary, type ObjectType } from '../../hooks/vocabulary.hook.ts';
import { objectHref, scenarioHref } from '../../navigation/links.navigation.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { formatNumber, plural } from '../../utils/format.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import { HELD, idFrom, NameDialog } from '../studio/kit.view.tsx';
import { RunView } from './run.view.tsx';
import { BRANCH_STATUS, FAILURE_FORM, UNITS_OF_TIME } from './words.view.ts';
import styles from './scenarios.view.module.css';

type Scenario = Output<'readSimulationScenario'>;
type Form = keyof typeof FAILURE_FORM;
const FILTERS: TabDef<'mine' | 'shared'>[] = [{ id: 'mine', label: 'Yours' }, { id: 'shared', label: 'Shared with you' }];
const ACCESS = [
  { value: 'view' as const, label: 'View it', hint: 'See what it states and its runs' },
  { value: 'run' as const, label: 'Run it', hint: 'Run it again on current data, as them' },
  { value: 'copy' as const, label: 'Copy it', hint: 'Save it as a scenario of their own' },
];
export const branchHref = (branchId: string) => hrefWith('/scenarios/branches/', { branch: branchId });

/** What a scenario states, in words. */
export function stated(s: Scenario, typeName: (id: string, plural?: boolean) => string): string {
  if (s.kind === 'branch' || s.statedFailure === null) return 'A branch of staged Actions';
  const f = s.statedFailure;
  const how = f.form === 'delayed' && f.delay !== undefined ? `delayed by ${f.delay.value} ${f.delay.unit}`
    : f.form === 'unavailable_for_period' && f.period !== undefined ? `out for ${f.period.value} ${f.period.unit}`
      : f.form === 'reduced_capacity' && f.capacityRemaining !== undefined ? `at ${Math.round(f.capacityRemaining * 100)}% capacity` : FAILURE_FORM[f.form];
  return `${plural(f.objectIds.length, typeName(f.objectTypeId).toLowerCase(), typeName(f.objectTypeId, true).toLowerCase())} ${how}`;
}

/** /scenarios/list/: the directory, a new scenario, one scenario, or a run a notification named. */
export function Scenarios() {
  const [params] = useParams();
  const scenario = params.get('scenario');
  const run = params.get('run');
  if (scenario !== null) {
    const id = idFrom(scenario);
    return id === undefined ? <NotFound what="a scenario" /> : <ScenarioPage key={id} scenarioId={id} />;
  }
  if (run !== null) {
    const id = idFrom(run);
    return id === undefined ? <NotFound what="a run" /> : <RunRedirect runId={id} />;
  }
  return <Directory />;
}

function NotFound({ what }: { what: string }) {
  return (
    <Page title="Scenarios" crumbs={[{ label: 'Scenarios' }]}>
      <EmptyState icon="scenarios" title={`This address does not name ${what}`} action={<LinkButton href="/scenarios/list/">All scenarios</LinkButton>}>Check the link you followed.</EmptyState>
    </Page>
  );
}

function RunRedirect({ runId }: { runId: string }) {
  const router = useRouter();
  const read = useQuery('readSimulationRun', { params: { runId } });
  useEffect(() => {
    if (read.data !== undefined) router.replace(hrefWith('/scenarios/list/', { scenario: read.data.scenarioId, run: runId }) as never);
  }, [read.data, router, runId]);
  return <Page title="Scenario run" crumbs={[{ label: 'Scenarios', href: '/scenarios/list/' }]}><QueryView query={read} what="The run">{() => <Loading label="Opening its scenario" />}</QueryView></Page>;
}

function Directory() {
  const { lookup } = useVocabulary();
  const [params, set] = useParams();
  const [filter, setFilter] = useTab(FILTERS, 'filter');
  const list = useQuery('listSimulationScenarios', { query: { filter } }, { keepPrevious: true });
  const making = params.get('new') !== null || params.get('tab') === 'new';
  usePageContext({ scope: { kind: 'page', page: 'scenarios' }, scopeLabel: 'Scenarios' });
  return (
    <Page title="Scenarios" description="A scenario walks the dependency graph your organisation has confirmed. It names what is reached and how; it never says one thing caused another."
      crumbs={[{ label: 'Scenarios' }]}
      actions={<Button variant="primary" icon="plus" onClick={() => set({ new: '1' })}>New scenario</Button>}>
      <Tabs label="Which scenarios" tabs={FILTERS} current={filter} onChange={setFilter} />
      <TabPanel id={filter}>
        <QueryView query={list} what="Scenarios" isEmpty={(d) => d.scenarios.length === 0}
          empty={<EmptyState icon="scenarios" title={filter === 'mine' ? 'No scenarios yet' : 'None shared with you'}>{filter === 'mine' ? 'Name what fails, and see what depends on it, through the edges your organisation has confirmed.' : 'Scenarios others share with you appear here.'}</EmptyState>}>
          {(d) => (
            <DataTable label="Scenarios" rows={d.scenarios} rowKey={(s) => s.id} rowHref={(s) => scenarioHref(s.id)} columns={[
              { id: 'name', header: 'Scenario', primary: true, cell: (s) => s.name },
              { id: 'what', header: 'What it states', cell: (s) => (lookup === undefined ? '…' : stated(s as Scenario, lookup.typeName)) },
              { id: 'mode', header: 'Mode', width: 'sm', cell: (s) => (s.mode === 'probabilistic' ? 'Probabilistic' : 'Deterministic') },
              { id: 'held', header: 'Yours or shared', cell: (s) => HELD[s.access] ?? s.access },
              { id: 'made', header: 'Made', width: 'sm', sortValue: (s) => s.createdAt, cell: (s) => <Time value={s.createdAt} /> },
            ]} />
          )}
        </QueryView>
      </TabPanel>
      {making ? <NewScenario onClose={() => set({ new: undefined, tab: undefined })} /> : null}
    </Page>
  );
}

type Candidate = { id: string; title: string };

/** The objects of a type to choose from: its first 200, by title, read as the person. */
function useCandidates(type: ObjectType | undefined, ontologyVersionId: string | undefined) {
  const title = type?.properties.find((p) => p.identityId === type.titleProperty);
  const read = useQuery('runStructuredPlan', type === undefined || ontologyVersionId === undefined ? null : {
    body: { plan: { schemaVersion: '1', ontologyVersionId, nodes: [{ objectTypeId: type.id, filters: [] }], select: title === undefined ? [] : [{ node: 0, property: title.identityId }], limit: 200 }, parameters: {} },
  });
  const out = read.data;
  const candidates: Candidate[] | undefined = out === undefined || out.outcome !== 'answer' ? undefined : out.result.page.objects.map((o) => ({
    id: o.id, title: title === undefined ? o.id.slice(0, 8) : o.disputed.includes(title.apiName) ? 'Systems disagree on its name' : String(o.values[title.apiName] ?? o.id.slice(0, 8)),
  }));
  return { read, candidates, refusal: out !== undefined && out.outcome === 'refusal' ? out.refusal.reason : undefined };
}

function NewScenario({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { data: vocabulary } = useVocabulary();
  const save = useMutation('saveSimulationScenario', { invalidates: ['listSimulationScenarios'] });
  const [name, setName] = useState('');
  const [typeId, setTypeId] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [form, setForm] = useState<Form>('unavailable');
  const [amount, setAmount] = useState('1');
  const [unit, setUnit] = useState<typeof UNITS_OF_TIME[number]>('days');
  const [capacity, setCapacity] = useState('50');
  const [mode, setMode] = useState<'deterministic' | 'probabilistic'>('deterministic');
  const [hops, setHops] = useState('4');
  const type = vocabulary?.objectTypes.find((t) => t.id === typeId);
  const { read, candidates, refusal } = useCandidates(type, vocabulary?.ontologyVersionId);
  const d = { value: Number(amount), unit };
  return (
    <Dialog open onClose={onClose} title="New scenario" size="lg" busy={save.pending}
      description="Name what fails and how; the walk follows confirmed edges only, and stops where an edge is not confirmed.">
      <form className={styles.form} onSubmit={async (e) => {
        e.preventDefault();
        const r = await save.run({
          body: {
            name: name.trim(), mode, bounds: { hops: Math.max(1, Math.min(8, Number(hops) || 4)), fanOut: 1000 },
            statedFailure: {
              form, objectTypeId: typeId, objectIds: chosen,
              ...(form === 'delayed' ? { delay: d } : {}), ...(form === 'unavailable_for_period' ? { period: d } : {}),
              ...(form === 'reduced_capacity' ? { capacityRemaining: Math.max(1, Math.min(99, Number(capacity) || 50)) / 100 } : {}),
            },
          },
        });
        if (r.ok) router.push(scenarioHref(r.data.id) as never);
      }}>
        <TextField label="Name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
        <SelectField label="What fails" required value={typeId} placeholder="Choose an object type" onChange={(e) => {
          setTypeId(e.target.value);
          setChosen([]);
        }} options={(vocabulary?.objectTypes ?? []).map((t) => ({ value: t.id, label: t.pluralName }))} />
        {typeId !== '' ? (
          <fieldset className={styles.fieldset}>
            <legend>Which (up to 100)</legend>
            {refusal !== undefined ? <p className={styles.muted}>{refusal}</p> : read.error !== undefined ? <ErrorMessage error={read.error} onRetry={read.refetch} />
              : candidates === undefined ? <Loading label="Reading its objects" block={false} /> : candidates.length === 0 ? <p className={styles.muted}>No objects you may see.</p> : (
                <div className={styles.checks}>{candidates.map((c) => (
                  <Checkbox key={c.id} label={c.title} checked={chosen.includes(c.id)} disabled={!chosen.includes(c.id) && chosen.length >= 100}
                    onChange={(e) => setChosen(e.target.checked ? [...chosen, c.id].slice(0, 100) : chosen.filter((x) => x !== c.id))} />
                ))}</div>
              )}
          </fieldset>
        ) : null}
        <div className={styles.fields}>
          <SelectField label="How" value={form} onChange={(e) => setForm(e.target.value as Form)}
            options={[{ value: 'unavailable', label: 'Unavailable' }, { value: 'delayed', label: 'Delayed by' }, { value: 'unavailable_for_period', label: 'Unavailable for' }, { value: 'reduced_capacity', label: 'At reduced capacity' }]} />
          {form === 'delayed' || form === 'unavailable_for_period' ? (
            <>
              <TextField label="Amount" type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} />
              <SelectField label="Unit" value={unit} onChange={(e) => setUnit(e.target.value as typeof unit)} options={UNITS_OF_TIME.map((u) => ({ value: u, label: u }))} />
            </>
          ) : null}
          {form === 'reduced_capacity' ? <TextField label="Capacity left (%)" type="number" min={1} max={99} value={capacity} onChange={(e) => setCapacity(e.target.value)} /> : null}
          <SelectField label="Mode" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}
            options={[{ value: 'deterministic', label: 'Deterministic' }, { value: 'probabilistic', label: 'Probabilistic (observed history)' }]} />
          <TextField label="Hops" type="number" min={1} max={8} value={hops} onChange={(e) => setHops(e.target.value)} hint="How far the walk goes, at most 8." />
        </div>
        {save.error !== undefined ? <ErrorMessage error={save.error} /> : null}
        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" pending={save.pending} blocked={save.blocked} disabled={name.trim() === '' || chosen.length === 0}>Save the scenario</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

function ScenarioPage({ scenarioId }: { scenarioId: string }) {
  const router = useRouter();
  const say = useToast();
  const people = useDirectory();
  const { lookup } = useVocabulary();
  const [params, set] = useParams();
  const read = useQuery('readSimulationScenario', { params: { scenarioId } });
  const latest = useQuery('readLatestSimulationRun', { params: { scenarioId } });
  const runs = useQuery('listSimulationRuns', { params: { scenarioId }, query: {} });
  const run = useMutation('runSimulationScenario', { invalidates: ['readLatestSimulationRun', 'listSimulationRuns'] });
  const copy = useMutation('copySimulationScenario', { invalidates: ['listSimulationScenarios'] });
  const shares = useQuery('listSimulationScenarioShares', read.data?.access === 'owner' ? { params: { scenarioId } } : null);
  const share = useMutation('shareSimulationScenario', { invalidates: ['listSimulationScenarioShares'] });
  const revoke = useMutation('revokeSimulationScenarioShare', { invalidates: ['listSimulationScenarioShares'] });
  const branches = useQuery('listSimulationBranches', { params: { scenarioId } });
  const create = useMutation('createSimulationBranch', { invalidates: ['listSimulationBranches'] });
  const [dialog, setDialog] = useState<'share' | 'copy' | 'branch' | undefined>();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const compare = useQuery('compareSimulationRuns', from === '' || to === '' || from === to ? null : { params: { scenarioId }, query: { from, to } });
  const shownRunId = params.get('run');
  const shown = useQuery('readSimulationRun', shownRunId === null ? null : { params: { runId: shownRunId } });
  const s = read.data;
  usePageContext({ scope: { kind: 'scenario', scenarioId }, scopeLabel: s?.name ?? 'a scenario' });
  if (s === undefined) {
    return <Page title="Scenario" crumbs={[{ label: 'Scenarios', href: '/scenarios/list/' }]}><QueryView query={read} what="The scenario">{() => null}</QueryView></Page>;
  }
  const canRun = s.kind === 'failure' && s.access !== 'view';
  const current = shownRunId !== null ? shown.data : latest.data?.run ?? undefined;
  const completed = (runs.data?.runs ?? []).filter((r) => r.status === 'completed');
  return (
    <Page title={s.name} documentTitle={s.name} width="full" crumbs={[{ label: 'Scenarios', href: '/scenarios/list/' }]}
      meta={<span className={styles.row}>{s.access !== 'owner' ? <Badge tone="info">{HELD[s.access]}</Badge> : null}<span className={styles.muted}>{lookup === undefined ? '' : stated(s, lookup.typeName)}</span></span>}
      actions={
        <div className={styles.row}>
          {canRun ? (
            <Button variant="primary" icon="play" pending={run.pending} blocked={run.blocked} onClick={() => void run.run({ params: { scenarioId } }).then((r) => {
              if (!r.ok) return;
              set({ run: undefined });
              say(r.data.status === 'failed' ? 'The run failed' : `Reached ${plural(r.data.reached.length, 'object')}`);
            })}>{latest.data?.run == null ? 'Run it' : 'Run it again'}</Button>
          ) : null}
          {s.access === 'owner' ? <Button icon="share" blocked={share.blocked} onClick={() => setDialog('share')}>Share</Button> : null}
          <Menu label="More" items={[
            { label: 'Open a branch', icon: 'branch', blocked: create.blocked, onSelect: () => setDialog('branch') },
            { label: 'Make a copy', icon: 'copy', disabled: !(s.access === 'owner' || s.access === 'copy'), blocked: copy.blocked, onSelect: () => setDialog('copy') },
          ]} renderTrigger={(x) => <IconButton {...x} label="More" icon="more" />} />
        </div>
      }>
      <article aria-label={s.name} className={styles.stack}>
        <Panel>
          <Properties items={[
            ['States', lookup === undefined ? '…' : stated(s, lookup.typeName)],
            ['Mode', `${s.mode === 'probabilistic' ? 'Probabilistic' : 'Deterministic'}${s.bounds.iterations !== undefined ? `, ${formatNumber(s.bounds.iterations)} iterations` : ''}`],
            ['Bounds', `${plural(s.bounds.hops, 'hop')}, ${formatNumber(s.bounds.fanOut)} objects a hop`],
            ['Graph', `version ${s.graphVersion} when saved`],
          ]} />
        </Panel>
        {run.error !== undefined ? <ErrorMessage error={run.error} /> : null}
        {shownRunId === null && latest.data?.graphChanged === true ? (
          <Banner tone="info" title="The graph has changed since this run">Run it again to walk the graph as it is now (graph version {latest.data.graphVersion}).</Banner>
        ) : null}
        {shownRunId !== null ? (
          <p className={styles.row}><span className={styles.muted}>An earlier run.</span><Button size="sm" variant="ghost" onClick={() => set({ run: undefined })}>Show the latest</Button></p>
        ) : null}
        {current !== undefined && current !== null ? <RunView run={current} />
          : latest.status === 'loading' || shown.status === 'loading' ? <Loading label="Reading its run" />
            : <EmptyState icon="play" title="Not run yet">{canRun ? 'Run it to see what is reached.' : 'Its owner, or someone it is shared with to run, runs it.'}</EmptyState>}
        <Section title="Runs" description="Any two compare; like for like only where the graph did not change between them.">
          <QueryView query={runs} what="Runs" isEmpty={(d) => d.runs.length === 0} empty={<p className={styles.muted}>No runs yet.</p>}>
            {(d) => (
              <div className={styles.stack}>
                <DataTable label="Runs" rows={d.runs} rowKey={(r) => r.runId} rowHref={(r) => hrefWith('/scenarios/list/', { scenario: scenarioId, run: r.runId })} columns={[
                  { id: 'when', header: 'Started', primary: true, cell: (r) => <Time value={r.startedAt} exact /> },
                  { id: 'state', header: 'State', width: 'sm', cell: (r) => (r.status === 'completed' ? <Badge tone="ok">Completed</Badge> : r.status === 'running' ? <Badge tone="info">Running</Badge> : <Badge tone="danger">Failed</Badge>) },
                  { id: 'graph', header: 'Graph', width: 'sm', cell: (r) => `version ${r.graphVersion}` },
                  { id: 'mode', header: 'Mode', width: 'sm', cell: (r) => r.mode },
                  { id: 'by', header: 'By', cell: (r) => people.nameOf(r.runBy) },
                ]} />
                {completed.length >= 2 ? (
                  <div className={styles.rowEnd}>
                    <SelectField label="Compare" value={from} placeholder="An earlier run" onChange={(e) => setFrom(e.target.value)}
                      options={completed.map((r) => ({ value: r.runId, label: `${new Date(r.startedAt).toLocaleString('en-GB')} (graph ${r.graphVersion})` }))} />
                    <SelectField label="With" value={to} placeholder="A later run" onChange={(e) => setTo(e.target.value)}
                      options={completed.map((r) => ({ value: r.runId, label: `${new Date(r.startedAt).toLocaleString('en-GB')} (graph ${r.graphVersion})` }))} />
                  </div>
                ) : null}
                {compare.data !== undefined ? (
                  <Panel>
                    <div className={styles.stackTight} role="status">
                      {!compare.data.comparable ? <strong>The graph changed between the runs, so they are not like for like.</strong> : null}
                      <span>{plural(compare.data.entered.length, 'object')} entered the affected set and {formatNumber(compare.data.left.length)} left it{compare.data.graphChanged ? ', partly because the graph changed' : ', because the data moved'}.</span>
                      <Moved label="Entered" objects={compare.data.entered} />
                      <Moved label="Left" objects={compare.data.left} />
                    </div>
                  </Panel>
                ) : compare.error !== undefined ? <ErrorMessage error={compare.error} /> : null}
              </div>
            )}
          </QueryView>
        </Section>
        <Section title="Branches" description="In a branch, Actions are staged against the record now and simulated over the graph. Nothing is written until they are promoted, as proposals, through approval."
          actions={<Button size="sm" icon="plus" blocked={create.blocked} onClick={() => setDialog('branch')}>Open a branch</Button>}>
          <QueryView query={branches} what="Branches" isEmpty={(d) => d.branches.length === 0} empty={<p className={styles.muted}>No branches yet.</p>}>
            {(d) => (
              <DataTable label="Branches" rows={d.branches} rowKey={(b) => b.id} rowHref={(b) => branchHref(b.id)} columns={[
                { id: 'name', header: 'Branch', primary: true, cell: (b) => b.name },
                { id: 'label', header: 'Label', cell: (b) => <Badge tone="accent">{b.label}</Badge> },
                { id: 'state', header: 'State', width: 'sm', cell: (b) => <Badge tone={BRANCH_STATUS[b.status].tone}>{BRANCH_STATUS[b.status].label}</Badge> },
                { id: 'counts', header: 'Staged', cell: (b) => `${b.counts.clean} clean, ${b.counts.conflicted} conflicted, ${b.counts.promoted} promoted` },
              ]} />
            )}
          </QueryView>
        </Section>
      </article>
      <ShareDialog open={dialog === 'share'} onClose={() => setDialog(undefined)} title={`Share ${s.name}`} what="this scenario" access={ACCESS}
        shares={sharesFor(shares.data?.shares)} shareBlocked={share.blocked} revokeBlocked={revoke.blocked}
        onShare={(grantee, access) => share.run({ params: { scenarioId }, body: { grantee, access } })}
        onRevoke={(shareId) => revoke.run({ params: { scenarioId, shareId } })} />
      <NameDialog open={dialog === 'copy'} title="Copy the scenario" initial={`${s.name} (copy)`.slice(0, 200)} action="Make the copy" pending={copy.pending} error={copy.error}
        hint="The copy is yours, private again."
        onClose={() => setDialog(undefined)}
        onSave={(name) => void copy.run({ params: { scenarioId }, body: { name } }).then((r) => {
          if (!r.ok) return;
          setDialog(undefined);
          router.push(scenarioHref(r.data.id) as never);
        })} />
      <NameDialog open={dialog === 'branch'} title="Open a branch" initial="" action="Open the branch" pending={create.pending} error={create.error}
        hint="Staged Actions in it are simulated, never executed, until promoted."
        onClose={() => setDialog(undefined)}
        onSave={(name) => void create.run({ body: { name, from: { kind: 'scenario', scenarioId } } }).then((r) => {
          if (!r.ok) return;
          setDialog(undefined);
          router.push(branchHref(r.data.id) as never);
        })} />
    </Page>
  );
}

/** The objects that entered or left the affected set, the first twenty linked. */
function Moved({ label, objects }: { label: string; objects: readonly { objectTypeId: string; objectId: string }[] }) {
  const { lookup } = useVocabulary();
  if (objects.length === 0) return null;
  return (
    <span className={styles.muted}>{label}: {objects.slice(0, 20).map((o, i) => (
      <span key={o.objectId}>{i > 0 ? ', ' : ''}<Link href={objectHref(o) as never}>{lookup?.typeName(o.objectTypeId) ?? 'Object'} {o.objectId.slice(0, 8)}</Link></span>
    ))}{objects.length > 20 ? ` and ${formatNumber(objects.length - 20)} more` : ''}</span>
  );
}
