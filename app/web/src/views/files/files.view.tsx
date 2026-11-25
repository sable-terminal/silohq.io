'use client';

// Files (spec 41): exports Silo made for a person and files uploaded into an Import Silo, each with
// its markings, where it came from and when it expires, opened under the opener's own access. All
// files (with upload, and a saved view exported as CSV, Excel or PDF), folders to keep them in, and
// what is shared with the person. A file opens in a drawer (?file=) on any of these pages.

import Link from 'next/link';
import { useRef, useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge, Marking } from '../../components/badge.component.tsx';
import { Button, IconButton } from '../../components/button.component.tsx';
import { Dialog } from '../../components/dialog.component.tsx';
import { FormActions, SelectField, TextField } from '../../components/field.component.tsx';
import { Menu } from '../../components/menu.component.tsx';
import { Page, Section } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage } from '../../components/states.component.tsx';
import { DataTable, type Column } from '../../components/table.component.tsx';
import { type TabDef, TabPanel, Tabs, useTab } from '../../components/tabs.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useData, useMutation, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { formatBytes, humanise } from '../../utils/format.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import { idFrom, NameDialog } from '../studio/kit.view.tsx';
import { FileDetail, useDownload, type FileRow } from './fileDetail.view.tsx';
import { base64Of, ONE_REQUEST, sendSigned } from './transfer.view.ts';
import styles from './files.view.module.css';

type Which = 'all' | 'mine' | 'shared';
type Folder = Output<'listFolders'>['folders'][number];
const WHICH: TabDef<Which>[] = [{ id: 'all', label: 'All' }, { id: 'mine', label: 'Yours' }, { id: 'shared', label: 'Shared with you' }];

/** The columns every file list shows. */
function useFileColumns(): Column<FileRow>[] {
  const people = useDirectory();
  const { download, pending } = useDownload();
  const [, set] = useParams();
  return [
    { id: 'name', header: 'Name', primary: true, cell: (f) => (
      <span className={styles.row}>{f.name}{f.markings.map((m) => <Marking key={m.id}>{m.name}</Marking>)}{!f.canOpen ? <Badge>Not opened for you</Badge> : null}</span>
    ) },
    { id: 'kind', header: 'Kind', width: 'sm', cell: (f) => (f.kind === 'export' ? `Export${f.provenance !== null ? `, ${humanise(f.provenance.sourceKind).toLowerCase()}` : ''}` : 'Upload') },
    { id: 'size', header: 'Size', width: 'sm', align: 'end', sortValue: (f) => f.size ?? 0, cell: (f) => (f.size === null ? '—' : formatBytes(f.size)) },
    { id: 'by', header: 'By', cell: (f) => people.nameOf(f.createdBy) },
    { id: 'made', header: 'Made', width: 'sm', sortValue: (f) => f.createdAt, cell: (f) => <Time value={f.createdAt} /> },
    { id: 'expires', header: 'Expires', width: 'sm', cell: (f) => (f.expiresAt === null ? '—' : <Time value={f.expiresAt} />) },
    { id: 'act', header: <span className="visually-hidden">Act</span>, align: 'end', cell: (f) => (
      <Menu label={f.name} items={[
        { label: 'Download', icon: 'download', disabled: !f.canOpen || f.access === 'view' || pending === f.id, onSelect: () => void download(f) },
        { label: 'Open', icon: 'arrowRight', onSelect: () => set({ file: f.id }, { push: true }) },
      ]} renderTrigger={(p) => <IconButton {...p} size="sm" label={`${f.name} actions`} icon="more" />} />
    ) },
  ];
}

function OpenFile() {
  const [params, set] = useParams();
  const id = idFrom(params.get('file'));
  return id === undefined ? null : <FileDetail key={id} fileId={id} onClose={() => set({ file: undefined })} />;
}

/** /files/all/: every file the person holds or is shared, in a folder or not. */
export function AllFiles() {
  const [params, set] = useParams();
  const [which, setWhich] = useTab(WHICH, 'which');
  const folderId = idFrom(params.get('folder'));
  const folders = useQuery('listFolders', { query: {} });
  const list = useQuery('listFiles', { query: { which, ...(folderId === undefined ? {} : { folderId }) } }, { keepPrevious: true });
  const columns = useFileColumns();
  const [dialog, setDialog] = useState<'upload' | 'export' | undefined>(params.get('upload') !== null ? 'upload' : undefined);
  usePageContext({ scope: { kind: 'page', page: 'files' }, scopeLabel: 'Files' });
  const folder = folders.data?.folders.find((f) => f.id === folderId);
  return (
    <Page title={folder === undefined ? 'Files' : folder.name} description="Exports Silo made for you and files uploaded into an Import Silo. Each opens under your own access."
      crumbs={folder === undefined ? [{ label: 'Files' }] : [{ label: 'Files', href: '/files/all/' }, { label: 'Folders', href: '/files/folders/' }]}
      actions={
        <div className={styles.row}>
          <Button icon="download" onClick={() => setDialog('export')}>Export a saved view</Button>
          <Button variant="primary" icon="upload" onClick={() => setDialog('upload')}>Upload</Button>
        </div>
      }>
      <div className={styles.stack}>
        <div className={styles.rowEnd}>
          <SelectField label="Folder" value={folderId ?? ''} onChange={(e) => set({ folder: e.target.value || undefined })}
            options={[{ value: '', label: 'Every folder' }, ...(folders.data?.folders ?? []).map((f) => ({ value: f.id, label: f.name }))]} />
        </div>
        <Tabs label="Which files" tabs={WHICH} current={which} onChange={setWhich} />
        <TabPanel id={which}>
          <QueryView query={list} what="Files" isEmpty={(d) => d.files.length === 0}
            empty={<EmptyState icon="files" title="No files here" action={<Button icon="upload" onClick={() => setDialog('upload')}>Upload</Button>}>Exports you make, and files you upload, are kept here.</EmptyState>}>
            {(d) => <DataTable label="Files" rows={d.files} rowKey={(f) => f.id} rowHref={(f) => hrefWith('/files/all/', { which: which === 'all' ? undefined : which, folder: folderId, file: f.id })} columns={columns} />}
          </QueryView>
        </TabPanel>
      </div>
      <OpenFile />
      {dialog === 'upload' ? <UploadDialog folderId={folderId} onClose={() => setDialog(undefined)} /> : null}
      {dialog === 'export' ? <ExportDialog folderId={folderId} onClose={() => setDialog(undefined)} /> : null}
    </Page>
  );
}

/** A file into an Import Silo, through Files: one request when small, a signed transfer when large. */
function UploadDialog({ folderId, onClose }: { folderId: string | undefined; onClose: () => void }) {
  const say = useToast();
  const { api, cache } = useData();
  const siloes = useQuery('listSiloes', { query: {} });
  const input = useRef<HTMLInputElement>(null);
  const [siloId, setSiloId] = useState('');
  const [state, setState] = useState<{ pending: boolean; error: unknown }>({ pending: false, error: undefined });
  const imports = (siloes.data?.siloes ?? []).filter((s) => s.kind === 'import' && (s.status === 'active' || s.status === 'provisioning'));
  return (
    <Dialog open onClose={onClose} title="Upload a file" size="md" busy={state.pending} description="It is kept in an Import Silo, with that Silo's retention and markings.">
      <form className={styles.form} onSubmit={async (e) => {
        e.preventDefault();
        const file = input.current?.files?.[0];
        if (file === undefined || siloId === '') return;
        setState({ pending: true, error: undefined });
        try {
          const folder = folderId === undefined ? {} : { folderId };
          if (file.size <= ONE_REQUEST) {
            await api.call('uploadToFiles', { body: { siloId, name: file.name, contentBase64: await base64Of(file), ...folder } }, { idempotencyKey: crypto.randomUUID() });
          } else {
            const transfer = await api.call('beginUploadToFiles', { body: { siloId, sizeBytes: file.size, ...folder } });
            await sendSigned(transfer, file);
            await api.call('completeUploadToFiles', { params: { uploadId: transfer.uploadId }, body: { siloId, name: file.name } }, { idempotencyKey: crypto.randomUUID() });
          }
          cache.invalidateAfter('uploadToFiles', ['listFiles']);
          say(`${file.name} uploaded`);
          onClose();
        } catch (error) {
          setState({ pending: false, error });
        }
      }}>
        {siloes.data !== undefined && imports.length === 0 ? <p className={styles.muted}>Uploading needs an Import Silo. An administrator makes one under Siloes.</p> : (
          <SelectField label="Into" required value={siloId} placeholder={siloes.data === undefined ? 'Listing…' : 'Choose an Import Silo'} onChange={(e) => setSiloId(e.target.value)}
            options={imports.map((s) => ({ value: s.id, label: s.name }))} />
        )}
        <label className={styles.stackTight}>
          <span>File</span>
          <input ref={input} type="file" required className={styles.fileInput} aria-label="File" />
        </label>
        {state.error !== undefined ? <ErrorMessage error={state.error} /> : null}
        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" pending={state.pending} disabled={siloId === ''}>Upload</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

/** A saved view's result, run for the person now, kept as a file. */
function ExportDialog({ folderId, onClose }: { folderId: string | undefined; onClose: () => void }) {
  const say = useToast();
  const views = useQuery('listWorkspaceViews', { query: {} });
  const exportIt = useMutation('exportToFiles', { invalidates: ['listFiles'] });
  const [viewId, setViewId] = useState('');
  const [format, setFormat] = useState<'csv' | 'xlsx' | 'pdf'>('csv');
  const [name, setName] = useState('');
  const exportable = (views.data?.views ?? []).filter((v) => v.manifestId !== null && v.archivedAt === null);
  const chosen = exportable.find((v) => v.id === viewId);
  const refused = exportIt.data?.outcome === 'refused' ? exportIt.data : undefined;
  return (
    <Dialog open onClose={onClose} title="Export a saved view" size="md" busy={exportIt.pending} description="Its answer is read for you now and kept as a file; what you may not see is not in it.">
      <form className={styles.form} onSubmit={async (e) => {
        e.preventDefault();
        if (chosen === undefined || chosen.manifestId === null) return;
        const r = await exportIt.run({ body: { planId: chosen.manifestId, format, name: name.trim() || chosen.name, source: { kind: 'view', savedViewId: chosen.id }, ...(folderId === undefined ? {} : { folderId }) } });
        if (r.ok && r.data.outcome === 'exported') {
          say(`Saved as ${r.data.file.name}: ${r.data.rows} rows`);
          onClose();
        }
      }}>
        <SelectField label="Saved view" required value={viewId} placeholder={views.data === undefined ? 'Listing…' : 'Choose a saved view'} onChange={(e) => {
          setViewId(e.target.value);
          setName(exportable.find((v) => v.id === e.target.value)?.name ?? '');
        }} options={exportable.map((v) => ({ value: v.id, label: v.name }))}
          hint={views.data !== undefined && exportable.length === 0 ? 'Save a question or an object set as a view first.' : undefined} />
        <div className={styles.fields}>
          <SelectField label="As" value={format} onChange={(e) => setFormat(e.target.value as typeof format)}
            options={[{ value: 'csv', label: 'CSV' }, { value: 'xlsx', label: 'Excel' }, { value: 'pdf', label: 'PDF' }]} />
          <TextField label="Name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
        </div>
        {refused !== undefined ? <ErrorMessage error={new Error(refused.reason)} /> : null}
        {exportIt.error !== undefined ? <ErrorMessage error={exportIt.error} /> : null}
        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" pending={exportIt.pending} blocked={exportIt.blocked} disabled={chosen === undefined}>Export</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

/** /files/folders/: folders within folders; a folder's files open in All files. */
export function Folders() {
  const say = useToast();
  const folders = useQuery('listFolders', { query: {} });
  const create = useMutation('createFolder', { invalidates: ['listFolders'] });
  const update = useMutation('updateFolder', { invalidates: ['listFolders'] });
  const [dialog, setDialog] = useState<{ kind: 'new'; parentId: string | undefined } | { kind: 'rename' | 'move'; folder: Folder } | undefined>();
  const [parentId, setParentId] = useState('');
  usePageContext({ scope: { kind: 'page', page: 'files' }, scopeLabel: 'Folders' });
  const all = folders.data?.folders ?? [];
  const children = (id: string | null) => all.filter((f) => f.parentId === id).sort((a, b) => a.name.localeCompare(b.name));
  /** A folder and every folder within it: where it may not be moved. */
  const within = (id: string): Set<string> => new Set([id, ...children(id).flatMap((c) => [...within(c.id)])]);
  const tree = (id: string | null) => (
    <ul className={styles.tree}>{children(id).map((f) => (
      <li key={f.id}>
        <div className={styles.treeRow}>
          <Link href={hrefWith('/files/all/', { folder: f.id }) as never}>{f.name}</Link>
          <Menu label={f.name} items={[
            { label: 'New folder inside', icon: 'plus', blocked: create.blocked, onSelect: () => setDialog({ kind: 'new', parentId: f.id }) },
            { label: 'Rename', icon: 'edit', blocked: update.blocked, onSelect: () => setDialog({ kind: 'rename', folder: f }) },
            { label: 'Move', icon: 'folder', blocked: update.blocked, onSelect: () => {
              setParentId(f.parentId ?? '');
              setDialog({ kind: 'move', folder: f });
            } },
          ]} renderTrigger={(p) => <IconButton {...p} size="sm" label={`${f.name} actions`} icon="more" />} />
        </div>
        {children(f.id).length > 0 ? tree(f.id) : null}
      </li>
    ))}</ul>
  );
  return (
    <Page title="Folders" description="Keep files together. A folder's files open in All files." crumbs={[{ label: 'Files', href: '/files/all/' }]}
      actions={<Button variant="primary" icon="plus" blocked={create.blocked} onClick={() => setDialog({ kind: 'new', parentId: undefined })}>New folder</Button>}>
      <QueryView query={folders} what="Folders" isEmpty={(d) => d.folders.length === 0}
        empty={<EmptyState icon="folder" title="No folders yet">Folders keep exports and uploads together.</EmptyState>}>
        {() => tree(null)}
      </QueryView>
      <NameDialog key={dialog?.kind === 'new' ? `new:${dialog.parentId ?? ''}` : 'new'} open={dialog?.kind === 'new'} title="New folder" initial="" action="Make the folder" pending={create.pending} error={create.error}
        hint={dialog?.kind === 'new' && dialog.parentId !== undefined ? `Inside ${all.find((f) => f.id === dialog.parentId)?.name ?? 'its folder'}.` : undefined}
        onClose={() => setDialog(undefined)}
        onSave={(name) => void create.run({ body: { name, ...(dialog?.kind === 'new' && dialog.parentId !== undefined ? { parentId: dialog.parentId } : {}) } }).then((r) => {
          if (!r.ok) return;
          setDialog(undefined);
          say('Folder made');
        })} />
      <NameDialog key={dialog?.kind === 'rename' ? `rename:${dialog.folder.id}` : 'rename'} open={dialog?.kind === 'rename'} title="Rename the folder"
        initial={dialog?.kind === 'rename' ? dialog.folder.name : ''} action="Rename" pending={update.pending} error={update.error}
        onClose={() => setDialog(undefined)}
        onSave={(name) => dialog?.kind === 'rename' && void update.run({ params: { folderId: dialog.folder.id }, body: { name } }).then((r) => r.ok && setDialog(undefined))} />
      <Dialog open={dialog?.kind === 'move'} onClose={() => setDialog(undefined)} title="Move the folder" size="sm" busy={update.pending}>
        {dialog?.kind === 'move' ? (
          <form className={styles.form} onSubmit={async (e) => {
            e.preventDefault();
            const r = await update.run({ params: { folderId: dialog.folder.id }, body: { parentId: parentId === '' ? null : parentId } });
            if (r.ok) setDialog(undefined);
          }}>
            <SelectField label="Into" value={parentId} onChange={(e) => setParentId(e.target.value)}
              options={[{ value: '', label: 'The top level' }, ...all.filter((f) => !within(dialog.folder.id).has(f.id)).map((f) => ({ value: f.id, label: f.name }))]} />
            {update.error !== undefined ? <ErrorMessage error={update.error} /> : null}
            <FormActions>
              <Button onClick={() => setDialog(undefined)}>Cancel</Button>
              <Button type="submit" variant="primary" pending={update.pending}>Move it</Button>
            </FormActions>
          </form>
        ) : null}
      </Dialog>
    </Page>
  );
}

/** /files/shared/: what others share with the person; each file's own shares are on the file. */
export function SharedFiles() {
  const list = useQuery('listFiles', { query: { which: 'shared' } });
  const mine = useQuery('listFiles', { query: { which: 'mine' } });
  const columns = useFileColumns();
  usePageContext({ scope: { kind: 'page', page: 'files' }, scopeLabel: 'Shared files' });
  return (
    <Page title="Shared" description="Files others shared with you. Sharing grants no marking: you open only what you are cleared for." crumbs={[{ label: 'Files', href: '/files/all/' }]}>
      <div className={styles.stack}>
        <Section title="Shared with you">
          <QueryView query={list} what="Shared files" isEmpty={(d) => d.files.length === 0} empty={<p className={styles.muted}>Nothing is shared with you yet.</p>}>
            {(d) => <DataTable label="Shared with you" rows={d.files} rowKey={(f) => f.id} rowHref={(f) => hrefWith('/files/shared/', { file: f.id })} columns={columns} />}
          </QueryView>
        </Section>
        <Section title="Yours to share" description="Open one of your files to share it, see who it is shared with, and stop sharing it.">
          <QueryView query={mine} what="Your files" isEmpty={(d) => d.files.length === 0} empty={<p className={styles.muted}>You have no files yet.</p>}>
            {(d) => <DataTable label="Your files" rows={d.files} rowKey={(f) => f.id} rowHref={(f) => hrefWith('/files/shared/', { file: f.id })} columns={columns} />}
          </QueryView>
        </Section>
      </div>
      <OpenFile />
    </Page>
  );
}
