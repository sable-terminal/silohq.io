'use client';

// The help centre's page: every guide, and every place in Silo with what it is for and what can
// be done there, searchable by what the person wants to do. Shipped with the client, so it is the
// same on every cell, connected to the internet or not.

import Link from 'next/link';
import { useMemo } from 'react';
import { Button } from '../../components/button.component.tsx';
import { Page, Section } from '../../components/page.component.tsx';
import { SearchInput } from '../../components/search.component.tsx';
import { EmptyState } from '../../components/states.component.tsx';
import { GUIDES } from '../../help/guides.help.ts';
import { useParam } from '../../hooks/params.hook.ts';
import { PLACES, trailOf } from '../../navigation/places.navigation.ts';
import { useWorkspace } from '../../shell/context.shell.tsx';
import styles from './centre.view.module.css';

export function HelpCentre() {
  const workspace = useWorkspace();
  const [query, setQuery] = useParam('q');
  const [guideId] = useParam('guide');
  const [placeHref] = useParam('place');
  const words = useMemo(() => (query ?? '').toLowerCase().split(/\s+/).filter(Boolean), [query]);
  const guide = GUIDES.find((g) => g.id === guideId);
  const places = PLACES.filter((w) => (placeHref === undefined || w.place.href === placeHref)
    && words.every((word) => [w.place.label, w.place.purpose, ...w.place.does, ...(w.place.keywords ?? []), ...trailOf(w)].join(' ').toLowerCase().includes(word)));
  const guides = GUIDES.filter((g) => (placeHref === undefined || g.places.includes(placeHref))
    && words.every((word) => [g.title, g.summary, ...g.steps, ...(g.keywords ?? [])].join(' ').toLowerCase().includes(word)));

  if (guide !== undefined) {
    return (
      <Page title={guide.title} description={guide.summary} crumbs={[{ label: 'Help centre', href: '/help/' }]} width="narrow">
        <ol className={styles.steps}>{guide.steps.map((step) => <li key={step}>{step}</li>)}</ol>
        <div className={styles.links}>
          {guide.places.map((href) => {
            const where = PLACES.find((w) => w.place.href === href);
            return where === undefined ? null : <Link key={href} href={href as never}>Go to {trailOf(where).join(' › ')}</Link>;
          })}
        </div>
      </Page>
    );
  }

  return (
    <Page title="Help centre" description="How to do what you came to Silo to do, and where everything is."
      actions={<Button icon="ticket" onClick={() => workspace.openPanel({ name: 'tickets', query: 'new' })}>Contact support</Button>}>
      <SearchInput label="Search help" placeholder="What do you want to do?" value={query ?? ''} onChange={(v) => setQuery(v)} />
      {placeHref !== undefined ? <p><Link href="/help/">Show help for every page</Link></p> : null}
      {guides.length > 0 ? (
        <Section title="Guides">
          <ul className={styles.list}>
            {guides.map((g) => (
              <li key={g.id}><Link href={`/help/?guide=${g.id}` as never} className={styles.item}><strong>{g.title}</strong><span>{g.summary}</span></Link></li>
            ))}
          </ul>
        </Section>
      ) : null}
      <Section title="Where everything is">
        {places.length === 0 ? <EmptyState title="Nothing matches">Try other words, or contact support.</EmptyState> : (
          <ul className={styles.list}>
            {places.map((w) => (
              <li key={w.place.href} className={styles.place}>
                <Link href={w.place.href as never} className={styles.item}>
                  <strong>{trailOf(w).join(' › ')}</strong>
                  <span>{w.place.purpose}</span>
                </Link>
                <ul className={styles.does}>{w.place.does.map((d) => <li key={d}>{d}</li>)}</ul>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </Page>
  );
}
