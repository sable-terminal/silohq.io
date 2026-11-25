'use client';

// Chooses one object (an allow-list entry's digital clone, a target for something): search by
// title across the types the person may see, then the chosen hit is opened as the person, which
// gives its Silo id. The person never types or pastes an id. A hit they may no longer open is
// said to be unavailable, not chosen.

import { useEffect, useId, useState } from 'react';
import { useData, useQuery } from '../data/query.data.ts';
import { useVocabulary } from '../hooks/vocabulary.hook.ts';
import { Button } from './button.component.tsx';
import { ErrorMessage } from './states.component.tsx';
import { Spinner } from './spinner.component.tsx';
import styles from './objectPicker.component.module.css';

export interface PickedObject { objectTypeId: string; objectId: string; title: string }

export function ObjectPicker({ label, hint, value, onChange, objectTypeIds }: {
  label: string;
  hint?: string | undefined;
  value: PickedObject | undefined;
  onChange: (picked: PickedObject | undefined) => void;
  /** Only objects of these types. */
  objectTypeIds?: readonly string[] | undefined;
}) {
  const { api } = useData();
  const { lookup } = useVocabulary();
  const id = useId();
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [resolving, setResolving] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<unknown>(undefined);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), 250);
    return () => clearTimeout(timer);
  }, [text]);
  const hits = useQuery('searchObjects', value === undefined && query.length >= 2
    ? { body: { text: query, surface: 'explorer', perSourceLimit: 8, ...(objectTypeIds !== undefined ? { objectTypeIds: [...objectTypeIds] } : {}) } } : null, { keepPrevious: true });

  if (value !== undefined) {
    return (
      <div className={styles.field}>
        <span className={styles.label} id={`${id}-label`}>{label}</span>
        <div className={styles.chosen} aria-labelledby={`${id}-label`}>
          <span><strong>{value.title}</strong> <span className={styles.muted}>{lookup?.typeName(value.objectTypeId) ?? ''}</span></span>
          <Button size="sm" variant="ghost" onClick={() => onChange(undefined)}>Change</Button>
        </div>
      </div>
    );
  }

  const choose = async (hit: { objectTypeId: string; identifier: string; title: string | null; sources: readonly { connectionId: string }[] }) => {
    const source = hit.sources[0];
    if (source === undefined) return;
    setResolving(`${hit.objectTypeId}:${hit.identifier}`);
    setProblem(undefined);
    try {
      const read = await api.call('readObjectView', { body: { objectTypeId: hit.objectTypeId, object: { connectionId: source.connectionId, reference: hit.identifier } } });
      if (read.outcome !== 'object') throw new Error('That object is not available to you now.');
      onChange({ objectTypeId: hit.objectTypeId, objectId: read.view.id, title: hit.title ?? hit.identifier });
    } catch (error) {
      setProblem(error);
    } finally {
      setResolving(undefined);
    }
  };

  const results = hits.data?.results ?? [];
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>{label}</label>
      <input id={id} type="search" className={styles.input} value={text} onChange={(e) => setText(e.target.value)} placeholder="Search by title" autoComplete="off"
        aria-describedby={hint !== undefined ? `${id}-hint` : undefined} aria-controls={`${id}-results`} />
      {hint !== undefined ? <span id={`${id}-hint`} className={styles.muted}>{hint}</span> : null}
      {query.length >= 2 ? (
        <ul id={`${id}-results`} className={styles.results} aria-label={`Objects matching ${query}`} aria-busy={hits.fetching || undefined}>
          {hits.status === 'loading' ? <li className={styles.muted}><Spinner size={14} /> Searching</li> : null}
          {hits.status === 'success' && results.length === 0 ? <li className={styles.muted}>No object matches.</li> : null}
          {results.map((h) => {
            const key = `${h.objectTypeId}:${h.identifier}`;
            return (
              <li key={key}>
                <button type="button" className={styles.hit} disabled={resolving !== undefined} onClick={() => void choose(h)}>
                  <span>{h.title ?? h.identifier}</span>
                  <span className={styles.muted}>{lookup?.typeName(h.objectTypeId) ?? ''}</span>
                  {resolving === key ? <Spinner size={14} /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {hits.error !== undefined ? <ErrorMessage error={hits.error} onRetry={hits.refetch} /> : null}
      {problem !== undefined ? <ErrorMessage error={problem} /> : null}
    </div>
  );
}
