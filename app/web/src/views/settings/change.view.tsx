'use client';

// Approvals and change (spec 46, 53): who approves which changes to the systems Silo writes to
// (routing policies by connection and scope, how many approvers and who qualifies, under what
// conditions, each superseded rather than edited, above the organisation's floor), and when a
// dedicated cell may take a release (its change windows, the change authority, freezes and an
// exception to one).

import { useState } from 'react';
import type { Input, Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button, IconButton } from '../../components/button.component.tsx';
import { Dialog } from '../../components/dialog.component.tsx';
import { Checkbox, FormActions, SelectField, TextArea, TextField } from '../../components/field.component.tsx';
import { Page, Panel, Section } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { humanise, plural } from '../../utils/format.util.ts';
import styles from './settings.view.module.css';

type Policy = Output<'listApprovalPolicies'>['policies'][number];
type PolicyBody = NonNullable<Input<'createApprovalPolicy'>['body']>;
type Qualification = NonNullable<PolicyBody['approverQualification']>;
type Risk = 'data' | 'bulk' | 'external' | 'physical';
const crumbs = [{ label: 'Settings', href: '/settings/' }];
const QUALIFICATION: Record<Qualification, string> = {
  any_permitted: 'Anyone permitted to approve', scope_admin: 'An administrator of the scope', role: 'A holder of a role', named_role: 'A holder of a named role', marking_holder: 'Someone cleared for its markings',
};
const RISKS: Risk[] = ['data', 'bulk', 'external', 'physical'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** /settings/approval-routing/: who approves which changes, above the organisation's floor. */
export function ApprovalRouting() {
  const say = useToast();
  const people = useDirectory();
  const policies = useQuery('listApprovalPolicies', {});
  const connections = useQuery('listConnections', { query: {} });
  const roles = useQuery('listRoles', {});
  const floor = useMutation('setPolicyFloor', { invalidates: ['listApprovalPolicies'] });
  const [editing, setEditing] = useState<Policy | 'new' | undefined>();
  const [floorOpen, setFloorOpen] = useState(false);
  const [floorForm, setFloorForm] = useState<{ connectionId: string; minimumApprovals: string; minimumQualification: Qualification; riskClass: '' | Risk }>({ connectionId: '', minimumApprovals: '1', minimumQualification: 'any_permitted', riskClass: '' });
  const connectionName = (id: string | null) => (id === null ? 'Every connection' : connections.data?.connections.find((c) => c.id === id)?.name ?? 'a connection');
  const live = (policies.data?.policies ?? []).filter((p) => p.supersededAt === null);
  return (
    <Page title="Approval routing" description="Who approves which changes before Silo writes them to a system. A policy is replaced by a new one, never edited, so every decision can be traced to the policy it followed." crumbs={crumbs} width="full"
      actions={
        <div className={styles.row}>
          <Button onClick={() => setFloorOpen(true)}>Set a floor</Button>
          <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>New policy</Button>
        </div>
      }>
      <QueryView query={policies} what="Approval policies" isEmpty={() => live.length === 0} empty={<EmptyState icon="check" title="No routing policies">Changes are approved as their Action type says.</EmptyState>}>
        {() => (
          <DataTable label="Approval policies" rows={live} rowKey={(p) => p.id} columns={[
            { id: 'where', header: 'For', primary: true, cell: (p) => `${connectionName(p.connectionId)}${p.scopeId !== null ? `, in ${people.scopeName(p.scopeId)}` : ''}` },
            { id: 'how', header: 'Approved by', cell: (p) => `${plural(p.approvalsRequired, 'approval')}: ${QUALIFICATION[p.approverQualification].toLowerCase()}${p.qualifyingRoleId !== null ? ` (${roles.data?.roles.find((r) => r.id === p.qualifyingRoleId)?.name ?? 'a role'})` : ''}${p.sequential ? ', in order' : ''}` },
            { id: 'when', header: 'When', cell: (p) => [p.riskClassCondition !== null ? `risk ${p.riskClassCondition.join(' or ')}` : undefined, p.rowThreshold !== null ? `over ${p.rowThreshold} rows` : undefined].filter(Boolean).join('; ') || 'Always' },
            { id: 'rules', header: 'Rules', cell: (p) => [p.selfApprovalPermitted ? 'self-approval allowed' : 'not by the proposer', p.sameScopeRequired ? 'approvers in the same scope' : undefined, p.requiresAdmin ? 'an administrator among them' : undefined, `expires after ${plural(p.expiryHours, 'hour')}`].filter(Boolean).join('; ') },
            { id: 'act', header: <span className="visually-hidden">Supersede</span>, align: 'end', cell: (p) => <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>Replace</Button> },
          ]} />
        )}
      </QueryView>
      {editing !== undefined ? <PolicyDialog policy={editing === 'new' ? undefined : editing} onClose={() => setEditing(undefined)} /> : null}
      <Dialog open={floorOpen} onClose={() => setFloorOpen(false)} title="The floor" size="sm" busy={floor.pending} description="No policy may ask for less than this.">
        <form className={styles.form} onSubmit={async (e) => {
          e.preventDefault();
          const r = await floor.run({ body: { connectionId: floorForm.connectionId === '' ? null : floorForm.connectionId, minimumApprovals: Math.max(0, Number(floorForm.minimumApprovals) || 0), minimumQualification: floorForm.minimumQualification, riskClass: floorForm.riskClass === '' ? null : floorForm.riskClass } });
          if (r.ok) {
            setFloorOpen(false);
            say(`Floor set by ${people.nameOf(r.data.setBy)}`);
          }
        }}>
          <SelectField label="For" value={floorForm.connectionId} onChange={(e) => setFloorForm({ ...floorForm, connectionId: e.target.value })}
            options={[{ value: '', label: 'Every connection' }, ...(connections.data?.connections ?? []).map((c) => ({ value: c.id, label: c.name }))]} />
          <SelectField label="Risk" value={floorForm.riskClass} onChange={(e) => setFloorForm({ ...floorForm, riskClass: e.target.value as '' | Risk })}
            options={[{ value: '', label: 'Every risk' }, ...RISKS.map((r) => ({ value: r, label: humanise(r) }))]} />
          <TextField label="At least this many approvals" type="number" min={0} value={floorForm.minimumApprovals} onChange={(e) => setFloorForm({ ...floorForm, minimumApprovals: e.target.value })} />
          <SelectField label="By at least" value={floorForm.minimumQualification} onChange={(e) => setFloorForm({ ...floorForm, minimumQualification: e.target.value as Qualification })}
            options={(Object.keys(QUALIFICATION) as Qualification[]).map((q) => ({ value: q, label: QUALIFICATION[q] }))} />
          {floor.error !== undefined ? <ErrorMessage error={floor.error} /> : null}
          <FormActions><Button onClick={() => setFloorOpen(false)}>Cancel</Button><Button type="submit" variant="primary" pending={floor.pending} blocked={floor.blocked}>Set the floor</Button></FormActions>
        </form>
      </Dialog>
    </Page>
  );
}

function PolicyDialog({ policy, onClose }: { policy: Policy | undefined; onClose: () => void }) {
  const say = useToast();
  const connections = useQuery('listConnections', { query: {} });
  const scopes = useQuery('listScopes', { query: {} });
  const roles = useQuery('listRoles', {});
  const create = useMutation('createApprovalPolicy', { invalidates: ['listApprovalPolicies'] });
  const supersede = useMutation('supersedeApprovalPolicy', { invalidates: ['listApprovalPolicies'] });
  const [f, setF] = useState({
    connectionId: policy?.connectionId ?? '', scopeId: policy?.scopeId ?? '', approvalsRequired: String(policy?.approvalsRequired ?? 1),
    approverQualification: policy?.approverQualification ?? 'any_permitted' as Qualification, qualifyingRoleId: policy?.qualifyingRoleId ?? '',
    requiresAdmin: policy?.requiresAdmin ?? false, sameScopeRequired: policy?.sameScopeRequired ?? false, selfApprovalPermitted: policy?.selfApprovalPermitted ?? false,
    sequential: policy?.sequential ?? false, rowThreshold: policy?.rowThreshold === null || policy === undefined ? '' : String(policy.rowThreshold),
    risks: policy?.riskClassCondition ?? [] as Risk[], expiryHours: String(policy?.expiryHours ?? 72),
  });
  const body: PolicyBody = {
    connectionId: f.connectionId === '' ? null : f.connectionId, scopeId: f.scopeId === '' ? null : f.scopeId, approvalsRequired: Math.max(1, Number(f.approvalsRequired) || 1),
    approverQualification: f.approverQualification, qualifyingRoleId: f.qualifyingRoleId === '' ? null : f.qualifyingRoleId, requiresAdmin: f.requiresAdmin, sameScopeRequired: f.sameScopeRequired,
    selfApprovalPermitted: f.selfApprovalPermitted, sequential: f.sequential, rowThreshold: f.rowThreshold === '' ? null : Number(f.rowThreshold),
    riskClassCondition: f.risks.length === 0 ? null : f.risks, expiryHours: Math.max(1, Number(f.expiryHours) || 72),
  };
  const pending = create.pending || supersede.pending;
  return (
    <Dialog open onClose={onClose} title={policy === undefined ? 'New approval policy' : 'Replace the policy'} size="lg" busy={pending}
      description={policy === undefined ? undefined : 'The new policy takes its place; the old one stays in the record of what applied when.'}>
      <form className={styles.form} onSubmit={async (e) => {
        e.preventDefault();
        const r = policy === undefined ? await create.run({ body }) : await supersede.run({ params: { policyId: policy.id }, body });
        if (r.ok) {
          say(policy === undefined ? 'Policy made: it routes from now on' : 'Replaced');
          onClose();
        }
      }}>
        <div className={styles.fields}>
          <SelectField label="For changes to" value={f.connectionId} onChange={(e) => setF({ ...f, connectionId: e.target.value })} options={[{ value: '', label: 'Every connection' }, ...(connections.data?.connections ?? []).map((c) => ({ value: c.id, label: c.name }))]} />
          <SelectField label="Proposed in" value={f.scopeId} onChange={(e) => setF({ ...f, scopeId: e.target.value })} options={[{ value: '', label: 'Any scope' }, ...(scopes.data?.scopes ?? []).map((s) => ({ value: s.id, label: s.name }))]} />
        </div>
        <div className={styles.fields}>
          <TextField label="Approvals needed" type="number" min={1} value={f.approvalsRequired} onChange={(e) => setF({ ...f, approvalsRequired: e.target.value })} />
          <SelectField label="By" value={f.approverQualification} onChange={(e) => setF({ ...f, approverQualification: e.target.value as Qualification })} options={(Object.keys(QUALIFICATION) as Qualification[]).map((q) => ({ value: q, label: QUALIFICATION[q] }))} />
          {f.approverQualification === 'role' || f.approverQualification === 'named_role' ? (
            <SelectField label="The role" required value={f.qualifyingRoleId} placeholder="Choose a role" onChange={(e) => setF({ ...f, qualifyingRoleId: e.target.value })} options={(roles.data?.roles ?? []).filter((r) => r.retiredAt === null).map((r) => ({ value: r.id, label: r.name }))} />
          ) : null}
          <TextField label="Expires after (hours)" type="number" min={1} value={f.expiryHours} onChange={(e) => setF({ ...f, expiryHours: e.target.value })} />
        </div>
        <fieldset className={styles.fieldset}>
          <legend>Only when (otherwise always)</legend>
          <div className={styles.checks}>{RISKS.map((r) => (
            <Checkbox key={r} label={`Its risk is ${r}`} checked={f.risks.includes(r)} onChange={(e) => setF({ ...f, risks: e.target.checked ? [...f.risks, r] : f.risks.filter((x) => x !== r) })} />
          ))}</div>
          <TextField label="It changes more rows than (optional)" type="number" min={1} value={f.rowThreshold} onChange={(e) => setF({ ...f, rowThreshold: e.target.value })} />
        </fieldset>
        <Checkbox label="Approvers decide one after another, in order" checked={f.sequential} onChange={(e) => setF({ ...f, sequential: e.target.checked })} />
        <Checkbox label="An administrator must be among them" checked={f.requiresAdmin} onChange={(e) => setF({ ...f, requiresAdmin: e.target.checked })} />
        <Checkbox label="Approvers must be in the proposer's scope" checked={f.sameScopeRequired} onChange={(e) => setF({ ...f, sameScopeRequired: e.target.checked })} />
        <Checkbox label="The proposer may approve their own change" checked={f.selfApprovalPermitted} onChange={(e) => setF({ ...f, selfApprovalPermitted: e.target.checked })} />
        {create.error !== undefined ? <ErrorMessage error={create.error} /> : null}
        {supersede.error !== undefined ? <ErrorMessage error={supersede.error} /> : null}
        <FormActions><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" pending={pending}>{policy === undefined ? 'Make the policy' : 'Replace it'}</Button></FormActions>
      </form>
    </Dialog>
  );
}

/** /settings/change-policy/: when a dedicated cell may take a release; freezes and their exceptions. */
export function ChangePolicy() {
  const say = useToast();
  const people = useDirectory();
  const read = useQuery('getChangePolicy', {});
  const set = useMutation('setChangePolicy', { invalidates: ['getChangePolicy'] });
  const freeze = useMutation('setChangeFreeze', { invalidates: ['getChangePolicy'] });
  const end = useMutation('endChangeFreeze', { invalidates: ['getChangePolicy'] });
  const except = useMutation('approveFreezeException', { invalidates: ['getChangePolicy'] });
  const [form, setForm] = useState<{ timeZone: string; windows: { day: number; start: string; end: string }[]; authority: string } | undefined>();
  const [freezing, setFreezing] = useState(false);
  const [freezeForm, setFreezeForm] = useState({ startsAt: '', endsAt: '', reason: '' });
  const [exception, setException] = useState<{ freezeId: string; releaseId: string; statement: string } | undefined>();
  const p = read.data;
  const f = form ?? (p === undefined ? undefined : { timeZone: p.timeZone, windows: p.windows, authority: p.changeAuthorityMembershipId ?? '' });
  const error = end.error ?? except.error;
  return (
    <Page title="Change policy and freezes" description="When a release may reach your dedicated cell, who may allow one in a freeze, and the freezes themselves." crumbs={crumbs} width="full"
      actions={<Button variant="primary" icon="plus" blocked={freeze.blocked} onClick={() => setFreezing(true)}>Freeze changes</Button>}>
      <QueryView query={read} what="The change policy">
        {(c) => (
          <div className={styles.stack}>
            {!c.applies ? <Banner tone="info" title="Releases arrive as Silo ships them">A change policy applies to a dedicated cell; your organisation is on a shared cell.</Banner> : null}
            {error !== undefined ? <ErrorMessage error={error} /> : null}
            <Section title="Change windows" description="Releases reach the cell only inside these windows, in its time zone.">
              {f !== undefined ? (
                <form className={styles.form} onSubmit={async (e) => {
                  e.preventDefault();
                  const r = await set.run({ body: { timeZone: f.timeZone, windows: f.windows, changeAuthorityMembershipId: f.authority === '' ? null : f.authority } });
                  if (r.ok) {
                    setForm(undefined);
                    say('Saved');
                  }
                }}>
                  <div className={styles.fields}>
                    <SelectField label="Time zone" value={f.timeZone} onChange={(e) => setForm({ ...f, timeZone: e.target.value })}
                      options={(typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [f.timeZone]).map((z) => ({ value: z, label: z.replaceAll('_', ' ') }))} />
                    <SelectField label="Change authority" value={f.authority} placeholder="No one named" onChange={(e) => setForm({ ...f, authority: e.target.value })}
                      options={people.members.filter((m) => m.status === 'active').map((m) => ({ value: m.membershipId, label: m.displayName }))} hint="Who may approve an exception to a freeze." />
                  </div>
                  {f.windows.map((w, i) => (
                    <div key={i} className={styles.rowEnd}>
                      <SelectField label="Day" value={String(w.day)} onChange={(e) => setForm({ ...f, windows: f.windows.map((x, j) => (j === i ? { ...x, day: Number(e.target.value) } : x)) })} options={DAYS.map((d, n) => ({ value: String(n), label: d }))} />
                      <TextField label="From" type="time" value={w.start} onChange={(e) => setForm({ ...f, windows: f.windows.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)) })} />
                      <TextField label="To" type="time" value={w.end} onChange={(e) => setForm({ ...f, windows: f.windows.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)) })} />
                      <IconButton icon="trash" label="Remove the window" onClick={() => setForm({ ...f, windows: f.windows.filter((_, j) => j !== i) })} />
                    </div>
                  ))}
                  <div className={styles.row}><Button size="sm" icon="plus" onClick={() => setForm({ ...f, windows: [...f.windows, { day: 2, start: '22:00', end: '23:59' }] })}>Add a window</Button></div>
                  {set.error !== undefined ? <ErrorMessage error={set.error} /> : null}
                  <FormActions><Button type="submit" variant="primary" pending={set.pending} blocked={set.blocked}>Save</Button></FormActions>
                </form>
              ) : null}
              {c.updatedAt !== null ? <p className={styles.muted}>Last changed <Time value={c.updatedAt} />.</p> : null}
            </Section>
            <Section title="Freezes">
              {c.freezes.length === 0 ? <p className={styles.muted}>No freezes.</p> : (
                <DataTable label="Freezes" rows={c.freezes} rowKey={(x) => x.id} columns={[
                  { id: 'when', header: 'When', primary: true, cell: (x) => <span><Time value={x.startsAt} exact /> to <Time value={x.endsAt} exact /></span> },
                  { id: 'why', header: 'Why', cell: (x) => x.reason },
                  { id: 'by', header: 'Set by', cell: (x) => people.nameOf(x.setBy) },
                  { id: 'state', header: 'State', width: 'sm', cell: (x) => (x.endedAt !== null ? <Badge>Ended</Badge> : Date.parse(x.endsAt) < Date.now() ? <Badge>Over</Badge> : <Badge tone="warn">In force</Badge>) },
                  { id: 'act', header: <span className="visually-hidden">Act</span>, align: 'end', cell: (x) => (x.endedAt !== null ? null : (
                    <span className={styles.row}>
                      <Button size="sm" blocked={except.blocked} onClick={() => setException({ freezeId: x.id, releaseId: '', statement: '' })}>Allow a release</Button>
                      <Button size="sm" variant="ghost" blocked={end.blocked} onClick={() => void end.run({ params: { freezeId: x.id } }).then((r) => r.ok && say('Ended'))}>End it</Button>
                    </span>
                  )) },
                ]} />
              )}
              {c.exceptions.length > 0 ? (
                <Panel>
                  <div className={styles.stackTight}>
                    <strong>Exceptions</strong>
                    {c.exceptions.map((x) => <span key={x.id} className={styles.muted}>Release <span className={styles.mono}>{x.releaseId}</span>: {x.statement} ({people.nameOf(x.approvedBy)}, <Time value={x.approvedAt} />)</span>)}
                  </div>
                </Panel>
              ) : null}
            </Section>
          </div>
        )}
      </QueryView>
      <Dialog open={freezing} onClose={() => setFreezing(false)} title="Freeze changes" size="sm" busy={freeze.pending}>
        <form className={styles.form} onSubmit={async (e) => {
          e.preventDefault();
          const r = await freeze.run({ params: { freezeId: crypto.randomUUID() }, body: { startsAt: new Date(freezeForm.startsAt).toISOString(), endsAt: new Date(freezeForm.endsAt).toISOString(), reason: freezeForm.reason.trim() } });
          if (r.ok) {
            setFreezing(false);
            say('Frozen: no release reaches the cell in that time');
          }
        }}>
          <TextField label="From" type="datetime-local" required value={freezeForm.startsAt} onChange={(e) => setFreezeForm({ ...freezeForm, startsAt: e.target.value })} />
          <TextField label="Until" type="datetime-local" required value={freezeForm.endsAt} onChange={(e) => setFreezeForm({ ...freezeForm, endsAt: e.target.value })} />
          <TextArea label="Why" required rows={2} maxLength={500} value={freezeForm.reason} onChange={(e) => setFreezeForm({ ...freezeForm, reason: e.target.value })} />
          {freeze.error !== undefined ? <ErrorMessage error={freeze.error} /> : null}
          <FormActions><Button onClick={() => setFreezing(false)}>Cancel</Button><Button type="submit" variant="primary" pending={freeze.pending} disabled={freezeForm.startsAt === '' || freezeForm.endsAt === '' || freezeForm.reason.trim() === ''}>Freeze</Button></FormActions>
        </form>
      </Dialog>
      <Dialog open={exception !== undefined} onClose={() => setException(undefined)} title="Allow a release in the freeze" size="sm" busy={except.pending} description="Only the change authority your organisation named may allow one.">
        {exception !== undefined ? (
          <form className={styles.form} onSubmit={async (e) => {
            e.preventDefault();
            const r = await except.run({ body: { freezeId: exception.freezeId, releaseId: exception.releaseId.trim(), statement: exception.statement.trim() } });
            if (r.ok) {
              setException(undefined);
              say('Allowed');
            }
          }}>
            <TextField label="Release" required className={styles.mono} value={exception.releaseId} onChange={(e) => setException({ ...exception, releaseId: e.target.value })} hint="As Silo's release notice names it." />
            <TextArea label="Why it may go ahead" required rows={2} maxLength={1000} value={exception.statement} onChange={(e) => setException({ ...exception, statement: e.target.value })} />
            {except.error !== undefined ? <ErrorMessage error={except.error} /> : null}
            <FormActions><Button onClick={() => setException(undefined)}>Cancel</Button><Button type="submit" variant="primary" pending={except.pending} disabled={exception.releaseId.trim() === '' || exception.statement.trim() === ''}>Allow it</Button></FormActions>
          </form>
        ) : null}
      </Dialog>
    </Page>
  );
}

