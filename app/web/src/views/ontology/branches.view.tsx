'use client';

// Branches (spec 25.3): where the model is changed safely. A branch starts from main's head;
// its changes are listed with their change class (adds only, compatible, breaking) and why;
// when main has moved on it is rebased, each conflicting element kept from the branch or from
// main as the person chooses; then it is proposed for review, or abandoned.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button, LinkButton } from '../../components/button.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { Checkbox, FormActions, RadioGroup, TextArea, TextField } from '../../components/field.component.tsx';
import { Page, Panel, Properties, Section, Toolbar } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage, Loading } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useBlocked, useMutation, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { plural } from '../../utils/format.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import { CHANGE_CLASS, KIND, OPERATION, type Branch } from './words.view.ts';
import styles from './ontology.view.module.css';

type Conflict = Output<'rebaseOntologyBranch'>['conflicts'][number];

const BRANCH_KIND: Record<Branch['kind'], string> = { main: 'Main', working: 'A person\'s', derivation: 'From derivation', scenario: 'A scenario\'s' };

function ProposeDialog({ branch, open, onClose }: { branch: Branch; open: boolean; onClose: () => void }) {
  const say = useToast();
  const router = useRouter();
  const submit = useMutation('submitOntologyProposal', { invalidates: ['listOntologyProposals'] });
  const [title, setTitle] = useState(branch.name);
  const [description, setDescription] = useState('');
  const send = async (event: FormEvent) => {
    event.preventDefault();
    const r = await submit.run({ params: { branchId: branch.id }, body: { title: title.trim(), ...(description.trim() !== '' ? { description: description.trim() } : {}) } });
    if (r.ok) {
      say('Proposed: its impact is worked out and reviewers are asked');
      onClose();
      router.push(hrefWith('/ontology/proposals/', { proposal: r.data.id }) as never);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Propose these changes" size="md" busy={submit.pending}
      description="Reviewers see each change, its class and its impact on everything that depends on it. Someone other than you approves it.">
      <form className={styles.form} onSubmit={send}>
        <TextField label="Title" required value={title} onChange={(e) => setTitle(e.target.value)} data-autofocus />
        <TextArea label="Why" rows={4} value={description} onChange={(e) => setDescription(e.target.value)} hint="What it is for, for the reviewers." />
        {submit.error !== undefined ? <ErrorMessage error={submit.error} /> : null}
        <FormActions><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" pending={submit.pending} blocked={submit.blocked} disabled={title.trim() === ''}>Propose</Button></FormActions>
      </form>
    </Dialog>
  );
}

function RebaseDialog({ branch, open, onClose }: { branch: Branch; open: boolean; onClose: () => void }) {
  const say = useToast();
  const rebase = useMutation('rebaseOntologyBranch', { invalidates: ['readOntologyBranch', 'readOntologyBranchChanges', 'listOntologyBranches', 'readOntology'] });
  const [conflicts, setConflicts] = useState<readonly Conflict[]>([]);
  const [choices, setChoices] = useState<Record<string, 'branch' | 'main'>>({});
  const run = async () => {
    const r = await rebase.run({ params: { branchId: branch.id }, body: conflicts.length > 0 ? { resolutions: choices } : {} });
    if (!r.ok) return;
    if (r.data.rebased) {
      say('Rebased onto main');
      onClose();
    } else {
      setConflicts(r.data.conflicts);
      setChoices(Object.fromEntries(r.data.conflicts.map((c) => [c.id, 'branch' as const])));
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Rebase onto main" size="md" busy={rebase.pending}
      description="Brings the branch up to main's head. Where the branch and main both changed an element, choose which to keep.">
      <div className={styles.stack}>
        {conflicts.length > 0 ? (
          <>
            <Banner tone="warn" title={plural(conflicts.length, 'conflict')}>Both the branch and main changed these. Choose for each.</Banner>
            {conflicts.map((c) => (
              <RadioGroup key={c.id} name={`conflict-${c.id}`} label={`${KIND[c.kind].one} ${c.apiName}`} value={choices[c.id] ?? 'branch'}
                onChange={(v) => setChoices({ ...choices, [c.id]: v })} options={[{ value: 'branch', label: 'Keep the branch\'s' }, { value: 'main', label: 'Take main\'s' }]} />
            ))}
          </>
        ) : null}
        {rebase.error !== undefined ? <ErrorMessage error={rebase.error} /> : null}
        <FormActions><Button onClick={onClose}>Cancel</Button><Button variant="primary" pending={rebase.pending} blocked={rebase.blocked} onClick={() => void run()}>{conflicts.length > 0 ? 'Rebase with these choices' : 'Rebase'}</Button></FormActions>
      </div>
    </Dialog>
  );
}

function BranchDetail({ branchId, onClose }: { branchId: string; onClose: () => void }) {
  const say = useToast();
  const people = useDirectory();
  const read = useQuery('readOntologyBranch', { params: { branchId } });
  const changes = useQuery('readOntologyBranchChanges', { params: { branchId } });
  const abandon = useMutation('abandonOntologyBranch', { invalidates: ['listOntologyBranches'] });
  const [proposing, setProposing] = useState(false);
  const [rebasing, setRebasing] = useState(false);
  const [abandoning, setAbandoning] = useState(false);
  const b = read.data;
  if (b === undefined) return <Dialog open onClose={onClose} drawer title="Branch">{read.status === 'error' ? <ErrorMessage error={read.error} onRetry={read.refetch} /> : <Loading label="Reading the branch" />}</Dialog>;
  const open = b.status === 'open';
  const highest = changes.data?.highestChangeClass ?? null;
  return (
    <Dialog open onClose={onClose} drawer title={b.name} description={<span className={styles.row}><Badge tone={open ? 'info' : 'neutral'}>{b.status}</Badge>{BRANCH_KIND[b.kind]}</span>}>
      <div className={styles.stack}>
        {b.behindMain && open ? <Banner tone="warn" title="Behind main" action={<Button size="sm" onClick={() => setRebasing(true)}>Rebase</Button>}>Main has changed since this branch was opened. Rebase before proposing.</Banner> : null}
        <Properties items={[
          ['Opened by', b.ownerMembershipId === null ? 'Silo' : people.nameOf(b.ownerMembershipId)],
          ['Opened', <Time key="o" value={b.createdAt} />],
          b.closedAt !== null ? ['Closed', <Time key="c" value={b.closedAt} />] : null,
          ['Change', highest === null ? 'Nothing yet' : <Badge key="h" tone={CHANGE_CLASS[highest].tone}>{CHANGE_CLASS[highest].label}</Badge>],
        ]} />
        {open ? (
          <div className={styles.row}>
            <LinkButton href={hrefWith('/ontology/model/', { branch: b.id })} icon="edit" variant="primary">Edit on this branch</LinkButton>
            <Button disabled={(changes.data?.changes.length ?? 0) === 0} onClick={() => setProposing(true)}>Propose</Button>
            <Button variant="ghost" onClick={() => setRebasing(true)}>Rebase</Button>
            <Button variant="ghost" blocked={abandon.blocked} onClick={() => setAbandoning(true)}>Abandon</Button>
          </div>
        ) : null}
        <Section title="Its changes">
          <QueryView query={changes} what="Its changes" isEmpty={(d) => d.changes.length === 0} empty={<p className={styles.muted}>No change yet.</p>}>
            {(d) => (
              <DataTable label="Changes" rows={d.changes} rowKey={(c) => `${c.kind}:${c.id}`} columns={[
                { id: 'el', header: 'Element', primary: true, cell: (c) => <span className={styles.stackTight}><Link href={hrefWith('/ontology/model/', { branch: b.id, element: c.id }) as never}>{c.apiName}</Link><span className={styles.muted}>{KIND[c.kind].one}</span></span> },
                { id: 'op', header: 'Change', width: 'sm', cell: (c) => OPERATION[c.operation] },
                { id: 'class', header: 'Class', width: 'sm', cell: (c) => <Badge tone={CHANGE_CLASS[c.changeClass].tone}>{CHANGE_CLASS[c.changeClass].label}</Badge> },
                { id: 'why', header: 'Why', cell: (c) => <span className={styles.muted}>{c.notes.join('; ')}</span> },
              ]} />
            )}
          </QueryView>
        </Section>
      </div>
      {proposing ? <ProposeDialog branch={b} open onClose={() => setProposing(false)} /> : null}
      {rebasing ? <RebaseDialog branch={b} open onClose={() => setRebasing(false)} /> : null}
      <ConfirmDialog open={abandoning} onClose={() => setAbandoning(false)} title={`Abandon ${b.name}?`} confirmLabel="Abandon" tone="danger"
        onConfirm={async () => {
          const r = await abandon.run({ params: { branchId: b.id } });
          if (r.ok) {
            say('Branch abandoned');
            onClose();
          }
          return r;
        }}>
        <p>Its changes are dropped and nothing more can be saved on it. Main is untouched.</p>
      </ConfirmDialog>
    </Dialog>
  );
}

export function Branches() {
  const say = useToast();
  const people = useDirectory();
  const [params, set] = useParams();
  const all = params.get('all') === '1';
  const list = useQuery('listOntologyBranches', { query: { status: all ? 'all' : 'open', limit: 200 } });
  const openBranch = useMutation('openOntologyBranch', { invalidates: ['listOntologyBranches'] });
  const blocked = useBlocked('openOntologyBranch');
  const [name, setName] = useState('');
  usePageContext({ scope: { kind: 'page', page: 'ontology' }, scopeLabel: 'Ontology branches' });
  const branchId = params.get('branch');
  return (
    <Page title="Branches" description="Change the model safely: on a branch from main, proposed for review, merged when approved."
      crumbs={[{ label: 'Ontology' }]} actions={<Button variant="primary" icon="plus" blocked={blocked} onClick={() => set({ new: '1' })}>Open a branch</Button>}>
      <Toolbar><Checkbox label="Show closed branches" checked={all} onChange={() => set({ all: all ? undefined : '1' })} /></Toolbar>
      <QueryView query={list} what="Branches" isEmpty={(d) => d.branches.filter((b) => b.kind !== 'main').length === 0}
        empty={<EmptyState icon="branch" title="No branch open" action={<Button variant="primary" blocked={blocked} onClick={() => set({ new: '1' })}>Open one</Button>}>Open a branch to change the model.</EmptyState>}>
        {(d) => (
          <DataTable label="Branches" rows={d.branches.filter((b) => b.kind !== 'main')} rowKey={(b) => b.id} rowHref={(b) => hrefWith('/ontology/branches/', { branch: b.id, all: all ? '1' : undefined })} columns={[
            { id: 'name', header: 'Branch', primary: true, sortValue: (b) => b.name, cell: (b) => b.name },
            { id: 'kind', header: 'Kind', width: 'md', cell: (b) => BRANCH_KIND[b.kind] },
            { id: 'state', header: 'State', width: 'md', cell: (b) => <span className={styles.row}><Badge tone={b.status === 'open' ? 'info' : 'neutral'}>{b.status}</Badge>{b.behindMain && b.status === 'open' ? <Badge tone="warn">Behind main</Badge> : null}</span> },
            { id: 'owner', header: 'Opened by', width: 'md', cell: (b) => (b.ownerMembershipId === null ? 'Silo' : people.nameOf(b.ownerMembershipId)) },
            { id: 'at', header: 'Opened', width: 'sm', sortValue: (b) => b.createdAt, cell: (b) => <Time value={b.createdAt} /> },
          ]} />
        )}
      </QueryView>
      <Dialog open={params.get('new') !== null} onClose={() => set({ new: undefined })} title="Open a branch" size="sm" busy={openBranch.pending}>
        <form className={styles.form} onSubmit={async (event) => {
          event.preventDefault();
          const r = await openBranch.run({ body: { name: name.trim() } });
          if (r.ok) {
            say('Branch opened from main');
            setName('');
            set({ new: undefined, branch: r.data.id });
          }
        }}>
          <TextField label="Name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Add supplier ratings" data-autofocus hint="What the change is for." />
          {openBranch.error !== undefined ? <ErrorMessage error={openBranch.error} /> : null}
          <FormActions><Button onClick={() => set({ new: undefined })}>Cancel</Button><Button type="submit" variant="primary" pending={openBranch.pending} disabled={name.trim() === ''}>Open</Button></FormActions>
        </form>
      </Dialog>
      {branchId !== null ? <BranchDetail key={branchId} branchId={branchId} onClose={() => set({ branch: undefined })} /> : null}
      <Panel><p className={styles.muted}>Proposals from branches are reviewed in <Link href="/ontology/proposals/">Proposals</Link>.</p></Panel>
    </Page>
  );
}
