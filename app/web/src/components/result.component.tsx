'use client';

// A result page as a table: objects with the properties selected, the first linking to the
// object's view; or groups with their measures. A value the person may not see says so; one the
// systems disagree on is never resolved here (spec 23.5). A selection made in another
// representation lands on its row (31.5): marked, and scrolled to.

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import type { Output } from '../api/client.api.ts';
import { useVocabulary } from '../hooks/vocabulary.hook.ts';
import { objectHref } from '../navigation/links.navigation.ts';
import { formatValue, type DataType } from '../utils/value.util.ts';
import { humanise } from '../utils/format.util.ts';
import { EmptyState } from './states.component.tsx';
import styles from './result.component.module.css';

export type ResultPage = Output<'readResultPage'>;

export function ResultTable({ page, label = 'Result', selected }: {
  page: ResultPage; label?: string;
  /** A selected group's key as JSON, or a selected object's id. */
  selected?: string | undefined;
}) {
  const { lookup } = useVocabulary();
  const body = useRef<HTMLTableSectionElement | null>(null);
  useEffect(() => {
    if (selected !== undefined) body.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected, page]);
  if (page.groups.length > 0) {
    const keys = Object.keys(page.groups[0]!.key);
    const measures = Object.keys(page.groups[0]!.measures);
    return (
      <div className={styles.scroll}>
        <table className={styles.table} aria-label={label}>
          <thead><tr>{[...keys, ...measures].map((k) => <th key={k} scope="col">{humanise(k)}</th>)}</tr></thead>
          <tbody ref={body}>
            {page.groups.map((g, i) => (
              <tr key={i} aria-selected={selected !== undefined ? JSON.stringify(g.key) === selected : undefined} className={selected !== undefined && JSON.stringify(g.key) === selected ? styles.selected : undefined}>
                {keys.map((k) => <td key={k}>{formatValue(undefined, g.key[k])}</td>)}
                {measures.map((m) => <td key={m} className={styles.number}>{formatValue('decimal', g.measures[m])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (page.objects.length === 0) return <EmptyState icon="search" title="No objects match" />;
  const first = page.objects[0]!;
  const type = lookup?.types.get(first.objectTypeId);
  const columns = Object.keys(first.values);
  const property = (apiName: string) => type?.properties.find((p) => p.apiName === apiName);
  return (
    <div className={styles.scroll}>
      <table className={styles.table} aria-label={label}>
        <thead><tr>{columns.map((c) => <th key={c} scope="col">{property(c)?.displayName ?? humanise(c)}</th>)}</tr></thead>
        <tbody ref={body}>
          {page.objects.map((o) => (
            <tr key={o.id} aria-selected={selected !== undefined ? o.id === selected : undefined} className={o.id === selected ? styles.selected : undefined}>
              {columns.map((c, i) => {
                const text = o.disputed.includes(c) ? <span className={styles.muted}>Systems disagree</span>
                  : o.masked.includes(c) || o.redacted.includes(c) ? <span className={styles.muted}>Not visible to you</span>
                  : formatValue(property(c)?.dataType as DataType | undefined, o.values[c]);
                return i === 0
                  ? <th key={c} scope="row"><Link href={objectHref({ objectTypeId: o.objectTypeId, objectId: o.id }) as never}>{text}</Link></th>
                  : <td key={c}>{text}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
