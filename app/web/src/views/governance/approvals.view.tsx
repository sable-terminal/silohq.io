'use client';

// Approvals (spec 44): what waits for a person's decision: a governed change, a Silo purge, a
// receipt purge, a declassification or a discovery scan. Each opens to the thing itself (the
// change's diff, the scan's document, the declassification's preview) and the approver's
// decision quotes the hash of exactly what they read (D264), so a subject that changed after
// they looked is refused rather than approved unseen. A chain shows its conditions and every
// step: who may approve, who did, in order where it is sequential.

import Link from 'next/link';
import { useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge, Status } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { Dialog } from '../../components/dialog.component.tsx';
import { Checkbox, FormActions, TextArea } from '../../components/field.component.tsx';
import { Page, Panel, Properties, Section, Toolbar } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage, Loading } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { useVocabulary } from '../../hooks/vocabulary.hook.ts';
import { usePageContext, useWorkspace } from '../../shell/context.shell.tsx';
import { formatNumber, humanise, plural } from '../../utils/format.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import { ChangePreview } from './changes.view.tsx';
import styles from './governance.view.module.css';

type Chain = Output<'getApprovalChain'>;

const SUBJECT: Record<Chain['subjectKind'], string> = {
  mutation: 'A change', purge: 'A Silo purge', receipt_purge: 'A receipt purge', declassification: 'A declassification', discovery_scan: 'A discovery scan',
};
const STATUS: Record<Chain['status'], { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' }> = {
  pending: { label: 'Waiting', tone: 'warn' }, approved: { label: 'Approved', tone: 'ok' }, rejected: { label: 'Rejected', tone: 'danger' }, expired: { label: 'Expired', tone: 'neutral' },
};
const QUALIFICATION: Record<Chain['conditions'][number]['qualification'], string> = {
  any_permitted: 'anyone permitted', role: 'someone with a role', named_role: 'someone with the named role', scope_admin: 'an admin of the scope', marking_holder: 'someone cleared for its markings',
};

/** What is being approved, read as the approver, with the hash a decision quotes. */
function useSubject(chain: Chain): { hash: string | null | undefined; body: React.ReactNode; error: unknown } {
  const { lookup } = useVocabulary();
  const s = chain.subject;
  const mutation = useQuery('getMutation', s.kind === 'mutation' ? { params: { mutationId: s.id } } : null);
  const scan = useQuery('getScanAuthorisation', s.kind === 'discovery_scan' ? { params: { authorisationId: s.id } } : null);
  const declass = useQuery('readDeclassification', s.kind === 'declassification' ? { params: { declassificationId: s.id } } : null);
  const receiptPurge = useQuery('getReceiptPurge', s.kind === 'receipt_purge' ? { params: { purgeId: s.id } } : null);
  const purge = useQuery('getPurge', s.kind === 'purge' && s.siloId !== null ? { params: { siloId: s.siloId, purgeId: s.id } } : null);
  if (s.kind === 'mutation') {
    const m = mutation.data;
    return { hash: m?.diffHash, error: mutation.error, body: m === undefined ? <Loading label="Reading the change" block={false} /> : (
      <div className={styles.stack}>
        <p>{plural(m.rowCount, 'record')} of {lookup?.typeName(m.objectTypeId, true) ?? 'objects'}, {m.riskClass} risk{m.dryRun ? ', a dry run' : ''}. <Link href={hrefWith('/governance/changes/', { change: m.id })}>Open the change</Link></p>
        <ChangePreview mutation={m} />
      </div>
    ) };
  }
  if (s.kind === 'discovery_scan') {
    const a = scan.data;
    return { hash: a?.documentHash, error: scan.error, body: a === undefined ? <Loading label="Reading the scan" block={false} /> : (
      <Properties columns={1} items={[
        ['Targets', <span key="t" className={styles.mono}>{a.ranges.join(', ')}</span>], ['Methods', a.methods.map(humanise).join(', ')],
        ['Host bound', formatNumber(a.maxHosts)], ['Valid until', <Time key="e" value={a.expiresAt} exact />],
        ['Document hash', <span key="h" className={styles.mono}>{a.documentHash}</span>],
      ]} />
    ) };
  }
  if (s.kind === 'declassification') {
    const d = declass.data;
    return { hash: d?.diffHash, error: declass.error, body: d === undefined ? <Loading label="Reading it" block={false} /> : (
      <Properties columns={1} items={[
        ['Taken off', humanise(d.resource.type)], ['Why', d.justification], ['People gaining access', formatNumber(d.preview.readersGainingAccess)],
        ['Downstream losing it', d.applyDownstream ? formatNumber(d.preview.downstreamLosing) : 'Not applied downstream'],
      ]} />
    ) };
  }
  if (s.kind === 'receipt_purge') {
    const p = receiptPurge.data;
    return { hash: p?.documentHash, error: receiptPurge.error, body: p === undefined ? <Loading label="Reading it" block={false} /> : (
      <Properties columns={1} items={[
        ['Purges', p.scope === 'receipt' ? 'One receipt\'s values' : 'Every receipt\'s values for one object'], ['Receipts', formatNumber(p.receipts)],
        ['Asked', <Time key="r" value={p.requestedAt} />],
      ]} />
    ) };
  }
  const p = purge.data;
  return { hash: p?.documentHash, error: purge.error, body: p === undefined ? <Loading label="Reading it" block={false} /> : (
    <Properties columns={1} items={[
      ['Purges', humanise(p.scope)], ['Also removes', [p.impact.warehouse ? 'its Warehouse rows' : '', p.impact.importedRows ? 'imported rows' : '', ...p.impact.timelines.map(() => 'a timeline')].filter(Boolean).join(', ') || 'Nothing else'],
      ['Asked', <Time key="r" value={p.requestedAt} />],
    ]} />
  ) };
}

function ChainDetail({ chainId, onClose }: { chainId: string; onClose: () => void }) {
  const read = useQuery('getApprovalChain', { params: { chainId } });
  const c = read.data;
  if (c === undefined) return <Dialog open onClose={onClose} drawer title="Approval">{read.status === 'error' ? <ErrorMessage error={read.error} onRetry={read.refetch} /> : <Loading label="Reading it" />}</Dialog>;
  return <ChainBody key={c.id} chain={c} onClose={onClose} />;
}

function ChainBody({ chain: c, onClose }: { chain: Chain; onClose: () => void }) {
  const say = useToast();
  const people = useDirectory();
  const workspace = useWorkspace();
  const decide = useMutation('decideApproval', { invalidates: ['listApprovalInbox', 'getMutation', 'getApprovalChain'] });
  const [comment, setComment] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const mine = c.requesterMembershipId === workspace.session.membershipId;
  const subject = useSubject(c);
  const pending = c.status === 'pending';
  const offered = c.steps.some((s) => s.offered && s.decision === null);
  const run = async (decision: 'approved' | 'rejected') => {
    if (subject.hash == null) return;
    const r = await decide.run({ params: { chainId: c.id }, body: { decision, diffHash: subject.hash, ...(comment.trim() !== '' ? { comment: comment.trim() } : {}) } });
    if (r.ok) {
      say(decision === 'approved' ? (r.data.status === 'approved' ? 'Approved: it goes ahead' : 'Approved; it waits for the others') : 'Rejected');
      setRejecting(false);
    }
  };
  return (
    <Dialog open onClose={onClose} drawer title={SUBJECT[c.subjectKind]} busy={decide.pending}
      description={<span className={styles.row}><Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge><span>{c.approvalsReceived} of {c.approvalsRequired} approvals</span></span>}>
      <div className={styles.stack}>
        <Properties items={[
          ['Asked by', people.nameOf(c.requesterMembershipId)], ['Asked', <Time key="a" value={c.createdAt} />],
          ['Expires', <Time key="e" value={c.expiresAt} exact />], ['Order', c.sequential ? 'One after another' : 'Any order'],
        ]} />
        {c.floorOverrodePolicy ? <Banner tone="info">Silo's minimum for this kind of change asks for more than your policy does.</Banner> : null}
        <Section title="What you are approving">
          {subject.error !== undefined ? <ErrorMessage error={subject.error} /> : subject.body}
        </Section>
        <Section title="Who may approve">
          <ul className={styles.plainList}>{c.conditions.map((x) => (
            <li key={x.id}>{plural(x.count, 'approval')} from {QUALIFICATION[x.qualification]}{x.requiresAdmin ? ', an admin' : ''}{x.selfApprovalPermitted ? '' : '; never the requester'}</li>
          ))}</ul>
          <DataTable label="Steps" rows={c.steps} rowKey={(s) => s.id} dense columns={[
            { id: 'rule', header: 'Step', primary: true, cell: (s) => `${s.sequence !== null ? `${s.sequence}. ` : ''}${humanise(s.qualifyingRule)}` },
            { id: 'who', header: 'Approver', width: 'md', cell: (s) => (s.approverMembershipId === null ? (s.offered ? 'Open' : 'Not yet offered') : people.nameOf(s.approverMembershipId)) },
            { id: 'decision', header: 'Decision', width: 'md', cell: (s) => (s.decision === null ? '—' : <Status tone={s.decision === 'approved' ? 'ok' : 'danger'}>{s.decision}{s.decidedAt !== null ? ', ' : ''}{s.decidedAt !== null ? <Time value={s.decidedAt} /> : null}</Status>) },
          ]} />
        </Section>
        {pending ? (
          <Panel>
            <div className={styles.form}>
              {mine ? <Banner tone="info">You asked for this; someone else approves it unless self-approval is permitted.</Banner> : null}
              {!offered ? <Banner tone="info">No step is open to you now: it may be another's turn.</Banner> : null}
              <TextArea label="Comment (optional)" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} hint="Recorded with your decision." />
              {decide.error !== undefined ? <ErrorMessage error={decide.error} /> : null}
              <FormActions>
                <Button variant="ghost" blocked={decide.blocked} disabled={subject.hash == null} onClick={() => setRejecting(true)}>Reject</Button>
                <Button variant="primary" pending={decide.pending} blocked={decide.blocked ?? (subject.hash == null ? 'Read what is being approved first' : undefined)} onClick={() => void run('approved')}>Approve what you read</Button>
              </FormActions>
            </div>
          </Panel>
        ) : null}
      </div>
      <Dialog open={rejecting} onClose={() => setRejecting(false)} title="Reject it?" size="sm" busy={decide.pending}>
        <div className={styles.form}>
          <p>It does not go ahead. The person who asked is told, with your comment.</p>
          <FormActions><Button onClick={() => setRejecting(false)}>Cancel</Button><Button variant="danger" pending={decide.pending} onClick={() => void run('rejected')}>Reject</Button></FormActions>
        </div>
      </Dialog>
    </Dialog>
  );
}

/** The approvals waiting (for you, or all you may see), each opening to what is approved. Also an app's widget. */
export function ApprovalInbox({ forMe, chainParam = 'chain' }: { forMe: boolean; chainParam?: string }) {
  const people = useDirectory();
  const [params, set] = useParams();
  const inbox = useQuery('listApprovalInbox', { query: { limit: 100, ...(forMe ? { forMe: 'true' as const } : {}) } }, { refreshMs: 60_000 });
  const id = params.get(chainParam);
  return (
    <>
      <QueryView query={inbox} what="Approvals" isEmpty={(d) => d.chains.length === 0} empty={<EmptyState icon="check" title="Nothing waits for you">When a change, purge, scan or declassification needs your approval, it is here.</EmptyState>}>
        {(d) => (
          <DataTable label="Approvals" rows={d.chains} rowKey={(c) => c.id} rowHref={(c) => `?${new URLSearchParams({ ...Object.fromEntries(params), [chainParam]: c.id }).toString()}`} columns={[
            { id: 'what', header: 'What', primary: true, cell: (c) => <span className={styles.row}>{SUBJECT[c.subjectKind]}{c.riskClass !== null ? <Badge tone={c.riskClass === 'physical' ? 'danger' : c.riskClass === 'external' ? 'warn' : 'neutral'}>{c.riskClass}</Badge> : null}</span> },
            { id: 'by', header: 'Asked by', width: 'md', cell: (c) => people.nameOf(c.requesterMembershipId) },
            { id: 'progress', header: 'Approvals', width: 'sm', cell: (c) => `${c.approvalsReceived} of ${c.approvalsRequired}` },
            { id: 'state', header: 'State', width: 'sm', cell: (c) => <Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge> },
            { id: 'expires', header: 'Expires', width: 'md', sortValue: (c) => c.expiresAt, cell: (c) => <Time value={c.expiresAt} /> },
          ]} />
        )}
      </QueryView>
      {id !== null ? <ChainDetail key={id} chainId={id} onClose={() => set({ [chainParam]: undefined })} /> : null}
    </>
  );
}

export function Approvals() {
  const [params, set] = useParams();
  const forMe = params.get('all') !== '1';
  usePageContext({ scope: { kind: 'page', page: 'governance' }, scopeLabel: 'Approvals' });
  return (
    <Page title="Approvals" description="What waits for a person's decision. You approve exactly what you read: if it changes after you looked, your decision is refused." crumbs={[{ label: 'Governance' }]}>
      <Toolbar><Checkbox label="Show every approval, not only those waiting for me" checked={!forMe} onChange={() => set({ all: forMe ? '1' : undefined })} /></Toolbar>
      <ApprovalInbox forMe={forMe} />
    </Page>
  );
}
