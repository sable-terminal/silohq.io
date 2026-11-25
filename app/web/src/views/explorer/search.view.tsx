'use client';

// Search across every type (spec 34.1, 33.5): the same typed, unmetered search as the search
// palette, pushed down to each source on titles and search properties, bounded per source, or
// read from the Object Index where enabled. Results are grouped by type with a count, exact only
// where every source answered within bounds; each source not searched is named with why. An index
// answer says when it was last refreshed: never presented as live. Types and properties whose
// names match are listed too, to browse.

import Link from 'next/link';
import type { Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Page, Section } from '../../components/page.component.tsx';
import { SearchInput } from '../../components/search.component.tsx';
import { EmptyState, ErrorMessage, Loading } from '../../components/states.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useBlocked, useQuery } from '../../data/query.data.ts';
import { useParam } from '../../hooks/params.hook.ts';
import { useVocabulary } from '../../hooks/vocabulary.hook.ts';
import { hitHref, typeHref } from '../../navigation/links.navigation.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { formatNumber } from '../../utils/format.util.ts';
import styles from './types.view.module.css';

type Reply = Output<'searchObjects'>;

const WHY: Record<Reply['notSearched'][number]['reason'], string> = {
  no_access: 'you have no access to it', withheld: 'its titles are withheld from you', no_search_capability: 'it cannot search by title',
  not_mappable: 'its title is not a field it can filter on', over_bound: 'more matches than the bound: narrow the search', source_unreachable: 'it did not answer',
};

export function Search() {
  const [q, setQ] = useParam('q');
  const text = (q ?? '').trim();
  const { lookup } = useVocabulary();
  const blocked = useBlocked('searchObjects');
  const objects = useQuery('searchObjects', text.length >= 1 && blocked === undefined ? { body: { text, surface: 'explorer' } } : null, { keepPrevious: true });
  const names = useQuery('searchVocabulary', text.length >= 1 && blocked === undefined ? { body: { text, limit: 10, surface: 'explorer' } } : null, { keepPrevious: true });
  usePageContext({ scope: { kind: 'page', page: 'explorer' }, scopeLabel: 'Search', status: objects.data === undefined ? undefined
    : objects.data.method === 'index' ? 'From the Object Index' : objects.data.method === 'mixed' ? 'From the sources and the Object Index' : 'Searched in each source' });
  const reply = objects.data;
  const found = reply?.groups.filter((g) => reply.results.some((r) => r.objectTypeId === g.objectTypeId)) ?? [];

  return (
    <Page title="Search" description="Find objects across every system at once, by their titles and search properties. Nothing here calls a model or is metered."
      crumbs={[{ label: 'Explorer', href: '/explorer/types/' }]}>
      <SearchInput label="Search objects" placeholder="Search objects by their titles" value={q ?? ''} onChange={(v) => setQ(v === '' ? undefined : v)} delayMs={300} />
      {blocked !== undefined ? <EmptyState icon="lock" title="Search is not available to you">{blocked.message}</EmptyState> : null}
      {text === '' && blocked === undefined ? <EmptyState icon="search" title="Search across every type">Type part of a name or reference. Press / anywhere to search pages and settings too.</EmptyState> : null}
      {text !== '' && names.data !== undefined && names.data.hits.length > 0 ? (
        <Section title="Types and properties">
          <ul className={styles.hits}>
            {names.data.hits.map((h) => (
              <li key={`${h.kind}:${h.id}`}>
                {h.kind === 'object_type' ? <Link href={typeHref(h.id) as never}>{h.displayName}</Link>
                  : h.objectTypeId !== null ? <><Link href={typeHref(h.objectTypeId) as never}>{h.displayName}</Link> <span className={styles.muted}>a property of {lookup?.typeName(h.objectTypeId, true)}</span></>
                  : <>{h.displayName} <span className={styles.muted}>{h.kind.replace('_', ' ')}</span></>}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {text !== '' && objects.status === 'error' ? <ErrorMessage error={objects.error} onRetry={objects.refetch} /> : null}
      {text !== '' && reply === undefined && objects.status !== 'error' && blocked === undefined ? <Loading label="Searching" /> : null}
      {reply !== undefined && text !== '' ? (
        <section aria-label={`Results for ${text}`} className={styles.results}>
          {found.length === 0 ? <p className={styles.muted}>Nothing matches “{text}” in the systems that could be searched{reply.notSearched.length > 0 ? ' (see below for those that could not)' : ''}.</p> : null}
          {found.map((group) => {
            const results = reply.results.filter((r) => r.objectTypeId === group.objectTypeId);
            const type = lookup?.types.get(group.objectTypeId);
            return (
              <Section key={group.objectTypeId} title={<>{type?.pluralName ?? 'Objects'} <Badge>{group.exact ? formatNumber(group.count) : `at least ${formatNumber(group.count)}`}</Badge></>}
                description={group.route === 'index' && group.refreshedAt !== null ? <>From the Object Index, as last refreshed <Time value={group.refreshedAt} />.</> : undefined}>
                <ul className={styles.hits}>
                  {results.map((r) => <li key={`${r.objectTypeId}:${r.identifier}`}><Link href={hitHref(r) as never}>{r.title ?? `${type?.displayName ?? 'Object'} ${r.identifier}`}</Link></li>)}
                </ul>
              </Section>
            );
          })}
          {reply.notSearched.length > 0 ? (
            <Section title="Not searched" description={found.length > 0 ? 'A count above is a lower bound where one of its systems is listed here.' : undefined}>
              <ul className={styles.hits}>
                {reply.notSearched.map((m) => (
                  <li key={`${m.objectTypeId}:${m.connectionId ?? ''}:${m.sourceObject ?? ''}`}>{lookup?.typeName(m.objectTypeId, true) ?? 'A type'} in {m.sourceObject ?? 'a system'}: {WHY[m.reason]}</li>
                ))}
              </ul>
            </Section>
          ) : null}
        </section>
      ) : null}
    </Page>
  );
}
