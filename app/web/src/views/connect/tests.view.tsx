'use client';

// A connection's tests (spec 17): the conformance runs that verified it, each opening to its
// tests (outcomes and reasons, never values), and the write test that earns writes (17.1): a
// test record created from sample values the person gives, read back, changed and removed, or a
// named record changed and restored. Writes are enabled only on a passed run on the
// connection's current connector version, by someone who may enable them.

import { useState, type FormEvent } from 'react';
import type { Input, Output } from '../../api/client.api.ts';
import { Badge, Status } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { Dialog } from '../../components/dialog.component.tsx';
import { Checkbox, FormActions, RadioGroup, SelectField, Switch, TextField } from '../../components/field.component.tsx';
import { JsonObjectField, useJsonObject } from '../../components/json.component.tsx';
import { Panel, Properties, Section } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage, Loading } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useBlocked, useMutation, useQuery } from '../../data/query.data.ts';
import { useParam } from '../../hooks/params.hook.ts';
import { useRefreshWhile } from '../../hooks/refresh.hook.ts';
import { formatDuration, plural } from '../../utils/format.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import { TEST_CLASS, TRIGGER, type Connection, type TestClass } from './words.view.ts';
import styles from './connect.view.module.css';

type Run = Output<'listConformanceRuns'>['runs'][number];
type TestRow = Output<'getConformanceRun'>['tests'][number];
type Setup = Output<'getConnectorSetup'>;
type StartClass = NonNullable<Input<'startConformanceRun'>['body']['classes']>[number];

const STARTABLE: readonly StartClass[] = ['read', 'pagination', 'filter_pushdown', 'error'];

function outcome(run: Pick<Run, 'status' | 'gate'>): { label: string; tone: 'ok' | 'danger' | 'info' | 'neutral' } {
  if (run.status === 'running') return { label: 'Running', tone: 'info' };
  if (run.status === 'abandoned') return { label: 'Abandoned', tone: 'neutral' };
  return run.gate.verified ? { label: 'Passed', tone: 'ok' } : { label: 'Did not pass', tone: 'danger' };
}

const OUTCOME: Record<TestRow['outcome'], { label: string; tone: 'ok' | 'danger' | 'neutral' }> = {
  passed: { label: 'Passed', tone: 'ok' },
  failed: { label: 'Failed', tone: 'danger' },
  not_applicable: { label: 'Not applicable', tone: 'neutral' },
};

/** A run's tests: what each checked and how it went, never the values it read. */
export function TestTable({ tests, label }: { tests: readonly TestRow[]; label: string }) {
  return (
    <DataTable label={label} rows={tests} rowKey={(t) => t.id} dense columns={[
      { id: 'test', header: 'Test', primary: true, sortValue: (t) => t.id, cell: (t) => <span className={styles.mono}>{t.id}</span> },
      { id: 'class', header: 'Checks', width: 'md', sortValue: (t) => t.class, cell: (t) => TEST_CLASS[t.class] },
      { id: 'object', header: 'Object', width: 'md', cell: (t) => t.object ?? '—' },
      { id: 'outcome', header: 'Outcome', width: 'sm', sortValue: (t) => t.outcome, cell: (t) => <Status tone={OUTCOME[t.outcome].tone}>{OUTCOME[t.outcome].label}</Status> },
      { id: 'why', header: 'Why', cell: (t) => (t.reason === null ? '' : <span className={styles.muted}>{t.reason.replaceAll('_', ' ')}{t.operator !== null ? ` (${t.operator.field} ${t.operator.op})` : ''}</span>) },
      { id: 'took', header: 'Took', width: 'xs', align: 'end', cell: (t) => formatDuration(t.durationMs) },
    ]} />
  );
}

function RunDetail({ runId, onClose }: { runId: string; onClose: () => void }) {
  const run = useQuery('getConformanceRun', { params: { runId } });
  const r = run.data;
  useRefreshWhile(r?.status === 'running', run.refetch);
  const result = r === undefined ? undefined : outcome(r);
  return (
    <Dialog open onClose={onClose} drawer title="Test run" description={r === undefined ? undefined : <>Started <Time value={r.startedAt} /></>}>
      {r === undefined ? (run.status === 'error' ? <ErrorMessage error={run.error} onRetry={run.refetch} /> : <Loading label="Reading the run" />) : (
        <div className={styles.stack}>
          <Properties columns={2} items={[
            ['Outcome', <Badge key="o" tone={result!.tone}>{result!.label}</Badge>],
            ['Why it ran', TRIGGER[r.trigger]],
            ['Passed', String(r.passedCount)],
            ['Failed', String(r.failedCount)],
            ['Not applicable', String(r.notApplicableCount)],
            ['Suite', r.suiteVersion],
            ['Finished', r.completedAt === null ? 'Still running' : <Time key="f" value={r.completedAt} />],
            ['Checked', r.classesRun.map((c) => TEST_CLASS[c]).join(', ')],
          ]} />
          {r.gate.failedClasses.length > 0 ? (
            <Banner tone="warn" title="What kept it from passing">
              {r.gate.failedClasses.map((c) => TEST_CLASS[c]).join(', ')}
              {r.gate.failingOperators.length > 0 ? `. Filters the source refused: ${r.gate.failingOperators.map((o) => `${o.object}.${o.field} ${o.op}`).join(', ')}` : ''}.
            </Banner>
          ) : null}
          <TestTable tests={r.tests} label="Tests in this run" />
        </div>
      )}
    </Dialog>
  );
}

function StartRunDialog({ connection, open, onClose }: { connection: Connection; open: boolean; onClose: () => void }) {
  const say = useToast();
  const start = useMutation('startConformanceRun', { invalidates: ['listConformanceRuns'] });
  const [, setRun] = useParam('run');
  const [classes, setClasses] = useState<Set<StartClass>>(() => new Set(STARTABLE));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const r = await start.run({ body: { connectionId: connection.id, classes: STARTABLE.filter((c) => classes.has(c)), trigger: 'manual' } });
    if (r.ok) {
      say('Tests started');
      onClose();
      setRun(r.data.id);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Run the tests" size="sm" busy={start.pending}
      description="Silo reads a little from each object it declares, through the same path as a query. Nothing in the system is changed.">
      <form onSubmit={submit} className={styles.form}>
        {STARTABLE.map((c) => (
          <Checkbox key={c} label={TEST_CLASS[c]} checked={classes.has(c)} onChange={() => {
            const next = new Set(classes);
            if (next.has(c)) next.delete(c);
            else next.add(c);
            setClasses(next);
          }} />
        ))}
        {start.error !== undefined ? <ErrorMessage error={start.error} /> : null}
        <FormActions>
          <Button onClick={onClose} disabled={start.pending}>Cancel</Button>
          <Button type="submit" variant="primary" pending={start.pending} disabled={classes.size === 0}>Run</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

function Conformance({ connection }: { connection: Connection }) {
  const [runId, setRun] = useParam('run');
  const [starting, setStarting] = useState(false);
  const runs = useQuery('listConformanceRuns', { params: { connectionId: connection.id }, query: { limit: 25 } });
  const running = (runs.data?.runs ?? []).some((r) => r.status === 'running');
  useRefreshWhile(running, runs.refetch);
  return (
    <Section title="Conformance tests" description="Each run checks the connection reads, pages, filters and fails as its connector says it does. A connection is verified on a passed run."
      actions={connection.status === 'revoked' ? undefined : <Button icon="play" onClick={() => setStarting(true)}>Run the tests</Button>}>
      <QueryView query={runs} what="Its tests" isEmpty={(d) => d.runs.length === 0}
        empty={<EmptyState icon="success" title="Not tested yet">Run the tests once its settings and credentials are in.</EmptyState>}>
        {(d) => (
          <DataTable label="Test runs" rows={d.runs} rowKey={(r) => r.id} rowHref={(r) => hrefWith('/connect/connections/', { connection: connection.id, tab: 'tests', run: r.id })} columns={[
            { id: 'started', header: 'Started', primary: true, sortValue: (r) => r.startedAt, cell: (r) => <Time value={r.startedAt} exact /> },
            { id: 'outcome', header: 'Outcome', width: 'md', cell: (r) => <Badge tone={outcome(r).tone}>{outcome(r).label}</Badge> },
            { id: 'why', header: 'Why it ran', width: 'md', cell: (r) => TRIGGER[r.trigger] },
            { id: 'counts', header: 'Tests', cell: (r) => `${r.passedCount} passed, ${r.failedCount} failed, ${r.notApplicableCount} not applicable` },
            { id: 'failing', header: 'Failing', cell: (r) => (r.gate.failedClasses.length === 0 ? '' : r.gate.failedClasses.map((c: TestClass) => TEST_CLASS[c]).join(', ')) },
          ]} />
        )}
      </QueryView>
      <StartRunDialog connection={connection} open={starting} onClose={() => setStarting(false)} />
      {runId !== undefined ? <RunDetail key={runId} runId={runId} onClose={() => setRun(undefined)} /> : null}
    </Section>
  );
}

function WriteTestDialog({ connection, setup, open, onClose }: { connection: Connection; setup: Setup; open: boolean; onClose: () => void }) {
  const write = useMutation('runWriteClass', { invalidates: ['getWriteClassStatus', 'listConformanceRuns'] });
  const [object, setObject] = useState(setup.objects[0]?.name ?? '');
  const [mode, setMode] = useState<'create' | 'update'>('create');
  const [identifier, setIdentifier] = useState('');
  const create = useJsonObject();
  const update = useJsonObject();
  const ready = object !== '' && (mode === 'create' ? create.value !== undefined && update.error === undefined : identifier.trim() !== '' && update.value !== undefined);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    await write.run({
      params: { connectionId: connection.id },
      body: mode === 'create'
        ? { object, create: create.value as never, ...(update.value !== undefined ? { update: update.value as never } : {}) }
        : { object, identifier: identifier.trim(), update: update.value as never },
    }, { timeoutMs: 120_000 });
  };
  const result = write.data;
  return (
    <Dialog open={open} onClose={() => {
      write.reset();
      onClose();
    }} title="Run the write test" size="lg" busy={write.pending}
      description="Silo writes through the connector in a sandbox, checks what it wrote, then undoes it. The values are yours: give ones the system will accept for a test record.">
      {result !== undefined ? (
        <div className={styles.stack}>
          <Banner tone={result.passed ? 'ok' : 'warn'} title={result.passed ? 'Passed' : 'Did not pass'}>
            {result.passed ? 'Writes can now be enabled on this connection.' : 'Look at the tests that failed, correct the values or the connector, and run it again.'}
          </Banner>
          <TestTable tests={result.tests} label="Write tests" />
          <FormActions><Button variant="primary" onClick={() => {
            write.reset();
            onClose();
          }}>Done</Button></FormActions>
        </div>
      ) : (
        <form onSubmit={submit} className={styles.form}>
          <SelectField label="Object" required value={object} onChange={(e) => setObject(e.target.value)}
            options={setup.objects.map((o) => ({ value: o.name, label: o.label ?? o.name }))} placeholder="Choose an object" />
          <RadioGroup name="write-mode" label="How to test" value={mode} onChange={setMode} options={[
            { value: 'create', label: 'Create a test record, then remove it', hint: 'For an object the connector may create and delete.' },
            { value: 'update', label: 'Change a record, then restore it', hint: 'For an object the connector may only update: name a record that is safe to touch.' },
          ]} />
          {mode === 'create'
            ? <JsonObjectField label="The test record" required state={create} hint="Field names as the connector declares them." />
            : <TextField label="The record to change" required value={identifier} onChange={(e) => setIdentifier(e.target.value)} hint="Its identifier in the system." />}
          <JsonObjectField label={mode === 'create' ? 'A change to make to it (optional)' : 'The change to make'} required={mode === 'update'} state={update} rows={3} />
          {write.error !== undefined ? <ErrorMessage error={write.error} /> : null}
          <FormActions>
            <Button onClick={onClose} disabled={write.pending}>Cancel</Button>
            <Button type="submit" variant="primary" pending={write.pending} blocked={write.blocked} disabled={!ready}>Run the write test</Button>
          </FormActions>
        </form>
      )}
    </Dialog>
  );
}

function Writes({ connection, setup }: { connection: Connection; setup: Setup | undefined }) {
  const say = useToast();
  const status = useQuery('getWriteClassStatus', { params: { connectionId: connection.id } });
  const toggle = useMutation('setConnectionWrites', { invalidates: ['getConnection', 'listConnections'] });
  const writeBlocked = useBlocked('runWriteClass');
  const [testing, setTesting] = useState(false);
  const s = status.data;
  const canEnable = s?.run?.passed === true;
  return (
    <Section title="Writes" description="Governed Actions change records in the system only once its connector has passed the write test on this connection, and someone who may has enabled writes."
      actions={setup !== undefined && setup.objects.length > 0 && connection.status !== 'revoked'
        ? <Button icon="play" blocked={writeBlocked} onClick={() => setTesting(true)}>Run the write test</Button> : undefined}>
      <QueryView query={status} what="Its write test">
        {(d) => (
          <Panel>
            <div className={styles.stack}>
              <Properties items={[
                ['Last write test', d.run === null ? 'None on this connector version' : <span key="r" className={styles.row}>
                  <Badge tone={d.run.passed ? 'ok' : 'danger'}>{d.run.passed ? 'Passed' : 'Did not pass'}</Badge>
                  {plural(d.run.passedCount, 'test')} passed, {d.run.failedCount} failed, <Time value={d.run.completedAt} />
                </span>],
              ]} columns={1} />
              <Switch label="Writes enabled" checked={d.writesEnabled}
                hint={d.writesEnabled ? 'Governed Actions may change records here.' : 'Read only: nothing in Silo changes records here.'}
                blocked={toggle.blocked?.message ?? (!d.writesEnabled && !canEnable ? 'Pass the write test on this connector version first.' : undefined)}
                onChange={async (enabled) => {
                  const r = await toggle.run({ params: { connectionId: connection.id }, body: { enabled } });
                  if (r.ok) say(enabled ? 'Writes enabled' : 'Writes disabled: the connection is read only');
                }} />
              {toggle.error !== undefined ? <ErrorMessage error={toggle.error} /> : null}
            </div>
          </Panel>
        )}
      </QueryView>
      {testing && setup !== undefined ? <WriteTestDialog connection={connection} setup={setup} open onClose={() => setTesting(false)} /> : null}
    </Section>
  );
}

export function Tests({ connection, setup }: { connection: Connection; setup: Setup | undefined }) {
  return (
    <div className={styles.stack}>
      <Conformance connection={connection} />
      <Writes connection={connection} setup={setup} />
    </div>
  );
}
