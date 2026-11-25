'use client';

// Accepting an invitation (spec 55.6): the link's token names the invitation; the person gives
// their name and a password, joins, and is signed in. The link works once.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { Banner } from '../../components/banner.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { TextField } from '../../components/field.component.tsx';
import { useData } from '../../data/query.data.ts';
import { EntryFrame, rememberOrganisation, takeToken } from './frame.view.tsx';
import { useAttempt } from './signIn.view.tsx';
import styles from './frame.view.module.css';

export function AcceptInvitation() {
  const { api, cache, status } = useData();
  const router = useRouter();
  const [organisation, setOrganisation] = useState('');
  const [token, setToken] = useState<string | undefined | null>(undefined);
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [password, setPassword] = useState('');
  const { busy, problem, attempt } = useAttempt();

  useEffect(() => {
    setOrganisation(new URLSearchParams(window.location.search).get('organisation') ?? '');
    setToken(takeToken() ?? null);
  }, []);

  if (token === undefined) return <EntryFrame title="Join your organisation"><p role="status">Reading the invitation…</p></EntryFrame>;
  if (token === null || organisation === '') {
    return (
      <EntryFrame title="This invitation link is incomplete">
        <p>Open the link from your invitation email exactly as it was sent. If it has expired, ask whoever invited you to send another.</p>
        <Link href="/sign-in/">Sign in instead</Link>
      </EntryFrame>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    attempt(async () => {
      await api.call('acceptInvitation', { body: { organisationSlug: organisation, token, password, firstName: first.trim(), lastName: last.trim() } });
      setPassword('');
      rememberOrganisation(organisation);
      cache.clear();
      status.live();
      router.replace('/' as never);
    });
  };

  return (
    <EntryFrame title={`Join ${organisation} on Silo`} intro="You were invited. Give your name and choose a password to join.">
      {problem !== undefined ? <Banner tone="danger" title="Not joined" urgent>{problem}</Banner> : null}
      <form className={styles.form} onSubmit={submit} noValidate>
        <div className={styles.row}>
          <TextField label="First name" autoComplete="given-name" required value={first} onChange={(e) => setFirst(e.target.value)} autoFocus />
          <TextField label="Last name" autoComplete="family-name" required value={last} onChange={(e) => setLast(e.target.value)} />
        </div>
        <TextField label="Password" type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)}
          hint="A long passphrase is best. Silo refuses passwords known from breaches." />
        <Button type="submit" variant="primary" className={styles.wide} pending={busy} disabled={first.trim() === '' || last.trim() === '' || password === ''}>Join</Button>
      </form>
    </EntryFrame>
  );
}
