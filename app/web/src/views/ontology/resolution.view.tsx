'use client';

// Resolution (spec 23, 24.8): which records in different systems are one object. For a type
// resolved across systems: run resolution (it writes the entity graph from keys and identifiers
// only, and proposes normalisation rules for what did not resolve); review proposals, previewing
// the actual pairs live under your own permissions, then confirm or reject them (never your own);
// propose that two objects are one, or undo a merge you confirmed; and declare which system wins
// a property where they disagree.

import { useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge, Status } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { Checkbox, FormActions, SelectField, TextArea, TextField } from '../../components/field.component.tsx';
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
import { usePageContext, useWorkspace } from '../../shell/context.shell.tsx';
import { formatNumber, plural } from '../../utils/format.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import type { ObjectType } from './words.view.ts';
import styles from './ontology.view.module.css';

type ResolutionProposal = Output<'readResolutionProposal'>;

const KIND: Record<ResolutionProposal['kind'], string> = { normalisation_rule: 'A normalisation rule', pair_list: 'Objects that are one', split: 'Undo a merge' };

function proposalText(p: ResolutionProposal): string {
  const b = p.proposal;
  if (b.kind === 'normalisation_rule') return `${b.steps.length > 0 ? b.steps.join(', then ') : b.cel}: ${plural(b.pairs, 'pair')} from ${formatNumber(b.unmatchedBefore)} unmatched${b.basis === 'model' ? ' (suggested by the model from key shapes)' : ''}`;
  if (b.kind === 'pair_list') return `${plural(b.pairs.length, 'pair')}${b.inference !== undefined ? `, inferred: ${b.inference.statement}` : ''}`;
  return 'Splits a merged object back into the ones it was';
}

function ProposalDetail({ proposalId, onClose }: { proposalId: string; onClose: () => void }) {
  const say = useToast();
  const people = useDirectory();
  const workspace = useWorkspace();
  const read = useQuery('readResolutionProposal', { params: { proposalId } });
  const preview = useMutation('previewResolutionProposal');
  const confirm = useMutation('confirmResolutionProposal', { invalidates: ['listResolutionProposals'] });
  const reject = useMutation('rejectResolutionProposal', { invalidates: ['listResolutionProposals'] });
  const split = useMutation('proposeResolutionSplit', { invalidates: ['listResolutionProposals'] });
  const [rejecting, setRejecting] = useState(false);
  const p = read.data;
  if (p === undefined) return <Dialog open onClose={onClose} drawer title="Proposal">{read.status === 'error' ? <ErrorMessage error={read.error} onRetry={read.refetch} /> : <Loading label="Reading the proposal" />}</Dialog>;
  const mine = p.proposedByMembershipId === workspace.session.membershipId;
  const open = p.status === 'open';
  const merged = p.proposal.kind === 'pair_list' ? p.proposal.merged ?? [] : [];
  return (
    <Dialog open onClose={onClose} drawer title={KIND[p.kind]} busy={confirm.pending || reject.pending}
      description={<span className={styles.row}><Badge tone={open ? 'info' : p.status === 'confirmed' ? 'ok' : 'neutral'}>{p.status}</Badge><span>{plural(p.affectedCount, 'object')} affected</span></span>}>
      <div className={styles.stack}>
        <p>{proposalText(p)}</p>
        <Properties columns={1} items={[
          ['Proposed by', p.proposedByMembershipId !== null ? people.nameOf(p.proposedByMembershipId) : 'Silo, from a run'],
          ['Proposed', <Time key="c" value={p.createdAt} />],
        ]} />
        {p.proposal.kind === 'normalisation_rule' ? <pre className={styles.code}>{p.proposal.cel}</pre> : null}
        <Section title="The pairs it makes" description="Read now, as you; nothing shown here is kept."
          actions={<Button size="sm" pending={preview.pending} blocked={preview.blocked} onClick={() => void preview.run({ params: { proposalId }, body: { limit: 50 } })}>Show them</Button>}>
          {preview.error !== undefined ? <ErrorMessage error={preview.error} /> : null}
          {preview.data !== undefined ? (
            <>
              <p className={styles.muted}>{plural(preview.data.total, 'pair')} in all; the first {preview.data.pairs.length} shown.</p>
              <DataTable label="Pairs" rows={preview.data.pairs} rowKey={(x) => x.key} dense columns={[
                { id: 'key', header: 'Key', primary: true, cell: (x) => <span className={styles.mono}>{x.key}</span> },
                { id: 'sides', header: 'Records', cell: (x) => <span className={styles.stackTight}>{x.sides.map((s) => <span key={`${s.connectionId}:${s.identifier}`} className={styles.mono}>{s.sourceObject} {s.identifier} ({s.key})</span>)}</span> },
              ]} />
            </>
          ) : null}
        </Section>
        {merged.length > 0 && p.status === 'confirmed' ? (
          <Section title="Merges it made">
            <ul className={styles.plainList}>{merged.map((m) => (
              <li key={m.redirectId}><span className={styles.mono}>{m.from.slice(0, 8)} → {m.to.slice(0, 8)}</span>{' '}
                <Button size="sm" variant="ghost" pending={split.pending} blocked={split.blocked} onClick={async () => {
                  const r = await split.run({ body: { redirectId: m.redirectId } });
                  if (r.ok) say('Proposed undoing it: someone else confirms');
                }}>Undo this merge</Button></li>
            ))}</ul>
          </Section>
        ) : null}
        {open ? (
          <>
            {confirm.error !== undefined ? <ErrorMessage error={confirm.error} /> : null}
            <div className={styles.row}>
              <Button variant="primary" pending={confirm.pending} blocked={confirm.blocked ?? (mine ? 'You proposed it: someone else confirms' : undefined)} onClick={async () => {
                const r = await confirm.run({ params: { proposalId } });
                if (r.ok) say('Confirmed');
              }}>Confirm</Button>
              <Button variant="ghost" blocked={reject.blocked} onClick={() => setRejecting(true)}>Reject</Button>
            </div>
          </>
        ) : null}
      </div>
      <ConfirmDialog open={rejecting} onClose={() => setRejecting(false)} title="Reject this proposal?" confirmLabel="Reject" tone="danger"
        onConfirm={async () => {
          const r = await reject.run({ params: { proposalId } });
          if (r.ok) say('Rejected');
          return r;
        }}><p>Nothing changes; the records stay as they resolved.</p></ConfirmDialog>
    </Dialog>
  );
}

function Proposals({ type }: { type: ObjectType }) {
  const [params, set] = useParams();
  const status = (params.get('status') ?? 'open') as 'open' | 'confirmed' | 'rejected';
  const list = useQuery('listResolutionProposals', { query: { objectTypeId: type.id, status, limit: 100 } });
  const id = params.get('proposal');
  return (
    <Section title="Proposals">
      <Toolbar>
        <SelectField label="State" hideLabel value={status} onChange={(e) => set({ status: e.target.value === 'open' ? undefined : e.target.value })}
          options={[{ value: 'open', label: 'Waiting' }, { value: 'confirmed', label: 'Confirmed' }, { value: 'rejected', label: 'Rejected' }]} />
      </Toolbar>
      <QueryView query={list} what="Proposals" isEmpty={(d) => d.proposals.length === 0} empty={<EmptyState icon="link" title="Nothing waiting">Run resolution to look for records that should be one.</EmptyState>}>
        {(d) => (
          <DataTable label="Resolution proposals" rows={d.proposals} rowKey={(p) => p.id} rowHref={(p) => hrefWith('/ontology/resolution/', { type: type.id, tab: 'proposals', proposal: p.id, status: params.get('status') })} columns={[
            { id: 'kind', header: 'Proposal', primary: true, cell: (p) => KIND[p.kind] },
            { id: 'what', header: 'What', cell: (p) => <span className={styles.muted}>{proposalText(p as ResolutionProposal)}</span> },
            { id: 'affected', header: 'Objects', width: 'sm', align: 'end', cell: (p) => formatNumber(p.affectedCount) },
            { id: 'at', header: 'Proposed', width: 'sm', cell: (p) => <Time value={p.createdAt} /> },
          ]} />
        )}
      </QueryView>
      {id !== null ? <ProposalDetail key={id} proposalId={id} onClose={() => set({ proposal: undefined })} /> : null}
    </Section>
  );
}

function Run({ type }: { type: ObjectType }) {
  const say = useToast();
  const [params, set] = useParams();
  const start = useMutation('startResolutionRun', { invalidates: ['listResolutionProposals'] });
  const [analyse, setAnalyse] = useState(true);
  const runId = params.get('run');
  const run = useQuery('readResolutionRun', runId === null ? null : { params: { runId } });
  useRefreshWhile(run.data?.status === 'running', run.refetch, 3000);
  const r = run.data;
  return (
    <Section title="Run resolution" description="Reads every contributing object's keys and identifiers, never other values, and writes which records are one object.">
      <Panel>
        <div className={styles.next}>
          <Checkbox label="Propose rules for what does not resolve" checked={analyse} onChange={() => setAnalyse(!analyse)}
            hint="Deterministic normalisation first; then, for what is left, the model sees key shapes and counts, never a key." />
          <Button variant="primary" icon="play" pending={start.pending} blocked={start.blocked} disabled={r?.status === 'running'} onClick={async () => {
            const out = await start.run({ body: { objectTypeId: type.id, analyse } });
            if (out.ok) {
              say('Resolution started: it carries on if you leave');
              set({ run: out.data.id });
            }
          }}>Run it</Button>
        </div>
        {start.error !== undefined ? <ErrorMessage error={start.error} /> : null}
      </Panel>
      {runId !== null ? (
        r === undefined ? (run.status === 'error' ? <ErrorMessage error={run.error} /> : <Loading label="Reading the run" block={false} />) : (
          <Panel>
            <div className={styles.stack}>
              <span className={styles.row}><Status tone={r.status === 'completed' ? 'ok' : r.status === 'running' ? 'info' : 'danger'}>{r.status}</Status><span className={styles.muted}>Started <Time value={r.startedAt} /></span></span>
              <Properties columns={3} items={[
                ['Objects', formatNumber(r.objects)], ['Without a key', formatNumber(r.unkeyed)], ['Merged', formatNumber(r.entries.merged)],
                ['Added', formatNumber(r.entries.added)], ['Remapped', formatNumber(r.entries.remapped)], ['Gone', formatNumber(r.entries.retired)],
              ]} />
              <DataTable label="By system" rows={r.sources} rowKey={(s) => `${s.connectionId}:${s.sourceObject}`} dense columns={[
                { id: 'obj', header: 'Object', primary: true, cell: (s) => s.sourceObject },
                { id: 'records', header: 'Records', width: 'sm', align: 'end', cell: (s) => formatNumber(s.records) },
                { id: 'alone', header: 'Matched nothing', width: 'sm', align: 'end', cell: (s) => formatNumber(s.unmatched) },
              ]} />
              {r.proposals.length > 0 ? <Banner tone="info" action={<Button size="sm" onClick={() => set({ tab: 'proposals', run: undefined })}>Review them</Button>}>{plural(r.proposals.length, 'proposal')} raised{r.modelConsulted ? '; the model was consulted' : ''}.</Banner> : null}
              {r.notes.length > 0 ? <p className={styles.muted}>{r.notes.join('; ')}</p> : null}
            </div>
          </Panel>
        )
      ) : null}
    </Section>
  );
}

function PairProposal({ type }: { type: ObjectType }) {
  const say = useToast();
  const propose = useMutation('proposeResolutionPairs', { invalidates: ['listResolutionProposals'] });
  const [from, setFrom] = useState<PickedObject | undefined>(undefined);
  const [to, setTo] = useState<PickedObject | undefined>(undefined);
  const [pairs, setPairs] = useState<{ from: PickedObject; to: PickedObject }[]>([]);
  return (
    <Section title="These are one" description="Say that two objects are the same thing; the first becomes the second, and references to it follow. Someone else confirms.">
      <div className={styles.split}>
        <ObjectPicker label="This object" value={from} onChange={setFrom} objectTypeIds={[type.id]} />
        <ObjectPicker label="is the same as" value={to} onChange={setTo} objectTypeIds={[type.id]} />
      </div>
      <FormActions>
        <Button disabled={from === undefined || to === undefined || from.objectId === to.objectId} onClick={() => {
          setPairs([...pairs, { from: from!, to: to! }]);
          setFrom(undefined);
          setTo(undefined);
        }}>Add the pair</Button>
      </FormActions>
      {pairs.length > 0 ? (
        <>
          <ul className={styles.plainList}>{pairs.map((p, i) => <li key={i}>{p.from.title} → {p.to.title} <Button size="sm" variant="ghost" onClick={() => setPairs(pairs.filter((_, j) => j !== i))}>Remove</Button></li>)}</ul>
          {propose.error !== undefined ? <ErrorMessage error={propose.error} /> : null}
          <FormActions>
            <Button variant="primary" pending={propose.pending} blocked={propose.blocked} onClick={async () => {
              const r = await propose.run({ body: { objectTypeId: type.id, pairs: pairs.map((p) => ({ from: p.from.objectId, to: p.to.objectId })) } });
              if (r.ok) {
                setPairs([]);
                say('Proposed: someone else confirms it');
              }
            }}>Propose {plural(pairs.length, 'pair')}</Button>
          </FormActions>
        </>
      ) : null}
    </Section>
  );
}

function Authorities({ type }: { type: ObjectType }) {
  const say = useToast();
  const people = useDirectory();
  const connections = useQuery('listConnections', { query: { limit: 500 } });
  const list = useQuery('listFieldAuthorities', { query: { objectTypeId: type.id } });
  const declare = useMutation('declareFieldAuthority', { invalidates: ['listFieldAuthorities'] });
  const revoke = useMutation('revokeFieldAuthority', { invalidates: ['listFieldAuthorities'] });
  const [property, setProperty] = useState('');
  const [winner, setWinner] = useState('');
  const [condition, setCondition] = useState('');
  const [reason, setReason] = useState('');
  const [declaring, setDeclaring] = useState(false);
  const systems = [...new Set(type.contributingObjects.map((c) => c.connectionId))];
  const name = (id: string) => connections.data?.connections.find((c) => c.id === id)?.name ?? 'a system';
  const propName = (id: string) => type.properties.find((p) => p.identityId === id)?.displayName ?? 'a property';
  return (
    <Section title="Which system wins" description="Where systems hold a property differently, a declared authority decides it instead of showing the disagreement."
      actions={<Button blocked={declare.blocked} onClick={() => setDeclaring(true)}>Declare one</Button>}>
      <QueryView query={list} what="Field authorities" isEmpty={(d) => d.authorities.filter((a) => a.revokedAt === null).length === 0}
        empty={<p className={styles.muted}>None: where systems disagree, the disagreement is shown, never resolved.</p>}>
        {(d) => (
          <DataTable label="Field authorities" rows={d.authorities.filter((a) => a.revokedAt === null)} rowKey={(a) => a.id} columns={[
            { id: 'prop', header: 'Property', primary: true, cell: (a) => propName(a.propertyIdentityId) },
            { id: 'winner', header: 'Decided by', width: 'md', cell: (a) => name(a.winningConnectionId) },
            { id: 'when', header: 'When', cell: (a) => (a.condition === null ? 'Always' : <span className={styles.mono}>{a.condition}</span>) },
            { id: 'why', header: 'Why', cell: (a) => <span className={styles.muted}>{a.reason}, {people.nameOf(a.declaredBy)}</span> },
            { id: 'act', header: <span className="visually-hidden">Revoke</span>, width: 'sm', align: 'end', cell: (a) => <Button size="sm" variant="ghost" blocked={revoke.blocked} onClick={async () => {
              const r = await revoke.run({ params: { authorityId: a.id } });
              if (r.ok) say('Revoked: disagreements on it are shown again');
            }}>Revoke</Button> },
          ]} />
        )}
      </QueryView>
      <Dialog open={declaring} onClose={() => setDeclaring(false)} title="Declare which system wins" size="md" busy={declare.pending}>
        <form className={styles.form} onSubmit={async (event) => {
          event.preventDefault();
          const r = await declare.run({ body: { objectTypeId: type.id, propertyIdentityId: property, winningConnectionId: winner, reason: reason.trim(), ...(condition.trim() !== '' ? { condition: condition.trim() } : {}) } });
          if (r.ok) {
            say('Declared');
            setDeclaring(false);
          }
        }}>
          <SelectField label="Property" required value={property} onChange={(e) => setProperty(e.target.value)} placeholder="Choose a property"
            options={type.properties.filter((p) => p.mappings.length > 1).map((p) => ({ value: p.identityId, label: p.displayName }))} hint="Only properties more than one system holds." />
          <SelectField label="Decided by" required value={winner} onChange={(e) => setWinner(e.target.value)} placeholder="Choose a system" options={systems.map((s) => ({ value: s, label: name(s) }))} />
          <TextField label="Only when (CEL, optional)" value={condition} onChange={(e) => setCondition(e.target.value)} spellCheck={false} />
          <TextArea label="Why" required rows={2} value={reason} onChange={(e) => setReason(e.target.value)} hint="Shown wherever the value is, so people know why it is that system's." />
          {declare.error !== undefined ? <ErrorMessage error={declare.error} /> : null}
          <FormActions><Button onClick={() => setDeclaring(false)}>Cancel</Button><Button type="submit" variant="primary" pending={declare.pending} disabled={property === '' || winner === '' || reason.trim() === ''}>Declare</Button></FormActions>
        </form>
      </Dialog>
    </Section>
  );
}

export function Resolution() {
  const [params, set] = useParams();
  const manifest = useQuery('readOntology', { query: {} });
  usePageContext({ scope: { kind: 'page', page: 'ontology' }, scopeLabel: 'Resolution' });
  const types = (manifest.data?.objectTypes ?? []).filter((t) => t.status !== 'retired' && t.resolutionClass === 'resolvable');
  const type = types.find((t) => t.id === params.get('type')) ?? types[0];
  const tabs: readonly TabDef<'run' | 'proposals' | 'pairs' | 'authority'>[] = [
    { id: 'run', label: 'Run' }, { id: 'proposals', label: 'Proposals' }, { id: 'pairs', label: 'These are one' }, { id: 'authority', label: 'Which system wins' },
  ];
  const [tab, setTab] = useTab(tabs);
  return (
    <Page title="Resolution" description="Which records in different systems are one object, and which system wins where they disagree." crumbs={[{ label: 'Ontology' }]}>
      <QueryView query={manifest} what="The model" isEmpty={() => types.length === 0}
        empty={<EmptyState icon="link" title="No type is resolved across systems">A type held in more than one system, with match keys, is resolved here.</EmptyState>}>
        {() => (type === undefined ? null : (
          <>
            <Toolbar><SelectField label="Object type" value={type.id} onChange={(e) => set({ type: e.target.value, proposal: undefined, run: undefined })} options={types.map((t) => ({ value: t.id, label: t.displayName }))} /></Toolbar>
            <Tabs label="Resolution" tabs={tabs} current={tab} onChange={setTab} />
            <TabPanel id={tab}>
              {tab === 'run' ? <Run key={type.id} type={type} /> : null}
              {tab === 'proposals' ? <Proposals key={type.id} type={type} /> : null}
              {tab === 'pairs' ? <PairProposal key={type.id} type={type} /> : null}
              {tab === 'authority' ? <Authorities key={type.id} type={type} /> : null}
            </TabPanel>
          </>
        ))}
      </QueryView>
    </Page>
  );
}
