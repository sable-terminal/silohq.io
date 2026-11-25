'use client';

// Signing in (spec 55.3, 55.4): the organisation first, so the page knows whether it signs in by
// password, by its identity provider or both; then the person's credentials; then their second
// factor where the organisation asks for one (a code from an authenticator app, or a security
// key), or setting up an authenticator where they have none. The session is the gateway's cookie
// only: nothing of it is kept in the page. Afterwards the person goes back to the page they asked
// for, if it is one of this client's own.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { isApiError, type Output } from '../../api/client.api.ts';
import { Banner } from '../../components/banner.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { TextField } from '../../components/field.component.tsx';
import { useData } from '../../data/query.data.ts';
import { hrefWith, safeNext } from '../../utils/href.util.ts';
import { EntryFrame, rememberedOrganisation, rememberOrganisation } from './frame.view.tsx';
import styles from './frame.view.module.css';

type Session = Output<'signIn'>;
type Options = Output<'signInOptions'>;
type Step =
  | { kind: 'checking' }
  | { kind: 'organisation' }
  | { kind: 'credentials'; organisation: string; options: Options }
  | { kind: 'mfa' }
  | { kind: 'enrol'; factorId: string; otpauthUri: string };

export const SSO_FLOW_KEY = 'silo.sso';

/** What a refusal says to the person at the door: the gateway's words, and the reference when it is a fault. */
export function entryProblem(error: unknown): string {
  if (isApiError(error)) {
    if (error.category === 'rate_limited') return `Too many attempts. Try again in ${error.retryAfterSeconds ?? 60} seconds.`;
    if (error.kind === 'offline') return 'Silo could not be reached. Check your connection and try again.';
    const reference = error.status >= 500 && error.correlationId !== undefined ? ` Reference ${error.correlationId}.` : '';
    return `${error.sentence}${reference}`;
  }
  if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'AbortError')) {
    return 'The security key was not used. Try again, or enter a code from your authenticator app.';
  }
  if (error instanceof Error && error.message === 'security_keys_unsupported') {
    return 'This browser cannot use a security key here. Enter a code from your authenticator app.';
  }
  return 'Something went wrong. Try again.';
}

/** The authenticator secret from an otpauth URI, grouped in fours for typing. */
export function secretOf(otpauthUri: string): string {
  const secret = new URL(otpauthUri).searchParams.get('secret') ?? '';
  return secret.replace(/(.{4})/g, '$1 ').trim();
}

/** Work that may fail: busy while it runs, its failure said in words. */
export function useAttempt(): { busy: boolean; problem: string | undefined; attempt: (work: () => Promise<void>) => void; clear: () => void } {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  return {
    busy,
    problem,
    clear: () => setProblem(undefined),
    attempt(work) {
      setBusy(true);
      setProblem(undefined);
      void work().catch((error: unknown) => setProblem(entryProblem(error))).finally(() => setBusy(false));
    },
  };
}

export function SignIn() {
  const router = useRouter();
  const { api, cache, status } = useData();
  const [step, setStep] = useState<Step>({ kind: 'checking' });
  const [organisation, setOrganisation] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [next, setNext] = useState('/');
  const { busy, problem, attempt } = useAttempt();

  const startEnrolment = async () => {
    const started = await api.call('startTotpEnrolment', {});
    setStep({ kind: 'enrol', factorId: started.factorId, otpauthUri: started.otpauthUri });
  };

  const finish = (session: Session, target = next) => {
    if (session.mfa === 'required') setStep({ kind: 'mfa' });
    else if (session.mfa === 'enrolment_required') void startEnrolment().catch(() => setStep({ kind: 'mfa' }));
    else {
      // Whatever was read before belongs to no one now.
      cache.clear();
      status.live();
      router.replace(target as never);
    }
  };

  // Where to go afterwards, and whether a session (or one waiting for its second factor) is already open.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const target = safeNext(params.get('next'));
    setNext(target);
    setOrganisation(params.get('organisation') ?? rememberedOrganisation());
    void (async () => {
      try {
        const session = await api.call('currentSession', {}, { attempts: 1 });
        finish(session, target);
      } catch {
        setStep({ kind: 'organisation' });
      }
    })();
    // Once, when the page opens.
  }, []);

  const chooseOrganisation = (event: FormEvent) => {
    event.preventDefault();
    const slug = organisation.trim().toLowerCase();
    if (slug === '') return;
    attempt(async () => {
      const options = await api.call('signInOptions', { query: { organisationSlug: slug } });
      rememberOrganisation(slug);
      setStep({ kind: 'credentials', organisation: slug, options });
    });
  };

  const signIn = (event: FormEvent) => {
    event.preventDefault();
    if (step.kind !== 'credentials') return;
    attempt(async () => {
      const session = await api.call('signIn', { body: { organisationSlug: step.organisation, email: email.trim(), password } });
      setPassword('');
      finish(session);
    });
  };

  const startSso = (providerId: string) => {
    if (step.kind !== 'credentials') return;
    attempt(async () => {
      const started = await api.call('startSignInBySso', { body: { organisationSlug: step.organisation, providerId } });
      // The flow is bound to this browser tab: the return page proves it is the one that started it.
      window.sessionStorage.setItem(SSO_FLOW_KEY, JSON.stringify({ binding: started.binding, next }));
      window.location.assign(started.redirectUrl);
    });
  };

  const verifyCode = (event: FormEvent) => {
    event.preventDefault();
    attempt(async () => {
      const digits = code.replace(/\s/g, '');
      const session = step.kind === 'enrol'
        ? await api.call('confirmTotpEnrolment', { body: { factorId: step.factorId, code: digits } })
        : await api.call('verifyMfa', { body: { code: digits } });
      setCode('');
      finish(session);
    });
  };

  const signInWithKey = () => {
    attempt(async () => {
      const started = await api.call('startSecurityKeyAssertion', {});
      const json = PublicKeyCredential as unknown as { parseRequestOptionsFromJSON?: (options: unknown) => PublicKeyCredentialRequestOptions };
      if (json.parseRequestOptionsFromJSON === undefined) throw new Error('security_keys_unsupported');
      const credential = await navigator.credentials.get({ publicKey: json.parseRequestOptionsFromJSON(started.options) }) as
        (PublicKeyCredential & { toJSON(): unknown }) | null;
      if (credential === null) throw new DOMException('no credential', 'NotAllowedError');
      const session = await api.call('verifySecurityKeyAssertion', { body: { response: credential.toJSON() as never } });
      finish(session);
    });
  };

  const signOut = () => {
    attempt(async () => {
      await api.call('signOut', {});
      setStep({ kind: 'organisation' });
    });
  };

  const securityKeys = typeof window !== 'undefined' && 'PublicKeyCredential' in window;
  const failure = problem === undefined ? null : <Banner tone="danger" title="Not signed in" urgent>{problem}</Banner>;

  if (step.kind === 'checking') return <EntryFrame title="Sign in"><p className={styles.intro} role="status">Checking whether you are signed in…</p></EntryFrame>;

  if (step.kind === 'organisation') {
    return (
      <EntryFrame title="Sign in">
        {failure}
        <form className={styles.form} onSubmit={chooseOrganisation} noValidate>
          <TextField label="Organisation" hint="The short name your organisation uses in Silo, such as acme" name="organisation" autoComplete="organization"
            autoCapitalize="none" spellCheck={false} required value={organisation} onChange={(e) => setOrganisation(e.target.value)} autoFocus />
          <Button type="submit" variant="primary" className={styles.wide} pending={busy} disabled={organisation.trim() === ''}>Continue</Button>
        </form>
      </EntryFrame>
    );
  }

  if (step.kind === 'credentials') {
    const { options } = step;
    return (
      <EntryFrame title={`Sign in to ${step.organisation}`}>
        {failure}
        {options.providers.map((provider, i) => (
          <Button key={provider.providerId} className={styles.wide} disabled={busy} onClick={() => startSso(provider.providerId)}>
            Continue with single sign-on{options.providers.length > 1 ? ` (${provider.kind.toUpperCase()} ${i + 1})` : ''}
          </Button>
        ))}
        {options.ssoRequired ? (
          <p className={styles.intro}>Your organisation signs in through its identity provider only.</p>
        ) : (
          <>
            {options.providers.length > 0 ? <div className={styles.divider}>or with your password</div> : null}
            <form className={styles.form} onSubmit={signIn} noValidate>
              <TextField label="Email" type="email" name="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
              <TextField label="Password" type="password" name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
              <Button type="submit" variant="primary" className={styles.wide} pending={busy} disabled={email === '' || password === ''}>Sign in</Button>
            </form>
            <Link className={styles.quiet} href={hrefWith('/reset-password/', { organisation: step.organisation }) as never}>Forgot your password?</Link>
          </>
        )}
        <Button variant="link" className={styles.quiet} onClick={() => setStep({ kind: 'organisation' })}>Use another organisation</Button>
      </EntryFrame>
    );
  }

  return (
    <EntryFrame title={step.kind === 'mfa' ? 'Confirm it is you' : 'Set up your authenticator'}
      intro={step.kind === 'mfa' ? 'Enter the code from your authenticator app.'
        : 'Your organisation asks for a second factor. Add Silo to an authenticator app with this key, then enter the code it shows.'}>
      {failure}
      <form className={styles.form} onSubmit={verifyCode} noValidate>
        {step.kind === 'enrol' ? (
          <>
            <p className={styles.secret}>{secretOf(step.otpauthUri)}</p>
            <a href={step.otpauthUri}>Open in an authenticator app on this device</a>
          </>
        ) : null}
        <TextField label="Code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={8} required value={code}
          onChange={(e) => setCode(e.target.value)} autoFocus />
        <Button type="submit" variant="primary" className={styles.wide} pending={busy} disabled={code.replace(/\s/g, '').length < 6}>
          {step.kind === 'mfa' ? 'Verify' : 'Confirm and continue'}
        </Button>
        {step.kind === 'mfa' && securityKeys ? <Button className={styles.wide} disabled={busy} onClick={signInWithKey}>Use a security key</Button> : null}
      </form>
      <Button variant="link" className={styles.quiet} onClick={signOut}>Sign out</Button>
    </EntryFrame>
  );
}
