'use client';

// Silo staff access (spec 61): every time someone at Silo asks to see or act in the
// organisation, why (a support request, an incident, a security investigation, a legal
// obligation), at what level, for how long, with which ticket, and who at Silo approved it. Where
// the customer's approval is required, an admin here approves or denies it; an approved or active
// session can be ended at once. Everything staff do under a session is in the audit log, named.

import { useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button, LinkButton } from '../../components/button.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { FormActions, SelectField, Switch, TextArea } from '../../components/field.component.tsx';
import { Page, Panel, Properties, Toolbar } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage, Loading } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { hrefWith } from '../../utils/href.util.ts';
import styles from './governance.view.module.css';

type Session = Output<'getOperatorAccessSession'>;

const PURPOSE: Record<Session['purpose'], string> = {
  support_request: 'A support request', incident_response: 'An incident', security_investigation: 'A security investigation', legal_obligation: 'A legal obligation',
};
const LEVEL: Record<Session['accessLevel'], string> = { metadata_read: 'See how things are set up, no data', tenant_read: 'Read data', tenant_act: 'Read data and act' };
const STATUS: Record<Session['status'], { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' | 'info' }> = {
  requested: { label: 'Waiting for your decision', tone: 'warn' }, approved: { label: 'Approved', tone: 'info' }, active: { label: 'In use now', tone: 'danger' },
  denied: { label: 'Denied', tone: 'neutral' }, cancelled: { label: 'Cancelled', tone: 'neutral' }, ended: { label: 'Ended', tone: 'neutral' }, expired: { label: 'Expired', tone: 'neutral' },
};

function Detail({ id, onClose }: { id: string; onClose: () => void }) {
  const say = useToast();
  const people = useDirectory();
  const read = useQuery('getOperatorAccessSession', { params: { sessionId: id } }, { refreshMs: 30_000 });
  const decide = useMutation('decideOperatorAccessSession', { invalidates: ['listOperatorAccessSessions'] });
  const revoke = useMutation('revokeOperatorAccessSession', { invalidates: ['listOperatorAccessSessions'] });
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState('');
  const [ending, setEnding] = useState(false);
  const s = read.data;
  if (s === undefined) return <Dialog open onClose={onClose} drawer title="Staff access">{read.status === 'error' ? <ErrorMessage error={read.error} onRetry={read.refetch} /> : <Loading label="Reading it" />}</Dialog>;
  return (
    <Dialog open onClose={onClose} drawer title={`${s.operatorDisplayName}, Silo`} description={<Badge tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Badge>}>
      <div className={styles.stack}>
        {s.emergency ? <Banner tone="danger" title="Emergency access">Opened without waiting for your approval; you are told at once and may end it.</Banner> : null}
        <Properties columns={1} items={[
          ['Why', PURPOSE[s.purpose]], ['In their words', s.reason], ['Ticket', s.ticketReference], ['Level', LEVEL[s.accessLevel]],
          s.scopeNote !== null ? ['Limited to', s.scopeNote] : null,
          ['For', `${s.requestedMinutes} minutes`], ['Asked', <Time key="r" value={s.requestedAt} exact />],
          ['Approved at Silo by', [s.staffApproverDisplayName, s.staffSecondApproverDisplayName].filter(Boolean).join(' and ') || 'Not yet'],
          s.approvedByMembershipId !== null ? ['Approved here by', people.nameOf(s.approvedByMembershipId)] : null,
          s.deniedReason !== null ? ['Denied because', s.deniedReason] : null,
          s.startsAt !== null ? ['From', <Time key="s" value={s.startsAt} exact />] : null,
          s.expiresAt !== null ? ['Until', <Time key="e" value={s.expiresAt} exact />] : null,
        ]} />
        {s.status === 'requested' && s.customerApprovalRequired ? (
          <div className={styles.row}>
            <Button variant="primary" pending={decide.pending} blocked={decide.blocked} onClick={async () => {
              const r = await decide.run({ params: { sessionId: id }, body: { decision: 'approve' } });
              if (r.ok) say('Approved');
            }}>Approve</Button>
            <Button variant="ghost" blocked={decide.blocked} onClick={() => setDenying(true)}>Deny</Button>
          </div>
        ) : null}
        {s.status === 'approved' || s.status === 'active' ? <Button variant="danger" blocked={revoke.blocked} onClick={() => setEnding(true)}>End it now</Button> : null}
        <LinkButton href={hrefWith('/governance/audit/', { resource: s.id })}>What they did, in the audit log</LinkButton>
        {decide.error !== undefined ? <ErrorMessage error={decide.error} /> : null}
      </div>
      <Dialog open={denying} onClose={() => setDenying(false)} title="Deny the access" size="sm" busy={decide.pending}>
        <form className={styles.form} onSubmit={async (event) => {
          event.preventDefault();
          const r = await decide.run({ params: { sessionId: id }, body: { decision: 'deny', ...(reason.trim() !== '' ? { reason: reason.trim() } : {}) } });
          if (r.ok) {
            setDenying(false);
            say('Denied');
          }
        }}>
          <TextArea label="Why (optional)" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} hint="Silo staff see it." />
          <FormActions><Button onClick={() => setDenying(false)}>Cancel</Button><Button type="submit" variant="danger" pending={decide.pending}>Deny</Button></FormActions>
        </form>
      </Dialog>
      <ConfirmDialog open={ending} onClose={() => setEnding(false)} title="End this access now?" confirmLabel="End it" tone="danger"
        onConfirm={async () => {
          const r = await revoke.run({ params: { sessionId: id } });
          if (r.ok) say('Ended: their access stops at once');
          return r;
        }}><p>Their access stops at once. The support request or incident it was for may take longer without it.</p></ConfirmDialog>
    </Dialog>
  );
}

/** Whether Silo staff need the organisation's approval before they may see or act (spec 61.3). */
export function StaffAccessPolicy() {
  const say = useToast();
  const read = useQuery('getOperatorAccessPolicy', {});
  const set = useMutation('setOperatorAccessPolicy', { invalidates: ['getOperatorAccessPolicy'] });
  const p = read.data;
  if (p === undefined) return null;
  return (
    <Panel>
      <Switch label="Ask us before Silo staff may see or act" checked={p.approvalRequired || p.requiredByCell}
        hint={p.requiredByCell ? 'Required in this cell for every organisation.' : 'Without it, staff with an approved reason may begin straight away; you are told either way.'}
        blocked={p.requiredByCell ? 'Required by this cell' : set.blocked?.message}
        onChange={async (approvalRequired) => {
          const r = await set.run({ body: { approvalRequired } });
          if (r.ok) say(approvalRequired ? 'Staff access now waits for your approval' : 'Staff access no longer waits for your approval');
        }} />
      {set.error !== undefined ? <ErrorMessage error={set.error} /> : null}
    </Panel>
  );
}

export function StaffAccess() {
  const [params, set] = useParams();
  const status = params.get('status') ?? '';
  const list = useQuery('listOperatorAccessSessions', { query: { limit: 100, ...(status !== '' ? { status: status as Session['status'] } : {}) } }, { refreshMs: 60_000 });
  usePageContext({ scope: { kind: 'page', page: 'governance' }, scopeLabel: 'Silo staff access' });
  const waiting = (list.data?.sessions ?? []).filter((s) => s.status === 'requested' && s.customerApprovalRequired).length;
  const id = params.get('session');
  return (
    <Page title="Silo staff access" description="Every time someone at Silo asks to see or act in your organisation: why, for how long, and who approved it." crumbs={[{ label: 'Governance' }]}>
      <StaffAccessPolicy />
      {waiting > 0 ? <Banner tone="warn" title="Waiting for you">{waiting === 1 ? 'A request waits' : `${waiting} requests wait`} for your decision.</Banner> : null}
      <Toolbar>
        <SelectField label="State" hideLabel value={status} onChange={(e) => set({ status: e.target.value })} placeholder="Every state"
          options={(Object.keys(STATUS) as Session['status'][]).map((s) => ({ value: s, label: STATUS[s].label }))} />
      </Toolbar>
      <QueryView query={list} what="Staff access" isEmpty={(d) => d.sessions.length === 0} empty={<EmptyState icon="lock" title="No staff access">No one at Silo has asked to see or act in your organisation.</EmptyState>}>
        {(d) => (
          <DataTable label="Staff access sessions" rows={d.sessions} rowKey={(s) => s.id} rowHref={(s) => hrefWith('/governance/staff/', { session: s.id, status: status || undefined })} columns={[
            { id: 'who', header: 'Who', primary: true, cell: (s) => s.operatorDisplayName },
            { id: 'why', header: 'Why', width: 'md', cell: (s) => PURPOSE[s.purpose] },
            { id: 'level', header: 'Level', width: 'md', cell: (s) => LEVEL[s.accessLevel] },
            { id: 'state', header: 'State', width: 'md', cell: (s) => <span className={styles.row}><Badge tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Badge>{s.emergency ? <Badge tone="danger">Emergency</Badge> : null}</span> },
            { id: 'when', header: 'Asked', width: 'sm', cell: (s) => <Time value={s.requestedAt} /> },
          ]} />
        )}
      </QueryView>
      {id !== null ? <Detail key={id} id={id} onClose={() => set({ session: undefined })} /> : null}
    </Page>
  );
}
