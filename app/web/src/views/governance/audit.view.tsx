'use client';

// The audit log (spec 59): every governed event in the organisation, who or what did it, to
// what, and when, on a hash chain no one can rewrite: filtered by time, event, person and
// resource and read a page at a time; sign-ins and second factors; every time a secret was
// opened, by which service and why; and the chain's integrity: verified from any point, its
// daily heads and the seals on partitions that have been dropped.

import { useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge, Status } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { Dialog } from '../../components/dialog.component.tsx';
import { SelectField, TextField } from '../../components/field.component.tsx';
import { Page, Panel, Properties, Section, Toolbar } from '../../components/page.component.tsx';
import { PagesView, QueryView } from '../../components/query.component.tsx';
import { EmptyState } from '../../components/states.component.tsx';
import { TabPanel, Tabs, useTab, type TabDef } from '../../components/tabs.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { usePages, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { formatNumber, humanise } from '../../utils/format.util.ts';
import styles from './governance.view.module.css';

type AuditEvent = Output<'listAuditEvents'>['events'][number];

const dayStart = (d: string) => (d === '' ? undefined : new Date(`${d}T00:00:00`).toISOString());
const dayEnd = (d: string) => (d === '' ? undefined : new Date(`${d}T23:59:59.999`).toISOString());

function EventDetail({ event, onClose }: { event: AuditEvent; onClose: () => void }) {
  const people = useDirectory();
  return (
    <Dialog open onClose={onClose} drawer title={humanise(event.event)} description={<Time value={event.occurredAt} exact />}>
      <div className={styles.stack}>
        <Properties columns={1} items={[
          ['By', event.membershipId !== null ? people.nameOf(event.membershipId) : event.servicePrincipalId !== null ? 'A service principal' : event.operatorId !== null ? 'Silo staff, under an access session' : event.systemService ?? 'Silo'],
          event.subjectMembershipId !== null ? ['About', people.nameOf(event.subjectMembershipId)] : null,
          event.resourceType !== null ? ['On', <span key="r" className={styles.mono}>{event.resourceType} {event.resourceId ?? ''}</span>] : null,
          event.scopeId !== null ? ['Scope', people.scopeName(event.scopeId)] : null,
          event.purposeSessionId !== null ? ['Purpose session', <span key="p" className={styles.mono}>{event.purposeSessionId}</span>] : null,
          ['Reference', <span key="c" className={styles.mono}>{event.correlationId}</span>],
          ['Chain position', <span key="s" className={styles.mono}>{event.chainSeq}</span>],
          ['Recorded', <Time key="t" value={event.recordedAt} exact />],
        ]} />
        <Section title="Detail"><pre className={styles.code}>{JSON.stringify(event.detail, null, 2)}</pre></Section>
        <p className={styles.muted}>Its hash <span className={styles.mono}>{event.rowHash.slice(0, 24)}…</span> follows <span className={styles.mono}>{event.prevHash.slice(0, 24)}…</span>.</p>
      </div>
    </Dialog>
  );
}

function Events() {
  const people = useDirectory();
  const [params, set] = useParams();
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const event = params.get('event') ?? '';
  const member = params.get('member') ?? '';
  const resource = params.get('resource') ?? '';
  const [open, setOpen] = useState<AuditEvent | undefined>(undefined);
  const pages = usePages('listAuditEvents', (cursor) => ({ query: {
    limit: 100, ...(cursor !== undefined ? { cursor } : {}), ...(dayStart(from) !== undefined ? { from: dayStart(from)! } : {}), ...(dayEnd(to) !== undefined ? { to: dayEnd(to)! } : {}),
    ...(event !== '' ? { event } : {}), ...(member !== '' ? { membershipId: member } : {}), ...(resource !== '' ? { resourceId: resource } : {}),
  } }), (p) => p.nextCursor, [from, to, event, member, resource]);
  return (
    <Section title="Events">
      <Toolbar>
        <TextField label="From" type="date" value={from} onChange={(e) => set({ from: e.target.value })} />
        <TextField label="To" type="date" value={to} onChange={(e) => set({ to: e.target.value })} />
        <TextField label="Event" value={event} onChange={(e) => set({ event: e.target.value.trim() })} placeholder="mutation_executed" spellCheck={false} />
        <SelectField label="Person" value={member} onChange={(e) => set({ member: e.target.value })} placeholder="Anyone"
          options={people.members.map((m) => ({ value: m.membershipId, label: m.displayName }))} />
        <TextField label="Resource id" value={resource} onChange={(e) => set({ resource: e.target.value.trim() })} spellCheck={false} />
      </Toolbar>
      <PagesView pages={pages} what="Events" isEmpty={(p) => p.every((x) => x.events.length === 0)} empty={<EmptyState icon="document" title="No event matches" />}>
        {(p) => (
          <DataTable label="Audit events" rows={p.flatMap((x) => x.events)} rowKey={(e) => e.id} dense columns={[
            { id: 'when', header: 'When', primary: true, cell: (e) => <Button variant="link" size="sm" onClick={() => setOpen(e)}><Time value={e.occurredAt} exact /></Button> },
            { id: 'event', header: 'Event', cell: (e) => humanise(e.event) },
            { id: 'who', header: 'By', width: 'md', cell: (e) => (e.membershipId !== null ? people.nameOf(e.membershipId) : e.operatorId !== null ? 'Silo staff' : e.servicePrincipalId !== null ? 'Service principal' : e.systemService ?? 'Silo') },
            { id: 'on', header: 'On', width: 'md', cell: (e) => (e.resourceType === null ? '—' : <span className={styles.mono}>{e.resourceType}</span>) },
          ]} />
        )}
      </PagesView>
      {open !== undefined ? <EventDetail event={open} onClose={() => setOpen(undefined)} /> : null}
    </Section>
  );
}

function SignIns() {
  const people = useDirectory();
  const pages = usePages('listAuthEvents', (cursor) => ({ query: { limit: 100, ...(cursor !== undefined ? { cursor } : {}) } }), (p) => p.nextCursor, []);
  return (
    <Section title="Sign-ins" description="Signing in, second factors, single sign-on and sessions ending.">
      <PagesView pages={pages} what="Sign-in events" isEmpty={(p) => p.every((x) => x.events.length === 0)} empty={<p className={styles.muted}>None.</p>}>
        {(p) => (
          <DataTable label="Sign-in events" rows={p.flatMap((x) => x.events)} rowKey={(e) => e.id} dense columns={[
            { id: 'when', header: 'When', primary: true, cell: (e) => <Time value={e.occurredAt} exact /> },
            { id: 'event', header: 'Event', cell: (e) => humanise(e.event) },
            { id: 'who', header: 'Who', width: 'md', cell: (e) => (e.membershipId !== null ? people.nameOf(e.membershipId) : e.servicePrincipalId !== null ? 'Service principal' : '—') },
            { id: 'detail', header: 'Detail', cell: (e) => <span className={styles.mono}>{JSON.stringify(e.detail).slice(0, 80)}</span> },
          ]} />
        )}
      </PagesView>
    </Section>
  );
}

function Unwraps() {
  const people = useDirectory();
  const [params, set] = useParams();
  const reason = params.get('reason') ?? '';
  const pages = usePages('listCredentialUnwraps', (cursor) => ({ query: { limit: 100, ...(cursor !== undefined ? { cursor } : {}), ...(reason !== '' ? { reason: reason as never } : {}) } }), (p) => p.nextCursor, [reason]);
  return (
    <Section title="Secrets opened" description="Every time a sealed secret was opened: which, by which service, for whom and why. Never the secret.">
      <Toolbar>
        <SelectField label="Why" hideLabel value={reason} onChange={(e) => set({ reason: e.target.value })} placeholder="Any reason" options={[
          'query', 'mutation', 'probe', 'connect', 'refresh', 'rotation', 'change_stream', 'webhook', 'action_event', 'read_back', 'idp', 'mfa_verify', 'sso_assert',
        ].map((r) => ({ value: r, label: humanise(r) }))} />
      </Toolbar>
      <PagesView pages={pages} what="Secrets opened" isEmpty={(p) => p.every((x) => x.unwraps.length === 0)} empty={<p className={styles.muted}>None.</p>}>
        {(p) => (
          <DataTable label="Secrets opened" rows={p.flatMap((x) => x.unwraps)} rowKey={(u) => u.id} dense columns={[
            { id: 'when', header: 'When', primary: true, cell: (u) => <Time value={u.occurredAt} exact /> },
            { id: 'what', header: 'Secret', width: 'md', cell: (u) => humanise(u.credential.kind) },
            { id: 'why', header: 'Why', width: 'sm', cell: (u) => humanise(u.reason) },
            { id: 'by', header: 'By', width: 'md', cell: (u) => `${u.callingService}${u.membershipId !== null ? `, for ${people.nameOf(u.membershipId)}` : ''}` },
            { id: 'out', header: 'Outcome', width: 'sm', cell: (u) => <Status tone={u.outcome === 'failed' ? 'danger' : 'ok'}>{u.outcome === 'held_by_agent' ? 'held by the agent' : u.outcome}</Status> },
          ]} />
        )}
      </PagesView>
    </Section>
  );
}

function Integrity() {
  const [after, setAfter] = useState('');
  const chain = useQuery('readAuditChain', { query: { limit: 200, ...(after.trim() !== '' ? { afterChainSeq: after.trim() } : {}) } }, { staleMs: 0 });
  const heads = useQuery('listChainHeads', { query: { limit: 30 } });
  const seals = useQuery('listPartitionSeals', { query: { limit: 50 } });
  return (
    <div className={styles.stack}>
      <Section title="Verify the chain" description="Each event's hash includes the one before it; any change, gap or event of another organisation breaks it.">
        <Toolbar end={<Button onClick={() => chain.refetch()}>Verify</Button>}>
          <TextField label="From chain position (optional)" value={after} onChange={(e) => setAfter(e.target.value)} spellCheck={false} />
        </Toolbar>
        <QueryView query={chain} what="The chain">
          {(c) => (c.verification.ok
            ? <Banner tone="ok" title="Intact">{formatNumber(c.verification.count)} events checked from position {c.anchor.chainSeq}; ends at <span className={styles.mono}>{c.verification.lastHash.slice(0, 24)}…</span></Banner>
            : <Banner tone="danger" title="Broken" urgent>At position {c.verification.chainSeq}: {c.verification.reason === 'gap' ? 'an event is missing' : c.verification.reason === 'organisation' ? 'an event of another organisation' : 'a hash does not match'}. Contact Silo support at once.</Banner>)}
        </QueryView>
      </Section>
      <Section title="Daily heads" description="Each day's last hash, closed and published, so the chain can be checked against it later.">
        <QueryView query={heads} what="Daily heads" isEmpty={(h) => h.heads.length === 0} empty={<p className={styles.muted}>None yet.</p>}>
          {(h) => (
            <DataTable label="Daily heads" rows={h.heads} rowKey={(x) => x.id} dense columns={[
              { id: 'day', header: 'Day', primary: true, cell: (x) => x.headDate },
              { id: 'events', header: 'Events', width: 'sm', align: 'end', cell: (x) => formatNumber(Number(x.eventCount)) },
              { id: 'hash', header: 'Head', cell: (x) => <span className={styles.mono}>{x.headHash.slice(0, 32)}</span> },
              { id: 'pub', header: 'Published', width: 'md', cell: (x) => (x.publishedAt === null ? <Badge tone="warn">Not yet</Badge> : <Time value={x.publishedAt} />) },
            ]} />
          )}
        </QueryView>
      </Section>
      <Section title="Sealed partitions" description="Old months of the ledgers, sealed with their running hash before they were dropped under retention.">
        <QueryView query={seals} what="Seals" isEmpty={(s) => s.seals.length === 0} empty={<p className={styles.muted}>Nothing sealed yet.</p>}>
          {(s) => (
            <DataTable label="Sealed partitions" rows={s.seals} rowKey={(x) => x.id} dense columns={[
              { id: 'ledger', header: 'Ledger', primary: true, cell: (x) => x.ledger },
              { id: 'range', header: 'Covers', cell: (x) => `${x.rangeStart.slice(0, 10)} to ${x.rangeEnd.slice(0, 10)}` },
              { id: 'rows', header: 'Rows', width: 'sm', align: 'end', cell: (x) => formatNumber(Number(x.rowCount)) },
              { id: 'state', header: 'State', width: 'md', cell: (x) => (x.droppedAt === null ? <Badge tone="info">Sealed</Badge> : <span>Dropped <Time value={x.droppedAt} /></span>) },
            ]} />
          )}
        </QueryView>
      </Section>
    </div>
  );
}

export function AuditLog() {
  usePageContext({ scope: { kind: 'page', page: 'governance' }, scopeLabel: 'the audit log' });
  const tabs: readonly TabDef<'events' | 'signins' | 'secrets' | 'integrity'>[] = [
    { id: 'events', label: 'Events' }, { id: 'signins', label: 'Sign-ins' }, { id: 'secrets', label: 'Secrets opened' }, { id: 'integrity', label: 'Integrity' },
  ];
  const [tab, setTab] = useTab(tabs);
  return (
    <Page title="Audit log" description="Every governed event, who or what did it and to what, on a hash chain no one can rewrite." crumbs={[{ label: 'Governance' }]}>
      <Tabs label="Audit log" tabs={tabs} current={tab} onChange={setTab} />
      <TabPanel id={tab}>
        {tab === 'events' ? <Events /> : null}
        {tab === 'signins' ? <SignIns /> : null}
        {tab === 'secrets' ? <Unwraps /> : null}
        {tab === 'integrity' ? <Integrity /> : null}
      </TabPanel>
      <Panel><p className={styles.muted}>Values are never in the log: only what happened, to which record, and who.</p></Panel>
    </Page>
  );
}
