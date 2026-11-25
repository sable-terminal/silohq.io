'use client';

// The pages before sign-in: one card in the middle of the page, Silo's name above it, and the
// ways between them (sign in, create an organisation, reset a password) below. Under the same
// strict policy as every page; nothing about the person is kept but the organisation's short name,
// remembered on this device for the next sign-in.

import Link from 'next/link';
import type { ReactNode } from 'react';
import { readStored, writeStored } from '../../hooks/storage.hook.ts';
import styles from './frame.view.module.css';

const ORGANISATION_KEY = 'silo.organisation';

export const rememberedOrganisation = (): string => readStored<string>(ORGANISATION_KEY, '');
export const rememberOrganisation = (slug: string): void => writeStored(ORGANISATION_KEY, slug);

/** A token from a link's fragment, taken once and cleared from the address, so it is not left in history or a bookmark. */
export function takeToken(): string | undefined {
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const token = fragment.get('token') ?? undefined;
  if (token !== undefined) window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
  return token;
}

export function EntryFrame({ title, intro, children, foot }: { title: string; intro?: ReactNode; children: ReactNode; foot?: ReactNode }) {
  return (
    <main id="main" className={styles.page}>
      <div className={styles.column}>
        <p className={styles.brand} aria-hidden="true">Silo</p>
        <section className={styles.card} aria-labelledby="entry-title">
          <h1 id="entry-title" className={styles.title}>{title}</h1>
          {intro !== undefined ? <div className={styles.intro}>{intro}</div> : null}
          {children}
        </section>
        <nav className={styles.foot} aria-label="Other ways in">
          {foot ?? (
            <>
              <Link href="/sign-in/">Sign in</Link>
              <Link href="/sign-up/">Create an organisation</Link>
              <Link href="/reset-password/">Forgot your password?</Link>
            </>
          )}
        </nav>
      </div>
    </main>
  );
}
