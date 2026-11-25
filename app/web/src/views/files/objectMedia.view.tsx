'use client';

// An object's media (D238): the media set items linked to it that the viewer may see through their
// sets, shown as a set's gallery shows them, and an item linked from a set the viewer may add to.
// The link holds the object's Silo id, known here, never a value of it.

import { useState } from 'react';
import { Button } from '../../components/button.component.tsx';
import { SelectField } from '../../components/field.component.tsx';
import { ErrorMessage, Loading } from '../../components/states.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { Thumb, Viewer, type Item } from './media.view.tsx';
import styles from './files.view.module.css';

export function MediaSection({ objectTypeId, objectId, className, titleClassName }: { objectTypeId: string; objectId: string; className?: string | undefined; titleClassName?: string | undefined }) {
  const items = useQuery('listObjectMedia', { query: { objectTypeId, objectId } });
  const [chosen, setChosen] = useState<(Item & { mediaSetName: string }) | undefined>();
  return (
    <section className={className} aria-labelledby="media-title">
      <h2 id="media-title" className={titleClassName}>Media</h2>
      {items.data === undefined ? (items.status === 'error' ? <ErrorMessage error={items.error} onRetry={items.refetch} /> : <Loading label="Reading its media" block={false} />)
        : items.data.items.length === 0 ? <p className={styles.muted}>No media you may see is linked to this object.</p> : (
          <ul className={styles.grid} aria-label="Linked media">
            {items.data.items.map((item) => (
              <li key={item.id}>
                <button type="button" className={styles.tile} aria-pressed={chosen?.id === item.id} onClick={() => setChosen(item)} aria-label={`${item.name}, from ${item.mediaSetName}`}>
                  <Thumb item={item} />
                  <span className={styles.caption}>{item.name}</span>
                  <span className={styles.facts}>{item.mediaSetName}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      {chosen !== undefined ? <Viewer key={chosen.id} item={chosen} mayRemove={false} mayLink={false} onClose={() => setChosen(undefined)} onRemoved={() => undefined} onChanged={() => items.refetch()} /> : null}
      <LinkHere objectTypeId={objectTypeId} objectId={objectId} />
    </section>
  );
}

/** Link an item of a set the viewer owns or adds to. */
function LinkHere({ objectTypeId, objectId }: { objectTypeId: string; objectId: string }) {
  const say = useToast();
  const mine = useQuery('listMediaSets', { query: { filter: 'mine' } });
  const shared = useQuery('listMediaSets', { query: { filter: 'shared' } });
  const [setId, setSetId] = useState('');
  const [itemId, setItemId] = useState('');
  const items = useQuery('listMediaItems', setId === '' ? null : { params: { mediaSetId: setId }, query: { limit: 200 } });
  const link = useMutation('linkMediaItem', { invalidates: ['listObjectMedia', 'listMediaItems'] });
  const sets = [...(mine.data?.mediaSets ?? []), ...(shared.data?.mediaSets ?? [])].filter((s) => s.access !== 'view' && s.archivedAt === null);
  if (sets.length === 0) return null;
  return (
    <form className={styles.rowEnd} aria-label="Link media" onSubmit={async (e) => {
      e.preventDefault();
      const r = await link.run({ params: { mediaSetId: setId, itemId }, body: { objectTypeId, objectId } });
      if (r.ok) {
        setItemId('');
        say('Linked');
      }
    }}>
      <SelectField label="From" value={setId} placeholder="Choose a media set" onChange={(e) => {
        setSetId(e.target.value);
        setItemId('');
      }} options={sets.map((s) => ({ value: s.id, label: s.name }))} />
      <SelectField label="Item" value={itemId} placeholder={items.data === undefined ? 'Choose a set first' : 'Choose an item'} onChange={(e) => setItemId(e.target.value)}
        options={(items.data?.items ?? []).map((i) => ({ value: i.id, label: i.name }))} />
      <Button type="submit" pending={link.pending} blocked={link.blocked} disabled={itemId === ''}>Link it here</Button>
      {link.error !== undefined ? <ErrorMessage error={link.error} /> : null}
    </form>
  );
}
