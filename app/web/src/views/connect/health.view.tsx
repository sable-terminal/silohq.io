'use client';

// A connection's health (spec 17.4, 17.5): the re-checks that run weekly, after a source refuses
// a request, or when a person asks; what each found (objects it could see, how the system's
// shape drifted); and the repairs proposed for drift, each tried in a sandbox first, waiting
// for someone who may review repairs to apply or reject.

import { useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge, Status } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { Panel, Properties, Section } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage, Loading } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useBlocked, useMutation, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useParam } from '../../hooks/params.hook.ts';
import { useRefreshWhile } from '../../hooks/refresh.hook.ts';
import { plural } from '../../utils/format.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import { CHANGE_KIND, describeChange, DISPOSITION, type Connection } from './words.view.ts';
import styles from './connect.view.module.css';

type Recheck = Output<'listRechecks'>['rechecks'][number];
type Proposal = Output<'listHealProposals'>['proposals'][number];
type Drift = Recheck['drift'][number];

const RECHECK_TRIGGER: Record<Recheck['trigger'], string> = { manual: 'Asked for', self_heal: 'After the source refused a request', weekly: 'Weekly' };

function recheckOutcome(r: Recheck): { label: string; tone: 'ok' | 'warn' | 'danger' | 'info' } {
  if (r.status === 'running') return { label: 'Running', tone: 'info' };
  if (r.halted) return { label: 'Halted the connection', tone: 'danger' };
  if (r.status === 'failed') return { label: 'Could not finish', tone: 'danger' };
  if (r.drift.length > 0) return { label: `${plural(r.drift.length, 'change')} found`, tone: 'warn' };
  return r.healthy ? { label: 'Healthy', tone: 'ok' } : { label: 'Unhealthy', tone: 'warn' };
}

const DRIFT: Record<Drift['kind'], string> = {
  field_absent: 'A field is missing',
  meaning_changed: 'A field changed meaning',
  new_field: 'A new field',
  object_removed: 'An object was removed',
  pushdown_lost: 'The source stopped filtering',
  rename: 'A field was renamed',
  type_changed: 'A field changed type',
  type_widened: 'A field widened',
};

function DriftList({ drift }: { drift: readonly Drift[] }) {
  if (drift.length === 0) return <p className={styles.muted}>No change in the system's shape.</p>;
  return (
    <DataTable label="What changed in the system" rows={drift} rowKey={(d) => `${d.kind}:${d.object}:${d.field ?? ''}`} dense columns={[
      { id: 'kind', header: 'Change', primary: true, cell: (d) => DRIFT[d.kind] },
      { id: 'where', header: 'Where', cell: (d) => <span className={styles.mono}>{d.field === null ? d.object : `${d.object}.${d.field}`}</span> },
      { id: 'detail', header: 'Detail', cell: (d) => <span className={styles.muted}>{d.detail}</span> },
    ]} />
  );
}

function RecheckDetail({ recheckId, onClose }: { recheckId: string; onClose: () => void }) {
  const read = useQuery('getRecheck', { params: { recheckId } });
  const r = read.data;
  useRefreshWhile(r?.status === 'running', read.refetch);
  return (
    <Dialog open onClose={onClose} drawer title="Re-check" description={r === undefined ? undefined : <>Started <Time value={r.startedAt} /></>}>
      {r === undefined ? (read.status === 'error' ? <ErrorMessage error={read.error} onRetry={read.refetch} /> : <Loading label="Reading the re-check" />) : (
        <div className={styles.stack}>
          <Properties items={[
            ['Outcome', <Badge key="o" tone={recheckOutcome(r).tone}>{recheckOutcome(r).label}</Badge>],
            ['Why it ran', RECHECK_TRIGGER[r.trigger]],
            ['Verified', r.verified === null ? 'Not tested' : r.verified ? 'Yes' : 'No'],
            ['Finished', r.completedAt === null ? 'Still running' : <Time key="f" value={r.completedAt} />],
          ]} />
          {r.errors.length > 0 ? <Banner tone="danger" title="What went wrong">{r.errors.join('; ')}</Banner> : null}
          <Section title="Objects">
            <DataTable label="Objects it looked at" rows={r.objects} rowKey={(o) => o.object} dense columns={[
              { id: 'object', header: 'Object', primary: true, cell: (o) => o.object },
              { id: 'seen', header: 'Could see it', width: 'md', cell: (o) => (o.observable ? <Status tone="ok">Yes</Status> : <Status tone="warn">No</Status>) },
              { id: 'records', header: 'Records sampled', width: 'sm', align: 'end', cell: (o) => String(o.records) },
              { id: 'why', header: 'Why not', cell: (o) => <span className={styles.muted}>{o.reason?.replaceAll('_', ' ') ?? ''}</span> },
            ]} />
          </Section>
          <Section title="Drift"><DriftList drift={r.drift} /></Section>
        </div>
      )}
    </Dialog>
  );
}

function ProposalDetail({ proposalId, onClose }: { proposalId: string; onClose: () => void }) {
  const say = useToast();
  const people = useDirectory();
  const read = useQuery('getHealProposal', { params: { proposalId } });
  const decide = useMutation('decideHealProposal', { invalidates: ['listHealProposals', 'getConnection', 'listConnections'] });
  const [rejecting, setRejecting] = useState(false);
  const p = read.data;
  useRefreshWhile(p?.sandbox.status === 'running', read.refetch);
  const accept = async () => {
    const r = await decide.run({ params: { proposalId }, body: { decision: 'accept' } });
    if (r.ok) say('Repair applied: the connection reads the system as it is now');
  };
  return (
    <Dialog open onClose={onClose} drawer title={p === undefined ? 'Repair' : CHANGE_KIND[p.changeKind]} busy={decide.pending}
      description={p === undefined ? undefined : <>Proposed <Time value={p.createdAt} /></>}>
      {p === undefined ? (read.status === 'error' ? <ErrorMessage error={read.error} onRetry={read.refetch} /> : <Loading label="Reading the repair" />) : (
        <div className={styles.stack}>
          <Properties items={[
            ['State', <Badge key="d" tone={DISPOSITION[p.disposition].tone}>{DISPOSITION[p.disposition].label}</Badge>],
            ['Sandbox', p.sandbox.status === 'passed' ? 'Passed its tests' : p.sandbox.status === 'failed' ? `Failed its tests${p.sandbox.reason !== null ? `: ${p.sandbox.reason.replaceAll('_', ' ')}` : ''}` : p.sandbox.status === 'running' ? 'Being tested' : 'Not tried'],
            p.reviewedAt !== null ? ['Decided', <span key="r">{people.nameOf(p.reviewedBy)}, <Time value={p.reviewedAt} /></span>] : null,
          ]} />
          <Section title="The repair">
            <ul className={styles.plainList}>{p.changes.map((c, i) => <li key={i}>{describeChange(c)}</li>)}</ul>
          </Section>
          <Section title="What changed in the system"><DriftList drift={p.drift} /></Section>
          {p.disposition === 'awaiting_review' ? (
            <>
              {p.sandbox.status === 'failed' ? <Banner tone="warn">It failed its tests in the sandbox: applying it may leave the connection unable to read.</Banner> : null}
              {decide.error !== undefined ? <ErrorMessage error={decide.error} /> : null}
              <div className={styles.row}>
                <Button variant="primary" pending={decide.pending} blocked={decide.blocked} onClick={() => void accept()}>Apply the repair</Button>
                <Button variant="ghost" blocked={decide.blocked} onClick={() => setRejecting(true)}>Reject</Button>
              </div>
            </>
          ) : null}
          <ConfirmDialog open={rejecting} onClose={() => setRejecting(false)} title="Reject the repair?" confirmLabel="Reject" tone="danger"
            onConfirm={async () => {
              const r = await decide.run({ params: { proposalId }, body: { decision: 'reject' } });
              if (r.ok) say('Repair rejected');
              return r;
            }}>
            <p>The connection keeps reading the system as it did. Where the system has changed, the affected fields may stay empty until the connector is updated.</p>
          </ConfirmDialog>
        </div>
      )}
    </Dialog>
  );
}

export function Health({ connection }: { connection: Connection }) {
  const say = useToast();
  const [recheckId, setRecheck] = useParam('recheck');
  const [proposalId, setProposal] = useParam('repair');
  const rechecks = useQuery('listRechecks', { params: { connectionId: connection.id }, query: { limit: 20 } });
  const proposals = useQuery('listHealProposals', { query: { connectionId: connection.id, limit: 50 } });
  const request = useMutation('requestRecheck', { invalidates: ['listRechecks'] });
  const reviewBlocked = useBlocked('listHealProposals');
  useRefreshWhile((rechecks.data?.rechecks ?? []).some((r) => r.status === 'running'), rechecks.refetch);
  const waiting = (proposals.data?.proposals ?? []).filter((p) => p.disposition === 'awaiting_review');
  const href = (extra: Record<string, string>) => hrefWith('/connect/connections/', { connection: connection.id, tab: 'health', ...extra });

  return (
    <div className={styles.stack}>
      <Panel>
        <div className={styles.next}>
          <div>
            <h2 className={styles.subheading}>{connection.lastHealthyAt === null ? 'Not yet seen healthy' : <>Last healthy <Time value={connection.lastHealthyAt} /></>}</h2>
            <p className={styles.muted}>Silo re-checks every connection weekly, and at once when a source refuses a request. Check it now after changing something in the system.</p>
          </div>
          {connection.status !== 'revoked' ? (
            <Button icon="refresh" pending={request.pending} blocked={request.blocked} onClick={async () => {
              const r = await request.run({ params: { connectionId: connection.id } });
              if (r.ok) {
                say('Re-check started');
                setRecheck(r.data.id);
              }
            }}>Check it now</Button>
          ) : null}
        </div>
        {request.error !== undefined ? <ErrorMessage error={request.error} /> : null}
      </Panel>
      <Section title="Repairs" description="When the system's shape changes, Silo proposes how the connector should read it now, and tries the repair in a sandbox first.">
        {reviewBlocked !== undefined ? <p className={styles.muted}>{reviewBlocked.message}</p> : (
          <QueryView query={proposals} what="Repairs" isEmpty={(d) => d.proposals.length === 0}
            empty={<EmptyState icon="success" title="No repairs proposed">The system's shape has matched its connector at every re-check.</EmptyState>}>
            {(d) => (
              <>
                {waiting.length > 0 ? <Banner tone="warn" title={`${plural(waiting.length, 'repair')} waiting for review`}>Until one is decided, the fields it touches may read empty.</Banner> : null}
                <DataTable label="Repairs" rows={d.proposals} rowKey={(p: Proposal) => p.id} rowHref={(p) => href({ repair: p.id })} columns={[
                  { id: 'kind', header: 'Change', primary: true, cell: (p) => CHANGE_KIND[p.changeKind] },
                  { id: 'what', header: 'Repair', cell: (p) => <span className={styles.muted}>{p.changes.slice(0, 2).map(describeChange).join('; ')}{p.changes.length > 2 ? `; and ${p.changes.length - 2} more` : ''}</span> },
                  { id: 'state', header: 'State', width: 'md', sortValue: (p) => p.disposition, cell: (p) => <Badge tone={DISPOSITION[p.disposition].tone}>{DISPOSITION[p.disposition].label}</Badge> },
                  { id: 'when', header: 'Proposed', width: 'sm', sortValue: (p) => p.createdAt, cell: (p) => <Time value={p.createdAt} /> },
                ]} />
              </>
            )}
          </QueryView>
        )}
      </Section>
      <Section title="Re-checks">
        <QueryView query={rechecks} what="Re-checks" isEmpty={(d) => d.rechecks.length === 0}
          empty={<EmptyState icon="clock" title="No re-check yet">The first runs within a week of the connection becoming active.</EmptyState>}>
          {(d) => (
            <DataTable label="Re-checks" rows={d.rechecks} rowKey={(r) => r.id} rowHref={(r) => href({ recheck: r.id })} columns={[
              { id: 'started', header: 'Started', primary: true, sortValue: (r) => r.startedAt, cell: (r) => <Time value={r.startedAt} exact /> },
              { id: 'why', header: 'Why it ran', width: 'lg', cell: (r) => RECHECK_TRIGGER[r.trigger] },
              { id: 'outcome', header: 'Outcome', width: 'md', cell: (r) => <Badge tone={recheckOutcome(r).tone}>{recheckOutcome(r).label}</Badge> },
              { id: 'objects', header: 'Objects seen', width: 'sm', align: 'end', cell: (r) => `${r.objects.filter((o) => o.observable).length} of ${r.objects.length}` },
            ]} />
          )}
        </QueryView>
      </Section>
      {recheckId !== undefined ? <RecheckDetail key={recheckId} recheckId={recheckId} onClose={() => setRecheck(undefined)} /> : null}
      {proposalId !== undefined ? <ProposalDetail key={proposalId} proposalId={proposalId} onClose={() => setProposal(undefined)} /> : null}
    </div>
  );
}
