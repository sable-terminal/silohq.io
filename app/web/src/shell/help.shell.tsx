'use client';

// The help centre (the header's question mark). It ships with the client, so it works the same
// on a sovereign or air-gapped cell with no outside help site: what this page is for and what
// can be done on it, every place in Silo found by what you want to do, keyboard shortcuts, where
// the organisation's cell is, and a way to contact support.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../components/button.component.tsx';
import { Icon } from '../components/icon.component.tsx';
import { SearchInput } from '../components/search.component.tsx';
import { GUIDES } from '../help/guides.help.ts';
import { PLACES, placeOf, trailOf } from '../navigation/places.navigation.ts';
import { useWorkspace } from './context.shell.tsx';
import { SHORTCUTS } from './shortcuts.shell.ts';
import styles from './help.shell.module.css';

export function HelpPanel() {
  const workspace = useWorkspace();
  const pathname = usePathname();
  const where = placeOf(pathname);
  const [query, setQuery] = useState('');
  const shortcuts = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (workspace.panel?.query === 'shortcuts') shortcuts.current?.scrollIntoView({ block: 'start' });
  }, [workspace.panel?.query]);

  const matches = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    const placeHits = PLACES.filter((w) => {
      const text = [w.place.label, w.place.purpose, ...w.place.does, ...(w.place.keywords ?? []), ...trailOf(w)].join(' ').toLowerCase();
      return words.every((word) => text.includes(word));
    }).slice(0, 8).map((w) => ({ key: w.place.href, title: trailOf(w).join(' › '), detail: w.place.purpose, href: w.place.href }));
    const guideHits = GUIDES.filter((g) => {
      const text = [g.title, g.summary, ...g.steps, ...(g.keywords ?? [])].join(' ').toLowerCase();
      return words.every((word) => text.includes(word));
    }).slice(0, 5).map((g) => ({ key: g.id, title: g.title, detail: g.summary, href: `/help/?guide=${g.id}` }));
    return [...guideHits, ...placeHits];
  }, [query]);

  const close = () => workspace.closePanel();

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <h2 className={styles.title}>Help centre</h2>
        <Link href="/help/" onClick={close}>Open the help centre</Link>
      </div>
      <SearchInput label="Search help" placeholder="What do you want to do?" value={query} onChange={setQuery} delayMs={100} />
      {query !== '' ? (
        <section aria-label="Results">
          {matches.length === 0 ? <p className={styles.muted}>Nothing matches. Try other words, or contact support.</p> : (
            <ul className={styles.results}>
              {matches.map((m) => (
                <li key={m.key}>
                  <Link href={m.href as never} className={styles.result} onClick={close}>
                    <span className={styles.resultTitle}>{m.title}</span>
                    <span className={styles.muted}>{m.detail}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
      {where !== undefined && query === '' ? (
        <section className={styles.section} aria-labelledby="help-here">
          <h3 id="help-here" className={styles.sectionTitle}>About this page: {trailOf(where).join(' › ')}</h3>
          <p>{where.place.purpose}</p>
          <ul className={styles.does}>
            {where.place.does.map((d) => <li key={d}>{d}</li>)}
          </ul>
          <Link href={`/help/?place=${encodeURIComponent(where.place.href)}` as never} onClick={close}>Guides for this page</Link>
        </section>
      ) : null}
      <section className={styles.section} aria-labelledby="help-shortcuts" ref={shortcuts}>
        <h3 id="help-shortcuts" className={styles.sectionTitle}>Keyboard shortcuts</h3>
        <dl className={styles.shortcuts}>
          {SHORTCUTS.map((s) => (
            <div key={s.keys} className={styles.shortcut}>
              <dt><kbd>{s.keys}</kbd></dt>
              <dd>{s.does}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className={styles.section} aria-labelledby="help-status">
        <h3 id="help-status" className={styles.sectionTitle}>Your Silo</h3>
        {workspace.residency !== undefined ? (
          <p>Your organisation runs in the {workspace.residency.location} cell ({workspace.residency.kind.replace('_', '-')}, {workspace.residency.residency.toUpperCase()} residency).</p>
        ) : <p className={styles.muted}>Where your organisation runs is shown to people who may read its residency.</p>}
      </section>
      <div className={styles.foot}>
        <Button icon="ticket" onClick={() => workspace.openPanel({ name: 'tickets', query: 'new' })}>Contact support</Button>
        <Link href="/help/" className={styles.all} onClick={close}><Icon name="document" size={14} /> All guides</Link>
      </div>
    </div>
  );
}
