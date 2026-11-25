'use client';

// Media sets (D237, D238): images, video, audio and PDFs kept in an Import Silo, shown as a gallery
// with what each file's bytes say (size, frame, length, pages, when a photo was taken). An item is
// opened under the opener's own access: in the reply when small, else through a signed, short-lived
// link the browser plays straight from storage, so video seeks. Thumbnails are the images
// themselves, read only as they scroll into view. Items are linked to objects by the set's rule (a
// filename template) or on an object's page. A set is shared to view or to add to; sharing grants
// no marking.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge, Marking } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button, IconButton, LinkButton } from '../../components/button.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { FormActions, SelectField, TextField } from '../../components/field.component.tsx';
import { Menu } from '../../components/menu.component.tsx';
import { Page, Properties, Section } from '../../components/page.component.tsx';
import { PagesView } from '../../components/query.component.tsx';
import { ShareDialog, type Grantee, type Share } from '../../components/share.component.tsx';
import { EmptyState, ErrorMessage, Loading } from '../../components/states.component.tsx';
import { type TabDef, TabPanel, Tabs, useTab } from '../../components/tabs.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useData, useMutation, usePages, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { useVocabulary } from '../../hooks/vocabulary.hook.ts';
import { objectHref } from '../../navigation/links.navigation.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { formatBytes, plural } from '../../utils/format.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import { Directory, FILTERS, idFrom, NotFound } from '../studio/kit.view.tsx';
import { base64Of, ONE_REQUEST, sendSigned } from './transfer.view.ts';
import styles from './files.view.module.css';

type MediaSet = Output<'getMediaSet'>;
export type Item = Output<'listMediaItems'>['items'][number];
type Kind = Item['kind'];
type MediaShare = Output<'listMediaSetShares'>['shares'][number];
/** Above this an image is not read for a thumbnail: it is shown when opened. */
const THUMB_BYTES = 4 * 1024 * 1024;
const KIND_LABEL: Record<Kind, string> = { image: 'Images', video: 'Video', audio: 'Audio', document: 'PDFs' };
const KIND_ONE: Record<Kind, string> = { image: 'Image', video: 'Video', audio: 'Audio', document: 'PDF' };
const KINDS: TabDef<'all' | Kind>[] = [{ id: 'all', label: 'All' }, ...(Object.keys(KIND_LABEL) as Kind[]).map((k) => ({ id: k, label: KIND_LABEL[k] }))];
const ACCESS = [
  { value: 'view' as const, label: 'View it', hint: 'Open its items, as they are cleared to' },
  { value: 'contribute' as const, label: 'View and add to it', hint: 'Adding still needs permission to upload into its Silo' },
];
const mediaSetHref = (id: string) => hrefWith('/files/media/', { mediaSet: id });

export const clock = (ms: number) => {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
};

function factLine(item: Item): string {
  const parts = [KIND_ONE[item.kind]];
  if (item.width !== null && item.height !== null) parts.push(`${item.width}×${item.height}`);
  if (item.durationMs !== null) parts.push(clock(item.durationMs));
  if (item.pages !== null) parts.push(plural(item.pages, 'page'));
  parts.push(formatBytes(item.sizeBytes));
  return parts.join(' · ');
}

/** An item's bytes as a URL the page may show: a blob of the reply, or the signed link. */
function useItemUrl() {
  const { api } = useData();
  return async (item: Item, link = false): Promise<{ url: string; revoke: () => void }> => {
    const opened = await api.call('openMediaItem', { params: { mediaSetId: item.mediaSetId, itemId: item.id }, body: { link: link || item.sizeBytes > ONE_REQUEST } });
    if (opened.kind === 'link') return { url: opened.url, revoke: () => undefined };
    const data = Uint8Array.from(atob(opened.content as string), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([data], { type: opened.contentType }));
    return { url, revoke: () => URL.revokeObjectURL(url) };
  };
}

/** /files/media/: the media sets, or one set opened. */
export function MediaSets() {
  const [params] = useParams();
  const open = params.get('mediaSet');
  if (open === null) return <MediaDirectory />;
  const id = idFrom(open);
  return id === undefined ? <NotFound title="Media sets" what="a media set" icon="image" href="/files/media/" /> : <MediaSetPage key={id} mediaSetId={id} />;
}

function MediaDirectory() {
  const [filter, setFilter] = useTab(FILTERS, 'filter');
  const list = useQuery('listMediaSets', { query: { filter } }, { keepPrevious: true });
  const create = useMutation('createMediaSet', { invalidates: ['listMediaSets'] });
  usePageContext({ scope: { kind: 'page', page: 'files' }, scopeLabel: 'Media sets' });
  return (
    <Directory title="Media sets" what="media set" icon="image" description="Images, video, audio and PDFs kept in an Import Silo, with what each file says about itself, linked to objects."
      filter={filter} onFilter={setFilter} query={list} rows={(d) => d.mediaSets.map((s) => ({ ...s, access: s.access === 'contribute' ? 'contribute' : s.access }))} hrefOf={mediaSetHref}
      columns={[{ id: 'items', header: 'Items', width: 'sm', align: 'end', cell: (s) => String(s.itemCount) }]}
      createBlocked={create.blocked} renderNew={(close) => <NewMediaSet onClose={close} />}
      emptyMine="A media set keeps photos, recordings and documents, and links them to the objects they show." />
  );
}

function NewMediaSet({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const create = useMutation('createMediaSet', { invalidates: ['listMediaSets'] });
  const siloes = useQuery('listSiloes', { query: {} });
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [siloId, setSiloId] = useState('');
  const imports = (siloes.data?.siloes ?? []).filter((s) => s.kind === 'import' && (s.status === 'active' || s.status === 'provisioning'));
  return (
    <Dialog open onClose={onClose} title="New media set" size="md" busy={create.pending}>
      <form className={styles.form} onSubmit={async (e) => {
        e.preventDefault();
        const r = await create.run({ body: { name: name.trim(), description: description.trim(), siloId } });
        if (r.ok) router.push(mediaSetHref(r.data.id) as never);
      }}>
        <TextField label="Name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
        <TextField label="Description (optional)" maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />
        {siloes.data !== undefined && imports.length === 0 ? <p className={styles.muted}>A media set is kept in an Import Silo. An administrator makes one under Siloes.</p> : (
          <SelectField label="Kept in" required value={siloId} placeholder={siloes.data === undefined ? 'Listing…' : 'Choose an Import Silo'} onChange={(e) => setSiloId(e.target.value)}
            options={imports.map((s) => ({ value: s.id, label: s.name }))} />
        )}
        {create.error !== undefined ? <ErrorMessage error={create.error} /> : null}
        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" pending={create.pending} blocked={create.blocked} disabled={name.trim() === '' || siloId === ''}>Make the set</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

const granteeOf = (s: MediaShare): Grantee => (s.granteeMembershipId !== null ? { kind: 'membership', membershipId: s.granteeMembershipId }
  : s.granteeScopeId !== null ? { kind: 'scope', scopeId: s.granteeScopeId } : { kind: 'organisation' });
const shareOf = (s: MediaShare): Share<'view' | 'contribute'> => ({
  id: s.id, grantee: granteeOf(s), access: s.access, createdAt: s.createdAt, revokedAt: s.revokedAt ?? (s.expiresAt !== null && Date.parse(s.expiresAt) < Date.now() ? s.expiresAt : null),
});

function MediaSetPage({ mediaSetId }: { mediaSetId: string }) {
  const router = useRouter();
  const say = useToast();
  const read = useQuery('getMediaSet', { params: { mediaSetId } });
  const [kind, setKind] = useTab(KINDS, 'kind');
  const items = usePages('listMediaItems', (after) => ({ params: { mediaSetId }, query: { ...(kind === 'all' ? {} : { kind }), ...(after === undefined ? {} : { after }) } }), (page) => page.next, [mediaSetId, kind]);
  const save = useMutation('saveMediaSet', { invalidates: ['getMediaSet', 'listMediaSets'] });
  const archive = useMutation('archiveMediaSet', { invalidates: ['getMediaSet', 'listMediaSets'] });
  const shares = useQuery('listMediaSetShares', read.data?.access === 'owner' ? { params: { mediaSetId } } : null);
  const share = useMutation('shareMediaSet', { invalidates: ['listMediaSetShares'] });
  const revoke = useMutation('revokeMediaSetShare', { invalidates: ['listMediaSetShares'] });
  const [chosen, setChosen] = useState<Item | undefined>();
  const [dialog, setDialog] = useState<'add' | 'edit' | 'rule' | 'share' | 'archive' | undefined>();
  usePageContext({ scope: { kind: 'page', page: 'files' }, scopeLabel: read.data?.name ?? 'a media set' });
  const set = read.data;
  if (set === undefined) {
    return <Page title="Media set" crumbs={[{ label: 'Files', href: '/files/all/' }, { label: 'Media sets', href: '/files/media/' }]}>{read.status === 'error' ? <ErrorMessage error={read.error} onRetry={read.refetch} /> : <Loading label="Opening it" />}</Page>;
  }
  const owner = set.access === 'owner';
  const live = set.archivedAt === null;
  const adds = set.access !== 'view' && live;
  return (
    <Page title={set.name} documentTitle={set.name} width="full" description={set.description || undefined}
      crumbs={[{ label: 'Files', href: '/files/all/' }, { label: 'Media sets', href: '/files/media/' }]}
      meta={<span className={styles.row}>{!live ? <Badge>Archived</Badge> : null}{!owner ? <Badge tone="info">{set.access === 'contribute' ? 'Shared with you to add to' : 'Shared with you to view'}</Badge> : null}
        <span className={styles.muted}>{plural(set.itemCount, 'item')}</span></span>}
      actions={
        <div className={styles.row}>
          {adds ? <Button variant="primary" icon="upload" onClick={() => setDialog('add')}>Add items</Button> : null}
          {owner && live ? <Button icon="share" blocked={share.blocked} onClick={() => setDialog('share')}>Share</Button> : null}
          <Menu label="More" items={[
            { label: 'Rename or describe', icon: 'edit', disabled: !owner || !live, blocked: save.blocked, onSelect: () => setDialog('edit') },
            { label: 'Link rule', icon: 'link', disabled: !owner || !live, onSelect: () => setDialog('rule') },
            { separator: true },
            { label: 'Archive', icon: 'trash', tone: 'danger', disabled: !owner || !live, blocked: archive.blocked, onSelect: () => setDialog('archive') },
          ]} renderTrigger={(x) => <IconButton {...x} label="More" icon="more" />} />
        </div>
      }>
      <div className={styles.stack}>
        {!live ? <Banner tone="info" title="Archived">It takes no new item.</Banner> : null}
        <p className={styles.muted}>Each item is kept in its Import Silo, with its markings and retention, and opened under your own access.</p>
        {set.linkRule !== null ? <p className={styles.muted}>Items are linked to objects by the rule <span className={styles.mono}>{set.linkRule.pattern}</span>.</p> : null}
        <Tabs label="Which kind" tabs={KINDS} current={kind} onChange={setKind} />
        <TabPanel id={kind}>
          <PagesView pages={items} what="Items" isEmpty={(all) => all.flatMap((p) => p.items).length === 0}
            empty={<EmptyState icon="image" title="Nothing here yet" action={adds ? <Button icon="upload" onClick={() => setDialog('add')}>Add items</Button> : undefined}>{adds ? 'Add photos, recordings or PDFs.' : 'Its owner and those it is shared with to add to put items here.'}</EmptyState>}>
            {(all) => (
              <ul className={styles.grid} aria-label="Items">
                {all.flatMap((p) => p.items).map((item) => (
                  <li key={item.id}>
                    <button type="button" className={styles.tile} aria-pressed={chosen?.id === item.id} onClick={() => setChosen(item)} aria-label={`${item.name}, ${KIND_ONE[item.kind].toLowerCase()}`}>
                      <Thumb item={item} />
                      <span className={styles.caption}>{item.name}</span>
                      <span className={styles.facts}>{factLine(item)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </PagesView>
        </TabPanel>
      </div>
      {chosen !== undefined ? (
        <Viewer key={chosen.id} item={chosen} mayRemove={owner} mayLink={adds} onClose={() => setChosen(undefined)}
          onRemoved={() => {
            setChosen(undefined);
            items.refetch();
          }} onChanged={(next) => setChosen(next)} />
      ) : null}
      {dialog === 'add' ? <AddItems mediaSetId={mediaSetId} onClose={() => setDialog(undefined)} onAdded={() => items.refetch()} /> : null}
      {dialog === 'edit' ? <EditSet set={set} pending={save.pending} error={save.error} onClose={() => setDialog(undefined)}
        onSave={(name, description) => void save.run({ params: { mediaSetId }, body: { name, description, lockVersion: set.lockVersion } }).then((r) => {
          if (!r.ok) return;
          setDialog(undefined);
          say('Saved');
        })} /> : null}
      {dialog === 'rule' ? <LinkRule set={set} onClose={() => setDialog(undefined)} onChanged={() => items.refetch()} /> : null}
      <ShareDialog open={dialog === 'share'} onClose={() => setDialog(undefined)} title={`Share ${set.name}`} what="this media set" access={ACCESS}
        shares={shares.data?.shares.map(shareOf)} shareBlocked={share.blocked} revokeBlocked={revoke.blocked}
        onShare={(grantee, access) => share.run({ params: { mediaSetId }, body: {
          grantee: grantee.kind === 'membership' ? { membershipId: grantee.membershipId } : grantee.kind === 'scope' ? { scopeId: grantee.scopeId } : { organisation: true }, access,
        } })}
        onRevoke={(shareId) => revoke.run({ params: { mediaSetId, shareId } })} />
      <ConfirmDialog open={dialog === 'archive'} onClose={() => setDialog(undefined)} title={`Archive ${set.name}?`} confirmLabel="Archive" tone="danger"
        onConfirm={async () => {
          const r = await archive.run({ params: { mediaSetId } });
          if (r.ok) {
            say('Archived');
            router.push('/files/media/' as never);
          }
          return r;
        }}><p>It takes no new item. Its items stay in their Silo, and their links stay.</p></ConfirmDialog>
    </Page>
  );
}

function EditSet({ set, pending, error, onClose, onSave }: { set: MediaSet; pending: boolean; error: unknown; onClose: () => void; onSave: (name: string, description: string) => void }) {
  const [name, setName] = useState(set.name);
  const [description, setDescription] = useState(set.description);
  return (
    <Dialog open onClose={onClose} title="Rename or describe" size="sm" busy={pending}>
      <form className={styles.form} onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() !== '') onSave(name.trim(), description.trim());
      }}>
        <TextField label="Name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
        <TextField label="Description" maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />
        {error !== undefined ? <ErrorMessage error={error} /> : null}
        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" pending={pending} disabled={name.trim() === ''}>Save</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

/** An image read as it scrolls into view; anything else, or an image too large, its kind. */
export function Thumb({ item }: { item: Item }) {
  const urlOf = useItemUrl();
  const box = useRef<HTMLSpanElement>(null);
  const [url, setUrl] = useState<string | undefined>();
  const [failed, setFailed] = useState(false);
  const shows = item.kind === 'image' && item.canOpen && item.sizeBytes <= THUMB_BYTES;
  useEffect(() => {
    if (!shows || box.current === null) return;
    let revoke: (() => void) | undefined;
    let live = true;
    const seen = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      seen.disconnect();
      urlOf(item).then((u) => {
        if (live) {
          setUrl(u.url);
          revoke = u.revoke;
        } else u.revoke();
      }, () => live && setFailed(true));
    }, { rootMargin: '200px' });
    seen.observe(box.current);
    return () => {
      live = false;
      seen.disconnect();
      revoke?.();
    };
    // The item is all it depends on.
  }, [item, shows]);
  return (
    <span ref={box} className={styles.thumb} aria-hidden="true">
      {url !== undefined ? <img src={url} alt="" className={styles.image} /> : (
        <span className={styles.glyph}>{!item.canOpen ? 'Not visible to you' : failed ? 'Not shown' : KIND_ONE[item.kind]}</span>
      )}
    </span>
  );
}

export function Viewer({ item, mayRemove, mayLink, onClose, onRemoved, onChanged }: {
  item: Item & { mediaSetName?: string }; mayRemove: boolean; mayLink: boolean; onClose: () => void; onRemoved: () => void; onChanged: (item: Item) => void;
}) {
  const say = useToast();
  const people = useDirectory();
  const { lookup } = useVocabulary();
  const urlOf = useItemUrl();
  const unlink = useMutation('unlinkMediaItem', { invalidates: ['listMediaItems', 'listObjectMedia'] });
  const remove = useMutation('removeMediaItem', { invalidates: ['listMediaItems', 'getMediaSet'] });
  const [url, setUrl] = useState<string | undefined>();
  const [problem, setProblem] = useState<unknown>();
  const [removing, setRemoving] = useState(false);
  useEffect(() => {
    if (!item.canOpen) return;
    let revoke: (() => void) | undefined;
    let live = true;
    // Video and audio from the signed link where storage signs one, so they seek; else from the reply.
    urlOf(item, item.kind === 'video' || item.kind === 'audio').catch(() => urlOf(item)).then((u) => {
      if (live) {
        setUrl(u.url);
        revoke = u.revoke;
      } else u.revoke();
    }, (error: unknown) => live && setProblem(error));
    return () => {
      live = false;
      revoke?.();
    };
    // The item is all it depends on.
  }, [item]);
  return (
    <Dialog open onClose={onClose} drawer title={item.name} description={item.mediaSetName !== undefined ? `From ${item.mediaSetName}` : undefined}>
      <div className={styles.stack}>
        {!item.canOpen ? <Banner tone="info" title="Not opened for you">You do not hold every marking on it.</Banner>
          : problem !== undefined ? <ErrorMessage error={problem} />
            : url === undefined ? <Loading label="Opening it" block={false} />
              : item.kind === 'image' ? <img src={url} alt={item.name} className={styles.full} />
                : item.kind === 'video' ? <video src={url} controls preload="metadata" className={styles.full} aria-label={item.name} />
                  : item.kind === 'audio' ? <audio src={url} controls preload="metadata" aria-label={item.name} />
                    : <LinkButton href={url} icon="download">Download the PDF</LinkButton>}
        <Properties columns={1} items={[
          ['Kind', `${KIND_ONE[item.kind]} (${item.contentType})`],
          ['Size', formatBytes(item.sizeBytes)],
          item.width !== null ? ['Frame', `${item.width} × ${item.height} pixels`] : null,
          item.durationMs !== null ? ['Length', clock(item.durationMs)] : null,
          item.pages !== null ? ['Pages', String(item.pages)] : null,
          item.capturedAt !== null ? ['Taken', `${item.capturedAt.replace('T', ' ')} (camera time)`] : null,
          ['Added', <span key="a"><Time value={item.addedAt} exact /> by {people.nameOf(item.addedBy)}</span>],
          item.markings.length > 0 ? ['Markings', <span key="m" className={styles.row}>{item.markings.map((m) => <Marking key={m.id}>{m.name}</Marking>)}</span>] : null,
        ]} />
        <Section title="Linked to">
          {item.links.length === 0 ? <p className={styles.muted}>No object yet. Link it on an object&apos;s page, or by the set&apos;s rule.</p> : (
            <ul className={styles.plainList} aria-label="Linked to">{item.links.map((l) => (
              <li key={l.id} className={styles.row}>
                <Link href={objectHref({ objectTypeId: l.objectTypeId, objectId: l.objectId }) as never}>{lookup?.typeName(l.objectTypeId) ?? 'An object'} {l.objectId.slice(0, 8)}</Link>
                <span className={styles.muted}>{l.madeBy === 'rule' ? "by the set's rule" : `by ${people.nameOf(l.linkedBy)}`}</span>
                {mayLink ? <Button size="sm" variant="ghost" pending={unlink.pending} blocked={unlink.blocked} onClick={() => void unlink.run({ params: { mediaSetId: item.mediaSetId, itemId: item.id, linkId: l.id } }).then((r) => {
                  if (!r.ok) return;
                  say('Unlinked');
                  onChanged({ ...item, links: item.links.filter((x) => x.id !== l.id) });
                })}>Unlink</Button> : null}
              </li>
            ))}</ul>
          )}
        </Section>
        {unlink.error !== undefined ? <ErrorMessage error={unlink.error} /> : null}
        {mayRemove ? <Button variant="ghost" icon="trash" blocked={remove.blocked} onClick={() => setRemoving(true)}>Remove from the set</Button> : null}
      </div>
      <ConfirmDialog open={removing} onClose={() => setRemoving(false)} title={`Remove ${item.name} from the set?`} confirmLabel="Remove" tone="danger"
        onConfirm={() => remove.run({ params: { mediaSetId: item.mediaSetId, itemId: item.id } }).then((r) => {
          if (r.ok) onRemoved();
          return r;
        })}><p>The file stays in Files; its links to objects go with it from the set.</p></ConfirmDialog>
    </Dialog>
  );
}

/** The set's link rule, its owner's: a filename template whose {key} is matched against a property of a type. */
function LinkRule({ set, onClose, onChanged }: { set: MediaSet; onClose: () => void; onChanged: () => void }) {
  const say = useToast();
  const { data: vocabulary } = useVocabulary();
  const setRule = useMutation('setMediaLinkRule', { invalidates: ['getMediaSet'] });
  const apply = useMutation('applyMediaLinkRule', { invalidates: ['listMediaItems'] });
  const [typeId, setTypeId] = useState(set.linkRule?.objectTypeId ?? '');
  const [propertyId, setPropertyId] = useState(set.linkRule?.propertyId ?? '');
  const [pattern, setPattern] = useState(set.linkRule?.pattern ?? '');
  const type = vocabulary?.objectTypes.find((t) => t.id === typeId);
  const keyed = (type?.properties ?? []).filter((p) => ['string', 'enum', 'integer', 'decimal'].includes(p.dataType));
  return (
    <Dialog open onClose={onClose} title="Link rule" size="md" busy={setRule.pending || apply.pending}
      description="Each item's name, read through the pattern, gives a key: it is linked to the objects whose property holds that key, among those the person adding it may see.">
      <form className={styles.form} onSubmit={async (e) => {
        e.preventDefault();
        const r = await setRule.run({ params: { mediaSetId: set.id }, body: { rule: { objectTypeId: typeId, propertyId, pattern } } });
        if (r.ok) say('Saved: items added from now on are linked by it');
      }}>
        <div className={styles.fields}>
          <SelectField label="Objects" value={typeId} placeholder="Choose a type" onChange={(e) => {
            setTypeId(e.target.value);
            setPropertyId('');
          }} options={(vocabulary?.objectTypes ?? []).map((t) => ({ value: t.id, label: t.pluralName }))} />
          <SelectField label="Whose" value={propertyId} placeholder="Choose a property" onChange={(e) => setPropertyId(e.target.value)} options={keyed.map((p) => ({ value: p.identityId, label: p.displayName }))} />
        </div>
        <TextField label="Matches the key in names like" className={styles.mono} value={pattern} maxLength={200} placeholder="pump-{key}*.jpg" onChange={(e) => setPattern(e.target.value)}
          hint="Write {key} once where the key is, and * for anything (at most two)." error={pattern !== '' && !pattern.includes('{key}') ? 'Write {key} where the key is' : undefined} />
        {setRule.error !== undefined ? <ErrorMessage error={setRule.error} /> : null}
        {apply.data !== undefined ? (
          <p role="status">{apply.data.refused !== null ? `Nothing was linked: ${apply.data.refused}.` : `${plural(apply.data.items, 'item')} read, ${apply.data.keyed} gave a key, ${plural(apply.data.linked, 'new link')}.`}</p>
        ) : null}
        {apply.error !== undefined ? <ErrorMessage error={apply.error} /> : null}
        <FormActions>
          {set.linkRule !== null ? (
            <>
              <Button variant="ghost" blocked={setRule.blocked} onClick={() => void setRule.run({ params: { mediaSetId: set.id }, body: { rule: null } }).then((r) => {
                if (!r.ok) return;
                setTypeId('');
                setPropertyId('');
                setPattern('');
                say('Cleared: links already made stay');
              })}>Clear the rule</Button>
              <Button pending={apply.pending} blocked={apply.blocked} onClick={() => void apply.run({ params: { mediaSetId: set.id } }).then((r) => r.ok && onChanged())}>Apply to the items already here</Button>
            </>
          ) : null}
          <Button type="submit" variant="primary" pending={setRule.pending} blocked={setRule.blocked} disabled={typeId === '' || propertyId === '' || !pattern.includes('{key}')}>Save the rule</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

function AddItems({ mediaSetId, onClose, onAdded }: { mediaSetId: string; onClose: () => void; onAdded: () => void }) {
  const { api, cache } = useData();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<{ name: string; ok: boolean; error?: unknown }[]>([]);
  return (
    <Dialog open onClose={onClose} title="Add items" size="md" busy={busy}>
      <form className={styles.form} onSubmit={async (e) => {
        e.preventDefault();
        const files = [...(input.current?.files ?? [])];
        if (files.length === 0) return;
        setBusy(true);
        const out: typeof report = [];
        for (const file of files) {
          try {
            if (file.size <= ONE_REQUEST) {
              await api.call('addMediaItem', { params: { mediaSetId }, body: { name: file.name, contentBase64: await base64Of(file) } }, { idempotencyKey: crypto.randomUUID() });
            } else {
              const transfer = await api.call('beginMediaUpload', { params: { mediaSetId }, body: { sizeBytes: file.size } });
              await sendSigned(transfer, file);
              await api.call('completeMediaUpload', { params: { mediaSetId, uploadId: transfer.uploadId }, body: { name: file.name } }, { idempotencyKey: crypto.randomUUID() });
            }
            out.push({ name: file.name, ok: true });
          } catch (error) {
            out.push({ name: file.name, ok: false, error });
          }
        }
        cache.invalidateAfter('addMediaItem', ['listMediaItems', 'getMediaSet']);
        setReport(out);
        setBusy(false);
        if (input.current !== null) input.current.value = '';
        onAdded();
      }}>
        <label className={styles.stackTight}>
          <span>Images, video, audio or PDFs</span>
          <input ref={input} type="file" multiple accept="image/*,video/*,audio/*,application/pdf" required className={styles.fileInput} aria-label="Files to add" />
        </label>
        {report.length > 0 ? (
          <ul className={styles.plainList} role="status">{report.map((r) => <li key={r.name}>{r.name}: {r.ok ? 'added' : <ErrorMessage error={r.error} />}</li>)}</ul>
        ) : null}
        <FormActions>
          <Button onClick={onClose}>{report.length > 0 ? 'Done' : 'Cancel'}</Button>
          <Button type="submit" variant="primary" pending={busy}>Add</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}
