'use client';

// Versions (spec 25.1, 25.8): every version of main, newest first, each opening to what it held.
// A rollback restores an earlier version's content as a proposal: its impact, approvals and
// merge are the ordinary ones, and the merge is a new version of kind rollback; nothing is
// rewritten.

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Badge } from '../../components/badge.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { Dialog } from '../../components/dialog.component.tsx';
import { FormActions, TextArea, TextField } from '../../components/field.component.tsx';
import { Page, Properties } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage, Loading } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { hrefWith } from '../../utils/href.util.ts';
import styles from './ontology.view.module.css';

const VERSION_KIND = { change: 'A change', merge: 'A merged proposal', migration: 'A migration', rollback: 'A rollback' } as const;

function VersionDetail({ versionId, sequence, latest, onClose }: { versionId: string; sequence: number; latest: boolean; onClose: () => void }) {
  const say = useToast();
  const router = useRouter();
  const read = useQuery('readOntologyVersion', { params: { versionId } });
  const rollback = useMutation('openOntologyRollback', { invalidates: ['listOntologyProposals'] });
  const [title, setTitle] = useState(`Roll back to version ${sequence}`);
  const [why, setWhy] = useState('');
  const [rolling, setRolling] = useState(false);
  const m = read.data;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const r = await rollback.run({ body: { targetVersionId: versionId, title: title.trim(), ...(why.trim() !== '' ? { description: why.trim() } : {}) } });
    if (r.ok) {
      say('Rollback proposed: it is reviewed like any change');
      router.push(hrefWith('/ontology/proposals/', { proposal: r.data.id }) as never);
    }
  };
  return (
    <Dialog open onClose={onClose} drawer title={`Version ${sequence}`}>
      {m === undefined ? (read.status === 'error' ? <ErrorMessage error={read.error} onRetry={read.refetch} /> : <Loading label="Reading the version" />) : (
        <div className={styles.stack}>
          <Properties columns={1} items={[
            ['Object types', String(m.objectTypes.filter((t) => t.status !== 'retired').length)],
            ['Link types', String(m.linkTypes.filter((l) => l.status !== 'retired').length)],
            ['Shared properties', String(m.sharedProperties.length)],
            ['Interfaces', String(m.interfaces.length)],
            ['Functions', String(m.functions.length)],
          ]} />
          <ul className={styles.chips}>{m.objectTypes.filter((t) => t.status !== 'retired').map((t) => <li key={t.id}>{t.displayName}</li>)}</ul>
          {!latest ? (
            rolling ? (
              <form className={styles.form} onSubmit={submit}>
                <TextField label="Title" required value={title} onChange={(e) => setTitle(e.target.value)} />
                <TextArea label="Why" rows={3} value={why} onChange={(e) => setWhy(e.target.value)} />
                {rollback.error !== undefined ? <ErrorMessage error={rollback.error} /> : null}
                <FormActions><Button onClick={() => setRolling(false)}>Cancel</Button><Button type="submit" variant="primary" pending={rollback.pending} blocked={rollback.blocked}>Propose the rollback</Button></FormActions>
              </form>
            ) : <Button blocked={rollback.blocked} onClick={() => setRolling(true)}>Roll back to this version</Button>
          ) : <p className={styles.muted}>This is main as it stands.</p>}
        </div>
      )}
    </Dialog>
  );
}

export function Versions() {
  const [params, set] = useParams();
  const list = useQuery('listOntologyVersions', { query: { limit: 200 } });
  usePageContext({ scope: { kind: 'page', page: 'ontology' }, scopeLabel: 'Ontology versions' });
  const versions = (list.data?.versions ?? []).filter((v) => v.branchKind === 'main');
  const open = versions.find((v) => v.id === params.get('version'));
  return (
    <Page title="Versions" description="Every version of main, newest first. Questions, receipts and saved answers name the version they used." crumbs={[{ label: 'Ontology' }]}>
      <QueryView query={list} what="Versions" isEmpty={() => versions.length === 0} empty={<EmptyState icon="clock" title="No version yet">The first comes with the first merged change.</EmptyState>}>
        {() => (
          <DataTable label="Versions" rows={versions} rowKey={(v) => v.id} rowHref={(v) => hrefWith('/ontology/versions/', { version: v.id })} columns={[
            { id: 'seq', header: 'Version', primary: true, sortValue: (v) => v.sequence, cell: (v) => <span className={styles.row}>{v.sequence}{v.id === versions[0]?.id ? <Badge tone="ok">Current</Badge> : null}</span> },
            { id: 'kind', header: 'Made by', width: 'md', cell: (v) => VERSION_KIND[v.kind] },
            { id: 'hash', header: 'Content', cell: (v) => <span className={styles.mono}>{v.manifestHash.slice(0, 16)}</span> },
            { id: 'at', header: 'When', width: 'md', sortValue: (v) => v.createdAt, cell: (v) => <Time value={v.createdAt} exact /> },
          ]} />
        )}
      </QueryView>
      {open !== undefined ? <VersionDetail key={open.id} versionId={open.id} sequence={open.sequence} latest={open.id === versions[0]?.id} onClose={() => set({ version: undefined })} /> : null}
    </Page>
  );
}
