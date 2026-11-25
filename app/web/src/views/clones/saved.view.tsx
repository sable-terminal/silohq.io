'use client';

// Saved canvases (spec 29.6, 37): the canvases people have made over object sets: their own,
// shared with them, favourited and archived. A new canvas is made over a saved object set and
// opens at once; a canvas is renamed by saving it, shared (to view, to run, or to copy),
// favourited onto the dashboard, and archived. The Canvas place opens one by its address
// (?view=); without one, it offers recent and favourite canvases and a new one.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Button, IconButton, LinkButton } from '../../components/button.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { FormActions, SelectField, TextField } from '../../components/field.component.tsx';
import { Menu } from '../../components/menu.component.tsx';
import { Page, Toolbar } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { ShareDialog } from '../../components/share.component.tsx';
import { EmptyState, ErrorMessage } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useBlocked, useMutation, usePermits, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { hrefWith } from '../../utils/href.util.ts';
import { Canvas } from './canvas.view.tsx';
import styles from './clones.view.module.css';

type View = Output<'listCanvasViews'>['views'][number];
type Access = 'view' | 'run' | 'copy';

const LAYOUT: Record<View['layoutKind'], string> = {
  spatial_3d: '3D', spatial_map: 'Map or site plan', schematic: 'Schematic', hierarchy: 'Hierarchy', graph_force: 'Graph', graph_layered: 'Layered graph', timeline: 'Timeline', list: 'List',
};
const ACCESS: readonly { value: Access; label: string; hint?: string }[] = [
  { value: 'view', label: 'View', hint: 'Open it, under their own access.' }, { value: 'run', label: 'Run', hint: 'Also use it in apps and Crons.' }, { value: 'copy', label: 'Copy', hint: 'Also make their own copy.' },
];
export const canvasHref = (viewId: string): string => hrefWith('/clones/canvas/', { view: viewId });

function NewCanvasDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const say = useToast();
  const sets = useQuery('listOntologyObjectSets', { query: { limit: 200 } });
  const save = useMutation('saveCanvasView', { invalidates: ['listCanvasViews'] });
  const [setId, setSetId] = useState('');
  const [name, setName] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const r = await save.run({ body: { canvasScope: 'set', objectSetId: setId, name: name.trim(), layoutKind: 'list' } });
    if (r.ok) {
      say('Canvas made: it opens laid out by what its type supports');
      router.push(canvasHref(r.data.id) as never);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="New canvas" size="sm" busy={save.pending} description="A live picture of a saved object set, opened under each viewer's own access.">
      <form className={styles.form} onSubmit={submit}>
        <SelectField label="Object set" required value={setId} onChange={(e) => {
          setSetId(e.target.value);
          if (name === '') setName(sets.data?.objectSets.find((s) => s.id === e.target.value)?.name ?? '');
        }} placeholder={sets.data?.objectSets.length === 0 ? 'Save an object set in Explorer first' : 'Choose a set'}
          options={(sets.data?.objectSets ?? []).map((s) => ({ value: s.id, label: s.name }))} />
        <TextField label="Name" required value={name} onChange={(e) => setName(e.target.value)} />
        {save.error !== undefined ? <ErrorMessage error={save.error} /> : null}
        <FormActions><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" pending={save.pending} blocked={save.blocked} disabled={setId === '' || name.trim() === ''}>Make it</Button></FormActions>
      </form>
    </Dialog>
  );
}

function CanvasTable({ views, label }: { views: readonly View[]; label: string }) {
  const say = useToast();
  const people = useDirectory();
  const permits = usePermits();
  const favourite = useMutation('favouriteCanvasView', { invalidates: ['listCanvasViews'] });
  const unfavourite = useMutation('unfavouriteCanvasView', { invalidates: ['listCanvasViews'] });
  const archive = useMutation('archiveCanvasView', { invalidates: ['listCanvasViews'] });
  const share = useMutation('shareCanvasView', { invalidates: ['listCanvasViewShares'] });
  const revoke = useMutation('revokeCanvasViewShare', { invalidates: ['listCanvasViewShares'] });
  const [sharing, setSharing] = useState<View | undefined>(undefined);
  const [archiving, setArchiving] = useState<View | undefined>(undefined);
  const shares = useQuery('listCanvasViewShares', sharing === undefined ? null : { params: { canvasViewId: sharing.id } });
  return (
    <>
      <DataTable label={label} rows={views} rowKey={(v) => v.id} rowHref={(v) => (v.archivedAt === null ? canvasHref(v.id) : undefined)} columns={[
        { id: 'name', header: 'Canvas', primary: true, sortValue: (v) => v.name, cell: (v) => <span className={styles.row}>{v.name}{v.favourited ? <Badge icon="star">Favourite</Badge> : null}</span> },
        { id: 'layout', header: 'Laid out as', width: 'md', cell: (v) => LAYOUT[v.layoutKind] },
        { id: 'owner', header: 'Owner', width: 'md', cell: (v) => (v.access === 'owner' ? 'You' : people.nameOf(v.ownerMembershipId)) },
        { id: 'shared', header: 'Shared', width: 'sm', cell: (v) => (v.visibility === 'private' ? 'No' : v.visibility === 'org_visible' ? 'Everyone' : 'Yes') },
        { id: 'updated', header: 'Updated', width: 'sm', sortValue: (v) => v.updatedAt, cell: (v) => <Time value={v.updatedAt} /> },
        { id: 'more', header: <span className="visually-hidden">Actions</span>, width: 'xs', align: 'end', cell: (v) => (
          <Menu label={`More for ${v.name}`} items={[
            v.favourited
              ? { label: 'Remove from favourites', icon: 'star', onSelect: () => void unfavourite.run({ params: { canvasViewId: v.id } }) }
              : { label: 'Favourite', icon: 'star', onSelect: () => void favourite.run({ params: { canvasViewId: v.id } }) },
            ...(v.access === 'owner' ? [
              { label: 'Share…', icon: 'share' as const, onSelect: () => setSharing(v), blocked: permits('shareCanvasView') },
              { separator: true as const },
              { label: 'Archive…', icon: 'trash' as const, tone: 'danger' as const, onSelect: () => setArchiving(v), blocked: permits('archiveCanvasView') },
            ] : []),
          ]} renderTrigger={(p) => <IconButton {...p} size="sm" label={`More for ${v.name}`} icon="more" />} />
        ) },
      ]} />
      {favourite.error ?? unfavourite.error ? <ErrorMessage error={favourite.error ?? unfavourite.error} /> : null}
      {sharing !== undefined ? (
        <ShareDialog<Access> open onClose={() => setSharing(undefined)} title={`Share ${sharing.name}`} what="this canvas" access={ACCESS}
          shares={shares.data?.shares.filter((s) => s.state === 'live').map((s) => ({ id: s.id, grantee: s.grantee, access: s.access, createdAt: s.sharedAt, revokedAt: s.revokedAt }))}
          onShare={(grantee, access) => share.run({ params: { canvasViewId: sharing.id }, body: { grantee, access } })}
          onRevoke={(shareId) => revoke.run({ params: { canvasViewId: sharing.id, shareId } })} shareBlocked={share.blocked} revokeBlocked={revoke.blocked} />
      ) : null}
      <ConfirmDialog open={archiving !== undefined} onClose={() => setArchiving(undefined)} title={`Archive ${archiving?.name ?? 'the canvas'}?`} confirmLabel="Archive" tone="danger"
        onConfirm={async () => {
          const r = await archive.run({ params: { canvasViewId: archiving!.id } });
          if (r.ok) say('Archived: people it was shared with are told');
          return r;
        }}><p>It no longer opens. Apps and dashboards that show it say it is archived.</p></ConfirmDialog>
    </>
  );
}

export function SavedCanvases() {
  const [params, set] = useParams();
  const filter = (params.get('filter') ?? 'mine') as 'mine' | 'shared' | 'favourited' | 'archived';
  const list = useQuery('listCanvasViews', { query: { filter, limit: 200 } });
  const blocked = useBlocked('saveCanvasView');
  usePageContext({ scope: { kind: 'page', page: 'clones' }, scopeLabel: 'Saved canvases' });
  return (
    <Page title="Saved canvases" description="Live pictures of object sets, each opened under the viewer's own access." crumbs={[{ label: 'Clones' }]}
      actions={<Button variant="primary" icon="plus" blocked={blocked} onClick={() => set({ new: '1' })}>New canvas</Button>}>
      <Toolbar>
        <SelectField label="Which" hideLabel value={filter} onChange={(e) => set({ filter: e.target.value === 'mine' ? undefined : e.target.value })}
          options={[{ value: 'mine', label: 'Yours' }, { value: 'shared', label: 'Shared with you' }, { value: 'favourited', label: 'Favourites' }, { value: 'archived', label: 'Archived' }]} />
      </Toolbar>
      <QueryView query={list} what="Canvases" isEmpty={(d) => d.views.length === 0}
        empty={<EmptyState icon="clones" title="No canvas here" action={<Button variant="primary" blocked={blocked} onClick={() => set({ new: '1' })}>Make one</Button>}>A canvas draws a saved object set live: by site plan, map, stage, hierarchy, links or time.</EmptyState>}>
        {(d) => <CanvasTable views={d.views} label="Canvases" />}
      </QueryView>
      {params.get('new') !== null ? <NewCanvasDialog open onClose={() => set({ new: undefined })} /> : null}
    </Page>
  );
}

/** The Canvas place: one canvas by its address, or recent and favourite ones to open. */
export function CanvasPlace() {
  const [params, set] = useParams();
  const viewId = params.get('view');
  const recent = useQuery('listCanvasViews', viewId === null ? { query: { filter: 'mine', limit: 20 } } : null);
  const favourites = useQuery('listCanvasViews', viewId === null ? { query: { filter: 'favourited', limit: 20 } } : null);
  const blocked = useBlocked('saveCanvasView');
  usePageContext(viewId === null ? { scope: { kind: 'page', page: 'clones' }, scopeLabel: 'the Clone Canvas' } : {});
  if (viewId !== null) return /^[0-9a-f-]{36}$/.test(viewId) ? <Canvas key={viewId} canvasViewId={viewId} /> : <Page title="Canvas"><EmptyState icon="clones" title="This address does not name a canvas" /></Page>;
  return (
    <Page title="Canvas" description="Open a canvas to see a set of objects live." crumbs={[{ label: 'Clones' }]}
      actions={<><LinkButton href="/clones/saved/">Every canvas</LinkButton><Button variant="primary" icon="plus" blocked={blocked} onClick={() => set({ new: '1' })}>New canvas</Button></>}>
      <QueryView query={favourites} what="Favourites" isEmpty={(d) => d.views.length === 0} empty={null}>
        {(d) => <CanvasTable views={d.views} label="Favourite canvases" />}
      </QueryView>
      <QueryView query={recent} what="Canvases" isEmpty={(d) => d.views.length === 0}
        empty={<EmptyState icon="clones" title="No canvas yet" action={<Button variant="primary" blocked={blocked} onClick={() => set({ new: '1' })}>Make one</Button>}>Save an object set in Explorer, then draw it here. <Link href="/explorer/types/">Explorer</Link></EmptyState>}>
        {(d) => <CanvasTable views={d.views} label="Canvases" />}
      </QueryView>
      {params.get('new') !== null ? <NewCanvasDialog open onClose={() => set({ new: undefined })} /> : null}
    </Page>
  );
}
