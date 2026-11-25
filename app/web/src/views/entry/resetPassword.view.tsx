'use client';

// Resetting a password (spec 55.3). Without a token, the person names their organisation and
// address and Silo emails a link, answering the same whether or not the address has an account
// (so the page never says who does). With the link's token, they choose a new password; the
// link works once.

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { Banner } from '../../components/banner.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { TextField } from '../../components/field.component.tsx';
import { useData } from '../../data/query.data.ts';
import { hrefWith } from '../../utils/href.util.ts';
import { EntryFrame, rememberedOrganisation, rememberOrganisation, takeToken } from './frame.view.tsx';
import { useAttempt } from './signIn.view.tsx';
import styles from './frame.view.module.css';

export function ResetPassword() {
  const { api } = useData();
  const [organisation, setOrganisation] = useState('');
  const [token, setToken] = useState<string | undefined | null>(undefined);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [outcome, setOutcome] = useState<'sent' | 'reset' | undefined>(undefined);
  const { busy, problem, attempt } = useAttempt();

  useEffect(() => {
    setOrganisation(new URLSearchParams(window.location.search).get('organisation') ?? rememberedOrganisation());
    setToken(takeToken() ?? null);
  }, []);

  if (token === undefined) return <EntryFrame title="Reset your password"><p role="status">Reading the link…</p></EntryFrame>;

  const slug = organisation.trim().toLowerCase();

  if (outcome === 'sent') {
    return (
      <EntryFrame title="Check your email">
        <p>If <strong>{email.trim()}</strong> has an account at {slug}, a link to reset its password is on its way. It works once, for a limited time.</p>
        <Link href={hrefWith('/sign-in/', { organisation: slug }) as never}>Back to sign in</Link>
      </EntryFrame>
    );
  }
  if (outcome === 'reset') {
    return (
      <EntryFrame title="Your password is changed">
        <p>Sign in with your new password. Sessions signed in with the old one have ended.</p>
        <Link href={hrefWith('/sign-in/', { organisation: slug }) as never}>Sign in</Link>
      </EntryFrame>
    );
  }

  if (token === null) {
    const request = (event: FormEvent) => {
      event.preventDefault();
      attempt(async () => {
        await api.call('requestPasswordReset', { body: { organisationSlug: slug, email: email.trim() } });
        rememberOrganisation(slug);
        setOutcome('sent');
      });
    };
    return (
      <EntryFrame title="Reset your password" intro="Silo emails you a link to choose a new one.">
        {problem !== undefined ? <Banner tone="danger" title="Not sent" urgent>{problem}</Banner> : null}
        <form className={styles.form} onSubmit={request} noValidate>
          <TextField label="Organisation" hint="The short name your organisation uses in Silo" autoCapitalize="none" spellCheck={false} required value={organisation}
            onChange={(e) => setOrganisation(e.target.value)} />
          <TextField label="Email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          <Button type="submit" variant="primary" className={styles.wide} pending={busy} disabled={slug === '' || email.trim() === ''}>Email me a link</Button>
        </form>
      </EntryFrame>
    );
  }

  const mismatch = again !== '' && again !== password;
  const reset = (event: FormEvent) => {
    event.preventDefault();
    if (mismatch || password === '') return;
    attempt(async () => {
      await api.call('resetPassword', { body: { organisationSlug: slug, token, newPassword: password } });
      setPassword('');
      setAgain('');
      setOutcome('reset');
    });
  };
  return (
    <EntryFrame title="Choose a new password" intro={slug === '' ? undefined : `For your account at ${slug}.`}>
      {problem !== undefined ? <Banner tone="danger" title="Not changed" urgent>{problem}</Banner> : null}
      <form className={styles.form} onSubmit={reset} noValidate>
        {slug === '' ? <TextField label="Organisation" autoCapitalize="none" spellCheck={false} required value={organisation} onChange={(e) => setOrganisation(e.target.value)} /> : null}
        <TextField label="New password" type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} autoFocus
          hint="A long passphrase is best. Silo refuses passwords known from breaches." />
        <TextField label="The same again" type="password" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)}
          error={mismatch ? 'The two do not match' : undefined} />
        <Button type="submit" variant="primary" className={styles.wide} pending={busy} disabled={password === '' || again === '' || mismatch || slug === ''}>Change my password</Button>
      </form>
    </EntryFrame>
  );
}
