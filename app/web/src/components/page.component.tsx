'use client';

// A page's frame: where it sits (breadcrumbs), its title and what it is for, the actions it
// offers, and its content. Sets the document title, so the browser's tab and history say where
// the person is.

import Link from 'next/link';
import { useEffect, type ReactNode } from 'react';
import { Icon } from './icon.component.tsx';
import styles from './page.component.module.css';

export interface Crumb { label: string; href?: string | undefined }

export function Page({ title, description, crumbs, actions, meta, children, width = 'wide' }: {
  title: ReactNode;
  /** A plain-text title for the browser tab when the visible title is not text. */
  documentTitle?: string;
  description?: ReactNode;
  crumbs?: readonly Crumb[];
  actions?: ReactNode;
  /** Small facts under the title: owner, updated, markings. */
  meta?: ReactNode;
  children: ReactNode;
  width?: 'narrow' | 'wide' | 'full';
}) {
  const text = typeof title === 'string' ? title : undefined;
  useEffect(() => {
    if (text !== undefined) document.title = `${text} · Silo`;
  }, [text]);
  return (
    <div className={`${styles.page} ${styles[width]}`}>
      <header className={styles.header}>
        {crumbs !== undefined && crumbs.length > 0 ? (
          <nav aria-label="Breadcrumb" className={styles.crumbs}>
            <ol>
              {crumbs.map((crumb, i) => (
                <li key={`${crumb.label}${i}`}>
                  {crumb.href !== undefined ? <Link href={crumb.href as never}>{crumb.label}</Link> : <span>{crumb.label}</span>}
                  <Icon name="chevronRight" size={12} />
                </li>
              ))}
            </ol>
          </nav>
        ) : null}
        <div className={styles.titleRow}>
          <div className={styles.titleText}>
            <h1 className={styles.title}>{title}</h1>
            {description !== undefined ? <p className={styles.description}>{description}</p> : null}
            {meta !== undefined ? <div className={styles.meta}>{meta}</div> : null}
          </div>
          {actions !== undefined ? <div className={styles.actions}>{actions}</div> : null}
        </div>
      </header>
      <div className={styles.body}>{children}</div>
    </div>
  );
}

/** A titled part of a page. */
export function Section({ title, description, actions, children }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <div>
          <h2 className={styles.sectionTitle}>{title}</h2>
          {description !== undefined ? <p className={styles.description}>{description}</p> : null}
        </div>
        {actions !== undefined ? <div className={styles.actions}>{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** Controls above a list: search, filters, then actions at the end. */
export function Toolbar({ children, end }: { children?: ReactNode; end?: ReactNode }) {
  return (
    <div className={styles.toolbar}>
      <div className={styles.toolbarStart}>{children}</div>
      {end !== undefined ? <div className={styles.toolbarEnd}>{end}</div> : null}
    </div>
  );
}

/** Facts as label and value. */
export function Properties({ items, columns = 2 }: { items: readonly (readonly [ReactNode, ReactNode] | false | null | undefined)[]; columns?: 1 | 2 | 3 }) {
  return (
    <dl className={`${styles.properties} ${styles[`cols${columns}`]}`}>
      {items.filter((i): i is readonly [ReactNode, ReactNode] => Array.isArray(i)).map(([label, value], i) => (
        <div key={i} className={styles.property}>
          <dt>{label}</dt>
          <dd>{value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A bordered box of content. */
export function Panel({ children, padded = true }: { children: ReactNode; padded?: boolean }) {
  return <div className={padded ? styles.panel : styles.panelFlush}>{children}</div>;
}
