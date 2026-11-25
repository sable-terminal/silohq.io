'use client';

// People (spec 55.7, 56.4, 56.8): the organisation's members by name and address, their status
// and scopes; an invitation by email with a role and a scope; suspension silences every grant
// without revoking it, reinstatement restores what was silenced, removal takes the member out and
// hands what they owned to the administrator above them. A member's roles are granted and revoked
// within the administrator's own subtree. Seats: who holds one, the pools allocated to scopes, and
// more bought.

import { useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge, type Tone } from '../../components/badge.component.tsx';
import { Button, IconButton } from '../../components/button.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { FormActions, SelectField, TextField } from '../../components/field.component.tsx';
import { Menu } from '../../components/menu.component.tsx';
import { Page, Panel, Properties, Section } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { type TabDef, TabPanel, Tabs, useTab } from '../../components/tabs.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { formatNumber, humanise, plural } from '../../utils/format.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import { idFrom } from '../studio/kit.view.tsx';
import styles from './settings.view.module.css';

type Member = Output<'listMembers'>['members'][number];
const crumbs = [{ label: 'Settings', href: '/settings/' }];
const STATUS: Record<Member['status'], { label: string; tone: Tone }> = {
  active: { label: 'Active', tone: 'ok' }, invited: { label: 'Invited', tone: 'info' }, suspended: { label: 'Suspended', tone: 'warn' }, removed: { label: 'Removed', tone: 'neutral' },
};
const WHO: TabDef<'current' | 'removed'>[] = [{ id: 'current', label: 'Current' }, { id: 'removed', label: 'Removed' }];

/** /settings/people/: members and invitations; a member's roles in a drawer (?member=). */
export function Members() {
  const say = useToast();
  const [params, set] = useParams();
  const [who, setWho] = useTab(WHO, 'who');
  const members = useQuery('listMembers', { query: {} });
  const scopes = useQuery('listScopes', { query: {} });
  const roles = useQuery('listRoles', {});
  const suspend = useMutation('suspendMember', { invalidates: ['listMembers', 'readDirectory'] });
  const reinstate = useMutation('reinstateMember', { invalidates: ['listMembers', 'readDirectory'] });
  const remove = useMutation('removeMember', { invalidates: ['listMembers', 'readDirectory'] });
  const invite = useMutation('createInvitation', { invalidates: ['listMembers'] });
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('');
  const [scopeId, setScopeId] = useState('');
  const [removing, setRemoving] = useState<Member | undefined>();
  const scopeName = (id: string) => scopes.data?.scopes.find((s) => s.id === id)?.name ?? 'a scope';
  const open = idFrom(params.get('member'));
  const error = suspend.error ?? reinstate.error;
  return (
    <Page title="Members and invitations" description="Who is in your organisation, what they may do and where." crumbs={crumbs} width="full">
      <div className={styles.stack}>
        <Section title="Invite someone">
          <form className={styles.rowEnd} aria-label="Invite" onSubmit={async (e) => {
            e.preventDefault();
            const r = await invite.run({ body: { email: email.trim(), roleId, ...(scopeId === '' ? {} : { scopeId }) } });
            if (r.ok) {
              say(`Invitation sent to ${email.trim()}.`);
              setEmail('');
            }
          }}>
            <TextField label="Invite by email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            <SelectField label="As" required value={roleId} placeholder="Choose a role" onChange={(e) => setRoleId(e.target.value)}
              options={(roles.data?.roles ?? []).filter((r) => r.retiredAt === null).map((r) => ({ value: r.id, label: r.name }))} />
            <SelectField label="In" value={scopeId} onChange={(e) => setScopeId(e.target.value)}
              options={[{ value: '', label: 'The whole organisation' }, ...(scopes.data?.scopes ?? []).filter((s) => s.archivedAt === null).map((s) => ({ value: s.id, label: s.name }))]} />
            <Button type="submit" variant="primary" pending={invite.pending} blocked={invite.blocked} disabled={email.trim() === '' || roleId === ''}>Invite</Button>
          </form>
          {invite.error !== undefined ? <ErrorMessage error={invite.error} /> : null}
        </Section>
        <Tabs label="Which members" tabs={WHO} current={who} onChange={setWho} />
        <TabPanel id={who}>
          {error !== undefined ? <ErrorMessage error={error} /> : null}
          <QueryView query={members} what="Members">
            {(d) => (
              <DataTable label="Members" rows={d.members.filter((m) => (who === 'removed') === (m.status === 'removed'))} rowKey={(m) => m.membershipId}
                rowHref={(m) => hrefWith('/settings/people/', { who: who === 'current' ? undefined : who, member: m.membershipId })} columns={[
                  { id: 'name', header: 'Name', primary: true, sortValue: (m) => m.displayName, cell: (m) => m.displayName },
                  { id: 'email', header: 'Email', cell: (m) => m.email },
                  { id: 'status', header: 'Status', width: 'sm', cell: (m) => <Badge tone={STATUS[m.status].tone}>{STATUS[m.status].label}</Badge> },
                  { id: 'scopes', header: 'Scopes', cell: (m) => m.scopeIds.map(scopeName).join(', ') || '—' },
                  { id: 'joined', header: 'Joined', width: 'sm', cell: (m) => (m.joinedAt === null ? '—' : <Time value={m.joinedAt} />) },
                  { id: 'act', header: <span className="visually-hidden">Act</span>, align: 'end', cell: (m) => (
                    <span className={styles.row}>
                      {m.status === 'active' ? <Button size="sm" blocked={suspend.blocked} onClick={() => void suspend.run({ params: { membershipId: m.membershipId } }).then((r) => r.ok && say(`${m.displayName} suspended: their grants are silenced, not revoked; ${plural(r.data.sessionsRevoked, 'session')} ended.`))}>Suspend</Button> : null}
                      {m.status === 'suspended' ? <Button size="sm" blocked={reinstate.blocked} onClick={() => void reinstate.run({ params: { membershipId: m.membershipId } }).then((r) => r.ok && say(`${m.displayName} reinstated.`))}>Reinstate</Button> : null}
                      {m.status !== 'removed' ? (
                        <Menu label={m.displayName} items={[
                          { label: 'Roles and scopes', icon: 'key', onSelect: () => set({ member: m.membershipId }) },
                          { label: 'Remove from the organisation', icon: 'trash', tone: 'danger', blocked: remove.blocked, onSelect: () => setRemoving(m) },
                        ]} renderTrigger={(p) => <IconButton {...p} size="sm" label={`${m.displayName} actions`} icon="more" />} />
                      ) : null}
                    </span>
                  ) },
                ]} />
            )}
          </QueryView>
        </TabPanel>
      </div>
      {open !== undefined ? <MemberDrawer membershipId={open} member={members.data?.members.find((m) => m.membershipId === open)} onClose={() => set({ member: undefined })} /> : null}
      <ConfirmDialog open={removing !== undefined} onClose={() => setRemoving(undefined)} title={`Remove ${removing?.displayName ?? 'them'}?`} confirmLabel="Remove" tone="danger"
        onConfirm={() => remove.run({ params: { membershipId: removing!.membershipId } }).then((r) => {
          if (r.ok) say(`${removing!.displayName} removed. What they owned has gone to the administrator above them.`);
          return r;
        })}><p>Their access ends at once. What they owned goes to the administrator above them, who decides what happens to it.</p></ConfirmDialog>
    </Page>
  );
}

function MemberDrawer({ membershipId, member, onClose }: { membershipId: string; member: Member | undefined; onClose: () => void }) {
  const say = useToast();
  const assignments = useQuery('listRoleAssignments', { query: { membershipId } });
  const roles = useQuery('listRoles', {});
  const scopes = useQuery('listScopes', { query: {} });
  const grant = useMutation('grantRole', { invalidates: ['listRoleAssignments'] });
  const revoke = useMutation('revokeRole', { invalidates: ['listRoleAssignments'] });
  const [roleId, setRoleId] = useState('');
  const [scopeId, setScopeId] = useState('');
  const [expires, setExpires] = useState('');
  const roleName = (id: string) => roles.data?.roles.find((r) => r.id === id)?.name ?? 'a role';
  const where = (a: Output<'listRoleAssignments'>['assignments'][number]) => (a.onScopeId !== null ? `in ${scopes.data?.scopes.find((s) => s.id === a.onScopeId)?.name ?? 'a scope'}`
    : a.onConnectionId !== null ? 'on a connection' : a.onSiloId !== null ? 'on a Silo' : a.onAppId !== null ? 'on an app' : a.onViewId !== null ? 'on a saved view' : a.onObjectTypeId !== null ? 'on a type' : 'everywhere');
  return (
    <Dialog open onClose={onClose} drawer title={member?.displayName ?? 'Member'} description={member?.email}>
      <div className={styles.stack}>
        <QueryView query={assignments} what="Their roles" isEmpty={(d) => d.assignments.filter((a) => a.revokedAt === null).length === 0} empty={<p className={styles.muted}>No roles.</p>}>
          {(d) => (
            <DataTable label="Their roles" rows={d.assignments.filter((a) => a.revokedAt === null)} rowKey={(a) => a.id} columns={[
              { id: 'role', header: 'Role', primary: true, cell: (a) => roleName(a.roleId) },
              { id: 'where', header: 'Where', cell: (a) => where(a) },
              { id: 'state', header: 'State', width: 'sm', cell: (a) => (a.silencedAt !== null ? <Badge tone="warn">Silenced</Badge> : a.expiresAt !== null ? <span>Until <Time value={a.expiresAt} /></span> : <Badge tone="ok">Held</Badge>) },
              { id: 'act', header: <span className="visually-hidden">Revoke</span>, align: 'end', cell: (a) => <Button size="sm" variant="ghost" blocked={revoke.blocked} onClick={() => void revoke.run({ params: { assignmentId: a.id } }).then((r) => r.ok && say('Revoked'))}>Revoke</Button> },
            ]} />
          )}
        </QueryView>
        <form className={styles.form} aria-label="Grant a role" onSubmit={async (e) => {
          e.preventDefault();
          const r = await grant.run({ body: { membershipId, roleId, ...(scopeId === '' ? {} : { scopeId }), ...(expires === '' ? {} : { expiresAt: new Date(expires).toISOString() }) } });
          if (r.ok) {
            setRoleId('');
            say('Granted');
          }
        }}>
          <div className={styles.fields}>
            <SelectField label="Grant" value={roleId} placeholder="Choose a role" onChange={(e) => setRoleId(e.target.value)} options={(roles.data?.roles ?? []).filter((r) => r.retiredAt === null).map((r) => ({ value: r.id, label: r.name }))} />
            <SelectField label="Where" value={scopeId} onChange={(e) => setScopeId(e.target.value)} options={[{ value: '', label: 'Everywhere' }, ...(scopes.data?.scopes ?? []).filter((s) => s.archivedAt === null).map((s) => ({ value: s.id, label: s.name }))]} />
            <TextField label="Until (optional)" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
          </div>
          {grant.error !== undefined ? <ErrorMessage error={grant.error} /> : null}
          {revoke.error !== undefined ? <ErrorMessage error={revoke.error} /> : null}
          <FormActions><Button type="submit" pending={grant.pending} blocked={grant.blocked} disabled={roleId === ''}>Grant</Button></FormActions>
        </form>
      </div>
    </Dialog>
  );
}

/** /settings/seats/: who holds a seat, the pools allocated to scopes, and more seats bought. */
export function Seats() {
  const say = useToast();
  const seats = useQuery('listSeats', {});
  const members = useQuery('listMembers', { query: {} });
  const scopes = useQuery('listScopes', { query: {} });
  const assign = useMutation('assignSeat', { invalidates: ['listSeats'] });
  const unassign = useMutation('unassignSeat', { invalidates: ['listSeats'] });
  const release = useMutation('releaseSeat', { invalidates: ['listSeats'] });
  const allocate = useMutation('allocateSeatPool', { invalidates: ['listSeats'] });
  const buy = useMutation('buySeats', { invalidates: ['listSeats', 'readBilling'] });
  const [dialog, setDialog] = useState<'assign' | 'pool' | 'buy' | undefined>();
  const [membershipId, setMembershipId] = useState('');
  const [scopeId, setScopeId] = useState('');
  const [tier, setTier] = useState<'standard' | 'business' | 'enterprise'>('standard');
  const [count, setCount] = useState('1');
  const name = (id: string | null) => (id === null ? '—' : members.data?.members.find((m) => m.membershipId === id)?.displayName ?? 'A member');
  const scopeName = (id: string | null) => (id === null ? '—' : scopes.data?.scopes.find((s) => s.id === id)?.name ?? 'a scope');
  const holders = new Set((seats.data?.seats ?? []).filter((s) => s.status === 'assigned').map((s) => s.membershipId));
  const error = assign.error ?? unassign.error ?? release.error ?? allocate.error ?? buy.error;
  return (
    <Page title="Seats" description="Who holds a seat, the pools you allocate to scopes, and more seats when you need them." crumbs={crumbs} width="full"
      actions={
        <div className={styles.row}>
          <Button onClick={() => setDialog('buy')}>Buy seats</Button>
          <Button onClick={() => setDialog('pool')}>Allocate a pool</Button>
          <Button variant="primary" icon="plus" onClick={() => setDialog('assign')}>Assign a seat</Button>
        </div>
      }>
      <QueryView query={seats} what="Seats">
        {(d) => (
          <div className={styles.stack}>
            <Panel>
              <Properties columns={3} items={[['Assigned', formatNumber(d.counts.assigned)], ['Free', formatNumber(d.counts.unassigned)], ['Reclaimed', formatNumber(d.counts.reclaimed)]]} />
            </Panel>
            {error !== undefined ? <ErrorMessage error={error} /> : null}
            {d.pools.length > 0 ? (
              <Section title="Pools">
                <DataTable label="Seat pools" rows={d.pools} rowKey={(p) => `${p.scopeId}:${p.planTier}`} columns={[
                  { id: 'scope', header: 'Scope', primary: true, cell: (p) => scopeName(p.scopeId) },
                  { id: 'tier', header: 'Plan', width: 'sm', cell: (p) => humanise(p.planTier) },
                  { id: 'allocated', header: 'Allocated', align: 'end', cell: (p) => formatNumber(p.seatsAllocated) },
                  { id: 'available', header: 'Free', align: 'end', cell: (p) => formatNumber(p.available) },
                ]} />
              </Section>
            ) : null}
            <Section title="Seats">
              {d.seats.length === 0 ? <EmptyState icon="user" title="No seats yet">Buy seats to assign them.</EmptyState> : (
                <DataTable label="Seats" rows={d.seats.filter((s) => s.status !== 'released')} rowKey={(s) => s.id} columns={[
                  { id: 'who', header: 'Held by', primary: true, cell: (s) => (s.status === 'assigned' ? name(s.membershipId) : <span className={styles.muted}>No one</span>) },
                  { id: 'tier', header: 'Plan', width: 'sm', cell: (s) => humanise(s.planTier) },
                  { id: 'pool', header: 'Pool', cell: (s) => scopeName(s.allocatedScopeId) },
                  { id: 'state', header: 'State', width: 'sm', cell: (s) => <Badge tone={s.status === 'assigned' ? 'ok' : s.status === 'reclaimed' ? 'warn' : 'neutral'}>{humanise(s.status)}</Badge> },
                  { id: 'act', header: <span className="visually-hidden">Act</span>, align: 'end', cell: (s) => (
                    <Menu label="Seat" items={[
                      { label: 'Take it back', icon: 'undo', disabled: s.status !== 'assigned', blocked: unassign.blocked, onSelect: () => void unassign.run({ params: { seatId: s.id } }).then((r) => r.ok && say('Taken back: it is free')) },
                      { label: 'Release it from the plan', icon: 'trash', tone: 'danger', disabled: s.status === 'assigned', blocked: release.blocked, onSelect: () => void release.run({ params: { seatId: s.id } }).then((r) => r.ok && say('Released: it is no longer billed from the next period')) },
                    ]} renderTrigger={(p) => <IconButton {...p} size="sm" label="Seat actions" icon="more" />} />
                  ) },
                ]} />
              )}
            </Section>
          </div>
        )}
      </QueryView>
      <Dialog open={dialog === 'assign'} onClose={() => setDialog(undefined)} title="Assign a seat" size="sm" busy={assign.pending}>
        <form className={styles.form} onSubmit={async (e) => {
          e.preventDefault();
          const r = await assign.run({ body: { membershipId, planTier: tier, ...(scopeId === '' ? {} : { scopeId }) } });
          if (r.ok) {
            setDialog(undefined);
            say(`Assigned${r.data.allowanceGranted ? ', with their model allowance' : ''}`);
          }
        }}>
          <SelectField label="To" required value={membershipId} placeholder="Choose a member" onChange={(e) => setMembershipId(e.target.value)}
            options={(members.data?.members ?? []).filter((m) => m.status === 'active' && !holders.has(m.membershipId)).map((m) => ({ value: m.membershipId, label: m.displayName }))} />
          <SelectField label="Plan" value={tier} onChange={(e) => setTier(e.target.value as typeof tier)} options={[{ value: 'standard', label: 'Standard' }, { value: 'business', label: 'Business' }, { value: 'enterprise', label: 'Enterprise' }]} />
          <SelectField label="From the pool of" value={scopeId} onChange={(e) => setScopeId(e.target.value)} options={[{ value: '', label: 'The organisation' }, ...(scopes.data?.scopes ?? []).map((s) => ({ value: s.id, label: s.name }))]} />
          {assign.error !== undefined ? <ErrorMessage error={assign.error} /> : null}
          <FormActions><Button onClick={() => setDialog(undefined)}>Cancel</Button><Button type="submit" variant="primary" pending={assign.pending} disabled={membershipId === ''}>Assign</Button></FormActions>
        </form>
      </Dialog>
      <Dialog open={dialog === 'pool'} onClose={() => setDialog(undefined)} title="Allocate a pool" size="sm" busy={allocate.pending} description="Seats a scope's administrators assign themselves.">
        <form className={styles.form} onSubmit={async (e) => {
          e.preventDefault();
          const r = await allocate.run({ body: { scopeId, planTier: tier, seats: Math.max(0, Number(count) || 0) } });
          if (r.ok) {
            setDialog(undefined);
            say(`${plural(r.data.seatsAllocated, 'seat')} allocated`);
          }
        }}>
          <SelectField label="Scope" required value={scopeId} placeholder="Choose a scope" onChange={(e) => setScopeId(e.target.value)} options={(scopes.data?.scopes ?? []).map((s) => ({ value: s.id, label: s.name }))} />
          <SelectField label="Plan" value={tier} onChange={(e) => setTier(e.target.value as typeof tier)} options={[{ value: 'standard', label: 'Standard' }, { value: 'business', label: 'Business' }, { value: 'enterprise', label: 'Enterprise' }]} />
          <TextField label="Seats" type="number" min={0} value={count} onChange={(e) => setCount(e.target.value)} />
          {allocate.error !== undefined ? <ErrorMessage error={allocate.error} /> : null}
          <FormActions><Button onClick={() => setDialog(undefined)}>Cancel</Button><Button type="submit" variant="primary" pending={allocate.pending} disabled={scopeId === ''}>Allocate</Button></FormActions>
        </form>
      </Dialog>
      <Dialog open={dialog === 'buy'} onClose={() => setDialog(undefined)} title="Buy seats" size="sm" busy={buy.pending} description="Added to your plan now and billed pro rata.">
        <form className={styles.form} onSubmit={async (e) => {
          e.preventDefault();
          const r = await buy.run({ body: { seats: Math.max(1, Number(count) || 1) } });
          if (r.ok) {
            setDialog(undefined);
            say(`${plural(r.data.added, 'seat')} added: ${formatNumber(r.data.seatCount)} in all`);
          }
        }}>
          <TextField label="Seats to add" type="number" min={1} value={count} onChange={(e) => setCount(e.target.value)} />
          {buy.error !== undefined ? <ErrorMessage error={buy.error} /> : null}
          <FormActions><Button onClick={() => setDialog(undefined)}>Cancel</Button><Button type="submit" variant="primary" pending={buy.pending} blocked={buy.blocked}>Buy</Button></FormActions>
        </form>
      </Dialog>
    </Page>
  );
}
