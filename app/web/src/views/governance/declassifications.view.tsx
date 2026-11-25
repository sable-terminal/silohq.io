'use client';

// Declassifications (spec 58.10): taking a marking off something (a type, a property, a source
// field, a connection, a view, an app and the rest), requested by someone named for the marking,
// approved by another person, previewed first (who gains access, what downstream loses its
// marking), and reverted if it was wrong.

import { useState, type FormEvent } from 'react';
import type { Input, Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button, LinkButton } from '../../components/button.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { Checkbox, FormActions, SelectField, TextArea, TextField } from '../../components/field.component.tsx';
import { Page, Properties } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage, Loading } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useBlocked, useMutation, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { useVocabulary } from '../../hooks/vocabulary.hook.ts';
import { approvalHref } from '../../navigation/links.navigation.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { formatNumber } from '../../utils/format.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import styles from './governance.view.module.css';

type Declassification = Output<'readDeclassification'>;
type ResourceType = Input<'requestDeclassification'>['body']['resource']['type'];

const RESOURCE: Record<ResourceType, string> = {
  object_type: 'Object type', property: 'Property', property_mapping: 'Source field', link_type: 'Link type', connection: 'Connection', view: 'Saved view',
  app: 'App', action_type: 'Action type', function: 'Function', interface: 'Interface', silo: 'Silo',
};
const STATUS: Record<Declassification['status'], { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' | 'info' }> = {
  awaiting_approval: { label: 'Waiting for approval', tone: 'warn' }, approved: { label: 'Approved', tone: 'info' }, executed: { label: 'Done', tone: 'ok' },
  rejected: { label: 'Rejected', tone: 'danger' }, expired: { label: 'Expired', tone: 'neutral' }, reverted: { label: 'Reverted', tone: 'neutral' },
};

function RequestDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const say = useToast();
  const [, set] = useParams();
  const { data: vocabulary } = useVocabulary();
  const markings = useQuery('listMarkings', {});
  const connections = useQuery('listConnections', { query: { limit: 500 } });
  const request = useMutation('requestDeclassification', { invalidates: ['listDeclassifications'] });
  const [markingId, setMarkingId] = useState('');
  const [type, setType] = useState<ResourceType>('object_type');
  const [id, setId] = useState('');
  const [justification, setJustification] = useState('');
  const [downstream, setDownstream] = useState(true);
  const options = type === 'object_type' ? (vocabulary?.objectTypes ?? []).map((t) => ({ value: t.id, label: t.displayName }))
    : type === 'connection' ? (connections.data?.connections ?? []).map((c) => ({ value: c.id, label: c.name }))
    : undefined;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const r = await request.run({ body: { markingId, resource: { type, id: id.trim() }, justification: justification.trim(), applyDownstream: downstream } });
    if (r.ok) {
      say('Requested: someone else approves it');
      set({ new: undefined, declassification: r.data.id });
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Request a declassification" size="md" busy={request.pending}
      description="You must be named for the marking. You see who would gain access before anyone approves.">
      <form className={styles.form} onSubmit={submit}>
        <SelectField label="Marking" required value={markingId} onChange={(e) => setMarkingId(e.target.value)} placeholder="Choose a marking"
          options={(markings.data?.markings ?? []).filter((m) => m.retiredAt === null).map((m) => ({ value: m.id, label: m.name }))} />
        <SelectField label="Taken off" value={type} onChange={(e) => {
          setType(e.target.value as ResourceType);
          setId('');
        }} options={(Object.keys(RESOURCE) as ResourceType[]).map((r) => ({ value: r, label: RESOURCE[r] }))} />
        {options !== undefined
          ? <SelectField label={RESOURCE[type]} required value={id} onChange={(e) => setId(e.target.value)} placeholder="Choose" options={options} />
          : <TextField label={`${RESOURCE[type]} id`} required value={id} onChange={(e) => setId(e.target.value)} spellCheck={false} hint={type === 'property_mapping' ? 'From the type\'s field mappings in Types and links.' : undefined} />}
        <Checkbox label="Also from what is built on it" checked={downstream} onChange={() => setDownstream(!downstream)} />
        <TextArea label="Why" required rows={3} value={justification} onChange={(e) => setJustification(e.target.value)} />
        {request.error !== undefined ? <ErrorMessage error={request.error} /> : null}
        <FormActions><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" pending={request.pending} blocked={request.blocked}
          disabled={markingId === '' || id.trim() === '' || justification.trim() === ''}>Request</Button></FormActions>
      </form>
    </Dialog>
  );
}

function Detail({ id, onClose }: { id: string; onClose: () => void }) {
  const say = useToast();
  const people = useDirectory();
  const markings = useQuery('listMarkings', {}, { staleMs: 10 * 60_000 });
  const read = useQuery('readDeclassification', { params: { declassificationId: id } });
  const revert = useMutation('revertDeclassification', { invalidates: ['listDeclassifications'] });
  const [reverting, setReverting] = useState(false);
  const d = read.data;
  const name = (m: string) => markings.data?.markings.find((x) => x.id === m)?.name ?? 'a marking';
  if (d === undefined) return <Dialog open onClose={onClose} drawer title="Declassification">{read.status === 'error' ? <ErrorMessage error={read.error} onRetry={read.refetch} /> : <Loading label="Reading it" />}</Dialog>;
  return (
    <Dialog open onClose={onClose} drawer title={`${name(d.markingId)} off a ${RESOURCE[d.resource.type].toLowerCase()}`} description={<Badge tone={STATUS[d.status].tone}>{STATUS[d.status].label}</Badge>}>
      <div className={styles.stack}>
        <Properties columns={1} items={[
          ['Requested', <span key="r">{people.nameOf(d.requestedBy)}, <Time value={d.createdAt} /></span>],
          ['Why', d.justification],
          ['Markings before', d.preview.markingsBefore.map(name).join(', ') || 'None'],
          ['Markings after', d.preview.markingsAfter.map(name).join(', ') || 'None'],
          ['People gaining access', formatNumber(d.preview.readersGainingAccess)],
          ['Built on it, losing the marking', d.applyDownstream ? formatNumber(d.preview.downstreamLosing) : 'Not applied downstream'],
          d.executedAt !== null ? ['Done', <Time key="e" value={d.executedAt} />] : null,
          d.revertedAt !== null ? ['Reverted', <Time key="v" value={d.revertedAt} />] : null,
        ]} />
        {d.status === 'awaiting_approval' ? <LinkButton href={approvalHref(d.approvalChainId)}>Open its approval</LinkButton> : null}
        {d.status === 'executed' ? <Button variant="ghost" blocked={revert.blocked} onClick={() => setReverting(true)}>Revert it</Button> : null}
        {d.preview.readersGainingAccess > 0 && d.status === 'awaiting_approval' ? <Banner tone="warn">{formatNumber(d.preview.readersGainingAccess)} people would gain access when it is done.</Banner> : null}
      </div>
      <ConfirmDialog open={reverting} onClose={() => setReverting(false)} title="Revert the declassification?" confirmLabel="Revert" tone="danger"
        onConfirm={async () => {
          const r = await revert.run({ params: { declassificationId: id } });
          if (r.ok) say('Reverted: the marking is back');
          return r;
        }}><p>The marking is applied again, to it and to what it reached downstream. People who gained access lose it.</p></ConfirmDialog>
    </Dialog>
  );
}

export function Declassifications() {
  const people = useDirectory();
  const [params, set] = useParams();
  const list = useQuery('listDeclassifications', { query: { limit: 200 } });
  const markings = useQuery('listMarkings', {}, { staleMs: 10 * 60_000 });
  const blocked = useBlocked('requestDeclassification');
  usePageContext({ scope: { kind: 'page', page: 'governance' }, scopeLabel: 'Declassifications' });
  const name = (m: string) => markings.data?.markings.find((x) => x.id === m)?.name ?? 'a marking';
  const id = params.get('declassification');
  return (
    <Page title="Declassifications" description="Markings taken off what they were on: requested by someone named for the marking, approved by another, reversible."
      crumbs={[{ label: 'Governance' }]} actions={<Button variant="primary" icon="plus" blocked={blocked} onClick={() => set({ new: '1' })}>Request one</Button>}>
      <QueryView query={list} what="Declassifications" isEmpty={(d) => d.declassifications.length === 0} empty={<EmptyState icon="shield" title="None yet">Nothing has had a marking taken off.</EmptyState>}>
        {(d) => (
          <DataTable label="Declassifications" rows={d.declassifications} rowKey={(x) => x.id} rowHref={(x) => hrefWith('/governance/declassifications/', { declassification: x.id })} columns={[
            { id: 'marking', header: 'Marking', primary: true, cell: (x) => name(x.markingId) },
            { id: 'off', header: 'Taken off', width: 'md', cell: (x) => RESOURCE[x.resource.type] },
            { id: 'state', header: 'State', width: 'md', cell: (x) => <Badge tone={STATUS[x.status].tone}>{STATUS[x.status].label}</Badge> },
            { id: 'gain', header: 'People gaining access', width: 'md', align: 'end', cell: (x) => formatNumber(x.preview.readersGainingAccess) },
            { id: 'by', header: 'Requested', width: 'md', cell: (x) => <span>{people.nameOf(x.requestedBy)}, <Time value={x.createdAt} /></span> },
          ]} />
        )}
      </QueryView>
      {params.get('new') !== null ? <RequestDialog open onClose={() => set({ new: undefined })} /> : null}
      {id !== null ? <Detail key={id} id={id} onClose={() => set({ declassification: undefined })} /> : null}
    </Page>
  );
}
