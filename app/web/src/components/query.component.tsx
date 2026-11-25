'use client';

// One read's region, handled the same way everywhere: loading, then the content; a failure in
// place of the content with a retry; an empty answer with what the place is for; and, when a
// background refresh fails, the content kept with a note that it may be out of date.

import type { ReactNode } from 'react';
import type { PagesResult, QueryResult } from '../data/query.data.ts';
import { Button } from './button.component.tsx';
import { ErrorMessage, ErrorState, Loading, Skeleton } from './states.component.tsx';
import { Time } from './time.component.tsx';
import styles from './query.component.module.css';

export function QueryView<T>({ query, children, isEmpty, empty, what, skeleton }: {
  query: QueryResult<T>;
  children: (data: T) => ReactNode;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  /** Names the content in a failure: "Connections". */
  what?: string;
  /** Placeholder lines rather than a spinner. */
  skeleton?: boolean;
}) {
  if (query.status === 'idle') return null;
  if (query.data === undefined) {
    if (query.status === 'error') return <ErrorState error={query.error} what={what} onRetry={query.refetch} />;
    return skeleton ? <Skeleton /> : <Loading label={what === undefined ? 'Loading' : `Loading ${what.toLowerCase()}`} />;
  }
  return (
    <>
      {query.error !== undefined ? (
        <div className={styles.stale}>
          <ErrorMessage error={query.error} onRetry={query.refetch} />
          <span className={styles.staleNote}>Showing what was read <Time value={new Date(query.updatedAt).toISOString()} />.</span>
        </div>
      ) : null}
      {isEmpty?.(query.data) && empty !== undefined ? empty : children(query.data)}
    </>
  );
}

/** A paged list's region: the pages so far, and a button for the next. */
export function PagesView<T>({ pages, children, isEmpty, empty, what }: {
  pages: PagesResult<T>;
  children: (pages: readonly T[]) => ReactNode;
  isEmpty?: (pages: readonly T[]) => boolean;
  empty?: ReactNode;
  what?: string;
}) {
  if (pages.status === 'idle') return null;
  if (pages.status === 'error') return <ErrorState error={pages.error} what={what} onRetry={pages.refetch} />;
  if (pages.status === 'loading') return <Skeleton />;
  return (
    <>
      {isEmpty?.(pages.pages) && empty !== undefined ? empty : children(pages.pages)}
      {pages.error !== undefined ? <ErrorMessage error={pages.error} onRetry={pages.refetch} /> : null}
      {pages.hasMore ? (
        <div className={styles.more}>
          <Button onClick={pages.loadMore} pending={pages.fetching}>Load more</Button>
        </div>
      ) : null}
    </>
  );
}
