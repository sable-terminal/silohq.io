'use client';

// Crons (spec 40): a saved question, a schedule or a watch on changes, a condition, and what is
// done when it holds (tell people, file a report, escalate for a decision, or propose or carry
// out an Action within bounds), run without anyone present as the Cron's own principal, never
// with more than its owner holds. Paused when a connection halts, its owner leaves or it keeps
// failing, and says which. Its runs, what each action did, escalations waiting on someone, and
// who it is shared with.

import Link from 'next/link';
import { useMemo, useState, type FormEvent } from 'react';
import type { Input, Output } from '../../api/client.api.ts';
import { Badge, Status } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button, IconButton } from '../../components/button.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { Checkbox, fieldError, FormActions, RadioGroup, SelectField, TextField } from '../../components/field.component.tsx';
import { Menu } from '../../components/menu.component.tsx';
import { Page, Panel, Properties, Section, Toolbar } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage, Loading } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useBlocked, useMutation, usePermit, usePermits, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { useVocabulary } from '../../hooks/vocabulary.hook.ts';
import { usePageContext, useWorkspace } from '../../shell/context.shell.tsx';
import { plural } from '../../utils/format.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import styles from './governance.view.module.css';

type Cron = Output<'readCron'>;
type Body = Input<'createCron'>['body'];
type ActionBody = Body['actions'][number];
type Run = Output<'listCronRuns'>['runs'][number];
type Condition = NonNullable<Cron['condition']>;

const PAUSED: Record<NonNullable<Cron['pausedReason']>, string> = {
  manual: 'Paused by a person', repeated_failure: 'Paused after failing repeatedly', connection_halted: 'Paused: a connection it reads is halted',
  owner_removed: 'Paused: its owner left', billing_suspended: 'Paused: billing is suspended', authorisation_expired: 'Paused: its authorisation to act ran out',
};
const ACTION: Record<Cron['actions'][number]['kind'], string> = { notify: 'Tell people', report: 'File a report', escalate: 'Escalate for a decision', mutate: 'Propose or carry out an Action' };
const OUTCOME_TONE: Record<Run['actions'][number]['outcome'], 'ok' | 'danger' | 'neutral' | 'info'> = { delivered: 'ok', executed: 'ok', succeeded: 'ok', proposed: 'info', skipped: 'neutral', failed: 'danger' };
const SCHEDULES: readonly { value: string; label: string }[] = [
  { value: '0 * * * *', label: 'Every hour' }, { value: '0 9 * * *', label: 'Every day at 09:00' }, { value: '0 9 * * 1-5', label: 'Weekdays at 09:00' },
  { value: '0 9 * * 1', label: 'Mondays at 09:00' }, { value: '0 9 1 * *', label: 'The first of each month at 09:00' },
];

function conditionText(c: Condition | null): string {
  if (c === null) return 'Every run';
  if (c.kind === 'composite') return c.operands.map(conditionText).join(c.combinator === 'AND' ? ' and ' : ' or ');
  const op = (c.operator ?? '').replaceAll('_', ' ');
  const v = c.value === null || c.value === undefined ? '' : ` ${typeof c.value === 'object' ? JSON.stringify(c.value) : String(c.value)}`;
  return c.kind === 'result' ? `When it ${op}${v}` : c.kind === 'finding' ? `When a detector ${op}${v}` : `When the figure is ${op}${v}`;
}

function scheduleText(s: string | null): string {
  if (s === null) return 'When what it watches changes';
  return SCHEDULES.find((x) => x.value === s)?.label ?? s;
}

// ----------------------------------------------------------------------------- making one

function CreateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const say = useToast();
  const [, set] = useParams();
  const people = useDirectory();
  const views = useQuery('listWorkspaceViews', {});
  const sets = useQuery('listOntologyObjectSets', { query: { limit: 200 } });
  const actionsPermit = usePermit('listActionTypes');
  const actionTypes = useQuery('listActionTypes', actionsPermit.allowed === true ? { query: { status: 'confirmed', limit: 500 } } : null);
  const detectors = useQuery('listRecognitionDetectors', {}, { staleMs: 10 * 60_000 });
  const { data: vocabulary } = useVocabulary();
  const create = useMutation('createCron', { invalidates: ['listCrons'] });
  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [triggerKind, setTriggerKind] = useState<'schedule' | 'watch'>('schedule');
  const [schedule, setSchedule] = useState(SCHEDULES[1]!.value);
  const [custom, setCustom] = useState('');
  const [watched, setWatched] = useState<Set<string>>(new Set());
  const [windowMinutes, setWindowMinutes] = useState('5');
  const [conditionKind, setConditionKind] = useState<'none' | 'result' | 'value' | 'finding'>('result');
  const [resultOp, setResultOp] = useState<'returned_rows' | 'returned_none' | 'count_crossed' | 'differs_from_previous'>('returned_rows');
  const [threshold, setThreshold] = useState('');
  const [direction, setDirection] = useState<'above' | 'below'>('above');
  const [valueOp, setValueOp] = useState<'above' | 'below' | 'changed_by_proportion' | 'unchanged_for'>('above');
  const [figureKind, setFigureKind] = useState<'measure' | 'property'>('measure');
  const [figureName, setFigureName] = useState('');
  const [detectorId, setDetectorId] = useState('');
  const [findingType, setFindingType] = useState('');
  const [findingOp, setFindingOp] = useState<'raised' | 'score_above' | 'recurred'>('raised');
  const [notify, setNotify] = useState(true);
  const [recipients, setRecipients] = useState<Set<string>>(new Set());
  const [report, setReport] = useState(false);
  const [format, setFormat] = useState<'csv' | 'xlsx' | 'pdf'>('csv');
  const [escalate, setEscalate] = useState('');
  const [mutateId, setMutateId] = useState('');
  const [failures, setFailures] = useState('3');
  const [subjectKind, subjectId] = subject.split(':') as ['view' | 'set' | '', string | undefined];
  const chosenSet = subjectKind === 'set' ? sets.data?.objectSets.find((s) => s.id === subjectId) : undefined;
  const watchType = chosenSet?.baseTypeId !== null && chosenSet !== undefined ? vocabulary?.objectTypes.find((t) => t.id === chosenSet.baseTypeId) : undefined;

  const condition = (): Body['condition'] => {
    if (conditionKind === 'none') return undefined;
    if (conditionKind === 'result') return { kind: 'result', operator: resultOp, ...(resultOp === 'count_crossed' ? { threshold: Number(threshold), direction } : {}) };
    if (conditionKind === 'value') {
      const n = Number(threshold);
      return { kind: 'value', operator: valueOp, figure: figureKind === 'measure' ? { measure: figureName } : { property: figureName },
        ...(valueOp === 'above' || valueOp === 'below' ? { threshold: n } : valueOp === 'changed_by_proportion' ? { proportion: n / 100 } : { hours: n }) };
    }
    return { kind: 'finding', operator: findingOp, detectorId, objectTypeId: findingType, ...(findingOp === 'score_above' ? { threshold: Number(threshold) } : {}) };
  };
  const actions = (): ActionBody[] => [
    ...(notify ? [{ kind: 'notify' as const, recipients: [...recipients] }] : []),
    ...(report ? [{ kind: 'report' as const, format }] : []),
    ...(escalate !== '' ? [escalate.startsWith('scope:') ? { kind: 'escalate' as const, scopeId: escalate.slice(6) } : { kind: 'escalate' as const, membershipId: escalate }] : []),
    ...(mutateId !== '' ? [{ kind: 'mutate' as const, actionTypeId: mutateId, mode: 'propose' as const }] : []),
  ];
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const r = await create.run({ body: {
      name: name.trim(),
      ...(subjectKind === 'view' ? { subject: { savedViewId: subjectId! } } : subjectKind === 'set' ? { subject: { objectSetId: subjectId! } } : {}),
      trigger: triggerKind === 'schedule' ? { schedule: schedule === 'custom' ? custom.trim() : schedule } : { watch: { properties: [...watched], windowSeconds: Number(windowMinutes) * 60 } },
      ...(condition() !== undefined ? { condition: condition() } : {}),
      actions: actions(),
      failurePolicy: Number(failures) > 0 ? { mode: 'pause_after', failures: Number(failures) } : { mode: 'notify_and_continue' },
    } });
    if (r.ok) {
      say(`${r.data.name} is running${r.data.nextRunAt !== null ? `; next ${new Date(r.data.nextRunAt).toLocaleString('en-GB')}` : ''}`);
      set({ new: undefined, cron: r.data.id });
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="New Cron" size="xl" busy={create.pending}
      description="It runs as its own principal, never with more than you hold; when you lose access, it does too.">
      <form className={styles.form} onSubmit={submit}>
        <TextField label="Name" required value={name} onChange={(e) => setName(e.target.value)} data-autofocus error={fieldError(create.error, 'name')} />
        <SelectField label="It asks" required value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Choose a saved view or object set" options={[
          ...(views.data?.views ?? []).filter((v) => v.archivedAt === null).map((v) => ({ value: `view:${v.id}`, label: `Saved view: ${v.name}` })),
          ...(sets.data?.objectSets ?? []).map((s) => ({ value: `set:${s.id}`, label: `Object set: ${s.name}` })),
        ]} hint="Save a question in Ask or Explorer to use it here." />
        <Section title="When">
          <RadioGroup name="trigger" label="Runs" value={triggerKind} onChange={setTriggerKind} options={[
            { value: 'schedule', label: 'On a schedule', hint: 'In your organisation\'s time zone.' },
            { value: 'watch', label: 'When what it watches changes', hint: 'An object set only: its sources must stream changes.' },
          ]} />
          {triggerKind === 'schedule' ? (
            <div className={styles.split}>
              <SelectField label="Schedule" value={schedule} onChange={(e) => setSchedule(e.target.value)} options={[...SCHEDULES, { value: 'custom', label: 'Something else' }]} />
              {schedule === 'custom' ? <TextField label="Cron expression" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="*/15 8-18 * * 1-5" spellCheck={false} /> : null}
            </div>
          ) : (
            <>
              {watchType === undefined ? <Banner tone="warn">Choose an object set on a type to watch it.</Banner> : (
                <fieldset className={styles.choices}>
                  <legend>Properties it watches</legend>
                  {watchType.properties.map((p) => (
                    <Checkbox key={p.apiName} label={p.displayName} checked={watched.has(p.apiName)} onChange={() => {
                      const next = new Set(watched);
                      if (next.has(p.apiName)) next.delete(p.apiName);
                      else next.add(p.apiName);
                      setWatched(next);
                    }} />
                  ))}
                </fieldset>
              )}
              <TextField label="Gather changes for (minutes)" type="number" min={1} max={1440} value={windowMinutes} onChange={(e) => setWindowMinutes(e.target.value)} />
            </>
          )}
        </Section>
        <Section title="If">
          <SelectField label="Condition" value={conditionKind} onChange={(e) => setConditionKind(e.target.value as typeof conditionKind)} options={[
            { value: 'result', label: 'Something about the answer' }, { value: 'value', label: 'A figure in the answer' }, { value: 'finding', label: 'A detector found something' }, { value: 'none', label: 'Always' },
          ]} />
          {conditionKind === 'result' ? (
            <div className={styles.split}>
              <SelectField label="When it" value={resultOp} onChange={(e) => setResultOp(e.target.value as typeof resultOp)} options={[
                { value: 'returned_rows', label: 'returns anything' }, { value: 'returned_none', label: 'returns nothing' }, { value: 'count_crossed', label: 'crosses a count' }, { value: 'differs_from_previous', label: 'differs from last time' },
              ]} />
              {resultOp === 'count_crossed' ? (
                <>
                  <SelectField label="Going" value={direction} onChange={(e) => setDirection(e.target.value as typeof direction)} options={[{ value: 'above', label: 'above' }, { value: 'below', label: 'below' }]} />
                  <TextField label="Count" type="number" min={0} value={threshold} onChange={(e) => setThreshold(e.target.value)} />
                </>
              ) : null}
            </div>
          ) : null}
          {conditionKind === 'value' ? (
            <div className={styles.split}>
              <SelectField label="The figure is" value={figureKind} onChange={(e) => setFigureKind(e.target.value as typeof figureKind)} options={[{ value: 'measure', label: 'A measure of the answer' }, { value: 'property', label: 'A property of the one object' }]} />
              <TextField label="Its name" value={figureName} onChange={(e) => setFigureName(e.target.value)} spellCheck={false} placeholder="total_amount" />
              <SelectField label="When it is" value={valueOp} onChange={(e) => setValueOp(e.target.value as typeof valueOp)} options={[
                { value: 'above', label: 'above' }, { value: 'below', label: 'below' }, { value: 'changed_by_proportion', label: 'changed by a percentage' }, { value: 'unchanged_for', label: 'unchanged for hours' },
              ]} />
              <TextField label={valueOp === 'changed_by_proportion' ? 'Percent' : valueOp === 'unchanged_for' ? 'Hours' : 'Threshold'} type="number" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
            </div>
          ) : null}
          {conditionKind === 'finding' ? (
            <div className={styles.split}>
              <SelectField label="Detector" value={detectorId} onChange={(e) => setDetectorId(e.target.value)} placeholder="Choose" options={(detectors.data?.detectors ?? []).map((d) => ({ value: d.id, label: d.name }))} />
              <SelectField label="On" value={findingType} onChange={(e) => setFindingType(e.target.value)} placeholder="Choose a type" options={(vocabulary?.objectTypes ?? []).map((t) => ({ value: t.id, label: t.pluralName }))} />
              <SelectField label="When it" value={findingOp} onChange={(e) => setFindingOp(e.target.value as typeof findingOp)} options={[
                { value: 'raised', label: 'raises anything' }, { value: 'score_above', label: 'scores above' }, { value: 'recurred', label: 'finds something again' },
              ]} />
              {findingOp === 'score_above' ? <TextField label="Score" type="number" value={threshold} onChange={(e) => setThreshold(e.target.value)} /> : null}
            </div>
          ) : null}
        </Section>
        <Section title="Then">
          <Checkbox label="Tell people" checked={notify} onChange={() => setNotify(!notify)} hint="You and whoever you name, in Home: the Cron, the condition and counts, never values." />
          {notify ? (
            <fieldset className={styles.choices}>
              <legend>Also tell</legend>
              {people.members.filter((m) => m.status === 'active').map((m) => (
                <Checkbox key={m.membershipId} label={m.displayName} checked={recipients.has(m.membershipId)} onChange={() => {
                  const next = new Set(recipients);
                  if (next.has(m.membershipId)) next.delete(m.membershipId);
                  else next.add(m.membershipId);
                  setRecipients(next);
                }} />
              ))}
            </fieldset>
          ) : null}
          <div className={styles.split}>
            <Checkbox label="File a report in Files" checked={report} onChange={() => setReport(!report)} />
            {report ? <SelectField label="As" value={format} onChange={(e) => setFormat(e.target.value as typeof format)} options={[{ value: 'csv', label: 'CSV' }, { value: 'xlsx', label: 'Excel' }, { value: 'pdf', label: 'PDF' }]} /> : null}
          </div>
          <SelectField label="Escalate for a decision to" value={escalate} onChange={(e) => setEscalate(e.target.value)} placeholder="Nobody" options={[
            ...people.members.filter((m) => m.status === 'active').map((m) => ({ value: m.membershipId, label: m.displayName })),
            ...people.scopes.map((s) => ({ value: `scope:${s.id}`, label: `Anyone in ${s.name}` })),
          ]} />
          <SelectField label="Propose an Action on what it returns" value={mutateId} onChange={(e) => setMutateId(e.target.value)} placeholder="None"
            options={(actionTypes.data?.actionTypes ?? []).map((a) => ({ value: a.id, label: a.displayName }))} hint="Proposed for people to approve. Carrying one out unattended is set up with bounds after the Cron exists." />
        </Section>
        <TextField label="Pause after this many failures in a row" type="number" min={0} max={20} value={failures} onChange={(e) => setFailures(e.target.value)} hint="0 to keep going and tell you each time." />
        {create.error !== undefined && fieldError(create.error, 'name') === undefined ? <ErrorMessage error={create.error} /> : null}
        <FormActions>
          <Button onClick={onClose} disabled={create.pending}>Cancel</Button>
          <Button type="submit" variant="primary" pending={create.pending} blocked={create.blocked} disabled={name.trim() === '' || subject === '' || actions().length === 0}>Start it</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

// ----------------------------------------------------------------------------- one Cron

function Runs({ cron }: { cron: Cron }) {
  const say = useToast();
  const people = useDirectory();
  const workspace = useWorkspace();
  const runs = useQuery('listCronRuns', { params: { cronId: cron.id }, query: { limit: 25 } });
  const ack = useMutation('acknowledgeCronEscalation', { invalidates: ['listCronRuns'] });
  return (
    <Section title="Runs">
      <QueryView query={runs} what="Its runs" isEmpty={(d) => d.runs.length === 0} empty={<p className={styles.muted}>It has not run yet.</p>}>
        {(d) => (
          <div className={styles.stack}>
            {d.runs.map((r) => (
              <Panel key={r.id}>
                <div className={styles.stack}>
                  <span className={styles.row}>
                    <Status tone={r.status === 'completed' ? 'ok' : r.status === 'failed' ? 'danger' : r.status === 'running' ? 'info' : 'neutral'}>{r.status}</Status>
                    <Time value={r.startedAt} exact />
                    <span className={styles.muted}>{r.trigger === 'manual' ? 'run by hand' : r.trigger === 'change' ? 'on a change' : 'on schedule'}</span>
                    {r.conditionOutcome !== null ? <Badge tone={r.conditionOutcome === 'met' ? 'accent' : 'neutral'}>{r.conditionOutcome === 'met' ? 'Condition held' : r.conditionOutcome === 'not_met' ? 'Condition did not hold' : 'Could not tell'}</Badge> : null}
                  </span>
                  {r.skippedReason !== null ? <p className={styles.muted}>Skipped: {r.skippedReason.replaceAll('_', ' ')}</p> : null}
                  {r.error !== null ? <p className={styles.muted}>{r.error}</p> : null}
                  {r.actions.length > 0 ? (
                    <ul className={styles.plainList}>{r.actions.map((a) => (
                      <li key={a.id}>
                        <span className={styles.row}>
                          <Status tone={OUTCOME_TONE[a.outcome]}>{ACTION[a.kind]}: {a.outcome}</Status>
                          {a.mutationId !== null ? <Link href={hrefWith('/governance/changes/', { change: a.mutationId })}>The change</Link> : null}
                          {a.fileId !== null ? <Link href={hrefWith('/files/all/', { file: a.fileId })}>The report</Link> : null}
                          {a.kind === 'escalate' && a.acknowledgedAt === null && (a.escalatedMembershipId === workspace.session.membershipId || a.escalatedScopeId !== null) ? (
                            <Button size="sm" pending={ack.pending} blocked={ack.blocked} onClick={async () => {
                              const out = await ack.run({ params: { runActionId: a.id } });
                              if (out.ok) say('Acknowledged');
                            }}>Acknowledge</Button>
                          ) : a.kind === 'escalate' && a.acknowledgedAt !== null ? <span className={styles.muted}>acknowledged <Time value={a.acknowledgedAt} /></span>
                            : a.kind === 'escalate' ? <span className={styles.muted}>waiting on {a.escalatedMembershipId !== null ? people.nameOf(a.escalatedMembershipId) : people.scopeName(a.escalatedScopeId)}</span> : null}
                        </span>
                        {a.error !== null ? <span className={styles.muted}> {a.error}</span> : null}
                      </li>
                    ))}</ul>
                  ) : null}
                </div>
              </Panel>
            ))}
          </div>
        )}
      </QueryView>
      {ack.error !== undefined ? <ErrorMessage error={ack.error} /> : null}
    </Section>
  );
}

function Shares({ cron }: { cron: Cron }) {
  const say = useToast();
  const people = useDirectory();
  const shares = useQuery('listCronShares', { params: { cronId: cron.id } });
  const share = useMutation('shareCron', { invalidates: ['listCronShares'] });
  const revoke = useMutation('revokeCronShare', { invalidates: ['listCronShares'] });
  const [grantee, setGrantee] = useState('');
  const who = (g: Output<'listCronShares'>['shares'][number]['grantee']) => (g.kind === 'organisation' ? 'Everyone in the organisation' : g.kind === 'scope' ? people.scopeName(g.scopeId) : people.nameOf(g.membershipId));
  return (
    <Section title="Shared with" description="People it is shared with see it and its runs; it still runs as its owner's principal.">
      <QueryView query={shares} what="Its shares" isEmpty={(d) => d.shares.filter((s) => s.state === 'live').length === 0} empty={<p className={styles.muted}>Not shared.</p>}>
        {(d) => (
          <ul className={styles.plainList}>{d.shares.filter((s) => s.state === 'live').map((s) => (
            <li key={s.id}>{who(s.grantee)} <span className={styles.muted}>since <Time value={s.sharedAt} /></span>{' '}
              <Button size="sm" variant="ghost" blocked={revoke.blocked} onClick={async () => {
                const r = await revoke.run({ params: { cronId: cron.id, shareId: s.id } });
                if (r.ok) say('No longer shared with them');
              }}>Stop sharing</Button></li>
          ))}</ul>
        )}
      </QueryView>
      <Toolbar end={<Button pending={share.pending} blocked={share.blocked} disabled={grantee === ''} onClick={async () => {
        const g = grantee === 'org' ? { kind: 'organisation' as const } : grantee.startsWith('scope:') ? { kind: 'scope' as const, scopeId: grantee.slice(6) } : { kind: 'membership' as const, membershipId: grantee };
        const r = await share.run({ params: { cronId: cron.id }, body: { grantee: g } });
        if (r.ok) {
          setGrantee('');
          say('Shared');
        }
      }}>Share</Button>}>
        <SelectField label="Share with" hideLabel value={grantee} onChange={(e) => setGrantee(e.target.value)} placeholder="Share with…" options={[
          { value: 'org', label: 'Everyone in the organisation' },
          ...people.scopes.map((s) => ({ value: `scope:${s.id}`, label: s.name })),
          ...people.members.filter((m) => m.status === 'active').map((m) => ({ value: m.membershipId, label: m.displayName })),
        ]} />
      </Toolbar>
      {share.error ?? revoke.error ? <ErrorMessage error={share.error ?? revoke.error} /> : null}
    </Section>
  );
}

function CronDetail({ cronId, onClose }: { cronId: string; onClose: () => void }) {
  const say = useToast();
  const people = useDirectory();
  const permits = usePermits();
  const read = useQuery('readCron', { params: { cronId } });
  const pause = useMutation('pauseCron', { invalidates: ['listCrons'] });
  const resume = useMutation('resumeCron', { invalidates: ['listCrons'] });
  const runNow = useMutation('runCronNow', { invalidates: ['listCronRuns'] });
  const remove = useMutation('deleteCron', { invalidates: ['listCrons'] });
  const [deleting, setDeleting] = useState(false);
  const c = read.data;
  if (c === undefined) return <Dialog open onClose={onClose} drawer title="Cron">{read.status === 'error' ? <ErrorMessage error={read.error} onRetry={read.refetch} /> : <Loading label="Reading the Cron" />}</Dialog>;
  const error = pause.error ?? resume.error ?? runNow.error;
  return (
    <Dialog open onClose={onClose} drawer title={c.name} description={<span className={styles.row}><Badge tone={c.status === 'active' ? 'ok' : c.status === 'paused' ? 'warn' : 'neutral'}>{c.status}</Badge>{scheduleText(c.schedule)}</span>}>
      <div className={styles.stack}>
        {c.pausedReason !== null ? <Banner tone="warn" title={PAUSED[c.pausedReason]}>{c.pausedAt !== null ? <>Since <Time value={c.pausedAt} />.</> : null}</Banner> : null}
        <div className={styles.row}>
          {c.status === 'active' ? <Button icon="pause" pending={pause.pending} blocked={pause.blocked} onClick={async () => { const r = await pause.run({ params: { cronId } }); if (r.ok) say('Paused'); }}>Pause</Button> : null}
          {c.status === 'paused' ? <Button icon="play" pending={resume.pending} blocked={resume.blocked} onClick={async () => { const r = await resume.run({ params: { cronId } }); if (r.ok) say('Resumed'); }}>Resume</Button> : null}
          <Button pending={runNow.pending} blocked={runNow.blocked} onClick={async () => {
            const r = await runNow.run({ params: { cronId } });
            if (r.ok) say(r.data.skipped !== null ? `Not run: ${r.data.skipped.replaceAll('_', ' ')}` : 'Running now');
          }}>Run now</Button>
          <Menu label="More for this Cron" items={[{ label: 'Delete…', icon: 'trash', tone: 'danger', onSelect: () => setDeleting(true), blocked: permits('deleteCron') }]}
            renderTrigger={(p) => <IconButton {...p} label="More for this Cron" icon="more" />} />
        </div>
        {error !== undefined ? <ErrorMessage error={error} /> : null}
        <Properties columns={1} items={[
          ['Owner', people.nameOf(c.ownerMembershipId)],
          ['Asks', c.savedViewId !== null ? <Link key="v" href={hrefWith('/ask/views/', { view: c.savedViewId })}>Its saved view</Link> : 'An object set'],
          ['If', conditionText(c.condition)],
          ['Then', c.actions.map((a) => ACTION[a.kind]).join('; ')],
          ['Next run', c.nextRunAt === null ? '—' : <Time key="n" value={c.nextRunAt} exact />],
          ['Last run', c.lastRunAt === null ? 'Never' : <Time key="l" value={c.lastRunAt} />],
          ['On failure', c.failurePolicy.mode === 'pause_after' ? `Pauses after ${plural(c.failurePolicy.failures, 'failure')} in a row` : 'Tells you and carries on'],
          ['Reads', plural(c.connectionIds.length, 'connection')],
          ['Time zone', c.timezone],
        ]} />
        <Runs cron={c} />
        <Shares cron={c} />
      </div>
      <ConfirmDialog open={deleting} onClose={() => setDeleting(false)} title={`Delete ${c.name}?`} confirmLabel="Delete" tone="danger"
        onConfirm={async () => {
          const r = await remove.run({ params: { cronId } });
          if (r.ok) {
            say('Deleted: its principal is revoked');
            onClose();
          }
          return r;
        }}><p>It stops, its principal is revoked, and its history stays in the audit log.</p></ConfirmDialog>
    </Dialog>
  );
}

export function Crons() {
  const people = useDirectory();
  const [params, set] = useParams();
  const which = (params.get('which') ?? 'mine') as 'mine' | 'shared' | 'managed';
  const list = useQuery('listCrons', { query: { which } });
  const blocked = useBlocked('createCron');
  usePageContext({ scope: { kind: 'page', page: 'governance' }, scopeLabel: 'Crons' });
  const rows = useMemo(() => list.data?.crons ?? [], [list.data]);
  const id = params.get('cron');
  return (
    <Page title="Crons" description="What watches, tells people and acts on a schedule, without anyone present, never with more than its owner holds."
      crumbs={[{ label: 'Governance' }]} actions={<Button variant="primary" icon="plus" blocked={blocked} onClick={() => set({ new: '1' })}>New Cron</Button>}>
      <Toolbar>
        <SelectField label="Which" hideLabel value={which} onChange={(e) => set({ which: e.target.value === 'mine' ? undefined : e.target.value })}
          options={[{ value: 'mine', label: 'Yours' }, { value: 'shared', label: 'Shared with you' }, { value: 'managed', label: 'Every Cron you manage' }]} />
      </Toolbar>
      <QueryView query={list} what="Crons" isEmpty={() => rows.length === 0}
        empty={<EmptyState icon="cron" title="No Cron here" action={<Button variant="primary" blocked={blocked} onClick={() => set({ new: '1' })}>Make one</Button>}>A Cron runs a saved question on a schedule and acts when it holds.</EmptyState>}>
        {() => (
          <DataTable label="Crons" rows={rows} rowKey={(c) => c.id} rowHref={(c) => hrefWith('/governance/crons/', { cron: c.id, which: which === 'mine' ? undefined : which })} columns={[
            { id: 'name', header: 'Cron', primary: true, sortValue: (c) => c.name, cell: (c) => c.name },
            { id: 'when', header: 'When', width: 'md', cell: (c) => scheduleText(c.schedule) },
            { id: 'state', header: 'State', width: 'md', cell: (c) => (c.status === 'active' ? <Badge tone="ok">Active</Badge> : <Badge tone="warn" title={c.pausedReason === null ? undefined : PAUSED[c.pausedReason]}>{c.status}</Badge>) },
            { id: 'next', header: 'Next run', width: 'md', sortValue: (c) => c.nextRunAt, cell: (c) => (c.nextRunAt === null ? '—' : <Time value={c.nextRunAt} />) },
            { id: 'owner', header: 'Owner', width: 'md', cell: (c) => people.nameOf(c.ownerMembershipId) },
          ]} />
        )}
      </QueryView>
      {params.get('new') !== null ? <CreateDialog open onClose={() => set({ new: undefined })} /> : null}
      {id !== null ? <CronDetail key={id} cronId={id} onClose={() => set({ cron: undefined })} /> : null}
    </Page>
  );
}
