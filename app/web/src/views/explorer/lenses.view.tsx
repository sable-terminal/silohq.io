'use client';

// Lenses (spec 38.9): a person's private working layers over the shared ontology. Each holds
// what they decided (dispositions on findings) and arranged (working sets of objects, findings or
// object sets), never a record value. One applies at a time, chosen here or from the header's
// Lens chip, across Explorer, object views, the canvas, Ask and Recognition. A Lens is shared with
// a person, a team or the organisation to view, use or copy; it resolves against each opener's own
// access, and the share states how much of it each recipient can see.

import { useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Button, IconButton } from '../../components/button.component.tsx';
import { Dialog } from '../../components/dialog.component.tsx';
import { FormActions, TextField } from '../../components/field.component.tsx';
import { Menu } from '../../components/menu.component.tsx';
import { Page, Panel, Properties, Section } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { ShareDialog } from '../../components/share.component.tsx';
import { EmptyState, ErrorMessage } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { useVocabulary } from '../../hooks/vocabulary.hook.ts';
import { findingHref, objectHref } from '../../navigation/links.navigation.ts';
import { usePageContext, useWorkspace } from '../../shell/context.shell.tsx';
import { formatNumber, plural } from '../../utils/format.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import Link from 'next/link';
import styles from './explorer.view.module.css';

type Lens = Output<'listRecognitionLenses'>['lenses'][number];
type OpenedLens = Output<'openRecognitionLens'>;
type Access = 'view' | 'use' | 'copy';

const ACCESS: { value: Access; label: string; hint: string }[] = [
  { value: 'view', label: 'View it', hint: 'See its working sets and dispositions' },
  { value: 'use', label: 'Use it', hint: 'Apply it as their Lens' },
  { value: 'copy', label: 'Copy it', hint: 'Make their own copy to change' },
];

const counts = (l: Pick<Lens, 'dispositions'>) =>
  `${formatNumber(l.dispositions.confirmed)} confirmed, ${formatNumber(l.dispositions.dismissed)} dismissed, ${formatNumber(l.dispositions.deferred)} deferred`;

function NameDialog({ open, title, initial, action, pending, error, onClose, onSave }: {
  open: boolean; title: string; initial: string; action: string; pending: boolean; error: unknown; onClose: () => void; onSave: (name: string) => void;
}) {
  const [name, setName] = useState(initial);
  return (
    <Dialog open={open} onClose={onClose} title={title} size="sm" busy={pending}>
      <form className={styles.stack} onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() !== '') onSave(name.trim());
      }}>
        <TextField label="Name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        {error !== undefined ? <ErrorMessage error={error} /> : null}
        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" pending={pending} disabled={name.trim() === ''}>{action}</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

function WorkingSets({ lens }: { lens: OpenedLens }) {
  const { lookup } = useVocabulary();
  if (lens.workingSets.length === 0) return <p className={styles.muted}>No working sets yet. Findings and objects you gather while this Lens applies are kept here.</p>;
  return (
    <ul className={styles.plainList}>
      {lens.workingSets.map((set, i) => (
        <li key={i}>
          <strong>{set.name}</strong>{' '}
          {set.kind === 'object_set' ? <Link href={hrefWith('/explorer/sets/', { set: set.objectSetId }) as never}>an object set</Link>
            : set.kind === 'findings' ? <span>{plural(set.findingIds.length, 'finding')}: {set.findingIds.slice(0, 5).map((id, n) => <span key={id}>{n > 0 ? ', ' : ''}<Link href={findingHref(id) as never}>{n + 1}</Link></span>)}</span>
            : <span>{plural(set.objectIds.length, lookup?.typeName(set.objectTypeId) ?? 'object')}: {set.objectIds.slice(0, 5).map((id, n) => (
              <span key={id}>{n > 0 ? ', ' : ''}<Link href={objectHref({ objectTypeId: set.objectTypeId, objectId: id }) as never}>{n + 1}</Link></span>
            ))}</span>}
        </li>
      ))}
    </ul>
  );
}

function LensDetail({ lensId, onClose }: { lensId: string; onClose: () => void }) {
  const workspace = useWorkspace();
  const say = useToast();
  const lens = useQuery('openRecognitionLens', { params: { lensId } });
  const shares = useQuery('listRecognitionLensShares', lens.data?.access === 'owner' ? { params: { lensId } } : null);
  const update = useMutation('updateRecognitionLens', { invalidates: ['listRecognitionLenses', 'openRecognitionLens'] });
  const copy = useMutation('copyRecognitionLens', { invalidates: ['listRecognitionLenses'] });
  const share = useMutation('shareRecognitionLens', { invalidates: ['listRecognitionLensShares'] });
  const revoke = useMutation('revokeRecognitionLensShare', { invalidates: ['listRecognitionLensShares'] });
  const [dialog, setDialog] = useState<'rename' | 'copy' | 'share' | undefined>(undefined);
  const [params, set] = useParams();
  return (
    <Dialog open onClose={onClose} drawer title={lens.data?.name ?? 'Lens'} description="A private working layer over the shared ontology.">
      <QueryView query={lens} what="The Lens">
        {(l) => {
          const owner = l.access === 'owner';
          const inUse = workspace.lens?.id === l.id;
          return (
            <div className={styles.stack}>
              <div className={styles.row}>
                {inUse ? <Badge tone="ok">In use</Badge> : (
                  <Button variant="primary" disabled={l.access === 'view'} onClick={() => {
                    workspace.setLens({ id: l.id, name: l.name });
                    say(`${l.name} applies now`);
                  }} blocked={l.access === 'view' ? 'Shared with you to view only' : undefined}>Use this Lens</Button>
                )}
                {owner ? <Button icon="share" onClick={() => setDialog('share')} blocked={share.blocked}>Share</Button> : null}
                {owner ? <Button icon="edit" onClick={() => setDialog('rename')} blocked={update.blocked}>Rename</Button> : null}
                {owner || l.access === 'copy' ? <Button icon="copy" onClick={() => setDialog('copy')}>Make a copy</Button> : null}
              </div>
              {l.statement !== null ? <p className={styles.muted}>{l.statement}</p> : null}
              {l.hidden > 0 ? <p className={styles.muted}>{plural(l.hidden, 'part')} of it {l.hidden === 1 ? 'is' : 'are'} not visible to you.</p> : null}
              <Panel>
                <Properties items={[
                  ['Yours or shared', owner ? 'Yours' : `Shared with you to ${l.access}`],
                  ['Dispositions', counts(l)],
                  ['Made', <Time key="t" value={l.createdAt} />],
                ]} />
              </Panel>
              <Section title="Working sets"><WorkingSets lens={l} /></Section>
              {owner ? (
                <Button variant="ghost" icon="trash" blocked={update.blocked} pending={update.pending} onClick={() => void update.run({ params: { lensId }, body: { archive: true, version: l.version } }).then((r) => {
                  if (!r.ok) return;
                  if (inUse) workspace.setLens(undefined);
                  say('Lens archived');
                  set({ lens: undefined });
                })}>Archive this Lens</Button>
              ) : null}
              {update.error !== undefined ? <ErrorMessage error={update.error} /> : null}
              <NameDialog open={dialog === 'rename'} title="Rename the Lens" initial={l.name} action="Rename" pending={update.pending} error={update.error}
                onClose={() => setDialog(undefined)} onSave={(name) => void update.run({ params: { lensId }, body: { name, version: l.version } }).then((r) => r.ok && setDialog(undefined))} />
              <NameDialog open={dialog === 'copy'} title="Copy the Lens" initial={`${l.name} (copy)`} action="Make the copy" pending={copy.pending} error={copy.error}
                onClose={() => setDialog(undefined)} onSave={(name) => void copy.run({ params: { lensId }, body: { name } }).then((r) => {
                  if (!r.ok) return;
                  setDialog(undefined);
                  set({ lens: r.data.id, ...(params.get('new') === null ? {} : { new: undefined }) });
                })} />
              <ShareDialog<Access> open={dialog === 'share'} onClose={() => setDialog(undefined)} title={`Share ${l.name}`} what="this Lens" access={ACCESS}
                shares={shares.data?.shares.map((s) => ({ id: s.id, grantee: s.grantee, access: s.access, createdAt: s.createdAt, revokedAt: s.revokedAt,
                  note: `could see ${Math.round(s.coverageAtShare * 100)}% of it when shared` }))}
                shareBlocked={share.blocked} revokeBlocked={revoke.blocked}
                onShare={async (grantee, access) => {
                  const r = await share.run({ params: { lensId }, body: { grantee, access } });
                  if (r.ok) say(`Shared. Recipients see ${Math.round(r.data.coverage.lowest * 100)}% to ${Math.round(r.data.coverage.highest * 100)}% of it.`);
                  return r;
                }}
                onRevoke={(shareId) => revoke.run({ params: { shareId } })} />
            </div>
          );
        }}
      </QueryView>
    </Dialog>
  );
}

export function Lenses() {
  const workspace = useWorkspace();
  const [params, set] = useParams();
  const mine = useQuery('listRecognitionLenses', {});
  const shared = useQuery('listSharedRecognitionLenses', {});
  const create = useMutation('createRecognitionLens');
  const lensId = params.get('lens') ?? undefined;
  const making = params.get('new') !== null;
  usePageContext({ scope: { kind: 'page', page: 'explorer' }, scopeLabel: 'Lenses' });

  const columns = (sharedList: boolean) => [
    { id: 'name', header: 'Lens', primary: true, cell: (l: Lens) => <>{l.name} {workspace.lens?.id === l.id ? <Badge tone="ok">In use</Badge> : null}</> },
    { id: 'sets', header: 'Working sets', cell: (l: Lens) => String(l.workingSets.length) },
    { id: 'dispositions', header: 'Dispositions', cell: (l: Lens) => counts(l) },
    { id: 'made', header: sharedList ? 'Made' : 'Made', cell: (l: Lens) => <Time value={l.createdAt} /> },
    { id: 'use', header: <span className="visually-hidden">Use</span>, align: 'end' as const, cell: (l: Lens) => (
      <Menu label={`${l.name} actions`} items={[
        { label: 'Use this Lens', icon: 'lens', disabled: workspace.lens?.id === l.id, onSelect: () => workspace.setLens({ id: l.id, name: l.name }) },
        { label: 'Open', icon: 'arrowRight', onSelect: () => set({ lens: l.id }, { push: true }) },
      ]} renderTrigger={(p) => <IconButton {...p} size="sm" label={`${l.name} actions`} icon="more" />} />
    ) },
  ];

  return (
    <Page title="Lenses" description="Your private working layers over the shared ontology: your dispositions, working sets and the links you rely on. One applies at a time, chosen here or from the Lens chip at the top."
      crumbs={[{ label: 'Explorer', href: '/explorer/types/' }]}
      actions={<Button variant="primary" icon="plus" blocked={create.blocked} onClick={() => set({ new: '1' })}>New Lens</Button>}>
      <Section title="Yours">
        <QueryView query={mine} what="Your Lenses" isEmpty={(d) => d.lenses.length === 0}
          empty={<EmptyState icon="lens" title="No Lenses yet" action={<Button icon="plus" onClick={() => set({ new: '1' })}>New Lens</Button>}>
            A Lens keeps what you decide about findings and what you gather, apart from everyone else's.
          </EmptyState>}>
          {(d) => <DataTable label="Your Lenses" rows={d.lenses} rowKey={(l) => l.id} columns={columns(false)} rowHref={(l) => hrefWith('/explorer/lenses/', { lens: l.id })} />}
        </QueryView>
      </Section>
      <Section title="Shared with you">
        <QueryView query={shared} what="Lenses shared with you" isEmpty={(d) => d.lenses.length === 0} empty={<p className={styles.muted}>None shared with you yet.</p>}>
          {(d) => <DataTable label="Lenses shared with you" rows={d.lenses as Lens[]} rowKey={(l) => l.id} columns={columns(true)} rowHref={(l) => hrefWith('/explorer/lenses/', { lens: l.id })} />}
        </QueryView>
      </Section>
      {lensId !== undefined ? <LensDetail key={lensId} lensId={lensId} onClose={() => set({ lens: undefined })} /> : null}
      <NameDialog open={making} title="New Lens" initial="" action="Make it" pending={create.pending} error={create.error}
        onClose={() => set({ new: undefined })}
        onSave={(name) => void create.run({ body: { name } }).then((r) => {
          if (!r.ok) return;
          workspace.setLens({ id: r.data.id, name: r.data.name });
          set({ new: undefined, lens: r.data.id });
        })} />
    </Page>
  );
}
