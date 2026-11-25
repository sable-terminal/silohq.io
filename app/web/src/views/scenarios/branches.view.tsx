'use client';

// Scenario branches (spec 39.8): Actions staged against the record now and simulated over the
// graph, never executed. Opening a branch checks every staged Action against each record as it is
// now (clean, conflicted, already applied, orphaned) and runs it again; a conflict is decided per
// property (keep the staged value or take the value now); an Action is staged again on a current
// base; a branch is compared with its scenario or another branch; the clean ones are promoted into
// the mutation path as proposals, where they wait for approval like any other. Nothing in a branch
// ever writes to a source. Branches carry a label every overlay and export repeats.

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button, IconButton, LinkButton } from '../../components/button.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { SelectField } from '../../components/field.component.tsx';
import { Menu } from '../../components/menu.component.tsx';
import { ObjectPicker, type PickedObject } from '../../components/objectPicker.component.tsx';
import { Page, Panel, Properties, Section } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage, Loading } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { useVocabulary } from '../../hooks/vocabulary.hook.ts';
import { objectHref, scenarioHref } from '../../navigation/links.navigation.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { humanise, plural } from '../../utils/format.util.ts';
import { ActionForm } from '../explorer/object.view.tsx';
import { idFrom } from '../studio/kit.view.tsx';
import { RunView } from './run.view.tsx';
import { branchHref } from './scenarios.view.tsx';
import { BRANCH_STATUS, duration, STALENESS } from './words.view.ts';
import styles from './scenarios.view.module.css';

type Opened = Output<'openSimulationBranch'>;
type Staged = Opened['branch']['stagedActions'][number];
type Check = Opened['checks'][number];
type Scenario = Output<'listSimulationScenarios'>['scenarios'][number];
const show = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** /scenarios/branches/: every branch of the scenarios a person holds, or one branch. */
export function ScenarioBranches() {
  const [params] = useParams();
  const open = params.get('branch');
  if (open === null) return <Directory />;
  const id = idFrom(open);
  return id === undefined ? (
    <Page title="Branches" crumbs={[{ label: 'Scenarios', href: '/scenarios/list/' }]}>
      <EmptyState icon="branch" title="This address does not name a branch" action={<LinkButton href="/scenarios/branches/">All branches</LinkButton>}>Check the link you followed.</EmptyState>
    </Page>
  ) : <BranchPage key={id} branchId={id} />;
}

function Directory() {
  const mine = useQuery('listSimulationScenarios', { query: { filter: 'mine' } });
  const shared = useQuery('listSimulationScenarios', { query: { filter: 'shared' } });
  usePageContext({ scope: { kind: 'page', page: 'scenarios' }, scopeLabel: 'Scenario branches' });
  const scenarios = [...(mine.data?.scenarios ?? []), ...(shared.data?.scenarios ?? []).filter((s) => !(mine.data?.scenarios ?? []).some((m) => m.id === s.id))];
  return (
    <Page title="Branches" description="Stage changes in a branch and see their effects before anything runs. A branch is opened from its scenario, or from an object, a finding or the canvas."
      crumbs={[{ label: 'Scenarios', href: '/scenarios/list/' }]}>
      <QueryView query={mine} what="Scenarios" isEmpty={() => scenarios.length === 0}
        empty={<EmptyState icon="branch" title="No scenarios yet" action={<LinkButton href="/scenarios/list/?new=1" variant="primary">New scenario</LinkButton>}>A branch belongs to a scenario: make one first.</EmptyState>}>
        {() => <div className={styles.stack}>{scenarios.map((s) => <BranchesOf key={s.id} scenario={s} />)}</div>}
      </QueryView>
    </Page>
  );
}

/** One scenario's branches, shown only when it has some. */
function BranchesOf({ scenario }: { scenario: Scenario }) {
  const list = useQuery('listSimulationBranches', { params: { scenarioId: scenario.id } });
  if (list.data === undefined) return list.status === 'error' ? <ErrorMessage error={list.error} onRetry={list.refetch} /> : null;
  if (list.data.branches.length === 0) return null;
  return (
    <Section title={scenario.name} actions={<LinkButton size="sm" variant="link" href={scenarioHref(scenario.id)}>Open the scenario</LinkButton>}>
      <DataTable label={`Branches of ${scenario.name}`} rows={list.data.branches} rowKey={(b) => b.id} rowHref={(b) => branchHref(b.id)} columns={[
        { id: 'name', header: 'Branch', primary: true, cell: (b) => b.name },
        { id: 'label', header: 'Label', cell: (b) => <Badge tone="accent">{b.label}</Badge> },
        { id: 'state', header: 'State', width: 'sm', cell: (b) => <Badge tone={BRANCH_STATUS[b.status].tone}>{BRANCH_STATUS[b.status].label}</Badge> },
        { id: 'counts', header: 'Staged', cell: (b) => `${b.counts.clean} clean, ${b.counts.conflicted} conflicted, ${b.counts.alreadyApplied} already applied, ${b.counts.orphaned} orphaned, ${b.counts.promoted} promoted` },
        { id: 'made', header: 'Opened', width: 'sm', cell: (b) => <Time value={b.createdAt} /> },
      ]} />
    </Section>
  );
}

function BranchPage({ branchId }: { branchId: string }) {
  const say = useToast();
  const branch = useQuery('readSimulationBranch', { params: { branchId } });
  const scenario = useQuery('readSimulationScenario', branch.data === undefined ? null : { params: { scenarioId: branch.data.scenarioId } });
  const siblings = useQuery('listSimulationBranches', branch.data === undefined ? null : { params: { scenarioId: branch.data.scenarioId } });
  const open = useMutation('openSimulationBranch', { invalidates: ['readSimulationBranch', 'listSimulationBranches'] });
  const promote = useMutation('promoteSimulationBranch', { invalidates: ['readSimulationBranch', 'listSimulationBranches', 'listMutations'] });
  const close = useMutation('closeSimulationBranch', { invalidates: ['readSimulationBranch', 'listSimulationBranches'] });
  const [dialog, setDialog] = useState<'stage' | 'compare' | 'close' | 'promoted' | undefined>();
  usePageContext({ scope: branch.data === undefined ? { kind: 'page', page: 'scenarios' } : { kind: 'scenario', scenarioId: branch.data.scenarioId }, scopeLabel: branch.data?.name ?? 'a branch' });
  // Opening checks every staged Action against the record now and runs the branch again: once on arrival, and when asked.
  const loaded = branch.data !== undefined;
  useEffect(() => {
    if (loaded) void open.run({ params: { branchId } });
    // Once, when the branch is first read.
  }, [loaded, branchId]);
  const reopen = () => void open.run({ params: { branchId } });

  const b = open.data?.branch ?? branch.data;
  if (b === undefined) {
    return <Page title="Branch" crumbs={[{ label: 'Scenarios', href: '/scenarios/list/' }, { label: 'Branches', href: '/scenarios/branches/' }]}><QueryView query={branch} what="The branch">{() => null}</QueryView></Page>;
  }
  const isOpen = b.status === 'open';
  const checks = open.data?.checks ?? [];
  return (
    <Page title={b.name} documentTitle={b.name} width="full" crumbs={[{ label: 'Scenarios', href: '/scenarios/list/' }, { label: 'Branches', href: '/scenarios/branches/' }]}
      meta={<span className={styles.row}><Badge tone="accent">{b.label}</Badge><Badge tone={BRANCH_STATUS[b.status].tone}>{BRANCH_STATUS[b.status].label}</Badge>
        {scenario.data !== undefined ? <Link href={scenarioHref(scenario.data.id) as never}>{scenario.data.name}</Link> : null}</span>}
      actions={
        <div className={styles.row}>
          {isOpen ? <Button variant="primary" icon="plus" onClick={() => setDialog('stage')}>Stage an Action</Button> : null}
          {isOpen && b.counts.clean > 0 ? (
            <Button icon="check" pending={promote.pending} blocked={promote.blocked} onClick={() => void promote.run({ params: { branchId }, body: {} }).then((r) => {
              if (!r.ok) return;
              setDialog('promoted');
              reopen();
            })}>Promote the clean ones</Button>
          ) : null}
          <Menu label="More" items={[
            { label: 'Check against the record again', icon: 'refresh', disabled: open.pending, onSelect: reopen },
            { label: 'Compare', icon: 'arrowUpDown', onSelect: () => setDialog('compare') },
            { separator: true },
            { label: 'Close the branch', icon: 'lock', tone: 'danger', disabled: !isOpen, blocked: close.blocked, onSelect: () => setDialog('close') },
          ]} renderTrigger={(x) => <IconButton {...x} label="More" icon="more" />} />
        </div>
      }>
      <div className={styles.stack}>
        <Panel>
          <Properties items={[
            ['Staged', `${b.counts.clean} clean, ${b.counts.conflicted} conflicted, ${b.counts.alreadyApplied} already applied, ${b.counts.orphaned} orphaned, ${b.counts.promoted} promoted`],
            ['Opened', <Time key="o" value={b.createdAt} exact />],
            ['Kept for', b.basesPurged ? 'Its bases are purged' : b.basesPurgeAt !== null ? <>its bases until <Time key="p" value={b.basesPurgeAt} exact /></> : `${plural(b.retentionDays, 'day')} after it closes`],
          ]} />
        </Panel>
        {!isOpen ? <Banner tone="info" title={BRANCH_STATUS[b.status].label}>Nothing more is staged or promoted in it. It can still be opened and compared until its bases are purged.</Banner> : null}
        {open.pending ? <Loading label="Checking each staged Action against the record now" block={false} /> : null}
        {open.error !== undefined ? <ErrorMessage error={open.error} onRetry={reopen} /> : null}
        {promote.error !== undefined ? <ErrorMessage error={promote.error} /> : null}
        <Section title="Staged Actions">
          {b.stagedActions.length === 0 ? (
            <p className={styles.muted}>Nothing staged yet. Stage an Action on an object: it is simulated here and written nowhere.</p>
          ) : (
            <div className={styles.stack}>{b.stagedActions.map((s) => (
              <StagedCard key={s.id} staged={s} check={checks.find((c) => c.stagedActionId === s.id)} open={isOpen} onChanged={reopen} />
            ))}</div>
          )}
        </Section>
        {open.data !== undefined ? <Section title="What it reaches"><RunView run={open.data.run} /></Section> : null}
      </div>
      {dialog === 'stage' ? <StageDialog branchId={branchId} onClose={() => setDialog(undefined)} onStaged={() => {
        setDialog(undefined);
        say('Staged: simulated, not executed');
        reopen();
      }} /> : null}
      {dialog === 'compare' ? <CompareDialog branchId={branchId} siblings={(siblings.data?.branches ?? []).filter((x) => x.id !== branchId)} onClose={() => setDialog(undefined)} /> : null}
      <Dialog open={dialog === 'promoted'} onClose={() => setDialog(undefined)} title="Promoted" size="md">
        {promote.data !== undefined ? (
          <div className={styles.stack}>
            <p>{plural(promote.data.promoted.length, 'staged Action')} {promote.data.promoted.length === 1 ? 'is' : 'are'} now {promote.data.promoted.length === 1 ? 'a proposal' : 'proposals'}, waiting for approval like any other change.</p>
            {promote.data.notPromoted.length > 0 ? (
              <ul className={styles.plainList}>{promote.data.notPromoted.map((n) => <li key={n.stagedActionId}>{humanise(n.reason)}: {n.statement}</li>)}</ul>
            ) : null}
            <LinkButton href="/governance/changes/">Follow them in Changes</LinkButton>
          </div>
        ) : null}
      </Dialog>
      <ConfirmDialog open={dialog === 'close'} onClose={() => setDialog(undefined)} title={`Close ${b.name}?`} confirmLabel="Close it" tone="danger"
        onConfirm={() => close.run({ params: { branchId }, body: { version: b.version } }).then((r) => {
          if (r.ok) say('Closed');
          return r;
        })}><p>No more staging or promotion. Its bases are purged when its retention ends; until then it can still be opened.</p></ConfirmDialog>
    </Page>
  );
}

function StagedCard({ staged: s, check, open, onChanged }: { staged: Staged; check: Check | undefined; open: boolean; onChanged: () => void }) {
  const say = useToast();
  const { lookup } = useVocabulary();
  const restage = useMutation('restageSimulationAction', { invalidates: ['readSimulationBranch'] });
  const resolve = useMutation('resolveSimulationConflicts', { invalidates: ['readSimulationBranch'] });
  const pending = s.conflicts.filter((c) => c.resolution === null);
  const decide = (c: Staged['conflicts'][number], choice: 'keep_staged' | 'take_current') =>
    void resolve.run({ params: { stagedActionId: s.id }, body: { resolutions: [{ connectionId: c.connectionId, reference: c.reference, property: c.property, choice }] } }).then((r) => {
      if (!r.ok) return;
      say('Recorded');
      onChanged();
    });
  return (
    <div className={styles.card} role="group" aria-label={`Staged Action ${s.sequence}`}>
      <div className={styles.cardHead}>
        <span><strong>{humanise(s.operation)}</strong> on {plural(s.targets, lookup?.typeName(s.objectTypeId).toLowerCase() ?? 'record')} <span className={styles.muted}>({s.properties.join(', ') || 'whole records'})</span></span>
        <Badge tone={STALENESS[s.staleness].tone}>{STALENESS[s.staleness].label}</Badge>
        {s.physical ? <Badge tone="warn">Physical</Badge> : null}
        {s.promotedAt !== null ? <Badge tone="ok">Promoted</Badge> : null}
        {open && s.promotedAt === null ? (
          <Button size="sm" variant="ghost" icon="refresh" pending={restage.pending} blocked={restage.blocked}
            onClick={() => void restage.run({ params: { stagedActionId: s.id } }).then((r) => {
              if (!r.ok) return;
              say('Staged again on the record as it is now');
              onChanged();
            })}>Stage again</Button>
        ) : null}
      </div>
      <span className={styles.muted}>Staged <Time value={s.stagedAt} />{s.stalenessCheckedAt !== null ? <>; checked <Time value={s.stalenessCheckedAt} /></> : null}</span>
      {s.statement !== null ? <p className={styles.muted}>{s.statement}</p> : null}
      {check?.refusal != null ? <Banner tone="warn" title={`It would be refused now at ${humanise(check.refusal.stage).toLowerCase()}`}>{check.refusal.reason}</Banner> : null}
      {check !== undefined && check.targets.some((t) => t.properties.length > 0) ? (
        <DataTable label={`What staged Action ${s.sequence} changes`} rows={check.targets.flatMap((t) => t.properties.map((p) => ({ t, p })))} rowKey={({ t, p }) => `${t.connectionId}:${t.reference}:${p.property}`} columns={[
          { id: 'record', header: 'Record', primary: true, cell: ({ t }) => <Link href={objectHref({ objectTypeId: s.objectTypeId, objectId: t.objectId }) as never}>{t.reference}</Link> },
          { id: 'property', header: 'Property', cell: ({ p }) => p.property },
          { id: 'now', header: 'Now', cell: ({ p }) => show(p.current) },
          { id: 'staged', header: 'Staged', cell: ({ p }) => (p.branchUnknown ? <span className={styles.muted}>set by the system</span> : show(p.branch)) },
          { id: 'state', header: 'State', width: 'sm', cell: ({ p }) => <Badge tone={STALENESS[p.state].tone}>{STALENESS[p.state].label}</Badge> },
          { id: 'effect', header: 'Downstream', cell: ({ t }) => (t.effect.form === null ? '—' : `${t.effect.form}${t.effect.delay !== null ? ` by ${duration(t.effect.delay)}` : ''}`) },
        ]} />
      ) : null}
      {pending.length > 0 ? (
        <div className={styles.stackTight}>
          <strong>Changed since it was staged</strong>
          {pending.map((c) => (
            <div key={`${c.reference}:${c.property}`} className={styles.row}>
              <span>{c.reference}.{c.property}{c.changedByKnown ? '' : ' (changed in its system)'}</span>
              <Button size="sm" blocked={!open ? 'The branch is closed' : resolve.blocked} onClick={() => decide(c, 'keep_staged')}>Keep the staged value</Button>
              <Button size="sm" blocked={!open ? 'The branch is closed' : resolve.blocked} onClick={() => decide(c, 'take_current')}>Take the value now</Button>
            </div>
          ))}
        </div>
      ) : null}
      {restage.error !== undefined ? <ErrorMessage error={restage.error} /> : null}
      {resolve.error !== undefined ? <ErrorMessage error={resolve.error} /> : null}
    </div>
  );
}

/** Stage an Action: an object, then one of the Actions available on it, its form as the object view gives it. */
function StageDialog({ branchId, onClose, onStaged }: { branchId: string; onClose: () => void; onStaged: () => void }) {
  const stage = useMutation('stageSimulationAction', { invalidates: ['readSimulationBranch', 'listSimulationBranches'] });
  const [picked, setPicked] = useState<PickedObject | undefined>();
  const [actionTypeId, setActionTypeId] = useState('');
  const view = useQuery('readObjectView', picked === undefined ? null : { body: { objectTypeId: picked.objectTypeId, object: { objectId: picked.objectId } } });
  const actions = view.data?.outcome === 'object' ? view.data.view.actions ?? [] : [];
  const action = actions.find((a) => a.actionTypeId === actionTypeId);
  return (
    <Dialog open onClose={onClose} title="Stage an Action" size="lg" busy={stage.pending}
      description="It is checked as a proposal would be and simulated over the graph. Nothing is written until the branch is promoted and the proposal approved.">
      <div className={styles.form}>
        <ObjectPicker label="On" value={picked} onChange={(p) => {
          setPicked(p);
          setActionTypeId('');
        }} />
        {picked !== undefined ? (
          view.data === undefined ? (view.status === 'error' ? <ErrorMessage error={view.error} onRetry={view.refetch} /> : <Loading label="Reading its Actions" block={false} />)
            : view.data.outcome !== 'object' ? <p className={styles.muted}>{view.data.outcome === 'refusal' ? view.data.refusal.reason : 'There is no such object, or none you may see.'}</p>
              : actions.length === 0 ? <p className={styles.muted}>No Actions you may take on this object.</p> : (
                <SelectField label="Action" value={actionTypeId} placeholder="Choose an Action" onChange={(e) => setActionTypeId(e.target.value)}
                  options={actions.map((a) => ({ value: a.actionTypeId, label: a.displayName }))} />
              )
        ) : null}
        {action !== undefined ? (
          action.state === 'criteria_failed' ? <p className={styles.muted}>Not available on this object: {action.criterion}</p>
            : action.target === null ? <p className={styles.muted}>This object has no record the Action can write to.</p>
              : <ActionForm key={action.actionTypeId} action={action} target={action.target} stage={{
                label: 'Stage it', pending: stage.pending, error: stage.error, blocked: stage.blocked,
                run: (parameters) => void stage.run({ params: { branchId }, body: { actionTypeId: action.actionTypeId, parameters: parameters as never, objects: [action.target!] } })
                  .then((r) => r.ok && onStaged()),
              }} />
        ) : null}
      </div>
    </Dialog>
  );
}

function CompareDialog({ branchId, siblings, onClose }: { branchId: string; siblings: readonly { id: string; name: string }[]; onClose: () => void }) {
  const { lookup } = useVocabulary();
  const [against, setAgainst] = useState('');
  const compare = useQuery('compareSimulationBranch', { params: { branchId }, query: against === '' ? {} : { against } });
  const name = (o: { objectTypeId: string; objectId: string }) => <Link href={objectHref(o) as never}>{lookup?.typeName(o.objectTypeId) ?? 'Object'} {o.objectId.slice(0, 8)}</Link>;
  return (
    <Dialog open onClose={onClose} drawer title="Compare the branch">
      <div className={styles.stack}>
        <SelectField label="Against" value={against} onChange={(e) => setAgainst(e.target.value)}
          options={[{ value: '', label: 'Its scenario, with nothing staged' }, ...siblings.map((s) => ({ value: s.id, label: `The branch ${s.name}` }))]} />
        <QueryView query={compare} what="The comparison">
          {(c) => (
            <div className={styles.stack}>
              {!c.comparable ? <Banner tone="info" title="Not like for like">The graph changed between them.</Banner> : null}
              <Properties columns={1} items={[
                ['Reached only here', c.downstream.onlyHere.length === 0 ? 'Nothing' : <span key="h">{c.downstream.onlyHere.slice(0, 20).map((o, i) => <span key={o.objectId}>{i > 0 ? ', ' : ''}{name(o)}</span>)}</span>],
                ['Reached only there', c.downstream.onlyThere.length === 0 ? 'Nothing' : <span key="t">{c.downstream.onlyThere.slice(0, 20).map((o, i) => <span key={o.objectId}>{i > 0 ? ', ' : ''}{name(o)}</span>)}</span>],
              ]} />
              {c.downstream.delayChanged.length > 0 ? (
                <DataTable label="Delayed differently" rows={c.downstream.delayChanged} rowKey={(o) => o.objectId} columns={[
                  { id: 'object', header: 'Object', primary: true, cell: (o) => name(o) },
                  { id: 'here', header: 'Here', cell: (o) => duration(o.here) },
                  { id: 'there', header: 'There', cell: (o) => duration(o.there) },
                ]} />
              ) : null}
              {c.targets.length > 0 ? (
                <DataTable label="The records it changes" rows={c.targets} rowKey={(t) => `${t.branchId}:${t.objectId}:${t.property}`} columns={[
                  { id: 'object', header: 'Object', primary: true, cell: (t) => t.objectId.slice(0, 8) },
                  { id: 'property', header: 'Property', cell: (t) => t.property },
                  { id: 'now', header: 'Now', cell: (t) => show(t.current) },
                  { id: 'branch', header: 'In the branch', cell: (t) => show(t.branch) },
                ]} />
              ) : <p className={styles.muted}>It changes no record.</p>}
            </div>
          )}
        </QueryView>
      </div>
    </Dialog>
  );
}
