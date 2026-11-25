'use client';

// Purges (spec 70): deleting what a Silo holds, with a receipt. A purge is previewed first: what
// stops working (history detectors, timelines, observed lead times, search, the Warehouse's copy,
// rows imported from its files) and how many people must approve it. Requested, it waits for that
// approval in Governance, then runs; its receipt says what was removed from each store. A Silo's
// purges are listed (D270), each opening with its impact and receipt.

import { useState } from 'react';
import { Badge } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button, LinkButton } from '../../components/button.component.tsx';
import { Dialog } from '../../components/dialog.component.tsx';
import { FormActions, SelectField, TextField } from '../../components/field.component.tsx';
import { Page, Properties } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { useVocabulary } from '../../hooks/vocabulary.hook.ts';
import { approvalHref } from '../../navigation/links.navigation.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { humanise, plural } from '../../utils/format.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import { idFrom } from '../studio/kit.view.tsx';
import { useSiloChoice } from './overview.view.tsx';
import { PURGE_SCOPE, PURGE_STATUS, type Purge, type Silo } from './words.view.ts';
import styles from './siloes.view.module.css';

type Scope = Purge['scope'];
const SCOPES_FOR: Record<Silo['kind'], Scope[]> = {
  capture: ['silo', 'concept', 'entity'], import: ['silo', 'file', 'object', 'entity'], object_index: ['silo', 'index'], warehouse: ['silo'],
};

/** What a purge stops: the impact a preview or a purge states. */
export function Impact({ impact }: { impact: Purge['impact'] }) {
  const lines = [
    impact.detectors.length > 0 ? `${plural(impact.detectors.length, 'history detector')} stop` : undefined,
    impact.timelines.length > 0 ? `${plural(impact.timelines.length, 'timeline')} lose their history` : undefined,
    impact.leadTimes.length > 0 ? `${plural(impact.leadTimes.length, 'observed lead time')} lose their evidence` : undefined,
    impact.searchRoutes.length > 0 ? `${plural(impact.searchRoutes.length, 'search route')} stop` : undefined,
    impact.warehouse ? 'The Warehouse loses what it copied from here' : undefined,
    impact.importedRows ? 'Rows imported from its files go' : undefined,
  ].filter((x): x is string => x !== undefined);
  return lines.length === 0 ? <p className={styles.muted}>Nothing else stops working.</p> : <ul className={styles.plainList}>{lines.map((l) => <li key={l}>{l}</li>)}</ul>;
}

/** Preview, then request, a purge of a Silo or part of it. */
export function PurgeDialog({ silo, initialScope = 'silo', onClose }: { silo: Silo; initialScope?: Scope; onClose: () => void }) {
  const say = useToast();
  const { data: vocabulary } = useVocabulary();
  const preview = useMutation('previewPurge', { refresh: false });
  const request = useMutation('requestPurge', { invalidates: ['listPurges', 'listSiloes', 'getSilo'] });
  const files = useQuery('listSiloFiles', silo.kind === 'import' ? { params: { siloId: silo.id } } : null);
  const [scope, setScope] = useState<Scope>(initialScope);
  const [objectTypeId, setObjectTypeId] = useState('');
  const [fileId, setFileId] = useState('');
  const [objectRef, setObjectRef] = useState('');
  const needsType = scope === 'concept' || scope === 'entity';
  const needsRef = scope === 'entity' || scope === 'object';
  const ready = (!needsType || objectTypeId !== '') && (scope !== 'file' || fileId !== '') && (!needsRef || objectRef.trim() !== '');
  const body = {
    scope, ...(objectTypeId !== '' && (needsType || scope === 'index') ? { objectTypeId } : {}), ...(scope === 'file' ? { fileId } : {}), ...(needsRef ? { objectRef: objectRef.trim() } : {}),
  };
  const shown = preview.data;
  const types = silo.objectTypes.length > 0 ? (vocabulary?.objectTypes ?? []).filter((t) => silo.objectTypes.some((x) => x.objectTypeId === t.id)) : vocabulary?.objectTypes ?? [];
  return (
    <Dialog open onClose={onClose} title={`Purge from ${silo.name}`} size="md" busy={preview.pending || request.pending}
      description="It is previewed first: what stops working and who must approve. Nothing is removed until it is requested and approved.">
      <form className={styles.form} onSubmit={async (e) => {
        e.preventDefault();
        if (shown === undefined) {
          await preview.run({ params: { siloId: silo.id }, body });
          return;
        }
        const r = await request.run({ params: { siloId: silo.id }, body });
        if (r.ok) {
          say(r.data.status === 'awaiting_approval' ? 'Requested: it waits for approval in Governance' : `Purge ${PURGE_STATUS[r.data.status].label.toLowerCase()}`);
          onClose();
        }
      }}>
        <div className={styles.fields}>
          <SelectField label="What" value={scope} onChange={(e) => {
            setScope(e.target.value as Scope);
            preview.reset();
          }} options={SCOPES_FOR[silo.kind].map((s) => ({ value: s, label: PURGE_SCOPE[s] }))} />
          {needsType || scope === 'index' ? (
            <SelectField label={scope === 'index' ? 'Of the type (optional)' : 'Of the type'} required={needsType} value={objectTypeId} placeholder={scope === 'index' ? 'Every type' : 'Choose a type'}
              onChange={(e) => {
                setObjectTypeId(e.target.value);
                preview.reset();
              }} options={types.map((t) => ({ value: t.id, label: t.pluralName }))} />
          ) : null}
          {scope === 'file' ? (
            <SelectField label="File" required value={fileId} placeholder={files.data === undefined ? 'Listing…' : 'Choose a file'} onChange={(e) => {
              setFileId(e.target.value);
              preview.reset();
            }} options={(files.data?.files ?? []).filter((f) => f.status !== 'purged').map((f) => ({ value: f.id, label: f.filename }))} />
          ) : null}
          {needsRef ? (
            <TextField label={scope === 'entity' ? "The object's reference" : 'The definition object'} required value={objectRef} maxLength={500}
              hint={scope === 'entity' ? 'As its history in this Silo names it.' : 'Its name in the Silo\'s definition.'}
              onChange={(e) => {
                setObjectRef(e.target.value);
                preview.reset();
              }} />
          ) : null}
        </div>
        {shown !== undefined ? (
          <Banner tone="warn" title="What stops working">
            <div className={styles.stackTight}>
              <Impact impact={shown.impact} />
              <span>{shown.approvalsRequired === 0 ? 'It needs no approval: you are its approver.' : `It needs ${plural(shown.approvalsRequired, 'approval')}.`}</span>
            </div>
          </Banner>
        ) : null}
        {preview.error !== undefined ? <ErrorMessage error={preview.error} /> : null}
        {request.error !== undefined ? <ErrorMessage error={request.error} /> : null}
        <FormActions>
          <Button onClick={onClose}>Keep it</Button>
          {shown === undefined
            ? <Button type="submit" pending={preview.pending} blocked={preview.blocked} disabled={!ready}>Preview the purge</Button>
            : <Button type="submit" variant="danger" pending={request.pending} blocked={request.blocked}>Request the purge</Button>}
        </FormActions>
      </form>
    </Dialog>
  );
}

/** /siloes/purges/: a Silo's purges, and one purge with its receipt. */
export function Purges() {
  const people = useDirectory();
  const { lookup } = useVocabulary();
  const [params, set] = useParams();
  const { silo, picker } = useSiloChoice();
  const [requesting, setRequesting] = useState(false);
  const purges = useQuery('listPurges', silo === undefined ? null : { params: { siloId: silo.id }, query: {} });
  const openId = idFrom(params.get('purge'));
  usePageContext({ scope: { kind: 'page', page: 'siloes' }, scopeLabel: 'Purges' });
  return (
    <Page title="Purges" description="Deleting what a Silo holds, previewed first and approved where your organisation asks for it, with a receipt of what was removed."
      crumbs={[{ label: 'Siloes', href: '/siloes/overview/' }]}
      actions={silo !== undefined ? <Button variant="danger" icon="trash" onClick={() => setRequesting(true)}>Purge from {silo.name}</Button> : undefined}>
      <div className={styles.stack}>
        {picker}
        {silo !== undefined ? (
          <QueryView query={purges} what="Purges" isEmpty={(d) => d.purges.length === 0} empty={<EmptyState icon="trash" title="No purges">Nothing has been purged from this Silo.</EmptyState>}>
            {(d) => (
              <DataTable label="Purges" rows={d.purges} rowKey={(p) => p.id} rowHref={(p) => hrefWith('/siloes/purges/', { silo: silo.id, purge: p.id })} columns={[
                { id: 'what', header: 'What', primary: true, cell: (p) => `${PURGE_SCOPE[p.scope]}${p.objectTypeId !== null ? `: ${lookup?.typeName(p.objectTypeId, true) ?? 'a type'}` : ''}${p.objectRef !== null ? `, ${p.objectRef}` : ''}` },
                { id: 'state', header: 'State', width: 'md', cell: (p) => <Badge tone={PURGE_STATUS[p.status].tone}>{PURGE_STATUS[p.status].label}</Badge> },
                { id: 'by', header: 'Asked by', cell: (p) => people.nameOf(p.requestedBy) },
                { id: 'when', header: 'Asked', width: 'sm', cell: (p) => <Time value={p.requestedAt} /> },
                { id: 'receipt', header: 'Receipt', width: 'sm', cell: (p) => (p.receipt ? 'Kept' : '—') },
              ]} />
            )}
          </QueryView>
        ) : null}
      </div>
      {silo !== undefined && openId !== undefined ? <PurgeDetail siloId={silo.id} purgeId={openId} onClose={() => set({ purge: undefined })} /> : null}
      {requesting && silo !== undefined ? <PurgeDialog silo={silo} onClose={() => setRequesting(false)} /> : null}
    </Page>
  );
}

function PurgeDetail({ siloId, purgeId, onClose }: { siloId: string; purgeId: string; onClose: () => void }) {
  const read = useQuery('getPurge', { params: { siloId, purgeId } });
  return (
    <Dialog open onClose={onClose} drawer title="Purge" description={read.data === undefined ? undefined : <Badge tone={PURGE_STATUS[read.data.status].tone}>{PURGE_STATUS[read.data.status].label}</Badge>}>
      <QueryView query={read} what="The purge">
        {(p) => (
          <div className={styles.stack}>
            <Properties columns={1} items={[
              ['What', PURGE_SCOPE[p.scope]],
              ['Asked', <Time key="a" value={p.requestedAt} exact />],
              p.completedAt !== null ? ['Completed', <Time key="c" value={p.completedAt} exact />] : null,
              p.failureStage !== null ? ['Stopped at', humanise(p.failureStage)] : null,
              p.documentHash !== null ? ['What was approved', <span key="h" className={styles.mono}>{p.documentHash.slice(0, 16)}…</span>] : null,
            ]} />
            {p.approvalChainId !== null && p.status === 'awaiting_approval' ? <LinkButton href={approvalHref(p.approvalChainId)}>Its approval in Governance</LinkButton> : null}
            <section className={styles.stackTight}>
              <strong>What it stops</strong>
              <Impact impact={p.impact} />
            </section>
            {p.receipt !== null ? (
              <section className={styles.stackTight} aria-label="Receipt">
                <strong>Receipt, <Time value={p.receipt.completedAt} exact /></strong>
                <ul className={styles.plainList}>{Object.entries(p.receipt.counts).map(([k, n]) => <li key={k}>{humanise(k)}: {n}</li>)}</ul>
                <pre className={styles.code}>{JSON.stringify(p.receipt.removed, null, 2)}</pre>
              </section>
            ) : null}
          </div>
        )}
      </QueryView>
    </Dialog>
  );
}

