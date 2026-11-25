'use client';

// Discovery (spec 19): a Silo Agent finds the systems on your network and reads their structure,
// never a row, and Silo turns what it finds into proposals. Off by default, and switched on only
// in Settings by a super admin; even then each scan needs its own authorisation (one agent,
// explicit targets, the methods allowed, a host bound, an expiry of at most 31 days), decided
// through an approval chain. A finding is a proposal to review: approved, it becomes a private
// connector and a draft connection, and may start an ontology derivation.

import Link from 'next/link';
import { useMemo, useState, type FormEvent } from 'react';
import type { Input, Output } from '../../api/client.api.ts';
import { Badge, Status } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button, LinkButton } from '../../components/button.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { Checkbox, fieldError, FormActions, SelectField, TextArea, TextField } from '../../components/field.component.tsx';
import { Page, Panel, Properties, Section, Toolbar } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage, Loading } from '../../components/states.component.tsx';
import { TabPanel, Tabs, useTab, type TabDef } from '../../components/tabs.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useBlocked, useMutation, usePermit, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { useRefreshWhile } from '../../hooks/refresh.hook.ts';
import { approvalHref, connectionHref } from '../../navigation/links.navigation.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { formatNumber, plural } from '../../utils/format.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import styles from './connect.view.module.css';

type Authorisation = Output<'listScanAuthorisations'>['authorisations'][number];
type Method = Authorisation['methods'][number];
type Run = Output<'getScanRun'>;
type Finding = Output<'listFindings'>['findings'][number];

const METHOD: Record<Method, { label: string; hint: string }> = {
  port_scan: { label: 'Port scan', hint: 'Which well-known ports answer.' },
  host_config: { label: 'Host configuration', hint: 'What the agent\'s own host is configured to reach.' },
  catalogue_introspection: { label: 'Database catalogues', hint: 'Schemas, tables, columns and keys, with a read-only login; never a row.' },
  opcua_browse: { label: 'OPC UA browse', hint: 'A server\'s address space: types, variables and references.' },
  mqtt_observe: { label: 'MQTT observe', hint: 'Topic families and their field shapes, briefly.' },
};

const AUTH_STATE: Record<Authorisation['status'], { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' | 'info' }> = {
  pending: { label: 'Waiting for approval', tone: 'info' },
  approved: { label: 'Approved', tone: 'ok' },
  rejected: { label: 'Rejected', tone: 'danger' },
  expired: { label: 'Expired', tone: 'neutral' },
  revoked: { label: 'Revoked', tone: 'neutral' },
};

const RUN_STATE: Record<Run['status'], { label: string; tone: 'ok' | 'warn' | 'danger' | 'info' | 'neutral' }> = {
  running: { label: 'Running', tone: 'info' }, completed: { label: 'Completed', tone: 'ok' }, failed: { label: 'Stopped', tone: 'danger' }, revoked: { label: 'Revoked', tone: 'neutral' },
};

const PROTOCOL: Record<Finding['found']['protocol'], string> = {
  sql: 'SQL database', rest: 'REST API', soap: 'SOAP service', graphql: 'GraphQL API', odata: 'OData service', sftp: 'SFTP server', opc_ua: 'OPC UA server', mqtt: 'MQTT broker', other: 'Other',
};

const DAY = 86_400_000;
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Agents by name, from the pools the person may see. */
function useAgents() {
  const permit = usePermit('listAgentPools');
  const pools = useQuery('listAgentPools', permit.allowed === true ? {} : null, { staleMs: 60_000 });
  return useMemo(() => {
    const agents = (pools.data?.pools ?? []).flatMap((p) => p.agents.map((a) => ({ ...a, pool: p.name })));
    const names = new Map(agents.map((a) => [a.id, `${a.name} (${a.pool})`]));
    return { agents: agents.filter((a) => a.status !== 'revoked'), nameOf: (id: string) => names.get(id) ?? 'an agent', blocked: permit.blocked?.message };
  }, [pools.data, permit.blocked]);
}

function RequestDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const say = useToast();
  const [, set] = useParams();
  const agents = useAgents();
  const request = useMutation('requestScanAuthorisation', { invalidates: ['listScanAuthorisations'] });
  const [agentId, setAgentId] = useState('');
  const [targets, setTargets] = useState('');
  const [methods, setMethods] = useState<Set<Method>>(new Set(['port_scan']));
  const [maxHosts, setMaxHosts] = useState('256');
  const [until, setUntil] = useState(isoDate(Date.now() + 7 * DAY));
  const ranges = targets.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const body: Input<'requestScanAuthorisation'>['body'] = {
      agentId, ranges, methods: [...methods], maxHosts: Number(maxHosts), expiresAt: new Date(`${until}T23:59:59`).toISOString(),
    };
    const r = await request.run({ body });
    if (r.ok) {
      say('Requested: it runs once the approval chain approves it');
      set({ new: undefined, authorisation: r.data.id });
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Request a scan" size="lg" busy={request.pending}
      description="Say exactly where the agent may look and how. Approvers see this document and quote its hash when they approve it.">
      <form onSubmit={submit} className={styles.form}>
        <SelectField label="Agent" required value={agentId} onChange={(e) => setAgentId(e.target.value)} placeholder={agents.blocked ?? (agents.agents.length === 0 ? 'No agent enrolled' : 'Choose an agent')}
          options={agents.agents.map((a) => ({ value: a.id, label: `${a.name} (${a.pool})${a.status === 'healthy' ? '' : `, ${a.status}`}` }))} error={fieldError(request.error, 'agentId')} />
        <TextArea label="Targets" required rows={4} value={targets} onChange={(e) => setTargets(e.target.value)} spellCheck={false} placeholder={'10.20.0.0/24\nhistorian.plant.local'}
          hint="One per line: an IPv4 address, a range no wider than /16, or a host name. Never a default subnet." error={fieldError(request.error, 'ranges')} />
        <fieldset className={styles.choices}>
          <legend>Methods allowed</legend>
          {(Object.keys(METHOD) as Method[]).map((m) => (
            <Checkbox key={m} label={METHOD[m].label} hint={METHOD[m].hint} checked={methods.has(m)} onChange={() => {
              const next = new Set(methods);
              if (next.has(m)) next.delete(m);
              else next.add(m);
              setMethods(next);
            }} />
          ))}
        </fieldset>
        <div className={styles.split}>
          <TextField label="Most hosts it may contact" type="number" min={1} max={65536} required value={maxHosts} onChange={(e) => setMaxHosts(e.target.value)}
            hint="The run stops when it reaches this." error={fieldError(request.error, 'maxHosts')} />
          <TextField label="Valid until" type="date" required value={until} min={isoDate(Date.now() + DAY)} max={isoDate(Date.now() + 31 * DAY)} onChange={(e) => setUntil(e.target.value)}
            hint="At most 31 days: a window, not standing permission." error={fieldError(request.error, 'expiresAt')} />
        </div>
        {request.error !== undefined && ['agentId', 'ranges', 'maxHosts', 'expiresAt'].every((f) => fieldError(request.error, f) === undefined) ? <ErrorMessage error={request.error} /> : null}
        <FormActions>
          <Button onClick={onClose} disabled={request.pending}>Cancel</Button>
          <Button type="submit" variant="primary" pending={request.pending} blocked={request.blocked} disabled={agentId === '' || ranges.length === 0 || methods.size === 0}>Request</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

function AuthorisationDetail({ authorisation, onClose }: { authorisation: Authorisation; onClose: () => void }) {
  const say = useToast();
  const people = useDirectory();
  const agents = useAgents();
  const [, set] = useParams();
  const runs = useQuery('listScanRuns', { params: { authorisationId: authorisation.id }, query: {} });
  const start = useMutation('startScan', { invalidates: ['listScanRuns'] });
  const revoke = useMutation('revokeScanAuthorisation', { invalidates: ['listScanAuthorisations', 'listScanRuns'] });
  const [revoking, setRevoking] = useState(false);
  useRefreshWhile((runs.data?.runs ?? []).some((r) => r.status === 'running'), runs.refetch, 3000);
  const usable = authorisation.status === 'approved' && Date.parse(authorisation.expiresAt) > Date.now();
  return (
    <Dialog open onClose={onClose} drawer title="Scan authorisation" description={<Badge tone={AUTH_STATE[authorisation.status].tone}>{AUTH_STATE[authorisation.status].label}</Badge>}>
      <div className={styles.stack}>
        <Properties columns={1} items={[
          ['Agent', agents.nameOf(authorisation.agentId)],
          ['Targets', <span key="t" className={styles.mono}>{authorisation.ranges.join(', ')}</span>],
          ['Methods', authorisation.methods.map((m) => METHOD[m].label).join(', ')],
          ['Host bound', formatNumber(authorisation.maxHosts)],
          ['Valid until', <Time key="e" value={authorisation.expiresAt} exact />],
          ['Requested', <span key="b">{people.nameOf(authorisation.authorisedBy)}, <Time value={authorisation.createdAt} /></span>],
          ['Document hash', <span key="h" className={styles.mono}>{authorisation.documentHash}</span>],
        ]} />
        <div className={styles.row}>
          {usable ? <Button variant="primary" icon="play" pending={start.pending} blocked={start.blocked} onClick={async () => {
            const r = await start.run({ params: { authorisationId: authorisation.id } });
            if (r.ok) say('Scan started');
          }}>Start a scan</Button> : null}
          {authorisation.status === 'pending' ? <LinkButton href={approvalHref(authorisation.approvalChainId)}>Open its approval</LinkButton> : null}
          {authorisation.status === 'approved' || authorisation.status === 'pending'
            ? <Button variant="ghost" icon="stop" blocked={revoke.blocked} onClick={() => setRevoking(true)}>Revoke</Button> : null}
        </div>
        {start.error !== undefined ? <ErrorMessage error={start.error} /> : null}
        <Section title="Runs">
          <QueryView query={runs} what="Its runs" isEmpty={(d) => d.runs.length === 0} empty={<p className={styles.muted}>No scan has run under it.</p>}>
            {(d) => (
              <DataTable label="Scan runs" rows={d.runs} rowKey={(r) => r.id} columns={[
                { id: 'started', header: 'Started', primary: true, cell: (r) => <Time value={r.startedAt} exact /> },
                { id: 'state', header: 'State', width: 'sm', cell: (r) => <Status tone={RUN_STATE[r.status].tone}>{RUN_STATE[r.status].label}</Status> },
                { id: 'hosts', header: 'Hosts', width: 'xs', align: 'end', cell: (r) => formatNumber(r.hostsContacted) },
                { id: 'probes', header: 'Probes', width: 'xs', align: 'end', cell: (r) => formatNumber(r.probes) },
                { id: 'found', header: 'Findings', width: 'sm', align: 'end', cell: (r) => (r.findings === 0 ? '0'
                  : <Button size="sm" variant="link" onClick={() => set({ tab: 'findings', run: r.id, authorisation: undefined })}>{formatNumber(r.findings)}</Button>) },
                { id: 'why', header: 'Why it stopped', cell: (r) => <span className={styles.muted}>{r.reasons.map((x) => x.replaceAll('_', ' ')).join('; ')}</span> },
              ]} />
            )}
          </QueryView>
        </Section>
      </div>
      <ConfirmDialog open={revoking} onClose={() => setRevoking(false)} title="Revoke this authorisation?" confirmLabel="Revoke" tone="danger"
        onConfirm={async () => {
          const r = await revoke.run({ params: { authorisationId: authorisation.id } });
          if (r.ok) say('Revoked: scans under it stop within seconds');
          return r;
        }}>
        <p>No new scan may run under it, and one running stops within seconds. What was found stays for review.</p>
      </ConfirmDialog>
    </Dialog>
  );
}

function Authorisations() {
  const [params, set] = useParams();
  const agents = useAgents();
  const list = useQuery('listScanAuthorisations', { query: { limit: 100 } });
  const blocked = useBlocked('requestScanAuthorisation');
  const openId = params.get('authorisation');
  const listed = (list.data?.authorisations ?? []).find((a) => a.id === openId);
  // One past the first hundred, or linked to from an approval, is read on its own.
  const one = useQuery('getScanAuthorisation', openId !== null && list.data !== undefined && listed === undefined ? { params: { authorisationId: openId } } : null);
  const open = listed ?? one.data;
  return (
    <Section title="Scan authorisations" actions={<Button variant="primary" icon="plus" blocked={blocked} onClick={() => set({ new: '1' })}>Request a scan</Button>}>
      <QueryView query={list} what="Authorisations" isEmpty={(d) => d.authorisations.length === 0}
        empty={<EmptyState icon="search" title="No scan requested">Request one: say which agent may look where, and how.</EmptyState>}>
        {(d) => (
          <DataTable label="Scan authorisations" rows={d.authorisations} rowKey={(a) => a.id} rowHref={(a) => hrefWith('/connect/discovery/', { authorisation: a.id })} columns={[
            { id: 'targets', header: 'Targets', primary: true, cell: (a) => <span className={styles.mono}>{a.ranges.slice(0, 3).join(', ')}{a.ranges.length > 3 ? `, and ${a.ranges.length - 3} more` : ''}</span> },
            { id: 'agent', header: 'Agent', width: 'md', cell: (a) => agents.nameOf(a.agentId) },
            { id: 'methods', header: 'Methods', cell: (a) => a.methods.map((m) => METHOD[m].label).join(', ') },
            { id: 'state', header: 'State', width: 'md', sortValue: (a) => a.status, cell: (a) => <Badge tone={AUTH_STATE[a.status].tone}>{AUTH_STATE[a.status].label}</Badge> },
            { id: 'until', header: 'Until', width: 'sm', sortValue: (a) => a.expiresAt, cell: (a) => <Time value={a.expiresAt} /> },
          ]} />
        )}
      </QueryView>
      {params.get('new') !== null ? <RequestDialog open onClose={() => set({ new: undefined })} /> : null}
      {open !== undefined ? <AuthorisationDetail key={open.id} authorisation={open} onClose={() => set({ authorisation: undefined })} /> : null}
    </Section>
  );
}

function FindingDetail({ findingId, onClose }: { findingId: string; onClose: () => void }) {
  const say = useToast();
  const read = useQuery('getFinding', { params: { findingId } });
  const scopes = useQuery('listMyPermittedScopes', { query: { permission: 'connection.create' } });
  const review = useMutation('reviewFinding', { invalidates: ['listFindings'] });
  const [scopeId, setScopeId] = useState('');
  const [name, setName] = useState('');
  const [derive, setDerive] = useState(true);
  const [rejecting, setRejecting] = useState(false);
  const f = read.data;
  if (f === undefined) {
    return <Dialog open onClose={onClose} drawer title="Finding">{read.status === 'error' ? <ErrorMessage error={read.error} onRetry={read.refetch} /> : <Loading label="Reading the finding" />}</Dialog>;
  }
  const tables = f.found.schemas.reduce((n, s) => n + s.tables.length, 0);
  const promotable = f.proposedConnectorType !== null;
  const approve = async (event: FormEvent) => {
    event.preventDefault();
    const r = await review.run({ params: { findingId }, body: { decision: 'approve', ...(promotable && scopeId !== '' ? { promote: { owningScopeId: scopeId, proposeOntology: derive, ...(name.trim() !== '' ? { name: name.trim() } : {}) } } : {}) } });
    if (r.ok) say(r.data.promotedConnectionId !== null ? 'Approved: a draft connection was made from it' : 'Approved');
  };
  return (
    <Dialog open onClose={onClose} drawer title={`${f.found.product ?? PROTOCOL[f.found.protocol]} on ${f.host}`} busy={review.pending}
      description={<>{PROTOCOL[f.found.protocol]}{f.found.version !== null ? `, version ${f.found.version}` : ''}{f.found.port !== null ? `, port ${f.found.port}` : ''}</>}>
      <div className={styles.stack}>
        <Properties items={[
          ['Decision', f.reviewDecision === 'pending' ? 'Waiting for review' : f.reviewDecision === 'approved' ? 'Approved' : 'Rejected'],
          ['Suggested connector', f.proposedConnectorType ?? 'None: no catalogue fits'],
          ['Confidence', f.confidence === null ? '—' : `${Math.round(f.confidence * 100)}%`],
          ['Structure', [
            tables > 0 ? plural(tables, 'table') : '', f.found.opcua !== undefined ? plural(f.found.opcua.types.length, 'OPC UA type') : '',
            f.found.mqtt !== undefined ? plural(f.found.mqtt.families.length, 'topic family', 'topic families') : '', f.found.topics.length > 0 ? plural(f.found.topics.length, 'topic') : '',
          ].filter(Boolean).join(', ') || 'Its ports only'],
          f.promotedConnectionId !== null ? ['Connection', <Link key="c" href={connectionHref(f.promotedConnectionId)}>Open the draft connection</Link>] : null,
        ]} />
        {f.proposedObjectTypes.length > 0 ? (
          <Section title="Object types it suggests">
            <DataTable label="Suggested object types" rows={f.proposedObjectTypes} rowKey={(o) => o.sourceObject} dense columns={[
              { id: 'source', header: 'From', primary: true, cell: (o) => <span className={styles.mono}>{o.sourceObject}</span> },
              { id: 'type', header: 'As', width: 'md', cell: (o) => o.apiName },
              { id: 'id', header: 'Identified by', width: 'md', cell: (o) => o.identifier.join(', ') },
              { id: 'fields', header: 'Fields', width: 'xs', align: 'end', cell: (o) => String(o.fields) },
              { id: 'match', header: 'Already in your ontology', cell: (o) => (o.matches === null ? '—' : `${o.matches.apiName} (${Math.round(o.matches.score * 100)}%)`) },
            ]} />
          </Section>
        ) : null}
        {f.proposedLinks.length > 0 ? (
          <Section title="Links it suggests">
            <ul className={styles.plainList}>{f.proposedLinks.map((l, i) => (
              <li key={i}><span className={styles.mono}>{l.from}</span> to <span className={styles.mono}>{l.to}</span>, {l.cardinality.replace('_', ' ').replaceAll('_', ' ')}
                <span className={styles.muted}> ({l.origin === 'declared' ? 'a declared key' : `inferred, ${Math.round(l.confidence * 100)}%`})</span></li>
            ))}</ul>
          </Section>
        ) : null}
        {f.reviewDecision === 'pending' ? (
          <Panel>
            <form onSubmit={approve} className={styles.form}>
              {promotable ? (
                <>
                  <p className={styles.muted}>Approving it can make a private connector and a draft connection from it. Credentials are given on the connection afterwards.</p>
                  <SelectField label="Connection owned by" value={scopeId} onChange={(e) => setScopeId(e.target.value)} placeholder="Approve without making a connection"
                    options={(scopes.data?.scopes ?? []).map((s) => ({ value: s.id, label: s.name }))} />
                  {scopeId !== '' ? (
                    <>
                      <TextField label="Connection name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
                      <Checkbox label="Propose object types and links from it" checked={derive} onChange={() => setDerive(!derive)} hint="Starts a derivation you confirm in Ontology." />
                    </>
                  ) : null}
                </>
              ) : null}
              {review.error !== undefined ? <ErrorMessage error={review.error} /> : null}
              <FormActions>
                <Button variant="ghost" blocked={review.blocked} onClick={() => setRejecting(true)}>Reject</Button>
                <Button type="submit" variant="primary" pending={review.pending} blocked={review.blocked}>Approve</Button>
              </FormActions>
            </form>
          </Panel>
        ) : null}
      </div>
      <ConfirmDialog open={rejecting} onClose={() => setRejecting(false)} title="Reject this finding?" confirmLabel="Reject" tone="danger"
        onConfirm={async () => {
          const r = await review.run({ params: { findingId }, body: { decision: 'reject' } });
          if (r.ok) say('Rejected');
          return r;
        }}>
        <p>Nothing is made from it. It stays in the record of what the scan found.</p>
      </ConfirmDialog>
    </Dialog>
  );
}

function Findings() {
  const [params, set] = useParams();
  const decision = params.get('decision') ?? 'pending';
  const runId = params.get('run') ?? undefined;
  const list = useQuery('listFindings', { query: { limit: 200, ...(decision === 'all' ? {} : { decision: decision as 'pending' | 'approved' | 'rejected' }), ...(runId !== undefined ? { runId } : {}) } });
  const findingId = params.get('finding');
  const run = useQuery('getScanRun', runId === undefined ? null : { params: { runId } });
  useRefreshWhile(run.data?.status === 'running', run.refetch, 3000);
  return (
    <Section title="Findings" description="What scans found: structure only, never a row. Each is a proposal to review.">
      <Toolbar end={runId !== undefined ? <Button size="sm" variant="ghost" onClick={() => set({ run: undefined })}>Show every run</Button> : undefined}>
        <SelectField label="Decision" hideLabel value={decision} onChange={(e) => set({ decision: e.target.value === 'pending' ? undefined : e.target.value })}
          options={[{ value: 'pending', label: 'Waiting for review' }, { value: 'approved', label: 'Approved' }, { value: 'rejected', label: 'Rejected' }, { value: 'all', label: 'All' }]} />
      </Toolbar>
      {run.data !== undefined ? (
        <Panel>
          <span className={styles.row}>
            Findings of the scan started <Time value={run.data.startedAt} exact />:
            <Status tone={RUN_STATE[run.data.status].tone}>{RUN_STATE[run.data.status].label}</Status>
            <span className={styles.muted}>{plural(run.data.hostsContacted, 'host')} contacted, {plural(run.data.probes, 'probe')}, {plural(run.data.findings, 'finding')}</span>
          </span>
        </Panel>
      ) : null}
      <QueryView query={list} what="Findings" isEmpty={(d) => d.findings.length === 0}
        empty={<EmptyState icon="search" title="Nothing to review">Findings appear here as scans run.</EmptyState>}>
        {(d) => (
          <DataTable label="Findings" rows={d.findings} rowKey={(f) => f.id} rowHref={(f) => hrefWith('/connect/discovery/', { tab: 'findings', finding: f.id, decision: params.get('decision'), run: runId })} columns={[
            { id: 'host', header: 'Host', primary: true, sortValue: (f) => f.host, cell: (f) => <span className={styles.mono}>{f.host}{f.found.port !== null ? `:${f.found.port}` : ''}</span> },
            { id: 'what', header: 'What', cell: (f) => `${f.found.product ?? PROTOCOL[f.found.protocol]}${f.found.version !== null ? ` ${f.found.version}` : ''}` },
            { id: 'connector', header: 'Suggested connector', width: 'md', cell: (f) => f.proposedConnectorType ?? '—' },
            { id: 'types', header: 'Types', width: 'xs', align: 'end', cell: (f) => String(f.proposedObjectTypes.length) },
            { id: 'decision', header: 'Decision', width: 'md', cell: (f) => (f.reviewDecision === 'pending' ? <Badge tone="info">Waiting</Badge> : f.reviewDecision === 'approved' ? <Badge tone="ok">Approved</Badge> : <Badge>Rejected</Badge>) },
            { id: 'when', header: 'Found', width: 'sm', sortValue: (f) => f.createdAt, cell: (f) => <Time value={f.createdAt} /> },
          ]} />
        )}
      </QueryView>
      {findingId !== null ? <FindingDetail key={findingId} findingId={findingId} onClose={() => set({ finding: undefined })} /> : null}
    </Section>
  );
}

export function Discovery() {
  const settings = useQuery('getDiscoverySettings', {}, { staleMs: 60_000 });
  usePageContext({ scope: { kind: 'page', page: 'connect' }, scopeLabel: 'Discovery' });
  const tabs: readonly TabDef<'authorisations' | 'findings'>[] = [{ id: 'authorisations', label: 'Scans' }, { id: 'findings', label: 'Findings' }];
  const [tab, setTab] = useTab(tabs);
  const off = settings.data !== undefined && !settings.data.enabled;
  return (
    <Page title="Discovery" description="A Silo Agent finds the systems on your network and reads their structure, never their data. Each scan is authorised and approved on its own."
      crumbs={[{ label: 'Connect' }]}>
      {off ? (
        <Banner tone="info" title="Discovery is off" action={<LinkButton href="/settings/discovery/">Discovery settings</LinkButton>}>
          While it is off nothing can be scanned or reviewed. A super admin switches it on in Settings.{settings.data?.disabledAt != null ? <> Switched off <Time value={settings.data.disabledAt} />.</> : null}
        </Banner>
      ) : settings.status === 'error' ? <ErrorMessage error={settings.error} onRetry={settings.refetch} /> : (
        <>
          <Tabs label="Discovery" tabs={tabs} current={tab} onChange={setTab} />
          <TabPanel id={tab}>{tab === 'authorisations' ? <Authorisations /> : <Findings />}</TabPanel>
        </>
      )}
    </Page>
  );
}
