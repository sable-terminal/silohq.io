'use client';

// Changes (spec 43, 45, 46): every governed change, where it stands, exactly what it writes (each
// record's field, before and after), what else it reaches, what each system applied and what read
// back the same afterwards. A large change writes a sample first; a person looks at what the
// sample did and confirms the rest. An approved change whose execution is kept separate is run by
// its proposer. A finished change has a receipt: its webhooks' deliveries, a revert (a new change
// of its own, each conflict decided by a person), and a purge of the values it holds. An object's
// commits list every change that touched it.

import Link from 'next/link';
import { useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge, Status } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button, LinkButton } from '../../components/button.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { FormActions, RadioGroup, SelectField } from '../../components/field.component.tsx';
import { ObjectPicker, type PickedObject } from '../../components/objectPicker.component.tsx';
import { Page, Panel, Properties, Section, Toolbar } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage, Loading } from '../../components/states.component.tsx';
import { TabPanel, Tabs, useTab, type TabDef } from '../../components/tabs.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { useRefreshWhile } from '../../hooks/refresh.hook.ts';
import { useVocabulary } from '../../hooks/vocabulary.hook.ts';
import { approvalHref, objectHref } from '../../navigation/links.navigation.ts';
import { usePageContext, useWorkspace } from '../../shell/context.shell.tsx';
import { formatNumber, plural } from '../../utils/format.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import styles from './governance.view.module.css';

type Mutation = Output<'getMutation'>;
type Status = Mutation['status'];
type Revert = Output<'getRevert'>;

const STATUS: Record<Status, { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' | 'info' }> = {
  previewed: { label: 'Previewed, not proposed', tone: 'neutral' }, awaiting_approval: { label: 'Waiting for approval', tone: 'warn' }, approved: { label: 'Approved, not yet run', tone: 'info' },
  canary: { label: 'Sample written: waiting to confirm the rest', tone: 'warn' }, executing: { label: 'Running', tone: 'info' }, completed: { label: 'Done and verified', tone: 'ok' },
  completed_with_divergence: { label: 'Done; some records read back differently', tone: 'warn' }, partially_failed: { label: 'Partly failed', tone: 'danger' }, failed: { label: 'Failed', tone: 'danger' },
  refused: { label: 'Refused', tone: 'danger' }, rejected: { label: 'Rejected', tone: 'neutral' }, expired: { label: 'Expired', tone: 'neutral' },
};
const ORIGIN: Record<Mutation['origin'], string> = { action: 'An Action', ask: 'Ask', cron: 'A Cron', scenario_promotion: 'A scenario', revert: 'A revert' };
const CONFLICT: Record<Revert['conflicts'][number]['kind'], string> = {
  field_changed: 'Changed since', record_missing: 'No longer exists', record_reappeared: 'Exists again', created_record_changed: 'Created by the change, and changed since',
};
const show = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const RUNNING: readonly Status[] = ['executing', 'canary', 'approved'];

/** Exactly what a change writes: each record's field, before and after, and what else it reaches. */
export function ChangePreview({ mutation: m }: { mutation: Mutation }) {
  const p = m.preview;
  if (p === null) return <p className={styles.muted}>No preview.</p>;
  return (
    <div className={styles.stack}>
      {p.nonAtomic ? <Banner tone="warn">It writes to more than one system: if one fails, the others may already have applied.</Banner> : null}
      <DataTable label="What it writes" rows={p.rows.slice(0, 200)} rowKey={(r) => `${r.objectId}:${r.field ?? ''}:${r.connectionId}`} dense columns={[
        { id: 'record', header: 'Record', primary: true, cell: (r) => <Link href={objectHref({ objectTypeId: m.objectTypeId, objectId: r.objectId }) as never}><span className={styles.mono}>{r.entityReference}</span></Link> },
        { id: 'op', header: 'Change', width: 'sm', cell: (r) => r.operation.replaceAll('_', ' ') },
        { id: 'field', header: 'Field', width: 'md', cell: (r) => r.field ?? '—' },
        { id: 'before', header: 'Before', cell: (r) => (r.priorAbsent ? <span className={styles.muted}>none</span> : <span className={styles.mono}>{show(r.prior)}</span>) },
        { id: 'after', header: 'After', cell: (r) => (r.proposedAbsent ? <span className={styles.muted}>removed</span> : r.proposedUnknown ? <span className={styles.muted}>decided by the system</span> : <span className={styles.mono}>{show(r.proposed)}</span>) },
      ]} />
      {p.rows.length > 200 ? <p className={styles.muted}>The first 200 of {formatNumber(p.rows.length)} shown.</p> : null}
      {p.excluded.length > 0 ? <p className={styles.muted}>Left out: {p.excluded.map((x) => `${x.reference} (${x.reason.replaceAll('_', ' ')})`).join('; ')}.</p> : null}
      {p.notRestored.length > 0 ? <p className={styles.muted}>Cannot be put back by a revert: {p.notRestored.map((x) => x.field).join(', ')}.</p> : null}
      {p.sideEffects.length > 0 ? <p className={styles.muted}>Also: {p.sideEffects.map((s) => `${s.kind}${s.physical ? ' (physical)' : ''}`).join(', ')}.</p> : null}
      {p.blastRadius.computed && p.blastRadius.relationships !== undefined && p.blastRadius.relationships.length > 0 ? (
        <Section title="What else it reaches">
          <ul className={styles.plainList}>{p.blastRadius.relationships.map((r, i) => <li key={i}>{formatNumber(r.count)}{r.bounded ? '+' : ''} {r.kind.replaceAll('_', ' ')} via {r.via} in {r.sourceObject}</li>)}</ul>
        </Section>
      ) : null}
      {p.physical !== undefined ? (
        <Section title="On equipment">
          <p>{p.physical.statement}</p>
          <DataTable label="Nodes it writes" rows={p.physical.nodes} rowKey={(n) => `${n.connectionId}:${n.nodeAddress}`} dense columns={[
            { id: 'node', header: 'Node', primary: true, cell: (n) => <span className={styles.mono}>{n.nodeAddress}</span> },
            { id: 'now', header: 'Now', width: 'sm', cell: (n) => show(n.current) },
            { id: 'to', header: 'To', width: 'sm', cell: (n) => show(n.proposed) },
            { id: 'range', header: 'Allowed', width: 'md', cell: (n) => (n.range === null ? '—' : `${n.range.min} to ${n.range.max}${n.maxStep !== null ? `, steps of ${n.maxStep}` : ''}`) },
          ]} />
        </Section>
      ) : null}
    </div>
  );
}

function Deliveries({ mutationId }: { mutationId: string }) {
  const list = useQuery('listWebhookDeliveries', { params: { mutationId } });
  return (
    <QueryView query={list} what="Webhook deliveries" isEmpty={(d) => d.deliveries.length === 0} empty={<p className={styles.muted}>It called no webhook.</p>}>
      {(d) => (
        <DataTable label="Webhook deliveries" rows={d.deliveries} rowKey={(x) => x.id} dense columns={[
          { id: 'status', header: 'Delivery', primary: true, cell: (x) => <Status tone={x.status === 'delivered' ? 'ok' : x.status === 'failed' ? 'danger' : 'info'}>{x.status}</Status> },
          { id: 'tries', header: 'Attempts', width: 'xs', align: 'end', cell: (x) => String(x.attempts) },
          { id: 'effect', header: 'Took effect', width: 'md', cell: (x) => (x.records === 'delivery' ? 'Not reported' : x.effect ?? 'Not yet known') },
          { id: 'last', header: 'Last answer', cell: (x) => (x.lastStatus === null ? '—' : `${x.lastStatus}${x.lastError !== null ? `: ${x.lastError}` : ''}`) },
          { id: 'at', header: 'When', width: 'sm', cell: (x) => <Time value={x.deliveredAt ?? x.failedAt} /> },
        ]} />
      )}
    </QueryView>
  );
}

function RevertPanel({ revertId }: { revertId: string }) {
  const say = useToast();
  const read = useQuery('getRevert', { params: { revertId } });
  const decide = useMutation('decideRevertConflicts', { invalidates: ['getRevert', 'getMutation'] });
  const [choices, setChoices] = useState<Record<string, 'restore_prior' | 'keep_current' | 'exclude_record'>>({});
  const r = read.data;
  if (r === undefined) return read.status === 'error' ? <ErrorMessage error={read.error} /> : <Loading label="Reading the revert" block={false} />;
  const open = r.conflicts.filter((c) => c.decision === null);
  return (
    <Section title="Reverting it" description={`${r.scope === 'full' ? 'The whole change' : 'Part of it'}; ${plural(r.alreadyReverted, 'record')} already put back.`}
      actions={<LinkButton href={hrefWith('/governance/changes/', { change: r.newMutationId })} size="sm">The revert's own change</LinkButton>}>
      {r.conflicts.length === 0 ? <p className={styles.muted}>Nothing moved on since: it puts every record back.</p> : (
        <div className={styles.stack}>
          {open.length > 0 ? <Banner tone="warn" title={plural(open.length, 'record') + ' moved on since'}>Decide each: put back what was there before the change, keep what is there now, or leave the record out.</Banner> : null}
          <DataTable label="Conflicts" rows={r.conflicts} rowKey={(c) => c.id} dense columns={[
            { id: 'rec', header: 'Record', primary: true, cell: (c) => <span className={styles.stackTight}><span className={styles.mono}>{c.entityReference}</span><span className={styles.muted}>{c.field ?? 'the record'}: {CONFLICT[c.kind]}</span></span> },
            { id: 'wrote', header: 'The change wrote', width: 'md', cell: (c) => <span className={styles.mono}>{show(c.postWriteValue)}</span> },
            { id: 'now', header: 'Now', width: 'md', cell: (c) => <span className={styles.mono}>{show(c.currentValue)}</span> },
            { id: 'decide', header: 'Decision', width: 'lg', cell: (c) => (c.decision !== null ? c.decision.replaceAll('_', ' ') : (
              <SelectField label="Decision" hideLabel value={choices[c.id] ?? ''} onChange={(e) => setChoices({ ...choices, [c.id]: e.target.value as 'restore_prior' })} placeholder="Choose"
                options={[{ value: 'restore_prior', label: 'Put back the old value' }, { value: 'keep_current', label: 'Keep what is there now' }, { value: 'exclude_record', label: 'Leave the record out' }]} />
            )) },
          ]} />
          {decide.error !== undefined ? <ErrorMessage error={decide.error} /> : null}
          {open.length > 0 ? (
            <FormActions>
              <Button variant="primary" pending={decide.pending} blocked={decide.blocked} disabled={open.some((c) => choices[c.id] === undefined)} onClick={async () => {
                const out = await decide.run({ params: { revertId }, body: { decisions: open.map((c) => ({ conflictId: c.id, decision: choices[c.id]! })) } });
                if (out.ok) say('Decided: the revert goes ahead as its own change');
              }}>Record the decisions</Button>
            </FormActions>
          ) : null}
        </div>
      )}
    </Section>
  );
}

function ReceiptView({ receiptId, onClose }: { receiptId: string; onClose: () => void }) {
  const say = useToast();
  const [params, set] = useParams();
  const read = useQuery('getReceipt', { params: { receiptId } });
  const revert = useMutation('requestRevert', { invalidates: ['listMutations'] });
  const purge = useMutation('requestReceiptPurge');
  const purgeId = params.get('purge');
  const purgeRead = useQuery('getReceiptPurge', purgeId === null ? null : { params: { purgeId } });
  const [reverting, setReverting] = useState(false);
  const [scope, setScope] = useState<'full' | 'succeeded_half'>('full');
  const [purging, setPurging] = useState(false);
  const r = read.data;
  return (
    <Dialog open onClose={onClose} drawer title="Receipt" description={r === undefined ? undefined : <>Written <Time value={r.createdAt} exact /></>}>
      {r === undefined ? (read.status === 'error' ? <ErrorMessage error={read.error} onRetry={read.refetch} /> : <Loading label="Reading the receipt" />) : (
        <div className={styles.stack}>
          {r.purgedAt !== null ? <Banner tone="info" title="Its values were purged"><Time value={r.purgedAt} />. What happened is kept; the values are not.</Banner> : null}
          <Properties columns={1} items={[
            ['Change', <Link key="c" href={hrefWith('/governance/changes/', { change: r.mutationId })}>Open the change</Link>],
            r.revertsReceiptId !== null ? ['Reverts', <Button key="r" size="sm" variant="link" onClick={() => set({ receipt: r.revertsReceiptId })}>An earlier receipt</Button>] : null,
            ['Kept until', <Time key="k" value={r.retentionUntil} exact />],
            ['Document hash', <span key="h" className={styles.mono}>{r.documentHash}</span>],
          ]} />
          <Section title="Summary"><pre className={styles.code}>{JSON.stringify(r.summary, null, 2)}</pre></Section>
          {r.document !== null ? <details className={styles.details}><summary>The whole receipt</summary><pre className={styles.code}>{JSON.stringify(r.document, null, 2)}</pre></details> : null}
          <div className={styles.row}>
            {r.purgedAt === null ? <Button blocked={revert.blocked} onClick={() => setReverting(true)}>Revert it</Button> : null}
            {r.purgedAt === null ? <Button variant="ghost" blocked={purge.blocked} onClick={() => setPurging(true)}>Purge its values</Button> : null}
          </div>
          {revert.data !== undefined ? <RevertPanel revertId={revert.data.id} /> : null}
          {purgeRead.data !== undefined ? (
            <Panel>
              <span className={styles.row}>Purge: <Badge tone={purgeRead.data.status === 'completed' ? 'ok' : purgeRead.data.status === 'awaiting_approval' ? 'warn' : 'info'}>{purgeRead.data.status.replaceAll('_', ' ')}</Badge>
                {purgeRead.data.approvalChainId !== null && purgeRead.data.status === 'awaiting_approval' ? <Link href={approvalHref(purgeRead.data.approvalChainId)}>Its approval</Link> : null}</span>
            </Panel>
          ) : null}
          {revert.error ?? purge.error ? <ErrorMessage error={revert.error ?? purge.error} /> : null}
        </div>
      )}
      <Dialog open={reverting} onClose={() => setReverting(false)} title="Revert this change" size="sm" busy={revert.pending}
        description="A revert is a governed change of its own: it is previewed, may need approval, and has its own receipt. Records that moved on since are put to you one by one.">
        <div className={styles.form}>
          <RadioGroup name="revert-scope" label="Revert" value={scope} onChange={setScope} options={[
            { value: 'full', label: 'All of it' }, { value: 'succeeded_half', label: 'Only what succeeded', hint: 'Where part of it failed.' },
          ]} />
          <FormActions><Button onClick={() => setReverting(false)}>Cancel</Button><Button variant="primary" pending={revert.pending} onClick={async () => {
            const out = await revert.run({ body: { receiptId, scope } });
            if (out.ok) {
              setReverting(false);
              say(out.data.conflictCount > 0 ? `Revert prepared: ${plural(out.data.conflictCount, 'record')} to decide` : 'Revert prepared');
            }
          }}>Prepare the revert</Button></FormActions>
        </div>
      </Dialog>
      <ConfirmDialog open={purging} onClose={() => setPurging(false)} title="Purge this receipt's values?" confirmLabel="Ask to purge" tone="danger"
        onConfirm={async () => {
          const out = await purge.run({ body: { scope: 'receipt', receiptId } });
          if (out.ok) {
            say('Purge requested: it needs approval');
            set({ purge: out.data.id });
          }
          return out;
        }}><p>The values it holds (before and after) are destroyed once approved; what happened, when and by whom is kept. A purged receipt can no longer be reverted.</p></ConfirmDialog>
    </Dialog>
  );
}

function ChangeView({ mutationId, onClose }: { mutationId: string; onClose: () => void }) {
  const say = useToast();
  const people = useDirectory();
  const workspace = useWorkspace();
  const { lookup } = useVocabulary();
  const [, set] = useParams();
  const read = useQuery('getMutation', { params: { mutationId } });
  const m = read.data;
  useRefreshWhile(m !== undefined && RUNNING.includes(m.status), read.refetch, 3000);
  const execute = useMutation('executeMutation', { invalidates: ['getMutation', 'listMutations'] });
  const canary = useMutation('confirmMutationCanary', { invalidates: ['getMutation', 'listMutations'] });
  if (m === undefined) return <Dialog open onClose={onClose} drawer title="Change">{read.status === 'error' ? <ErrorMessage error={read.error} onRetry={read.refetch} /> : <Loading label="Reading the change" />}</Dialog>;
  const mine = m.proposerMembershipId === workspace.session.membershipId;
  const error = execute.error ?? canary.error;
  return (
    <Dialog open onClose={onClose} drawer title={`${ORIGIN[m.origin]}: ${plural(m.rowCount, 'record')} of ${lookup?.typeName(m.objectTypeId, true) ?? 'objects'}`}
      description={<span className={styles.row}><Badge tone={STATUS[m.status].tone}>{STATUS[m.status].label}</Badge><Badge>{m.riskClass}</Badge>{m.dryRun ? <Badge tone="info">Dry run</Badge> : null}</span>}>
      <div className={styles.stack}>
        {m.status === 'refused' ? <Banner tone="danger" title="Refused">{m.refusalReason ?? 'It was refused'}{m.refusedStage !== null ? ` at ${m.refusedStage.replaceAll('_', ' ')}` : ''}.</Banner> : null}
        <Properties items={[
          ['Proposed by', m.proposerMembershipId === null ? 'Silo' : people.nameOf(m.proposerMembershipId)], ['Proposed', <Time key="c" value={m.createdAt} />],
          m.completedAt !== null ? ['Finished', <Time key="f" value={m.completedAt} />] : null, m.expiresAt !== null && m.completedAt === null ? ['Expires', <Time key="e" value={m.expiresAt} />] : null,
          ['If a record fails', m.resolutionPolicy === 'strict' ? 'Nothing is written' : 'The rest are written'],
          m.chain !== null ? ['Approval', <Link key="a" href={approvalHref(m.chain.id)}>{m.chain.approvalsReceived} of {m.chain.approvalsRequired}, {m.chain.status}</Link>] : null,
        ]} />
        {m.status === 'approved' && m.executionSeparated ? (
          <Panel>
            <div className={styles.next}>
              <p className={styles.muted}>Approved. Its proposer runs it when ready{mine ? '' : `: ${people.nameOf(m.proposerMembershipId)}`}.</p>
              <Button variant="primary" pending={execute.pending} blocked={execute.blocked ?? (mine ? undefined : 'Only its proposer runs it')} onClick={async () => {
                const r = await execute.run({ params: { mutationId } });
                if (r.ok) say('Running');
              }}>Run it</Button>
            </div>
          </Panel>
        ) : null}
        {m.status === 'canary' && m.canaryEvidence !== null ? (
          <Panel>
            <div className={styles.stack}>
              <Banner tone="warn" title="A sample was written first">{m.canaryEvidence.statement}</Banner>
              <Properties columns={3} items={[['Sampled', formatNumber(m.canaryEvidence.sampled)], ['Read back differently', formatNumber(m.verification.diverged)], ['Failed', formatNumber(m.verification.failed)]]} />
              <FormActions>
                <Button variant="primary" pending={canary.pending} blocked={canary.blocked} onClick={async () => {
                  const r = await canary.run({ params: { mutationId }, body: { seen: { diverged: m.verification.diverged, failed: m.verification.failed } } });
                  if (r.ok) say('Confirmed: the rest is being written');
                }}>I have looked: write the rest</Button>
              </FormActions>
            </div>
          </Panel>
        ) : null}
        {error !== undefined ? <ErrorMessage error={error} /> : null}
        <Section title="What it writes"><ChangePreview mutation={m} /></Section>
        {m.executions.length > 0 ? (
          <Section title="What each system applied" description={`Read back afterwards: ${formatNumber(m.verification.verified)} the same, ${formatNumber(m.verification.diverged)} different, ${formatNumber(m.verification.failed)} failed.`}>
            <DataTable label="Executions" rows={m.executions} rowKey={(e) => `${e.connectionId}:${e.phase}`} dense columns={[
              { id: 'phase', header: 'Phase', primary: true, cell: (e) => (e.phase === 'canary' ? 'Sample' : 'All') },
              { id: 'status', header: 'Outcome', width: 'md', cell: (e) => <Status tone={e.status === 'succeeded' ? 'ok' : e.status === 'failed' ? 'danger' : 'info'}>{e.status.replaceAll('_', ' ')}</Status> },
              { id: 'n', header: 'Applied', width: 'sm', align: 'end', cell: (e) => `${formatNumber(e.recordsApplied)} of ${formatNumber(e.recordsAttempted)}` },
              { id: 'err', header: 'Error', cell: (e) => <span className={styles.muted}>{e.error ?? ''}</span> },
            ]} />
          </Section>
        ) : null}
        {m.revertId !== null ? <RevertPanel revertId={m.revertId} /> : null}
        {m.receiptId !== null ? (
          <>
            <Section title="Webhooks it called"><Deliveries mutationId={mutationId} /></Section>
            <Button onClick={() => set({ receipt: m.receiptId, change: undefined })}>Open its receipt</Button>
          </>
        ) : null}
        {m.promotion !== null ? <p className={styles.muted}>Promoted from a scenario, with {plural(m.promotion.rowsTogether, 'record')} together. <Link href={hrefWith('/scenarios/list/', { scenario: m.promotion.scenarioId })}>The scenario</Link></p> : null}
      </div>
    </Dialog>
  );
}

function Commits() {
  const people = useDirectory();
  const [object, setObject] = useState<PickedObject | undefined>(undefined);
  const [, set] = useParams();
  const commits = useQuery('listObjectCommits', object === undefined ? null : { params: { objectId: object.objectId }, query: { limit: 100 } });
  return (
    <Section title="An object's changes" description="Every governed change that touched one object, newest first.">
      <ObjectPicker label="Object" value={object} onChange={setObject} />
      {object !== undefined ? (
        <QueryView query={commits} what="Its changes" isEmpty={(d) => d.commits.length === 0} empty={<p className={styles.muted}>No governed change has touched it.</p>}>
          {(d) => (
            <DataTable label="Commits" rows={d.commits} rowKey={(c) => c.id} columns={[
              { id: 'when', header: 'When', primary: true, cell: (c) => <Button variant="link" size="sm" onClick={() => set({ change: c.mutationId })}><Time value={c.committedAt} exact /></Button> },
              { id: 'fields', header: 'Fields', cell: (c) => c.fieldsChanged.join(', ') },
              { id: 'by', header: 'By', width: 'md', cell: (c) => `${people.nameOf(c.authorMembershipId)}${c.approverMembershipIds.length > 0 ? `, approved by ${c.approverMembershipIds.map(people.nameOf).join(', ')}` : ''}` },
              { id: 'out', header: 'Read back', width: 'sm', cell: (c) => <Status tone={c.outcome === 'verified' ? 'ok' : c.outcome === 'diverged' ? 'warn' : 'danger'}>{c.outcome}</Status> },
              { id: 'rev', header: '', width: 'sm', cell: (c) => (c.revertsCommitId !== null ? <Badge>Revert</Badge> : null) },
            ]} />
          )}
        </QueryView>
      ) : null}
    </Section>
  );
}

export function Changes() {
  const people = useDirectory();
  const { lookup } = useVocabulary();
  const [params, set] = useParams();
  const status = params.get('status') ?? '';
  const list = useQuery('listMutations', { query: { limit: 200, ...(status !== '' ? { status: status as Status } : {}) } }, { refreshMs: 30_000 });
  usePageContext({ scope: { kind: 'page', page: 'governance' }, scopeLabel: 'Changes' });
  const tabs: readonly TabDef<'changes' | 'objects'>[] = [{ id: 'changes', label: 'Changes' }, { id: 'objects', label: 'By object' }];
  const [tab, setTab] = useTab(tabs);
  const change = params.get('change');
  const receipt = params.get('receipt');
  return (
    <Page title="Changes" description="Every governed change: exactly what it writes, what each system applied, what read back the same, and its receipt." crumbs={[{ label: 'Governance' }]}>
      <Tabs label="Changes" tabs={tabs} current={tab} onChange={setTab} />
      <TabPanel id={tab}>
        {tab === 'changes' ? (
          <>
            <Toolbar>
              <SelectField label="State" hideLabel value={status} onChange={(e) => set({ status: e.target.value })} placeholder="Every state"
                options={(Object.keys(STATUS) as Status[]).map((s) => ({ value: s, label: STATUS[s].label }))} />
            </Toolbar>
            <QueryView query={list} what="Changes" isEmpty={(d) => d.mutations.length === 0} empty={<EmptyState icon="undo" title="No governed change yet">Changes made through Actions, Ask, Crons and scenarios appear here.</EmptyState>}>
              {(d) => (
                <DataTable label="Changes" rows={d.mutations} rowKey={(m) => m.id} rowHref={(m) => hrefWith('/governance/changes/', { change: m.id, status: status || undefined })} columns={[
                  { id: 'when', header: 'Proposed', primary: true, sortValue: (m) => m.createdAt, cell: (m) => <Time value={m.createdAt} /> },
                  { id: 'what', header: 'What', cell: (m) => `${plural(m.rowCount, 'record')} of ${lookup?.typeName(m.objectTypeId, true) ?? 'objects'}${m.genericEdit ? ', an edit' : ''}${m.dryRun ? ', dry run' : ''}` },
                  { id: 'from', header: 'From', width: 'md', cell: (m) => `${ORIGIN[m.origin]}${m.proposerMembershipId !== null ? `, ${people.nameOf(m.proposerMembershipId)}` : ''}` },
                  { id: 'risk', header: 'Risk', width: 'sm', cell: (m) => <Badge tone={m.riskClass === 'physical' ? 'danger' : m.riskClass === 'external' ? 'warn' : 'neutral'}>{m.riskClass}</Badge> },
                  { id: 'state', header: 'State', width: 'lg', cell: (m) => <Badge tone={STATUS[m.status].tone}>{STATUS[m.status].label}</Badge> },
                ]} />
              )}
            </QueryView>
          </>
        ) : <Commits />}
      </TabPanel>
      {change !== null ? <ChangeView key={change} mutationId={change} onClose={() => set({ change: undefined })} /> : null}
      {receipt !== null ? <ReceiptView key={receipt} receiptId={receipt} onClose={() => set({ receipt: undefined, purge: undefined })} /> : null}
    </Page>
  );
}
