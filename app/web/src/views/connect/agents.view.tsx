'use client';

// Silo Agents (spec 10): the agents inside the customer's network that reach systems Silo
// cannot reach from outside, only ever connecting out to the cell. Pools of agents, their
// health, version and certificate; a production pool with fewer than two live agents is warned
// of. An enrolment token is shown once, with the address the agent connects to; Silo keeps only
// its hash. Each pool takes new agent releases automatically, on approval, or pinned to one
// version; the releases and the current staged rollout are shown beside them.

import Link from 'next/link';
import { useMemo, useState, type FormEvent } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge, Status } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { CopyButton } from '../../components/copy.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { fieldError, FormActions, RadioGroup, SelectField, TextField } from '../../components/field.component.tsx';
import { Page, Panel, Properties, Section } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useBlocked, useMutation, usePermit, useQuery } from '../../data/query.data.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { connectionHref } from '../../navigation/links.navigation.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { plural } from '../../utils/format.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import styles from './connect.view.module.css';

type Pool = Output<'listAgentPools'>['pools'][number];
type Agent = Pool['agents'][number];
type Releases = Output<'listAgentReleases'>;
type Policy = Pool['updatePolicy'];

const HEALTH: Record<Agent['status'], { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' }> = {
  healthy: { label: 'Healthy', tone: 'ok' },
  unhealthy: { label: 'Unhealthy', tone: 'warn' },
  offline: { label: 'Offline', tone: 'danger' },
  revoked: { label: 'Revoked', tone: 'neutral' },
};

function policyText(p: Pool): string {
  if (p.updatePolicy === 'pinned') return `Pinned to ${p.pinnedVersion ?? 'a version'}`;
  if (p.updatePolicy === 'approval') return p.approvedVersion === null ? 'On approval; none approved yet' : `On approval; ${p.approvedVersion} approved`;
  return 'Automatic';
}

const ROLLOUT: Record<NonNullable<Releases['rollout']>['status'], string> = { running: 'Rolling out', completed: 'Rolled out', halted: 'Halted', superseded: 'Superseded' };
const HALT: Record<NonNullable<NonNullable<Releases['rollout']>['haltReason']>, string> = {
  error_rate: 'agents on it failed too many calls', heartbeat: 'agents on it stopped reporting', refused: 'agents refused it',
};

function NewPoolDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const say = useToast();
  const [, set] = useParams();
  const create = useMutation('createAgentPool', { invalidates: ['listAgentPools'] });
  const [name, setName] = useState('');
  const [environment, setEnvironment] = useState<'production' | 'non_production'>('production');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const r = await create.run({ body: { name: name.trim(), environment } });
    if (r.ok) {
      say(`Pool ${r.data.name} created: enrol its agents next`);
      set({ new: undefined, pool: r.data.id });
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="New agent pool" size="sm" busy={create.pending}
      description="Agents in a pool share its connections: any of them can serve a call, so one can update or fail without stopping them.">
      <form onSubmit={submit} className={styles.form}>
        <TextField label="Name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} data-autofocus
          hint="Where the agents run: “London data centre”, “Plant 2 OT network”." error={fieldError(create.error, 'name')} />
        <RadioGroup name="environment" label="Environment" value={environment} onChange={setEnvironment} options={[
          { value: 'production', label: 'Production', hint: 'Warned of when fewer than two agents are live.' },
          { value: 'non_production', label: 'Non-production', hint: 'For testing; takes new releases first in a rollout.' },
        ]} />
        {create.error !== undefined && fieldError(create.error, 'name') === undefined ? <ErrorMessage error={create.error} /> : null}
        <FormActions>
          <Button onClick={onClose} disabled={create.pending}>Cancel</Button>
          <Button type="submit" variant="primary" pending={create.pending} blocked={create.blocked} disabled={name.trim() === ''}>Create the pool</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

function EnrolDialog({ pool, open, onClose }: { pool: Pool; open: boolean; onClose: () => void }) {
  const issue = useMutation('issueAgentEnrolmentToken');
  const token = issue.data;
  const close = () => {
    issue.reset();
    onClose();
  };
  return (
    <Dialog open={open} onClose={close} title={`Enrol an agent in ${pool.name}`} size="md" busy={issue.pending}
      description="Install the Silo Agent on a host inside your network, then give it a one-time enrolment token. It connects out to this cell over TCP 443; nothing connects in.">
      {token === undefined ? (
        <div className={styles.stack}>
          {issue.error !== undefined ? <ErrorMessage error={issue.error} /> : null}
          <FormActions>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" pending={issue.pending} blocked={issue.blocked} onClick={() => void issue.run({ params: { poolId: pool.id } })}>Make a token</Button>
          </FormActions>
        </div>
      ) : (
        <div className={styles.stack}>
          <Banner tone="ok" title={<>Shown once; valid until <Time value={token.expiresAt} exact /></>}>Silo keeps only its hash. If it is lost, make another.</Banner>
          <div className={styles.secret}>
            <span className={styles.secretLabel}>Enrolment token</span>
            <code className={styles.mono}>{token.token}</code>
            <CopyButton value={token.token} label="Copy the token" />
          </div>
          <div className={styles.secret}>
            <span className={styles.secretLabel}>It connects to</span>
            <code className={styles.mono}>{token.endpoint}</code>
            <CopyButton value={token.endpoint} label="Copy the address" />
          </div>
          <FormActions><Button variant="primary" onClick={close}>Done</Button></FormActions>
        </div>
      )}
    </Dialog>
  );
}

function PolicyDialog({ pool, releases, open, onClose }: { pool: Pool; releases: Releases | undefined; open: boolean; onClose: () => void }) {
  const say = useToast();
  const set = useMutation('setAgentPoolUpdatePolicy', { invalidates: ['listAgentPools'] });
  const [policy, setPolicy] = useState<Policy>(pool.updatePolicy);
  const [version, setVersion] = useState(pool.pinnedVersion ?? '');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const body = policy === 'pinned' ? { policy, version } as const : { policy } as const;
    const r = await set.run({ params: { poolId: pool.id }, body });
    if (r.ok) {
      say('Update policy saved');
      onClose();
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title={`How ${pool.name} takes new releases`} size="md" busy={set.pending}>
      <form onSubmit={submit} className={styles.form}>
        <RadioGroup name="policy" label="Updates" value={policy} onChange={setPolicy} options={[
          { value: 'automatic', label: 'Automatically', hint: 'In Silo\'s staged rollout, one agent at a time, stopping if agents on it fail.' },
          { value: 'approval', label: 'When approved', hint: 'An admin approves each version before the pool takes it.' },
          { value: 'pinned', label: 'Pinned to one version', hint: 'Until it falls below the oldest version Silo still accepts.' },
        ]} />
        {policy === 'pinned' ? (
          <SelectField label="Version" required value={version} onChange={(e) => setVersion(e.target.value)} placeholder="Choose a version"
            options={(releases?.releases ?? []).map((r) => ({ value: r.version, label: `${r.version} (${r.platforms.join(', ')})` }))} error={fieldError(set.error, 'version')} />
        ) : null}
        {set.error !== undefined && fieldError(set.error, 'version') === undefined ? <ErrorMessage error={set.error} /> : null}
        <FormActions>
          <Button onClick={onClose} disabled={set.pending}>Cancel</Button>
          <Button type="submit" variant="primary" pending={set.pending} blocked={set.blocked} disabled={policy === 'pinned' && version === ''}>Save</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

function PoolDetail({ pool, releases, onClose }: { pool: Pool; releases: Releases | undefined; onClose: () => void }) {
  const say = useToast();
  const connectionsPermit = usePermit('listConnections');
  const connections = useQuery('listConnections', connectionsPermit.allowed === true ? { query: { limit: 500 } } : null);
  const revoke = useMutation('revokeAgent', { invalidates: ['listAgentPools'] });
  const approve = useMutation('approveAgentPoolUpdate', { invalidates: ['listAgentPools'] });
  const enrolBlocked = useBlocked('issueAgentEnrolmentToken');
  const policyBlocked = useBlocked('setAgentPoolUpdatePolicy');
  const [enrolling, setEnrolling] = useState(false);
  const [changing, setChanging] = useState(false);
  const [revoking, setRevoking] = useState<Agent | undefined>(undefined);
  const latest = releases?.releases[0]?.version;
  const served = (connections.data?.connections ?? []).filter((c) => c.agentPoolId === pool.id && c.status !== 'revoked');
  const live = pool.agents.filter((a) => a.status === 'healthy').length;
  return (
    <Dialog open onClose={onClose} drawer title={pool.name} description={`${pool.environment === 'production' ? 'Production' : 'Non-production'}; ${plural(live, 'healthy agent')}`}>
      <div className={styles.stack}>
        {pool.underProvisioned ? <Banner tone="warn" title="Fewer than two live agents">A production pool needs at least two, so one can update or fail without stopping its connections.</Banner> : null}
        <div className={styles.row}>
          <Button variant="primary" icon="plus" blocked={enrolBlocked} onClick={() => setEnrolling(true)}>Enrol an agent</Button>
          <Button blocked={policyBlocked} onClick={() => setChanging(true)}>Update policy</Button>
        </div>
        <Panel>
          <Properties items={[
            ['Updates', policyText(pool)],
            pool.approvedAt !== null ? ['Approved', <Time key="a" value={pool.approvedAt} />] : null,
            ['Created', <Time key="c" value={pool.createdAt} />],
            ['Serves', connectionsPermit.allowed === false ? '—' : plural(served.length, 'connection')],
          ]} />
          {pool.updatePolicy === 'approval' && latest !== undefined && latest !== pool.approvedVersion ? (
            <div className={styles.next}>
              <p className={styles.muted}>Version {latest} is out and not yet approved for this pool.</p>
              <Button pending={approve.pending} blocked={approve.blocked} onClick={async () => {
                const r = await approve.run({ params: { poolId: pool.id }, body: { version: latest } });
                if (r.ok) say(`${latest} approved: the pool's agents take it one at a time`);
              }}>Approve {latest}</Button>
            </div>
          ) : null}
          {approve.error !== undefined ? <ErrorMessage error={approve.error} /> : null}
        </Panel>
        <Section title="Agents">
          {pool.agents.length === 0 ? <EmptyState icon="agent" title="No agent enrolled">Enrol one to let the pool serve its connections.</EmptyState> : (
            <DataTable label={`Agents in ${pool.name}`} rows={pool.agents} rowKey={(a) => a.id} columns={[
              { id: 'name', header: 'Agent', primary: true, sortValue: (a) => a.name, cell: (a) => <span className={styles.stackTight}>{a.name}<span className={styles.muted}>{a.hostname}, {a.platform}</span></span> },
              { id: 'health', header: 'Health', width: 'sm', sortValue: (a) => a.status, cell: (a) => <Status tone={HEALTH[a.status].tone}>{HEALTH[a.status].label}</Status> },
              { id: 'version', header: 'Version', width: 'md', cell: (a) => (
                <span className={styles.stackTight}>
                  <span className={styles.row}>{a.version}{a.versionState === 'outdated' ? <Badge tone="warn">Outdated</Badge> : a.versionState === 'refused' ? <Badge tone="danger">Too old</Badge> : null}</span>
                  {a.updatingTo !== null ? <span className={styles.muted}>Updating to {a.updatingTo}</span> : null}
                </span>
              ) },
              { id: 'heard', header: 'Last heard', width: 'sm', sortValue: (a) => a.lastHeartbeatAt, cell: (a) => (a.lastHeartbeatAt === null ? '—' : <Time value={a.lastHeartbeatAt} />) },
              { id: 'cert', header: 'Certificate until', width: 'sm', sortValue: (a) => a.certificateExpiresAt, cell: (a) => <Time value={a.certificateExpiresAt} /> },
              { id: 'revoke', header: <span className="visually-hidden">Revoke</span>, width: 'sm', align: 'end', cell: (a) => (a.status === 'revoked' ? null
                : <Button size="sm" variant="ghost" blocked={revoke.blocked} onClick={() => setRevoking(a)}>Revoke</Button>) },
            ]} />
          )}
        </Section>
        {served.length > 0 ? (
          <Section title="Connections it serves">
            <ul className={styles.plainList}>{served.map((c) => <li key={c.id}><Link href={connectionHref(c.id)}>{c.name}</Link></li>)}</ul>
          </Section>
        ) : null}
      </div>
      {enrolling ? <EnrolDialog pool={pool} open onClose={() => setEnrolling(false)} /> : null}
      {changing ? <PolicyDialog pool={pool} releases={releases} open onClose={() => setChanging(false)} /> : null}
      <ConfirmDialog open={revoking !== undefined} onClose={() => setRevoking(undefined)} title={`Revoke ${revoking?.name ?? 'the agent'}?`} confirmLabel="Revoke" tone="danger"
        onConfirm={async () => {
          const r = await revoke.run({ params: { agentId: revoking!.id } });
          if (r.ok) say('Agent revoked: its certificate no longer works');
          return r;
        }}>
        <p>Its certificate stops working at once and it can no longer reach this cell. The pool's other agents carry on. To use the host again, enrol it afresh.</p>
      </ConfirmDialog>
    </Dialog>
  );
}

function ReleasesPanel({ releases }: { releases: Releases }) {
  const r = releases.rollout;
  return (
    <Section title="Releases" description="New agent versions, rolled out in waves; pools that update automatically take them in turn.">
      {r !== null ? (
        <Banner tone={r.status === 'halted' ? 'warn' : 'info'} title={`${ROLLOUT[r.status]}: ${r.version}`}>
          Wave {r.wave}, since <Time value={r.waveStartedAt} />.{r.haltReason !== null ? ` Stopped because ${HALT[r.haltReason]}.` : ''}
        </Banner>
      ) : null}
      {releases.outdatedBelow !== null ? <p className={styles.muted}>Agents older than {releases.outdatedBelow} are outdated and should be updated.</p> : null}
      <DataTable label="Agent releases" rows={releases.releases} rowKey={(x) => x.releaseId} dense columns={[
        { id: 'version', header: 'Version', primary: true, cell: (x) => x.version },
        { id: 'platforms', header: 'Platforms', cell: (x) => x.platforms.join(', ') },
        { id: 'at', header: 'Released', width: 'md', cell: (x) => <Time value={x.installedAt} /> },
      ]} />
    </Section>
  );
}

export function Agents() {
  const [params, set] = useParams();
  const pools = useQuery('listAgentPools', {}, { refreshMs: 60_000 });
  const releases = useQuery('listAgentReleases', {}, { staleMs: 10 * 60_000 });
  const create = useBlocked('createAgentPool');
  usePageContext({ scope: { kind: 'page', page: 'connect' }, scopeLabel: 'Silo Agents' });
  const active = useMemo(() => (pools.data?.pools ?? []).filter((p) => p.status === 'active'), [pools.data]);
  const openId = params.get('pool');
  const open = active.find((p) => p.id === openId);
  return (
    <Page title="Agents" description="The Silo Agent runs inside your network and reaches systems Silo cannot reach from outside. It only ever connects out, to this cell."
      crumbs={[{ label: 'Connect' }]}
      actions={<Button variant="primary" icon="plus" blocked={create} onClick={() => set({ new: '1' })}>New pool</Button>}>
      <QueryView query={pools} what="Agent pools" isEmpty={() => active.length === 0}
        empty={<EmptyState icon="agent" title="No agent pool yet" action={<Button variant="primary" blocked={create} onClick={() => set({ new: '1' })}>Create a pool</Button>}>
          A pool is where agents for one network live. Create one, then enrol two agents in it.
        </EmptyState>}>
        {() => (
          <DataTable label="Agent pools" rows={active} rowKey={(p) => p.id} rowHref={(p) => hrefWith('/connect/agents/', { pool: p.id })} columns={[
            { id: 'name', header: 'Pool', primary: true, sortValue: (p) => p.name, cell: (p) => p.name },
            { id: 'env', header: 'Environment', width: 'md', cell: (p) => (p.environment === 'production' ? 'Production' : 'Non-production') },
            { id: 'agents', header: 'Agents', width: 'md', cell: (p) => (
              <span className={styles.row}>
                {plural(p.agents.filter((a) => a.status === 'healthy').length, 'healthy', 'healthy')} of {p.agents.filter((a) => a.status !== 'revoked').length}
                {p.underProvisioned ? <Badge tone="warn" icon="warning">Too few</Badge> : null}
              </span>
            ) },
            { id: 'outdated', header: 'Outdated', width: 'sm', cell: (p) => {
              const n = p.agents.filter((a) => a.status !== 'revoked' && a.versionState !== 'current').length;
              return n === 0 ? '—' : <Badge tone="warn">{n}</Badge>;
            } },
            { id: 'updates', header: 'Updates', cell: (p) => policyText(p) },
          ]} />
        )}
      </QueryView>
      {releases.data !== undefined && releases.data.releases.length > 0 ? <ReleasesPanel releases={releases.data} /> : null}
      {params.get('new') !== null ? <NewPoolDialog open onClose={() => set({ new: undefined })} /> : null}
      {open !== undefined ? <PoolDetail key={open.id} pool={open} releases={releases.data} onClose={() => set({ pool: undefined })} /> : null}
    </Page>
  );
}
