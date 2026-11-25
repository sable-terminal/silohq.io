'use client';

// Creating an organisation (self-serve sign-up, decision 2026-11-14): the founder's address, the
// organisation's name and short name, and the plan; Silo sends a link to confirm the address.
// Nothing is created until the link is opened, and no password is asked for until then.
// Completing it (the link's page) sets the founder's password and signs them in, then goes to
// the checkout when the plan is paid for.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import type { Input } from '../../api/client.api.ts';
import { Banner } from '../../components/banner.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { RadioGroup, TextField } from '../../components/field.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useData } from '../../data/query.data.ts';
import { slugOf } from '../../utils/slug.util.ts';
import { EntryFrame, rememberOrganisation, takeToken } from './frame.view.tsx';
import { useAttempt } from './signIn.view.tsx';
import styles from './frame.view.module.css';

type Start = NonNullable<Input<'startSignup'>['body']>;


export function SignUp() {
  const { api } = useData();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [plan, setPlan] = useState<Start['plan']>('standard');
  const [term, setTerm] = useState<Start['term']>('monthly');
  const [seats, setSeats] = useState('5');
  const [sent, setSent] = useState<{ email: string; expiresAt: string } | undefined>(undefined);
  const { busy, problem, attempt } = useAttempt();

  const shortName = slugEdited ? slug : slugOf(name);
  const seatCount = Number.parseInt(seats, 10);
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && name.trim() !== '' && /^[a-z0-9][a-z0-9-]{1,62}$/.test(shortName)
    && Number.isInteger(seatCount) && seatCount >= 1 && seatCount <= 499;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    attempt(async () => {
      const started = await api.call('startSignup', {
        body: { email: email.trim(), organisationName: name.trim(), organisationSlug: shortName, plan, term, seats: seatCount },
      });
      setSent({ email: email.trim(), expiresAt: started.expiresAt });
    });
  };

  if (sent !== undefined) {
    return (
      <EntryFrame title="Check your email">
        <p>We sent a link to <strong>{sent.email}</strong>. Open it before <Time value={sent.expiresAt} exact /> to confirm the address and create your organisation.</p>
        <p className={styles.intro}>Nothing is created until the link is opened. If it does not arrive, check your spam folder, or start again.</p>
        <Button variant="link" className={styles.quiet} onClick={() => setSent(undefined)}>Start again</Button>
      </EntryFrame>
    );
  }

  return (
    <EntryFrame title="Create an organisation" intro="Set up Silo for your organisation. You become its first administrator.">
      {problem !== undefined ? <Banner tone="danger" title="Not started" urgent>{problem}</Banner> : null}
      <form className={styles.form} onSubmit={submit} noValidate>
        <TextField label="Your work email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        <TextField label="Organisation name" autoComplete="organization" required value={name} onChange={(e) => setName(e.target.value)} />
        <TextField label="Short name" hint="How your people name the organisation when they sign in: lower-case letters, digits and hyphens" required
          autoCapitalize="none" spellCheck={false} value={shortName}
          onChange={(e) => {
            setSlugEdited(true);
            setSlug(e.target.value.toLowerCase());
          }}
          error={shortName !== '' && !/^[a-z0-9][a-z0-9-]{1,62}$/.test(shortName) ? 'Two to 63 lower-case letters, digits or hyphens, not starting with a hyphen' : undefined} />
        <RadioGroup<Start['plan']> name="plan" label="Plan" value={plan} onChange={setPlan} options={[
          { value: 'standard', label: 'Standard' },
          { value: 'business', label: 'Business' },
        ]} />
        <div className={styles.row}>
          <RadioGroup<Start['term']> name="term" label="Billed" value={term} onChange={setTerm} options={[
            { value: 'monthly', label: 'Monthly' },
            { value: 'annual', label: 'Annually' },
          ]} />
          <TextField label="Seats" type="number" min={1} max={499} required value={seats} onChange={(e) => setSeats(e.target.value)} />
        </div>
        <Button type="submit" variant="primary" className={styles.wide} pending={busy} disabled={!valid}>Send the link</Button>
      </form>
    </EntryFrame>
  );
}

const timeZone = (): string | undefined => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
};

/** The sign-up link's page: the founder's name and password; then they are signed in. */
export function CompleteSignUp() {
  const { api, cache, status } = useData();
  const router = useRouter();
  const [token, setToken] = useState<string | undefined | null>(undefined);
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [password, setPassword] = useState('');
  const { busy, problem, attempt } = useAttempt();
  useEffect(() => setToken(takeToken() ?? null), []);

  if (token === undefined) return <EntryFrame title="Create your organisation"><p role="status">Reading the link…</p></EntryFrame>;
  if (token === null) {
    return (
      <EntryFrame title="This link is incomplete">
        <p>Open the link from the email exactly as it was sent, or <Link href="/sign-up/">start again</Link>.</p>
      </EntryFrame>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    attempt(async () => {
      const zone = timeZone();
      const done = await api.call('completeSignup', {
        body: { token, password, firstName: first.trim(), lastName: last.trim(), ...(zone === undefined ? {} : { timeZone: zone }) },
      });
      setPassword('');
      cache.clear();
      status.live();
      if (done.checkoutUrl !== null) window.location.assign(done.checkoutUrl);
      else router.replace('/' as never);
    });
  };

  return (
    <EntryFrame title="Create your organisation" intro="Your address is confirmed. Choose your name and a password to finish.">
      {problem !== undefined ? <Banner tone="danger" title="Not created" urgent>{problem}</Banner> : null}
      <form className={styles.form} onSubmit={submit} noValidate>
        <div className={styles.row}>
          <TextField label="First name" autoComplete="given-name" required value={first} onChange={(e) => setFirst(e.target.value)} autoFocus />
          <TextField label="Last name" autoComplete="family-name" required value={last} onChange={(e) => setLast(e.target.value)} />
        </div>
        <TextField label="Password" type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)}
          hint="A long passphrase is best. Silo refuses passwords known from breaches." />
        <Button type="submit" variant="primary" className={styles.wide} pending={busy} disabled={first.trim() === '' || last.trim() === '' || password === ''}>
          Create the organisation
        </Button>
      </form>
      <p className={styles.intro}>Remembering the organisation's short name on this device for signing in.</p>
    </EntryFrame>
  );
}

export { rememberOrganisation };
