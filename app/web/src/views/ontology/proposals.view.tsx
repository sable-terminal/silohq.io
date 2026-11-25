'use client';

// Proposals and review (spec 22.5, 22.6, 25.4 to 25.6). A proposal shows each changed element
// with its change class and why, and the impact on everything that depends on it, counted where
// the reviewer may not see it. A derivation's proposal arrives filled in: each decision with its
// confidence and evidence, the confident ones collapsed to a line, the unsure ones open; the
// person accepts, corrects or rejects each, and what they leave undecided waits in a follow-up
// proposal. Approval is never the author's, and a breaking change needs ontology.manage too;
// the merge is a new main version.

import Link from 'next/link';
import { useState } from 'react';
import type { Input } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button, LinkButton } from '../../components/button.component.tsx';
import { ConfirmDialog } from '../../components/dialog.component.tsx';
import { Checkbox, TextField } from '../../components/field.component.tsx';
import { Page, Panel, Properties, Section, Toolbar } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage, ErrorState, Loading } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { usePageContext, useWorkspace } from '../../shell/context.shell.tsx';
import { plural } from '../../utils/format.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import { CARDINALITY, CHANGE_CLASS, CONFIDENT, EFFECT, EVIDENCE, KIND, OPERATION, ORIGIN, PROPOSAL_STATUS, type Proposal } from './words.view.ts';
import styles from './ontology.view.module.css';

type Decision = Proposal['decisions'][number];
type DecisionInput = Input<'confirmOntologyDecisions'>['body']['decisions'][number];
type Choice = { action: 'accept' | 'reject' | 'correct'; names?: { a: string; b: string } };

function decisionTitle(d: Decision): string {
  return d.kind === 'object_type' ? d.definition.displayName : `${d.definition.forwardName} (${d.definition.from} → ${d.definition.to})`;
}

function DecisionRow({ decision, choice, onChoose, editable }: { decision: Decision; choice: Choice | undefined; onChoose: (c: Choice | undefined) => void; editable: boolean }) {
  const confident = decision.confidence >= CONFIDENT;
  const [open, setOpen] = useState(!confident);
  const names = choice?.names ?? (decision.kind === 'object_type'
    ? { a: decision.definition.displayName, b: decision.definition.pluralName } : { a: decision.definition.forwardName, b: decision.definition.reverseName });
  const status = choice?.action ?? (decision.status === 'undecided' ? undefined : decision.status === 'corrected' ? 'correct' : decision.status === 'accepted' ? 'accept' : 'reject');
  return (
    <Panel>
      <div className={styles.decision}>
        <div className={styles.next}>
          <div>
            <h3 className={styles.subheading}>{decisionTitle(decision)}</h3>
            <span className={styles.row}>
              <span className={styles.muted}>{KIND[decision.kind].one}</span>
              <Badge tone={confident ? 'ok' : decision.confidence >= 0.5 ? 'warn' : 'danger'}>{Math.round(decision.confidence * 100)}% sure</Badge>
              {status !== undefined ? <Badge tone={status === 'reject' ? 'neutral' : 'info'}>{status === 'accept' ? 'Accepted' : status === 'reject' ? 'Rejected' : 'Corrected'}</Badge> : null}
            </span>
          </div>
          {editable && decision.status === 'undecided' ? (
            <span className={styles.row}>
              <Button size="sm" variant={choice?.action === 'accept' ? 'primary' : 'secondary'} onClick={() => onChoose(choice?.action === 'accept' ? undefined : { action: 'accept' })}>Accept</Button>
              <Button size="sm" variant={choice?.action === 'correct' ? 'primary' : 'secondary'} onClick={() => {
                setOpen(true);
                onChoose({ action: 'correct', names });
              }}>Correct</Button>
              <Button size="sm" variant={choice?.action === 'reject' ? 'danger' : 'ghost'} onClick={() => onChoose(choice?.action === 'reject' ? undefined : { action: 'reject' })}>Reject</Button>
            </span>
          ) : null}
        </div>
        {confident ? <Button size="sm" variant="link" onClick={() => setOpen(!open)}>{open ? 'Hide the detail' : 'Show the detail'}</Button> : null}
        {open ? (
          <>
            <p className={styles.muted}>Because of {decision.evidence.map((e) => `${EVIDENCE[e.source]} (${e.detail})`).join('; ') || 'nothing stated'}.</p>
            {decision.kind === 'object_type' ? (
              <p className={styles.muted}>
                From {decision.definition.contributingObjects.map((c) => c.sourceObject).join(', ')}; {plural(decision.definition.properties.length, 'property', 'properties')}
                {decision.definition.matchKeys.length > 0 ? `; matched on ${decision.definition.matchKeys.map((k) => k.property).join(', ')}` : ''}; titled by {decision.definition.title}.
              </p>
            ) : <p className={styles.muted}>{CARDINALITY[decision.definition.cardinality]}; {plural(decision.definition.routes.length, 'route')}.</p>}
            {choice?.action === 'correct' ? (
              <div className={styles.split}>
                <TextField label={decision.kind === 'object_type' ? 'Name' : 'Read forwards'} value={names.a} onChange={(e) => onChoose({ action: 'correct', names: { ...names, a: e.target.value } })} />
                <TextField label={decision.kind === 'object_type' ? 'Plural' : 'Read back'} value={names.b} onChange={(e) => onChoose({ action: 'correct', names: { ...names, b: e.target.value } })} />
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </Panel>
  );
}

function Review({ proposalId }: { proposalId: string }) {
  const say = useToast();
  const people = useDirectory();
  const workspace = useWorkspace();
  const [, set] = useParams();
  const read = useQuery('readOntologyProposal', { params: { proposalId } });
  const decide = useMutation('confirmOntologyDecisions', { invalidates: ['listOntologyProposals'] });
  const approve = useMutation('approveOntologyProposal', { invalidates: ['listOntologyProposals'] });
  const reject = useMutation('rejectOntologyProposal', { invalidates: ['listOntologyProposals'] });
  const withdraw = useMutation('withdrawOntologyProposal', { invalidates: ['listOntologyProposals'] });
  const merge = useMutation('mergeOntologyProposal', { invalidates: ['listOntologyProposals', 'readOntology', 'readVocabulary', 'listOntologyVersions', 'listOntologyBranches'] });
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [rejecting, setRejecting] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const p = read.data;
  usePageContext({ scope: { kind: 'page', page: 'ontology' }, scopeLabel: p?.title ?? 'an ontology proposal' });
  if (p === undefined) {
    return <Page title="Proposal" crumbs={[{ label: 'Ontology' }, { label: 'Proposals', href: '/ontology/proposals/' }]}>
      {read.status === 'error' ? <ErrorState error={read.error} what="The proposal" onRetry={read.refetch} /> : <Loading label="Reading the proposal" />}
    </Page>;
  }
  const mine = p.authorMembershipId === workspace.session.membershipId;
  const live = p.status === 'draft' || p.status === 'in_review' || p.status === 'approved';
  const undecided = p.decisions.filter((d) => d.status === 'undecided');
  const chosen = Object.entries(choices);
  const approvedBy = (perm: 'ontology.confirm' | 'ontology.manage') => p.approvals.some((a) => a.permission === perm);
  const error = decide.error ?? approve.error ?? merge.error;
  const sendDecisions = async () => {
    const decisions: DecisionInput[] = chosen.map(([decisionId, c]) => {
      if (c.action !== 'correct') return { decisionId, action: c.action };
      const d = p.decisions.find((x) => x.id === decisionId)!;
      return d.kind === 'object_type'
        ? { decisionId, action: 'correct', objectType: { ...d.definition, displayName: c.names!.a, pluralName: c.names!.b } as never }
        : { decisionId, action: 'correct', linkType: { ...d.definition, forwardName: c.names!.a, reverseName: c.names!.b } as never };
    });
    const r = await decide.run({ params: { proposalId }, body: { decisions } });
    if (r.ok) {
      setChoices({});
      say(r.data.followUpProposalId !== null ? 'Decided; what you left waits in a follow-up proposal' : 'Decided');
      if (r.data.followUpProposalId !== null) set({ proposal: r.data.followUpProposalId }, { push: true });
    }
  };
  return (
    <Page title={p.title} crumbs={[{ label: 'Ontology' }, { label: 'Proposals', href: '/ontology/proposals/' }]}
      description={p.description ?? undefined}
      meta={<span className={styles.row}>
        <Badge tone={PROPOSAL_STATUS[p.status].tone}>{PROPOSAL_STATUS[p.status].label}</Badge>
        <Badge tone={CHANGE_CLASS[p.highestChangeClass].tone}>{CHANGE_CLASS[p.highestChangeClass].label}</Badge>
        <span>From {ORIGIN[p.origin].toLowerCase()}{p.authorMembershipId !== null ? `, ${people.nameOf(p.authorMembershipId)}` : ''}</span>
      </span>}
      actions={live ? (
        <>
          <LinkButton href={hrefWith('/ontology/model/', { branch: p.branchId })}>See it on its branch</LinkButton>
          {p.status === 'approved'
            ? <Button variant="primary" pending={merge.pending} blocked={merge.blocked} onClick={async () => {
              const r = await merge.run({ params: { proposalId } });
              if (r.ok) say(`Merged: main is now version ${r.data.version.sequence}`);
            }}>Merge into main</Button>
            : <Button variant="primary" pending={approve.pending} blocked={approve.blocked ?? (mine ? 'The author does not approve their own proposal' : undecided.length > 0 ? 'Decide every derivation decision first' : undefined)}
              onClick={async () => {
                const r = await approve.run({ params: { proposalId }, body: { permission: p.requires.confirm && !approvedBy('ontology.confirm') ? 'ontology.confirm' : 'ontology.manage' } });
                if (r.ok) say(r.data.status === 'approved' ? 'Approved: ready to merge' : 'Approved; it still needs ontology.manage for a breaking change');
              }}>Approve</Button>}
          {mine ? <Button variant="ghost" blocked={withdraw.blocked} onClick={() => setWithdrawing(true)}>Withdraw</Button>
            : <Button variant="ghost" blocked={reject.blocked} onClick={() => setRejecting(true)}>Reject</Button>}
        </>
      ) : undefined}>
      {error !== undefined ? <ErrorMessage error={error} /> : null}
      {p.status === 'merged' && p.mergedAt !== null ? <Banner tone="ok" title="Merged">By {people.nameOf(p.mergedBy)}, <Time value={p.mergedAt} />.</Banner> : null}
      <Properties columns={3} items={[
        ['Needs', [p.requires.confirm ? `ontology.confirm${approvedBy('ontology.confirm') ? ' (given)' : ''}` : '', p.requires.manage ? `ontology.manage${approvedBy('ontology.manage') ? ' (given)' : ''}` : ''].filter(Boolean).join(' and ') || 'Nothing more'],
        ['Approvals', p.approvals.length === 0 ? 'None yet' : p.approvals.map((a) => `${people.nameOf(a.membershipId)} (${a.permission})`).join(', ')],
        ['Submitted', p.submittedAt === null ? 'Not yet' : <Time key="s" value={p.submittedAt} />],
      ]} />
      {p.decisions.length > 0 ? (
        <Section title="Decisions" description={undecided.length > 0 ? `${plural(undecided.length, 'decision')} to make. Confident ones are folded; open them to check.` : 'Every decision is made.'}
          actions={chosen.length > 0 ? <Button variant="primary" pending={decide.pending} blocked={decide.blocked} onClick={() => void sendDecisions()}>Record {plural(chosen.length, 'decision')}</Button> : undefined}>
          {undecided.length > 1 ? (
            <Toolbar><Button size="sm" onClick={() => setChoices(Object.fromEntries(undecided.filter((d) => d.confidence >= CONFIDENT).map((d) => [d.id, { action: 'accept' as const }])))}>Accept every confident one</Button></Toolbar>
          ) : null}
          <div className={styles.stack}>
            {p.decisions.map((d) => (
              <DecisionRow key={d.id} decision={d} choice={choices[d.id]} editable={live} onChoose={(c) => {
                const next = { ...choices };
                if (c === undefined) delete next[d.id];
                else next[d.id] = c;
                setChoices(next);
              }} />
            ))}
          </div>
        </Section>
      ) : null}
      <Section title="Changes">
        {p.changes.length === 0 ? <p className={styles.muted}>No change yet.</p> : (
          <DataTable label="Changes" rows={p.changes} rowKey={(c) => `${c.kind}:${c.id}`} columns={[
            { id: 'el', header: 'Element', primary: true, cell: (c) => <span className={styles.stackTight}><Link href={hrefWith('/ontology/model/', { branch: p.branchId, element: c.id }) as never}>{c.apiName}</Link><span className={styles.muted}>{KIND[c.kind].one}</span></span> },
            { id: 'op', header: 'Change', width: 'sm', cell: (c) => OPERATION[c.operation] },
            { id: 'class', header: 'Class', width: 'sm', cell: (c) => <Badge tone={CHANGE_CLASS[c.changeClass].tone}>{CHANGE_CLASS[c.changeClass].label}</Badge> },
            { id: 'why', header: 'Why', cell: (c) => <span className={styles.muted}>{c.notes.join('; ')}</span> },
          ]} />
        )}
      </Section>
      <Section title="Impact" description={p.impactComputedAt === null ? 'Not worked out yet: it is, when the proposal is submitted.' : <>Against main as it was <Time value={p.impactComputedAt} />, counting what you may not see.</>}>
        {p.impact === null ? null : (
          <>
            <Properties columns={3} items={(Object.keys(EFFECT) as (keyof typeof EFFECT)[]).map((e) => [EFFECT[e].label, String(p.impact!.byEffect[e] ?? 0)] as const)} />
            {p.impact.elements.length > 0 ? (
              <DataTable label="Impact by element" rows={p.impact.elements} rowKey={(e) => e.id} dense columns={[
                { id: 'el', header: 'Element', primary: true, cell: (e) => `${KIND[e.kind].one} ${p.changes.find((c) => c.id === e.id)?.apiName ?? ''}` },
                { id: 'effect', header: 'Effect', width: 'md', cell: (e) => <Badge tone={EFFECT[e.effect].tone}>{EFFECT[e.effect].label}</Badge> },
                { id: 'deps', header: 'Dependants', width: 'sm', align: 'end', cell: (e) => String(e.dependants) },
              ]} />
            ) : null}
          </>
        )}
      </Section>
      <ConfirmDialog open={rejecting} onClose={() => setRejecting(false)} title="Reject this proposal?" confirmLabel="Reject" tone="danger"
        onConfirm={async () => {
          const r = await reject.run({ params: { proposalId } });
          if (r.ok) say('Rejected');
          return r;
        }}>
        <p>It is closed without merging. Its branch stays for its author to change and propose again.</p>
      </ConfirmDialog>
      <ConfirmDialog open={withdrawing} onClose={() => setWithdrawing(false)} title="Withdraw your proposal?" confirmLabel="Withdraw" tone="danger"
        onConfirm={async () => {
          const r = await withdraw.run({ params: { proposalId } });
          if (r.ok) say('Withdrawn');
          return r;
        }}>
        <p>Reviewers are no longer asked. The branch stays; propose it again when it is ready.</p>
      </ConfirmDialog>
    </Page>
  );
}

export function Proposals() {
  const people = useDirectory();
  const [params, set] = useParams();
  const all = params.get('all') === '1';
  const list = useQuery('listOntologyProposals', { query: { status: all ? 'all' : 'open', limit: 200 } });
  usePageContext({ scope: { kind: 'page', page: 'ontology' }, scopeLabel: 'Ontology proposals' });
  const id = params.get('proposal');
  if (id !== null) return <Review key={id} proposalId={id} />;
  return (
    <Page title="Proposals" description="Changes to the model waiting for review: each with its change class and its impact on what depends on it."
      crumbs={[{ label: 'Ontology' }]} actions={<LinkButton href="/ontology/branches/?new=1" icon="branch">Open a branch</LinkButton>}>
      <Toolbar><Checkbox label="Show closed proposals" checked={all} onChange={() => set({ all: all ? undefined : '1' })} /></Toolbar>
      <QueryView query={list} what="Proposals" isEmpty={(d) => d.proposals.length === 0}
        empty={<EmptyState icon="check" title="Nothing to review">Proposals appear here when someone proposes a branch, derives types or the AI FDE suggests them.</EmptyState>}>
        {(d) => (
          <DataTable label="Proposals" rows={d.proposals} rowKey={(p) => p.id} rowHref={(p) => hrefWith('/ontology/proposals/', { proposal: p.id })} columns={[
            { id: 'title', header: 'Proposal', primary: true, sortValue: (p) => p.title, cell: (p) => p.title },
            { id: 'status', header: 'State', width: 'md', cell: (p) => <Badge tone={PROPOSAL_STATUS[p.status].tone}>{PROPOSAL_STATUS[p.status].label}</Badge> },
            { id: 'class', header: 'Class', width: 'sm', cell: (p) => <Badge tone={CHANGE_CLASS[p.highestChangeClass].tone}>{CHANGE_CLASS[p.highestChangeClass].label}</Badge> },
            { id: 'what', header: 'What', cell: (p) => <span className={styles.muted}>{plural(p.changes.length, 'change')}{p.decisions.length > 0 ? `, ${p.decisions.filter((x) => x.status === 'undecided').length} to decide` : ''}</span> },
            { id: 'from', header: 'From', width: 'md', cell: (p) => `${ORIGIN[p.origin]}${p.authorMembershipId !== null ? `, ${people.nameOf(p.authorMembershipId)}` : ''}` },
            { id: 'at', header: 'Created', width: 'sm', sortValue: (p) => p.createdAt, cell: (p) => <Time value={p.createdAt} /> },
          ]} />
        )}
      </QueryView>
    </Page>
  );
}

