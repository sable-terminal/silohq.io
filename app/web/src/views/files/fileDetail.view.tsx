'use client';

// One file (spec 41): what it is, where it came from, its markings and when it expires; opened
// under the opener's own access. Its owner renames it, moves it between folders, shares it with a
// person, a team or the organisation to view or download (each share saying whether the recipient
// can open it now, since sharing grants no marking), and deletes it: an export is deleted with a
// receipt of what was removed; an upload is purged from its Import Silo, which may wait for approval.

import { useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge, Marking } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { FormActions, SelectField } from '../../components/field.component.tsx';
import { Properties } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { ShareDialog, type Grantee, type Share } from '../../components/share.component.tsx';
import { ErrorMessage } from '../../components/states.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useData, useMutation, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { formatBytes, humanise } from '../../utils/format.util.ts';
import { NameDialog } from '../studio/kit.view.tsx';
import { ONE_REQUEST, saveBytes } from './transfer.view.ts';
import styles from './files.view.module.css';

export type FileRow = Output<'listFiles'>['files'][number];
type FileShare = Output<'listFileShares'>['shares'][number];
type Access = 'view' | 'download';
const ACCESS = [
  { value: 'download' as const, label: 'Download it', hint: 'Open it and keep a copy' },
  { value: 'view' as const, label: 'View it', hint: 'Open it in Silo only' },
];

const granteeOf = (s: FileShare): Grantee => (s.granteeMembershipId !== null ? { kind: 'membership', membershipId: s.granteeMembershipId }
  : s.granteeScopeId !== null ? { kind: 'scope', scopeId: s.granteeScopeId } : { kind: 'organisation' });
const shareOf = (s: FileShare): Share<Access> => ({
  id: s.id, grantee: granteeOf(s), access: s.access, createdAt: s.createdAt, revokedAt: s.revokedAt ?? (s.expiresAt !== null && Date.parse(s.expiresAt) < Date.now() ? s.expiresAt : null),
  note: s.recipientCanOpen === 'no' ? 'they cannot open it: they do not hold all its markings' : s.recipientCanOpen === 'unknown' ? 'whether they can open it is not known yet' : undefined,
});

/** Downloads a file the person may download: in the reply when small, else from a signed link. */
export function useDownload() {
  const { api } = useData();
  const [state, setState] = useState<{ pending: string | undefined; error: unknown }>({ pending: undefined, error: undefined });
  const download = async (f: Pick<FileRow, 'id' | 'size'>) => {
    setState({ pending: f.id, error: undefined });
    try {
      if ((f.size ?? 0) > ONE_REQUEST) {
        const link = await api.call('fileDownloadLink', { params: { fileId: f.id } });
        window.location.assign(link.url);
      } else {
        const got = await api.call('downloadFile', { params: { fileId: f.id } });
        saveBytes(got.content as string, got.contentType, got.name);
      }
      setState({ pending: undefined, error: undefined });
    } catch (error) {
      setState({ pending: undefined, error });
    }
  };
  return { download, pending: state.pending, error: state.error };
}

export function FileDetail({ fileId, onClose }: { fileId: string; onClose: () => void }) {
  const say = useToast();
  const people = useDirectory();
  const read = useQuery('readFile', { params: { fileId } });
  const folders = useQuery('listFolders', { query: {} });
  const update = useMutation('updateFile', { invalidates: ['listFiles', 'readFile'] });
  const remove = useMutation('deleteFile', { invalidates: ['listFiles'] });
  const owner = read.data?.access === 'owner';
  const shares = useQuery('listFileShares', owner ? { params: { fileId } } : null);
  const share = useMutation('shareFile', { invalidates: ['listFileShares'] });
  const revoke = useMutation('revokeFileShare', { invalidates: ['listFileShares'] });
  const { download, pending, error } = useDownload();
  const [dialog, setDialog] = useState<'rename' | 'move' | 'share' | 'delete' | undefined>();
  const [folderId, setFolderId] = useState('');
  return (
    <Dialog open onClose={onClose} drawer title={read.data?.name ?? 'File'} description={read.data === undefined ? undefined : <Badge>{read.data.kind === 'export' ? 'An export' : 'An upload'}</Badge>}>
      <QueryView query={read} what="The file">
        {(f) => (
          <div className={styles.stack}>
            {!f.canOpen ? <Banner tone="info" title="Not opened for you">You do not hold every marking on it.</Banner> : null}
            {f.markings.length > 0 ? <p className={styles.row}>{f.markings.map((m) => <Marking key={m.id}>{m.name}</Marking>)}</p> : null}
            <Properties columns={1} items={[
              ['Kind', f.kind === 'export' ? 'An export Silo made' : 'An upload'],
              ['Type', f.contentType ?? '—'],
              ['Size', f.size === null ? '—' : formatBytes(f.size)],
              ['By', people.nameOf(f.createdBy)],
              ['Made', <Time key="m" value={f.createdAt} exact />],
              ['Expires', f.expiresAt === null ? 'Not set' : <Time key="e" value={f.expiresAt} exact />],
              ['Folder', f.folderId === null ? 'None' : folders.data?.folders.find((x) => x.id === f.folderId)?.name ?? 'A folder'],
              f.provenance !== null ? ['From', `${humanise(f.provenance.sourceKind)}, produced`] : null,
              f.provenance !== null ? ['Produced', <Time key="p" value={f.provenance.producedAt} exact />] : null,
              ['Yours or shared', f.access === 'owner' ? 'Yours' : f.access === 'download' ? 'Shared with you to download' : 'Shared with you to view'],
            ]} />
            <div className={styles.row}>
              <Button variant="primary" icon="download" pending={pending === f.id} blocked={!f.canOpen ? 'You do not hold every marking on it' : f.access === 'view' ? 'Shared with you to view only' : undefined}
                onClick={() => void download(f)}>Download</Button>
              {owner ? <Button icon="share" blocked={share.blocked} onClick={() => setDialog('share')}>Share</Button> : null}
              {owner ? <Button icon="edit" blocked={update.blocked} onClick={() => setDialog('rename')}>Rename</Button> : null}
              {owner ? <Button icon="folder" blocked={update.blocked} onClick={() => {
                setFolderId(f.folderId ?? '');
                setDialog('move');
              }}>Move</Button> : null}
              {owner ? <Button variant="ghost" icon="trash" blocked={remove.blocked} onClick={() => setDialog('delete')}>Delete</Button> : null}
            </div>
            {error !== undefined ? <ErrorMessage error={error} /> : null}
            <NameDialog key={`rename:${f.name}`} open={dialog === 'rename'} title="Rename the file" initial={f.name} action="Rename" pending={update.pending} error={update.error}
              onClose={() => setDialog(undefined)}
              onSave={(name) => void update.run({ params: { fileId }, body: { name } }).then((r) => {
                if (!r.ok) return;
                setDialog(undefined);
                say('Renamed');
              })} />
            <Dialog open={dialog === 'move'} onClose={() => setDialog(undefined)} title="Move the file" size="sm" busy={update.pending}>
              <form className={styles.form} onSubmit={async (e) => {
                e.preventDefault();
                const r = await update.run({ params: { fileId }, body: { folderId: folderId === '' ? null : folderId } });
                if (r.ok) {
                  setDialog(undefined);
                  say('Moved');
                }
              }}>
                <SelectField label="Into" value={folderId} onChange={(e) => setFolderId(e.target.value)}
                  options={[{ value: '', label: 'No folder' }, ...(folders.data?.folders ?? []).map((x) => ({ value: x.id, label: x.name }))]} />
                {update.error !== undefined ? <ErrorMessage error={update.error} /> : null}
                <FormActions>
                  <Button onClick={() => setDialog(undefined)}>Cancel</Button>
                  <Button type="submit" variant="primary" pending={update.pending}>Move it</Button>
                </FormActions>
              </form>
            </Dialog>
            <ShareDialog open={dialog === 'share'} onClose={() => setDialog(undefined)} title={`Share ${f.name}`} what="this file" access={ACCESS}
              shares={shares.data?.shares.map(shareOf)} shareBlocked={share.blocked} revokeBlocked={revoke.blocked}
              onShare={(grantee, access) => share.run({ params: { fileId }, body: {
                grantee: grantee.kind === 'membership' ? { membershipId: grantee.membershipId } : grantee.kind === 'scope' ? { scopeId: grantee.scopeId } : { organisation: true }, access,
              } }).then((r) => {
                if (r.ok && r.data.recipientCanOpen === 'no') say('Shared, but they cannot open it: sharing grants no marking');
                return r;
              })}
              onRevoke={(shareId) => revoke.run({ params: { fileId, shareId } })} />
            <ConfirmDialog open={dialog === 'delete'} onClose={() => setDialog(undefined)} title={`Delete ${f.name}?`} confirmLabel="Delete" tone="danger"
              onConfirm={async () => {
                const r = await remove.run({ params: { fileId } });
                if (r.ok) {
                  say('purgeId' in r.data ? `Its removal from its Silo is ${humanise(r.data.purgeStatus).toLowerCase()}; it goes when that completes` : 'Deleted; a receipt of what was removed is kept');
                  onClose();
                }
                return r;
              }}>
              <p>{f.kind === 'upload' ? 'An upload is purged from its Import Silo, with what was read from it; that may wait for approval.' : 'Anything that links to it stops working. A receipt of what was removed is kept.'}</p>
            </ConfirmDialog>
          </div>
        )}
      </QueryView>
    </Dialog>
  );
}
