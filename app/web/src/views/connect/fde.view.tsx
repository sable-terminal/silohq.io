'use client';

// The AI FDE (spec 49 to 54): an engagement moves the organisation from connected systems to a
// confirmed ontology, governed Action types and working apps, through ten stages. It proposes;
// people confirm; its service principals execute and never authorise. Each stage's exit is
// confirmed by the customer's named engagement owner. Proposals carry their evidence and
// confidence, and go to people who hold the permission each needs; a session works through a
// stage's proposals in order. The stop button revokes at once. Budgets, limits, cost, metrics
// and the hand-over are all here.

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import type { Input, Output } from '../../api/client.api.ts';
import { Badge, Status } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { Checkbox, fieldError, FormActions, RadioGroup, SelectField, TextArea, TextField } from '../../components/field.component.tsx';
import { Menu } from '../../components/menu.component.tsx';
import { IconButton } from '../../components/button.component.tsx';
import { Page, Panel, Properties, Section, Toolbar } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage, Loading } from '../../components/states.component.tsx';
import { TabPanel, Tabs, useTab, type TabDef } from '../../components/tabs.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useBlocked, useMutation, usePermits, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { useRefreshWhile } from '../../hooks/refresh.hook.ts';
import { connectionHref } from '../../navigation/links.navigation.ts';
import { usePageContext, useWorkspace } from '../../shell/context.shell.tsx';
import { formatNumber, plural } from '../../utils/format.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import styles from './connect.view.module.css';

type Engagement = Output<'getEngagement'>;
type Summary = Output<'listEngagements'>['engagements'][number];
type Proposal = Output<'listFdeProposals'>['proposals'][number];
type ProposalStatus = Proposal['status'];
type Kind = Proposal['kind'];
type Escalation = Output<'listFdeEscalations'>['escalations'][number];
type Limits = Summary['rateLimits'];

const STATUS: Record<Summary['status'], { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' | 'info' }> = {
  active: { label: 'Working', tone: 'ok' }, paused: { label: 'Paused', tone: 'warn' }, stopped: { label: 'Stopped', tone: 'danger' },
  handed_over: { label: 'Handed over', tone: 'info' }, closed: { label: 'Closed', tone: 'neutral' },
};
const STAGE_STATE: Record<Engagement['stages'][number]['status'], { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' | 'info' }> = {
  pending: { label: 'Not started', tone: 'neutral' }, running: { label: 'Working', tone: 'info' }, awaiting_confirmation: { label: 'Waiting for the owner', tone: 'warn' },
  passed: { label: 'Passed', tone: 'ok' }, failed: { label: 'Failed', tone: 'danger' }, stopped: { label: 'Stopped', tone: 'neutral' },
};
const PROPOSAL_STATE: Record<ProposalStatus, string> = {
  pending: 'Waiting', accepted: 'Accepted', accepted_edited: 'Accepted with changes', rejected: 'Rejected', deferred: 'Deferred', expired: 'Expired', superseded: 'Superseded', withdrawn: 'Withdrawn',
};
const KIND: Record<Kind, string> = {
  action_type: 'Action type', connector_manifest: 'Connector', connector_mapping: 'Connector mapping', cron_notify: 'Cron', dashboard: 'Dashboard', dependency_edge: 'Dependency',
  detector_configuration: 'Detector', discovery_finding: 'Discovery finding', estate_entry: 'System in scope', field_alias: 'Field name', field_authority: 'Field authority',
  heal_review: 'Repair', interface: 'Interface', link_type: 'Link type', object_type: 'Object type', object_view_layout: 'Object page layout', reliability_finding: 'Reliability finding',
  resolution_pair: 'Resolution', studio_app: 'App', time_field: 'Time field', write_enablement: 'Writes',
};
const CAUSE: Record<Escalation['cause'], string> = {
  unsupported_transport: 'A system it cannot reach', contested_ontology_decision: 'A contested ontology decision', no_eligible_decider: 'Nobody may decide it',
  regulated_requirement: 'A regulated requirement', repeated_stage_failure: 'A stage keeps failing', physical_actuation: 'Physical actuation',
};
const PATH: Record<Escalation['path'], string> = {
  support_ticket: 'Silo support', ontology_owner: 'The ontology owner', engaging_administrator: 'The engaging administrator', compliance_officer: 'The compliance officer',
  deployment_engineer: 'The deployment engineer', operations_safety_owner: 'The operations safety owner',
};
const LIMIT: Record<keyof Limits, string> = {
  modelCallsPerMinute: 'Model calls a minute', probesPerMinute: 'Probes a minute', proposalsPerHour: 'Proposals an hour', concurrentTasks: 'Tasks at once',
  pendingProposalsPerDecider: 'Waiting proposals per person', attemptsPerTask: 'Attempts per task',
};
const BAND: Record<Proposal['confidenceBand'], 'ok' | 'warn' | 'danger'> = { high: 'ok', medium: 'warn', low: 'danger' };

const used = (consumed: string, budget: string) => {
  const b = Number(budget);
  return b > 0 ? Math.min(100, Math.round((Number(consumed) / b) * 100)) : 0;
};

// ----------------------------------------------------------------------------- start

function StartDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const say = useToast();
  const [, set] = useParams();
  const scopes = useQuery('listMyPermittedScopes', { query: { permission: 'fde.engage' } });
  const start = useMutation('startEngagement', { invalidates: ['listEngagements'] });
  const [name, setName] = useState('');
  const [goals, setGoals] = useState('');
  const [klass, setKlass] = useState<NonNullable<Input<'startEngagement'>['body']['engagementClass']>>('standard');
  const [tokens, setTokens] = useState('2000000');
  const [cost, setCost] = useState('500.00');
  const [scopeId, setScopeId] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const r = await start.run({ body: { name: name.trim(), goals: goals.trim(), engagementClass: klass, tokenBudget: Number(tokens), providerCostBudget: cost.trim(), ...(scopeId !== '' ? { scopeId } : {}) } });
    if (r.ok) {
      say('Engagement started: list the systems it should onboard');
      set({ new: undefined, engagement: r.data.id, tab: 'systems' }, { push: true });
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Start an AI FDE engagement" size="lg" busy={start.pending}
      description="It proposes; your people confirm every change. It stops the moment anyone with the stop permission says so, and never spends past its budget.">
      <form onSubmit={submit} className={styles.form}>
        <TextField label="Name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} data-autofocus error={fieldError(start.error, 'name')} />
        <TextArea label="What it is for" required rows={4} value={goals} onChange={(e) => setGoals(e.target.value)}
          hint="In your words: the systems, the decisions people make, what good looks like. Read as vocabulary, never as data." error={fieldError(start.error, 'goals')} />
        <RadioGroup name="class" label="Kind of engagement" value={klass} onChange={setKlass} options={[
          { value: 'standard', label: 'Standard' }, { value: 'enterprise', label: 'Enterprise' },
          { value: 'regulated', label: 'Regulated', hint: 'Regulated requirements are escalated to your compliance officer.' },
          { value: 'sovereign', label: 'Sovereign', hint: 'Models run only where your residency allows.' },
        ]} />
        <div className={styles.split}>
          <TextField label="Token budget" type="number" min={1} required value={tokens} onChange={(e) => setTokens(e.target.value)} error={fieldError(start.error, 'tokenBudget')} />
          <TextField label="Model cost budget (£)" required value={cost} onChange={(e) => setCost(e.target.value)} inputMode="decimal" error={fieldError(start.error, 'providerCostBudget')} />
        </div>
        {(scopes.data?.scopes.length ?? 0) > 1 ? (
          <SelectField label="Confined to (optional)" value={scopeId} onChange={(e) => setScopeId(e.target.value)} placeholder="The whole organisation"
            options={(scopes.data?.scopes ?? []).map((s) => ({ value: s.id, label: s.name }))} />
        ) : null}
        {start.error !== undefined && ['name', 'goals', 'tokenBudget', 'providerCostBudget'].every((f) => fieldError(start.error, f) === undefined) ? <ErrorMessage error={start.error} /> : null}
        <FormActions>
          <Button onClick={onClose} disabled={start.pending}>Cancel</Button>
          <Button type="submit" variant="primary" pending={start.pending} blocked={start.blocked} disabled={name.trim() === '' || goals.trim() === ''}>Start</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

// ----------------------------------------------------------------------------- overview

function LimitsDialog({ engagement, open, onClose }: { engagement: Engagement; open: boolean; onClose: () => void }) {
  const say = useToast();
  const set = useMutation('setEngagementLimits', { invalidates: ['listEngagements'] });
  const [tokens, setTokens] = useState(engagement.tokenBudget);
  const [cost, setCost] = useState(engagement.providerCostBudget);
  const [limits, setLimits] = useState<Record<keyof Limits, string>>(() => Object.fromEntries(Object.entries(engagement.rateLimits).map(([k, v]) => [k, String(v)])) as Record<keyof Limits, string>);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const r = await set.run({ params: { engagementId: engagement.id }, body: {
      tokenBudget: Number(tokens), providerCostBudget: cost.trim(), rateLimits: Object.fromEntries(Object.entries(limits).map(([k, v]) => [k, Number(v)])) as Limits,
    } });
    if (r.ok) {
      say('Limits saved: every principal works within them from its next call');
      onClose();
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Budget and limits" size="md" busy={set.pending}
      description="A deployment engineer may only lower these; the engagement's administrator may set any.">
      <form onSubmit={submit} className={styles.form}>
        <div className={styles.split}>
          <TextField label="Token budget" type="number" min={1} value={tokens} onChange={(e) => setTokens(e.target.value)} hint={`${formatNumber(Number(engagement.tokensConsumed))} used`} />
          <TextField label="Model cost budget (£)" value={cost} onChange={(e) => setCost(e.target.value)} hint={`£${engagement.providerCostConsumed} used`} />
        </div>
        <div className={styles.split}>
          {(Object.keys(LIMIT) as (keyof Limits)[]).map((k) => (
            <TextField key={k} label={LIMIT[k]} type="number" min={0} value={limits[k]} onChange={(e) => setLimits({ ...limits, [k]: e.target.value })} />
          ))}
        </div>
        {set.error !== undefined ? <ErrorMessage error={set.error} /> : null}
        <FormActions>
          <Button onClick={onClose} disabled={set.pending}>Cancel</Button>
          <Button type="submit" variant="primary" pending={set.pending} blocked={set.blocked}>Save</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

function PeopleDialog({ engagement, open, onClose }: { engagement: Engagement; open: boolean; onClose: () => void }) {
  const say = useToast();
  const people = useDirectory();
  const owner = useMutation('nameFdeEngagementOwner', { invalidates: ['listEngagements'] });
  const assign = useMutation('assignFdeEngineer', { invalidates: ['listEngagements'] });
  const remove = useMutation('removeFdeEngineer', { invalidates: ['listEngagements'] });
  const [ownerId, setOwnerId] = useState(engagement.ownerMembershipId);
  const [engineerId, setEngineerId] = useState(engagement.supervisingEngineerMembershipId ?? '');
  const members = people.members.filter((m) => m.status === 'active').map((m) => ({ value: m.membershipId, label: m.displayName }));
  const error = owner.error ?? assign.error ?? remove.error;
  return (
    <Dialog open={open} onClose={onClose} title="Who is responsible" size="md" busy={owner.pending || assign.pending || remove.pending}>
      <div className={styles.form}>
        <SelectField label="Engagement owner" value={ownerId} onChange={(e) => setOwnerId(e.target.value)} options={members}
          hint="Alone confirms each stage's exit. Never the supervising engineer." />
        <FormActions>
          <Button pending={owner.pending} blocked={owner.blocked} disabled={ownerId === engagement.ownerMembershipId} onClick={async () => {
            const r = await owner.run({ params: { engagementId: engagement.id }, body: { membershipId: ownerId } });
            if (r.ok) say(`${people.nameOf(ownerId)} owns the engagement`);
          }}>Name the owner</Button>
        </FormActions>
        <SelectField label="Supervising deployment engineer" value={engineerId} onChange={(e) => setEngineerId(e.target.value)} options={members} placeholder="None"
          hint="Facilitates sessions, raises and resolves escalations, decides technical proposals and may lower limits." />
        <FormActions>
          {engagement.supervisingEngineerMembershipId !== null ? <Button variant="ghost" pending={remove.pending} blocked={remove.blocked} onClick={async () => {
            const r = await remove.run({ params: { engagementId: engagement.id } });
            if (r.ok) {
              setEngineerId('');
              say('Engineer removed');
            }
          }}>Remove the engineer</Button> : null}
          <Button pending={assign.pending} blocked={assign.blocked} disabled={engineerId === '' || engineerId === engagement.supervisingEngineerMembershipId} onClick={async () => {
            const r = await assign.run({ params: { engagementId: engagement.id }, body: { membershipId: engineerId } });
            if (r.ok) say(`${people.nameOf(engineerId)} supervises the engagement`);
          }}>Assign</Button>
        </FormActions>
        {error !== undefined ? <ErrorMessage error={error} /> : null}
      </div>
    </Dialog>
  );
}

function Overview({ engagement }: { engagement: Engagement }) {
  const say = useToast();
  const people = useDirectory();
  const workspace = useWorkspace();
  const confirm = useMutation('confirmStageExit', { invalidates: ['listEngagements'] });
  const owner = engagement.ownerMembershipId === workspace.session.membershipId;
  const waiting = engagement.stages.filter((s) => s.status === 'awaiting_confirmation');
  return (
    <div className={styles.stack}>
      {engagement.status === 'stopped' ? <Banner tone="danger" title="Stopped">{engagement.stopReason ?? 'Every principal was revoked.'} <Time value={engagement.stoppedAt} /></Banner> : null}
      {engagement.openEscalations > 0 ? <Banner tone="warn" title={plural(engagement.openEscalations, 'escalation')} >Open: see Escalations.</Banner> : null}
      <Properties columns={3} items={[
        ['Stage', `${engagement.currentStage} of 9`],
        ['Owner', people.nameOf(engagement.ownerMembershipId)],
        ['Engineer', engagement.supervisingEngineerMembershipId === null ? 'None' : people.nameOf(engagement.supervisingEngineerMembershipId)],
        ['Tokens', `${formatNumber(Number(engagement.tokensConsumed))} of ${formatNumber(Number(engagement.tokenBudget))} (${used(engagement.tokensConsumed, engagement.tokenBudget)}%)`],
        ['Model cost', `£${engagement.providerCostConsumed} of £${engagement.providerCostBudget}`],
        ['Started', <Time key="s" value={engagement.startedAt} />],
        ['Kind', engagement.engagementClass],
        ['Agent installed', engagement.agentInstalledAt === null ? 'Not yet' : <Time key="a" value={engagement.agentInstalledAt} />],
        ['Proposals waiting', String(engagement.proposals.pending ?? 0)],
      ]} />
      <Panel><p className={styles.muted}>{engagement.goals}</p></Panel>
      <Section title="Stages" description="Each stage ends only when the engagement owner confirms its criteria are met.">
        <ol className={styles.stack}>
          {engagement.stages.map((s) => (
            <li key={s.id}>
              <Panel>
                <div className={styles.next}>
                  <div>
                    <h3 className={styles.subheading}>{s.stageNumber}. {s.name}{s.attempt > 1 ? <span className={styles.muted}> (attempt {s.attempt})</span> : null}</h3>
                    <Status tone={STAGE_STATE[s.status].tone}>{STAGE_STATE[s.status].label}</Status>
                  </div>
                  {s.status === 'awaiting_confirmation' ? (
                    <span className={styles.row}>
                      {s.stageNumber === 8 ? <Button variant="ghost" blocked={confirm.blocked ?? (owner ? undefined : 'Only the engagement owner confirms a stage')}
                        onClick={async () => {
                          const r = await confirm.run({ params: { engagementId: engagement.id, stageNumber: 8 }, body: { skip: true } });
                          if (r.ok) say('Stage 8 skipped');
                        }}>Skip it</Button> : null}
                      <Button variant="primary" pending={confirm.pending} blocked={confirm.blocked ?? (owner ? undefined : 'Only the engagement owner confirms a stage')}
                        onClick={async () => {
                          const r = await confirm.run({ params: { engagementId: engagement.id, stageNumber: s.stageNumber }, body: {} });
                          if (r.ok) say(`Stage ${s.stageNumber} confirmed`);
                        }}>Confirm its exit</Button>
                    </span>
                  ) : null}
                </div>
                {s.exitCriteria.length > 0 ? (
                  <ul className={styles.plainList}>
                    {s.exitCriteria.map((c, i) => <li key={i}><Status tone={c.met === true ? 'ok' : c.met === false ? 'danger' : 'neutral'}>{c.criterion}</Status></li>)}
                  </ul>
                ) : null}
              </Panel>
            </li>
          ))}
        </ol>
        {confirm.error !== undefined ? <ErrorMessage error={confirm.error} /> : null}
        {waiting.length > 0 && !owner ? <p className={styles.muted}>{people.nameOf(engagement.ownerMembershipId)} confirms it.</p> : null}
      </Section>
      <Section title="Its principals" description="One service principal per role, each with only its tools. They execute; they never authorise.">
        <DataTable label="Principals" rows={engagement.principals} rowKey={(p) => p.id} dense columns={[
          { id: 'role', header: 'Role', primary: true, cell: (p) => p.role },
          { id: 'tools', header: 'Tools', cell: (p) => <span className={styles.muted}>{p.toolPermissions.join(', ')}</span> },
          { id: 'state', header: 'State', width: 'sm', cell: (p) => (p.revokedAt === null ? <Badge tone="ok">Active</Badge> : <Badge>Revoked</Badge>) },
        ]} />
      </Section>
    </div>
  );
}

// ----------------------------------------------------------------------------- systems and tasks

function AddSystemDialog({ engagement, open, onClose }: { engagement: Engagement; open: boolean; onClose: () => void }) {
  const say = useToast();
  const scopes = useQuery('listMyPermittedScopes', { query: { permission: 'connection.create' } });
  const add = useMutation('addFdeSystem', { invalidates: ['listFdeSystems'] });
  const [name, setName] = useState('');
  const [provider, setProvider] = useState('');
  const [kind, setKind] = useState<'openapi' | 'url' | 'text' | 'wsdl' | 'graphql' | 'odata'>('url');
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [scopeId, setScopeId] = useState('');
  const scope = scopeId || (scopes.data?.scopes.length === 1 ? scopes.data.scopes[0]!.id : '');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const documentation = kind === 'url' ? { kind, url: url.trim() } as const : kind === 'text' ? { kind, title: name.trim(), text } as const : { kind, text } as const;
    const r = await add.run({ params: { engagementId: engagement.id }, body: {
      name: name.trim(), provider: provider.trim(), slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'system',
      documentation, owningScopeId: scope, ...(baseUrl.trim() !== '' ? { baseUrl: baseUrl.trim() } : {}),
    } });
    if (r.ok) {
      say('Listed: its Integration principal drafts a connector for it');
      onClose();
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="A system to onboard" size="lg" busy={add.pending}
      description="Give it the system's documentation. It drafts a connector and a connection, which waits for the system's owner to give its credential.">
      <form onSubmit={submit} className={styles.form}>
        <div className={styles.split}>
          <TextField label="System" required value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
          <TextField label="Made by" required value={provider} onChange={(e) => setProvider(e.target.value)} />
        </div>
        <SelectField label="Documentation" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} options={[
          { value: 'url', label: 'Its address' }, { value: 'openapi', label: 'An OpenAPI description' }, { value: 'text', label: 'Documentation, pasted' },
          { value: 'wsdl', label: 'A WSDL' }, { value: 'graphql', label: 'A GraphQL schema' }, { value: 'odata', label: 'An OData $metadata document' },
        ]} />
        {kind === 'url' ? <TextField label="Address" type="url" required value={url} onChange={(e) => setUrl(e.target.value)} />
          : <TextArea label="Paste it here" required rows={8} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />}
        <TextField label="The system's address (optional)" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://" />
        <SelectField label="Connection owned by" required value={scope} onChange={(e) => setScopeId(e.target.value)} placeholder="Choose a scope"
          options={(scopes.data?.scopes ?? []).map((s) => ({ value: s.id, label: s.name }))} />
        {add.error !== undefined ? <ErrorMessage error={add.error} /> : null}
        <FormActions>
          <Button onClick={onClose} disabled={add.pending}>Cancel</Button>
          <Button type="submit" variant="primary" pending={add.pending} blocked={add.blocked}
            disabled={name.trim() === '' || provider.trim() === '' || scope === '' || (kind === 'url' ? url.trim() === '' : text.trim() === '')}>List it</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

function Systems({ engagement }: { engagement: Engagement }) {
  const say = useToast();
  const people = useDirectory();
  const list = useQuery('listFdeSystems', { params: { engagementId: engagement.id } });
  const tasks = useQuery('listFdeTasks', { params: { engagementId: engagement.id } });
  const withdraw = useMutation('withdrawFdeSystem', { invalidates: ['listFdeSystems'] });
  const blocked = useBlocked('addFdeSystem');
  const [adding, setAdding] = useState(false);
  useRefreshWhile((tasks.data?.tasks ?? []).some((t) => t.status === 'running' || t.status === 'queued'), tasks.refetch, 5000);
  return (
    <div className={styles.stack}>
      <Section title="Systems in scope" actions={<Button icon="plus" blocked={blocked} onClick={() => setAdding(true)}>List a system</Button>}>
        <QueryView query={list} what="Systems" isEmpty={(d) => d.systems.length === 0}
          empty={<EmptyState icon="plug" title="No system listed">List the systems it should onboard, with their documentation.</EmptyState>}>
          {(d) => (
            <DataTable label="Systems" rows={d.systems} rowKey={(s) => s.id} columns={[
              { id: 'name', header: 'System', primary: true, cell: (s) => <span className={styles.stackTight}>{s.name}<span className={styles.muted}>{s.provider}</span></span> },
              { id: 'state', header: 'State', width: 'md', cell: (s) => (s.status === 'withdrawn' ? <Badge>Withdrawn</Badge> : s.awaitingCredential ? <Badge tone="warn">Waiting for its credential</Badge>
                : s.status === 'drafted' ? <Badge tone="ok">Drafted</Badge> : <Badge tone="info">Listed</Badge>) },
              { id: 'connection', header: 'Connection', width: 'md', cell: (s) => (s.connectionId === null ? '—' : <Link href={hrefWith('/connect/connections/', { connection: s.connectionId, tab: 'setup' })}>
                {s.awaitingCredential ? 'Give its credential' : 'Open'}</Link>) },
              { id: 'by', header: 'Listed', width: 'md', cell: (s) => <span>{people.nameOf(s.listedBy)}, <Time value={s.listedAt} /></span> },
              { id: 'act', header: <span className="visually-hidden">Withdraw</span>, width: 'sm', align: 'end', cell: (s) => (s.status === 'withdrawn' ? null
                : <Button size="sm" variant="ghost" blocked={withdraw.blocked} onClick={async () => {
                  const r = await withdraw.run({ params: { engagementId: engagement.id, systemId: s.id } });
                  if (r.ok) say(`${s.name} withdrawn from the engagement`);
                }}>Withdraw</Button>) },
            ]} />
          )}
        </QueryView>
        {withdraw.error !== undefined ? <ErrorMessage error={withdraw.error} /> : null}
      </Section>
      <Section title="Tasks" description="What its principals have done and are doing: structure, counts and cost, never values.">
        <QueryView query={tasks} what="Tasks" isEmpty={(d) => d.tasks.length === 0} empty={<p className={styles.muted}>No task yet.</p>}>
          {(d) => (
            <DataTable label="Tasks" rows={d.tasks} rowKey={(t) => t.id} dense columns={[
              { id: 'kind', header: 'Task', primary: true, cell: (t) => <span className={styles.stackTight}>{t.kind.replaceAll('_', ' ')}<span className={styles.muted}>Stage {t.stageNumber}, {t.role}</span></span> },
              { id: 'state', header: 'State', width: 'md', cell: (t) => <Status tone={t.status === 'succeeded' ? 'ok' : t.status === 'failed' ? 'danger' : t.status === 'running' ? 'info' : 'neutral'}>
                {t.status}{t.errorSemantic !== null ? `: ${t.errorSemantic.replaceAll('_', ' ')}` : ''}</Status> },
              { id: 'tries', header: 'Attempts', width: 'xs', align: 'end', cell: (t) => `${t.attempts}/${t.maxAttempts}` },
              { id: 'tokens', header: 'Tokens', width: 'sm', align: 'end', cell: (t) => formatNumber(Number(t.tokensConsumed)) },
              { id: 'cost', header: 'Cost', width: 'sm', align: 'end', cell: (t) => `£${t.providerCost}` },
              { id: 'connection', header: 'Connection', width: 'sm', cell: (t) => (t.connectionId === null ? '—' : <Link href={connectionHref(t.connectionId)}>Open</Link>) },
              { id: 'at', header: 'Created', width: 'sm', cell: (t) => <Time value={t.createdAt} /> },
            ]} />
          )}
        </QueryView>
      </Section>
      {adding ? <AddSystemDialog engagement={engagement} open onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

// ----------------------------------------------------------------------------- proposals and sessions

function ProposalDetail({ proposalId, onClose }: { proposalId: string; onClose: () => void }) {
  const say = useToast();
  const people = useDirectory();
  const read = useQuery('getFdeProposal', { params: { proposalId } });
  const decide = useMutation('decideFdeProposal', { invalidates: ['listFdeProposals', 'listEngagements'] });
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [reason, setReason] = useState<NonNullable<Input<'decideFdeProposal'>['body']['reason']>>('not_needed');
  const [note, setNote] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const p = read.data;
  if (p === undefined) return <Dialog open onClose={onClose} drawer title="Proposal">{read.status === 'error' ? <ErrorMessage error={read.error} onRetry={read.refetch} /> : <Loading label="Reading the proposal" />}</Dialog>;
  let edits: Record<string, unknown> | undefined;
  let editProblem: string | undefined;
  if (editing !== undefined) {
    try {
      const parsed: unknown = JSON.parse(editing);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) editProblem = 'Write an object';
      else edits = parsed as Record<string, unknown>;
    } catch (e) {
      editProblem = (e as Error).message;
    }
  }
  const run = async (body: Input<'decideFdeProposal'>['body'], message: string) => {
    const r = await decide.run({ params: { proposalId }, body });
    if (r.ok) say(message);
    return r;
  };
  return (
    <Dialog open onClose={onClose} drawer title={`${KIND[p.kind]}, stage ${p.stageNumber}`} busy={decide.pending}
      description={<span className={styles.row}><Badge tone={BAND[p.confidenceBand]}>{p.confidenceBand} confidence ({Math.round(Number(p.confidence) * 100)}%)</Badge><span>{PROPOSAL_STATE[p.status]}</span></span>}>
      <div className={styles.stack}>
        <Properties columns={1} items={[
          ['Needs', p.requiredPermission],
          p.markings.length > 0 ? ['Markings', p.markings.join(', ')] : null,
          ['Assigned to', p.assignedMembershipId === null ? 'Anyone who may decide it' : people.nameOf(p.assignedMembershipId)],
          p.decidedAt !== null ? ['Decided', <span key="d">{people.nameOf(p.decidedBy)}, <Time value={p.decidedAt} /></span>] : null,
          p.rejectionReason !== null ? ['Why rejected', p.rejectionReason.replaceAll('_', ' ')] : null,
        ]} />
        <Section title="What it proposes">
          {editing === undefined ? <pre className={styles.code}>{JSON.stringify(p.payload, null, 2)}</pre>
            : <TextArea label="Your changes (JSON)" rows={12} spellCheck={false} value={editing} onChange={(e) => setEditing(e.target.value)} error={editProblem}
              hint="Change only the fields you would correct; the difference is recorded with your decision." />}
        </Section>
        <Section title="Evidence">
          <ul className={styles.plainList}>{p.evidence.map((e, i) => <li key={i}><strong>{e.type.replaceAll('_', ' ')}</strong> <span className={styles.muted}>{JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'type'))).slice(0, 240)}</span></li>)}</ul>
        </Section>
        {Object.keys(p.verification).length > 0 ? <Section title="How it was checked"><pre className={styles.code}>{JSON.stringify(p.verification, null, 2)}</pre></Section> : null}
        {p.status === 'pending' ? (
          <>
            {decide.error !== undefined ? <ErrorMessage error={decide.error} /> : null}
            <div className={styles.row}>
              <Button variant="primary" pending={decide.pending} blocked={decide.blocked} disabled={editProblem !== undefined}
                onClick={() => void run({ decision: 'accept', ...(edits !== undefined ? { edits: edits as never } : {}) }, edits !== undefined ? 'Accepted with your changes' : 'Accepted')}>
                {editing === undefined ? 'Accept' : 'Accept with changes'}
              </Button>
              {editing === undefined ? <Button onClick={() => setEditing(JSON.stringify(p.payload, null, 2))}>Correct it</Button> : <Button variant="ghost" onClick={() => setEditing(undefined)}>Discard changes</Button>}
              <Button variant="ghost" blocked={decide.blocked} onClick={() => void run({ decision: 'defer' }, 'Deferred')}>Defer</Button>
              <Button variant="ghost" blocked={decide.blocked} onClick={() => setRejecting(true)}>Reject</Button>
            </div>
          </>
        ) : null}
      </div>
      <Dialog open={rejecting} onClose={() => setRejecting(false)} title="Reject the proposal" size="sm" busy={decide.pending}>
        <form className={styles.form} onSubmit={async (event) => {
          event.preventDefault();
          const r = await run({ decision: 'reject', reason, ...(note.trim() !== '' ? { note: note.trim() } : {}) }, 'Rejected');
          if (r.ok) setRejecting(false);
        }}>
          <SelectField label="Why" value={reason} onChange={(e) => setReason(e.target.value as typeof reason)} options={[
            { value: 'not_needed', label: 'Not needed' }, { value: 'wrong', label: 'Wrong' }, { value: 'duplicate', label: 'A duplicate' },
            { value: 'out_of_scope', label: 'Out of scope' }, { value: 'unclear', label: 'Unclear' }, { value: 'other', label: 'Something else' },
          ]} />
          <TextArea label="Note (optional)" rows={3} value={note} onChange={(e) => setNote(e.target.value)} hint="Teaches it what to propose next; never values." />
          <FormActions><Button onClick={() => setRejecting(false)}>Cancel</Button><Button type="submit" variant="danger" pending={decide.pending}>Reject</Button></FormActions>
        </form>
      </Dialog>
    </Dialog>
  );
}

function Proposals({ engagement }: { engagement: Engagement }) {
  const say = useToast();
  const people = useDirectory();
  const [params, set] = useParams();
  const status = (params.get('status') ?? 'pending') as ProposalStatus | 'all';
  const kind = params.get('kind') ?? '';
  const mine = params.get('mine') === '1';
  const list = useQuery('listFdeProposals', { params: { engagementId: engagement.id }, query: {
    ...(status === 'all' ? {} : { status }), ...(kind !== '' ? { kind: kind as Kind } : {}), ...(mine ? { mine: 'true' as const } : {}),
  } });
  const group = useMutation('acceptFdeProposalGroup', { invalidates: ['listFdeProposals', 'listEngagements'] });
  const assign = useMutation('assignFdeProposals', { invalidates: ['listFdeProposals'] });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assignee, setAssignee] = useState('');
  const openId = params.get('proposal');
  const rows = list.data?.proposals ?? [];
  const chosen = rows.filter((p) => selected.has(p.id) && p.status === 'pending');
  return (
    <Section title="Proposals" description="Each with its evidence and how sure it is. Accept, correct, defer or reject; several of high confidence may be accepted together.">
      <Toolbar end={chosen.length > 0 ? (
        <span className={styles.row}>
          <Button variant="primary" pending={group.pending} blocked={group.blocked} onClick={async () => {
            const r = await group.run({ params: { engagementId: engagement.id }, body: { proposalIds: chosen.map((p) => p.id), count: chosen.length } });
            if (r.ok) {
              setSelected(new Set());
              say(`${plural(r.data.accepted.length, 'proposal')} accepted`);
            }
          }}>Accept {chosen.length}</Button>
          <SelectField label="Assign to" hideLabel value={assignee} onChange={(e) => setAssignee(e.target.value)} placeholder="Assign to…"
            options={people.members.filter((m) => m.status === 'active').map((m) => ({ value: m.membershipId, label: m.displayName }))} />
          <Button pending={assign.pending} blocked={assign.blocked} disabled={assignee === ''} onClick={async () => {
            const r = await assign.run({ params: { engagementId: engagement.id }, body: { proposalIds: chosen.map((p) => p.id), membershipId: assignee } });
            if (r.ok) say(`${plural(r.data.assigned, 'proposal')} assigned to ${people.nameOf(assignee)}`);
          }}>Assign</Button>
        </span>
      ) : undefined}>
        <SelectField label="State" hideLabel value={status} onChange={(e) => set({ status: e.target.value === 'pending' ? undefined : e.target.value })}
          options={[...(Object.keys(PROPOSAL_STATE) as ProposalStatus[]).map((s) => ({ value: s, label: PROPOSAL_STATE[s] })), { value: 'all', label: 'All' }]} />
        <SelectField label="Kind" hideLabel value={kind} onChange={(e) => set({ kind: e.target.value })} placeholder="Every kind"
          options={(Object.keys(KIND) as Kind[]).map((k) => ({ value: k, label: KIND[k] }))} />
        <Checkbox label="Assigned to me" checked={mine} onChange={() => set({ mine: mine ? undefined : '1' })} />
      </Toolbar>
      {group.error !== undefined ? <ErrorMessage error={group.error} /> : null}
      {assign.error !== undefined ? <ErrorMessage error={assign.error} /> : null}
      <QueryView query={list} what="Proposals" isEmpty={(d) => d.proposals.length === 0} empty={<EmptyState icon="success" title="Nothing here">No proposal matches.</EmptyState>}>
        {(d) => (
          <DataTable label="Proposals" rows={d.proposals} rowKey={(p) => p.id} selection={status === 'pending' ? { selected, onChange: setSelected } : undefined}
            rowHref={(p) => hrefWith('/connect/fde/', { engagement: engagement.id, tab: 'proposals', proposal: p.id, status: params.get('status'), kind: kind || undefined })} columns={[
              { id: 'kind', header: 'Proposal', primary: true, cell: (p: Proposal) => <span className={styles.stackTight}>{KIND[p.kind]}<span className={styles.muted}>
                {String(p.payload['apiName'] ?? p.payload['name'] ?? p.payload['displayName'] ?? '')}</span></span> },
              { id: 'stage', header: 'Stage', width: 'xs', align: 'end', cell: (p) => String(p.stageNumber) },
              { id: 'band', header: 'Confidence', width: 'sm', sortValue: (p) => Number(p.confidence), cell: (p) => <Badge tone={BAND[p.confidenceBand]}>{p.confidenceBand}</Badge> },
              { id: 'needs', header: 'Needs', width: 'md', cell: (p) => <span className={styles.mono}>{p.requiredPermission}</span> },
              { id: 'assigned', header: 'Assigned', width: 'md', cell: (p) => (p.assignedMembershipId === null ? '—' : people.nameOf(p.assignedMembershipId)) },
              { id: 'state', header: 'State', width: 'sm', cell: (p) => PROPOSAL_STATE[p.status] },
            ]} />
        )}
      </QueryView>
      {openId !== null ? <ProposalDetail key={openId} proposalId={openId} onClose={() => set({ proposal: undefined })} /> : null}
    </Section>
  );
}

function Sessions({ engagement }: { engagement: Engagement }) {
  const say = useToast();
  const people = useDirectory();
  const list = useQuery('listFdeSessions', { params: { engagementId: engagement.id } });
  const start = useMutation('startFdeSession', { invalidates: ['listFdeSessions'] });
  const end = useMutation('endFdeSession', { invalidates: ['listFdeSessions'] });
  const [starting, setStarting] = useState(false);
  const [mode, setMode] = useState<'queue' | 'workshop'>('workshop');
  const [participants, setParticipants] = useState<Set<string>>(new Set());
  return (
    <Section title="Confirmation sessions" description="Work through a stage's waiting proposals in order: object types before links, links before resolution, each group by confidence."
      actions={<Button icon="play" blocked={start.blocked} onClick={() => setStarting(true)}>Start a session</Button>}>
      <QueryView query={list} what="Sessions" isEmpty={(d) => d.sessions.length === 0} empty={<p className={styles.muted}>No session yet.</p>}>
        {(d) => (
          <DataTable label="Sessions" rows={d.sessions} rowKey={(s) => s.id} columns={[
            { id: 'started', header: 'Started', primary: true, cell: (s) => (s.startedAt === null ? 'Scheduled' : <Time value={s.startedAt} exact />) },
            { id: 'mode', header: 'Kind', width: 'sm', cell: (s) => (s.mode === 'workshop' ? `Workshop, led by ${people.nameOf(s.facilitatorMembershipId)}` : 'Queue') },
            { id: 'stage', header: 'Stage', width: 'xs', align: 'end', cell: (s) => String(s.stageNumber) },
            { id: 'agenda', header: 'Agenda', cell: (s) => <span className={styles.muted}>{plural(s.agenda.length, 'group')}, {plural(s.counts.presented, 'proposal')}</span> },
            { id: 'done', header: 'Decided', cell: (s) => `${s.counts.accepted} accepted, ${s.counts.edited} edited, ${s.counts.rejected} rejected, ${s.counts.deferred} deferred` },
            { id: 'end', header: <span className="visually-hidden">End</span>, width: 'sm', align: 'end', cell: (s) => (s.endedAt !== null ? <Badge>Ended</Badge>
              : <Button size="sm" pending={end.pending} blocked={end.blocked} onClick={async () => {
                const r = await end.run({ params: { sessionId: s.id } });
                if (r.ok) say('Session ended');
              }}>End</Button>) },
          ]} />
        )}
      </QueryView>
      {end.error !== undefined ? <ErrorMessage error={end.error} /> : null}
      <Dialog open={starting} onClose={() => setStarting(false)} title="Start a session" size="md" busy={start.pending}>
        <form className={styles.form} onSubmit={async (event) => {
          event.preventDefault();
          const r = await start.run({ params: { engagementId: engagement.id }, body: { mode, participantMembershipIds: [...participants] } });
          if (r.ok) {
            setStarting(false);
            say(`Session started with ${plural(r.data.counts.presented, 'proposal')}`);
          }
        }}>
          <RadioGroup name="mode" label="Kind" value={mode} onChange={setMode} options={[
            { value: 'workshop', label: 'A workshop', hint: 'You lead it, with the people deciding together.' },
            { value: 'queue', label: 'A queue', hint: 'Each person decides on their own.' },
          ]} />
          <fieldset className={styles.choices}>
            <legend>Who takes part</legend>
            {people.members.filter((m) => m.status === 'active').map((m) => (
              <Checkbox key={m.membershipId} label={m.displayName} checked={participants.has(m.membershipId)} onChange={() => {
                const next = new Set(participants);
                if (next.has(m.membershipId)) next.delete(m.membershipId);
                else next.add(m.membershipId);
                setParticipants(next);
              }} />
            ))}
          </fieldset>
          {start.error !== undefined ? <ErrorMessage error={start.error} /> : null}
          <FormActions><Button onClick={() => setStarting(false)}>Cancel</Button><Button type="submit" variant="primary" pending={start.pending} disabled={participants.size === 0}>Start</Button></FormActions>
        </form>
      </Dialog>
    </Section>
  );
}

// ----------------------------------------------------------------------------- escalations, cost and hand-over

function Escalations({ engagement }: { engagement: Engagement }) {
  const say = useToast();
  const people = useDirectory();
  const list = useQuery('listFdeEscalations', { params: { engagementId: engagement.id } });
  const raise = useMutation('raiseFdeEscalation', { invalidates: ['listFdeEscalations', 'listEngagements'] });
  const resolve = useMutation('resolveFdeEscalation', { invalidates: ['listFdeEscalations', 'listEngagements'] });
  const [raising, setRaising] = useState(false);
  const [cause, setCause] = useState<Escalation['cause']>('contested_ontology_decision');
  const [path, setPath] = useState<Escalation['path']>('ontology_owner');
  const [ticket, setTicket] = useState('');
  const [resolving, setResolving] = useState<Escalation | undefined>(undefined);
  const [note, setNote] = useState('');
  return (
    <Section title="Escalations" description="What it cannot settle itself, and to whom it went." actions={<Button blocked={raise.blocked} onClick={() => setRaising(true)}>Raise one</Button>}>
      <QueryView query={list} what="Escalations" isEmpty={(d) => d.escalations.length === 0} empty={<p className={styles.muted}>None.</p>}>
        {(d) => (
          <DataTable label="Escalations" rows={d.escalations} rowKey={(x) => x.id} columns={[
            { id: 'cause', header: 'Cause', primary: true, cell: (x) => CAUSE[x.cause] },
            { id: 'path', header: 'To', width: 'md', cell: (x) => `${PATH[x.path]}${x.ticketRef !== null ? ` (${x.ticketRef})` : ''}` },
            { id: 'by', header: 'Raised', width: 'md', cell: (x) => <span>{x.raisedByMembershipId === null ? 'By the engagement' : people.nameOf(x.raisedByMembershipId)}, <Time value={x.createdAt} /></span> },
            { id: 'state', header: 'State', width: 'md', cell: (x) => (x.status === 'open' ? <Badge tone="warn">Open</Badge> : <span className={styles.stackTight}><Badge>Resolved</Badge><span className={styles.muted}>{x.resolutionNote}</span></span>) },
            { id: 'act', header: <span className="visually-hidden">Resolve</span>, width: 'sm', align: 'end', cell: (x) => (x.status === 'open' ? <Button size="sm" blocked={resolve.blocked} onClick={() => setResolving(x)}>Resolve</Button> : null) },
          ]} />
        )}
      </QueryView>
      <Dialog open={raising} onClose={() => setRaising(false)} title="Raise an escalation" size="md" busy={raise.pending}>
        <form className={styles.form} onSubmit={async (event) => {
          event.preventDefault();
          const r = await raise.run({ params: { engagementId: engagement.id }, body: { cause, path, ...(ticket.trim() !== '' ? { ticketRef: ticket.trim() } : {}) } });
          if (r.ok) {
            setRaising(false);
            say('Escalated');
          }
        }}>
          <SelectField label="Cause" value={cause} onChange={(e) => setCause(e.target.value as Escalation['cause'])} options={(Object.keys(CAUSE) as Escalation['cause'][]).map((c) => ({ value: c, label: CAUSE[c] }))} />
          <SelectField label="To" value={path} onChange={(e) => setPath(e.target.value as Escalation['path'])} options={(Object.keys(PATH) as Escalation['path'][]).map((p) => ({ value: p, label: PATH[p] }))} />
          {path === 'support_ticket' ? <TextField label="Support reference" value={ticket} onChange={(e) => setTicket(e.target.value)} placeholder="SUP-…" /> : null}
          {raise.error !== undefined ? <ErrorMessage error={raise.error} /> : null}
          <FormActions><Button onClick={() => setRaising(false)}>Cancel</Button><Button type="submit" variant="primary" pending={raise.pending}>Raise</Button></FormActions>
        </form>
      </Dialog>
      <Dialog open={resolving !== undefined} onClose={() => setResolving(undefined)} title="Resolve the escalation" size="sm" busy={resolve.pending}>
        <form className={styles.form} onSubmit={async (event) => {
          event.preventDefault();
          const r = await resolve.run({ params: { escalationId: resolving!.id }, body: { note: note.trim() } });
          if (r.ok) {
            setResolving(undefined);
            setNote('');
            say('Resolved');
          }
        }}>
          <TextArea label="How it was settled" required rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          {resolve.error !== undefined ? <ErrorMessage error={resolve.error} /> : null}
          <FormActions><Button onClick={() => setResolving(undefined)}>Cancel</Button><Button type="submit" variant="primary" pending={resolve.pending} disabled={note.trim() === ''}>Resolve</Button></FormActions>
        </form>
      </Dialog>
    </Section>
  );
}

function Results({ engagement }: { engagement: Engagement }) {
  const metrics = useQuery('getFdeMetrics', { params: { engagementId: engagement.id } });
  const cost = useQuery('readEngagementCost', { params: { engagementId: engagement.id } });
  return (
    <div className={styles.stack}>
      <Section title="Cost" description="What it was charged against your allowance, and what its model calls cost.">
        <QueryView query={cost} what="Cost">
          {(c) => (
            <>
              <Properties columns={3} items={[
                ['Tokens charged', formatNumber(Number(c.tokensCharged))],
                ['Simulations charged', formatNumber(Number(c.simulationsCharged))],
                ['Model calls', `${formatNumber(c.modelCost.calls)}${c.modelCost.measured ? `, £${c.modelCost.amount}` : ', cost not measured'}`],
              ]} />
              {c.lines.length > 0 ? (
                <DataTable label="Charges" rows={c.lines} rowKey={(l) => `${l.operation}:${l.pool}:${l.source}`} dense columns={[
                  { id: 'op', header: 'For', primary: true, cell: (l) => l.operation.replaceAll('_', ' ') },
                  { id: 'pool', header: 'From', width: 'md', cell: (l) => `${l.pool}, ${l.source}` },
                  { id: 'units', header: 'Units', width: 'sm', align: 'end', cell: (l) => formatNumber(Number(l.units)) },
                  { id: 'n', header: 'Charges', width: 'sm', align: 'end', cell: (l) => String(l.charges) },
                ]} />
              ) : null}
            </>
          )}
        </QueryView>
      </Section>
      <Section title="Measures" description="From its own records; every ratio with its sample and how far a small one can be trusted.">
        <QueryView query={metrics} what="Measures">
          {(m) => (
            <>
              <DataTable label="Measures" rows={m.metrics} rowKey={(x) => `${x.metric}:${JSON.stringify(x.dimensions)}`} dense columns={[
                { id: 'metric', header: 'Measure', primary: true, cell: (x) => <span className={styles.stackTight}>{x.metric.replaceAll('_', ' ')}{Object.keys(x.dimensions).length > 0 ? <span className={styles.muted}>{Object.entries(x.dimensions).map(([k, v]) => `${k}: ${String(v)}`).join(', ')}</span> : null}</span> },
                { id: 'value', header: 'Value', width: 'md', cell: (x) => `${x.value} ${x.unit}${x.numerator !== null ? ` (${x.numerator}/${x.denominator})` : ''}` },
                { id: 'interval', header: '95% interval', width: 'md', cell: (x) => (x.interval === null ? '—' : `${(x.interval[0] * 100).toFixed(0)}–${(x.interval[1] * 100).toFixed(0)}%`) },
                { id: 'at', header: 'Measured', width: 'sm', cell: (x) => <Time value={x.measuredAt} /> },
              ]} />
              {m.notMeasured.length > 0 ? <p className={styles.muted}>Not measured: {m.notMeasured.map((x) => `${x.metric.replaceAll('_', ' ')} (${x.why})`).join('; ')}.</p> : null}
            </>
          )}
        </QueryView>
      </Section>
    </div>
  );
}

function Handover({ engagement }: { engagement: Engagement }) {
  const say = useToast();
  const people = useDirectory();
  const read = useQuery('getHandover', { params: { engagementId: engagement.id } });
  const accept = useMutation('acceptHandover', { invalidates: ['listEngagements'] });
  const [keep, setKeep] = useState(true);
  const [tokens, setTokens] = useState('200000');
  const [cost, setCost] = useState('50.00');
  return (
    <Section title="Hand-over" description="Every artefact with the person who confirmed it, what was deferred and rejected, open escalations, and systems left out.">
      <QueryView query={read} what="The hand-over">
        {(h) => (
          <div className={styles.stack}>
            <Properties columns={3} items={[
              ['Made', plural(h.artefacts.length, 'artefact')], ['Deferred', String(h.deferred.length)], ['Rejected', String(h.rejected.length)],
              ['Open escalations', String(h.openEscalations.length)], ['Systems left out', h.excludedSystems.length === 0 ? 'None' : h.excludedSystems.join(', ')],
              ['Spent', `${formatNumber(Number(h.tokensConsumed))} tokens, £${h.providerCostConsumed}`],
            ]} />
            <DataTable label="Artefacts" rows={h.artefacts} rowKey={(a) => a.proposalId} dense columns={[
              { id: 'kind', header: 'Artefact', primary: true, cell: (a) => KIND[a.kind] },
              { id: 'target', header: 'Made', cell: (a) => <span className={styles.mono}>{a.target ?? '—'}</span> },
              { id: 'by', header: 'Confirmed', width: 'md', cell: (a) => <span>{people.nameOf(a.decidedBy)}, <Time value={a.decidedAt} /></span> },
            ]} />
            {h.openEscalations.length > 0 ? <Banner tone="warn">Open escalations go with it: {h.openEscalations.map((x) => x.cause.replaceAll('_', ' ')).join(', ')}.</Banner> : null}
            {engagement.status === 'active' || engagement.status === 'paused' ? (
              <Panel>
                <form className={styles.form} onSubmit={async (event) => {
                  event.preventDefault();
                  const r = await accept.run({ params: { engagementId: engagement.id }, body: keep ? { keepReliability: true, reliabilityTokenBudget: Number(tokens), reliabilityProviderCostBudget: cost.trim() } : { keepReliability: false } });
                  if (r.ok) say(r.data.successorEngagementId !== null ? 'Handed over: Reliability carries on under its own budget' : 'Handed over');
                }}>
                  <Checkbox label="Keep Reliability watching the systems" checked={keep} onChange={() => setKeep(!keep)}
                    hint="Every other principal is revoked; Reliability carries on under a successor engagement with its own budget." />
                  {keep ? (
                    <div className={styles.split}>
                      <TextField label="Its token budget" type="number" min={1} value={tokens} onChange={(e) => setTokens(e.target.value)} />
                      <TextField label="Its model cost budget (£)" value={cost} onChange={(e) => setCost(e.target.value)} />
                    </div>
                  ) : null}
                  {accept.error !== undefined ? <ErrorMessage error={accept.error} /> : null}
                  <FormActions><Button type="submit" variant="primary" pending={accept.pending} blocked={accept.blocked}>Accept the hand-over</Button></FormActions>
                </form>
              </Panel>
            ) : null}
          </div>
        )}
      </QueryView>
    </Section>
  );
}

// ----------------------------------------------------------------------------- the engagement page and list

type TabId = 'overview' | 'systems' | 'proposals' | 'sessions' | 'escalations' | 'results' | 'handover';

function EngagementPage({ engagementId }: { engagementId: string }) {
  const say = useToast();
  const permits = usePermits();
  const read = useQuery('getEngagement', { params: { engagementId } }, { refreshMs: 30_000 });
  const pause = useMutation('pauseEngagement', { invalidates: ['listEngagements'] });
  const resume = useMutation('resumeEngagement', { invalidates: ['listEngagements'] });
  const stop = useMutation('stopEngagement', { invalidates: ['listEngagements'] });
  const close = useMutation('closeEngagement', { invalidates: ['listEngagements'] });
  const [stopping, setStopping] = useState(false);
  const [closing, setClosing] = useState(false);
  const [limits, setLimits] = useState(false);
  const [people, setPeople] = useState(false);
  const e = read.data;
  usePageContext({ scope: { kind: 'page', page: 'connect' }, scopeLabel: e?.name ?? 'An AI FDE engagement' });
  const tabs: readonly TabDef<TabId>[] = [
    { id: 'overview', label: 'Overview' }, { id: 'systems', label: 'Systems and tasks' },
    { id: 'proposals', label: 'Proposals', count: e?.proposals.pending !== undefined && e.proposals.pending > 0 ? e.proposals.pending : undefined },
    { id: 'sessions', label: 'Sessions' }, { id: 'escalations', label: 'Escalations', count: e !== undefined && e.openEscalations > 0 ? e.openEscalations : undefined },
    { id: 'results', label: 'Cost and measures' }, { id: 'handover', label: 'Hand-over' },
  ];
  const [tab, setTab] = useTab(tabs);
  if (e === undefined) {
    return <Page title="AI FDE engagement" crumbs={[{ label: 'Connect' }, { label: 'AI FDE', href: '/connect/fde/' }]}>
      {read.status === 'error' ? <ErrorMessage error={read.error} onRetry={read.refetch} /> : <Loading label="Reading the engagement" />}
    </Page>;
  }
  const live = e.status === 'active' || e.status === 'paused';
  const error = pause.error ?? resume.error;
  return (
    <Page title={e.name} crumbs={[{ label: 'Connect' }, { label: 'AI FDE', href: '/connect/fde/' }]}
      meta={<span className={styles.row}><Badge tone={STATUS[e.status].tone}>{STATUS[e.status].label}</Badge><span>Stage {e.currentStage}</span></span>}
      actions={live ? (
        <>
          {e.status === 'active'
            ? <Button icon="pause" pending={pause.pending} blocked={pause.blocked} onClick={async () => {
              const r = await pause.run({ params: { engagementId } });
              if (r.ok) say('Paused: no new task starts');
            }}>Pause</Button>
            : <Button icon="play" pending={resume.pending} blocked={resume.blocked} onClick={async () => {
              const r = await resume.run({ params: { engagementId } });
              if (r.ok) say('Resumed');
            }}>Resume</Button>}
          <Button variant="danger" icon="stop" blocked={stop.blocked} onClick={() => setStopping(true)}>Stop</Button>
          <Menu label="More for this engagement" items={[
            { label: 'Budget and limits', icon: 'filter', onSelect: () => setLimits(true), blocked: permits('setEngagementLimits') },
            { label: 'Owner and engineer', icon: 'people', onSelect: () => setPeople(true), blocked: permits('nameFdeEngagementOwner') },
            { separator: true },
            { label: 'Close it…', icon: 'close', onSelect: () => setClosing(true), blocked: permits('closeEngagement') },
          ]} renderTrigger={(p) => <IconButton {...p} label="More for this engagement" icon="more" />} />
        </>
      ) : undefined}>
      {error !== undefined ? <ErrorMessage error={error} /> : null}
      <Tabs label="Engagement" tabs={tabs} current={tab} onChange={setTab} />
      <TabPanel id={tab}>
        {tab === 'overview' ? <Overview engagement={e} /> : null}
        {tab === 'systems' ? <Systems engagement={e} /> : null}
        {tab === 'proposals' ? <Proposals engagement={e} /> : null}
        {tab === 'sessions' ? <Sessions engagement={e} /> : null}
        {tab === 'escalations' ? <Escalations engagement={e} /> : null}
        {tab === 'results' ? <Results engagement={e} /> : null}
        {tab === 'handover' ? <Handover engagement={e} /> : null}
      </TabPanel>
      {limits ? <LimitsDialog engagement={e} open onClose={() => setLimits(false)} /> : null}
      {people ? <PeopleDialog engagement={e} open onClose={() => setPeople(false)} /> : null}
      <ConfirmDialog open={stopping} onClose={() => setStopping(false)} title={`Stop ${e.name}?`} confirmLabel="Stop it now" tone="danger" typeToConfirm="stop"
        onConfirm={async () => {
          const r = await stop.run({ params: { engagementId } });
          if (r.ok) say('Stopped: every principal is revoked');
          return r;
        }}>
        <p>Every principal is revoked on its next call, its waiting proposals are withdrawn and its tasks cancelled. It cannot be resumed; what people already confirmed stays.</p>
      </ConfirmDialog>
      <ConfirmDialog open={closing} onClose={() => setClosing(false)} title={`Close ${e.name}?`} confirmLabel="Close it" tone="danger"
        onConfirm={async () => {
          const r = await close.run({ params: { engagementId } });
          if (r.ok) say('Closed');
          return r;
        }}>
        <p>It ends without a hand-over: its principals are revoked and nothing further is proposed. To keep Reliability watching, accept the hand-over instead.</p>
      </ConfirmDialog>
    </Page>
  );
}

function EngagementList() {
  const [params, set] = useParams();
  const people = useDirectory();
  const list = useQuery('listEngagements', {});
  const blocked = useBlocked('startEngagement');
  usePageContext({ scope: { kind: 'page', page: 'connect' }, scopeLabel: 'AI FDE' });
  return (
    <Page title="AI FDE" description="The AI forward-deployed engineer: from connected systems to a confirmed ontology, governed Actions and working apps. It proposes; your people confirm."
      crumbs={[{ label: 'Connect' }]}
      actions={<Button variant="primary" icon="plus" blocked={blocked} onClick={() => set({ new: '1' })}>Start an engagement</Button>}>
      <QueryView query={list} what="Engagements" isEmpty={(d) => d.engagements.length === 0}
        empty={<EmptyState icon="sparkle" title="No engagement yet" action={<Button variant="primary" blocked={blocked} onClick={() => set({ new: '1' })}>Start one</Button>}>
          Give it your goals and a budget, list the systems, and confirm what it proposes stage by stage.
        </EmptyState>}>
        {(d) => (
          <DataTable label="Engagements" rows={d.engagements} rowKey={(x) => x.id} rowHref={(x) => hrefWith('/connect/fde/', { engagement: x.id })} columns={[
            { id: 'name', header: 'Engagement', primary: true, sortValue: (x) => x.name, cell: (x) => x.name },
            { id: 'state', header: 'State', width: 'md', cell: (x) => <Badge tone={STATUS[x.status].tone}>{STATUS[x.status].label}</Badge> },
            { id: 'stage', header: 'Stage', width: 'xs', align: 'end', cell: (x) => `${x.currentStage}/9` },
            { id: 'owner', header: 'Owner', width: 'md', cell: (x) => people.nameOf(x.ownerMembershipId) },
            { id: 'tokens', header: 'Budget used', width: 'md', cell: (x) => `${used(x.tokensConsumed, x.tokenBudget)}% of tokens, £${x.providerCostConsumed}` },
            { id: 'at', header: 'Started', width: 'sm', sortValue: (x) => x.startedAt, cell: (x) => <Time value={x.startedAt} /> },
          ]} />
        )}
      </QueryView>
      {params.get('new') !== null ? <StartDialog open onClose={() => set({ new: undefined })} /> : null}
    </Page>
  );
}

export function Fde() {
  const [params] = useParams();
  const id = params.get('engagement');
  return id !== null ? <EngagementPage key={id} engagementId={id} /> : <EngagementList />;
}
