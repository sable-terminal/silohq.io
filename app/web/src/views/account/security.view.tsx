'use client';

// How the person signs in: their second factors (an authenticator app, security keys; one
// always remains once their organisation asks for one) and the identities from identity
// providers linked to their account.

import { useState, type FormEvent } from 'react';
import { Banner } from '../../components/banner.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { ConfirmDialog } from '../../components/dialog.component.tsx';
import { TextField } from '../../components/field.component.tsx';
import { Page, Panel, Section } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { usePageContext, useWorkspace } from '../../shell/context.shell.tsx';
import { secretOf, SSO_FLOW_KEY } from '../entry/signIn.view.tsx';
import styles from './account.view.module.css';

type Enrolment = { factorId: string; otpauthUri: string };

export function Security() {
  const workspace = useWorkspace();
  const say = useToast();
  const factors = useQuery('listMfaFactors', {});
  const identities = useQuery('listIdentities', {});
  const slug = workspace.memberships.find((m) => m.current)?.organisationSlug;
  const providers = useQuery('signInOptions', slug === undefined ? null : { query: { organisationSlug: slug } });
  const remove = useMutation('removeMfaFactor');
  const unlink = useMutation('unlinkIdentity');
  const startTotp = useMutation('startTotpEnrolment');
  const confirmTotp = useMutation('confirmTotpEnrolment');
  const startKey = useMutation('startSecurityKeyRegistration');
  const confirmKey = useMutation('confirmSecurityKeyRegistration');
  const link = useMutation('startSsoLink');
  const [enrolment, setEnrolment] = useState<Enrolment | undefined>(undefined);
  const [code, setCode] = useState('');
  const [removing, setRemoving] = useState<{ id: string; label: string } | undefined>(undefined);
  const [unlinking, setUnlinking] = useState<{ id: string; label: string } | undefined>(undefined);
  const [keyProblem, setKeyProblem] = useState<string | undefined>(undefined);
  usePageContext({});

  const addAuthenticator = async () => {
    const started = await startTotp.run({});
    if (started.ok) setEnrolment({ factorId: started.data.factorId, otpauthUri: started.data.otpauthUri });
  };
  const confirm = async (event: FormEvent) => {
    event.preventDefault();
    if (enrolment === undefined) return;
    const done = await confirmTotp.run({ body: { factorId: enrolment.factorId, code: code.replace(/\s/g, '') } });
    if (done.ok) {
      setEnrolment(undefined);
      setCode('');
      factors.refetch();
      say('Authenticator app added');
    }
  };
  const addKey = async () => {
    setKeyProblem(undefined);
    const started = await startKey.run({});
    if (!started.ok) return;
    try {
      const json = PublicKeyCredential as unknown as { parseCreationOptionsFromJSON?: (options: unknown) => PublicKeyCredentialCreationOptions };
      if (json.parseCreationOptionsFromJSON === undefined) throw new Error('unsupported');
      const credential = await navigator.credentials.create({ publicKey: json.parseCreationOptionsFromJSON(started.data.options) }) as
        (PublicKeyCredential & { toJSON(): unknown }) | null;
      if (credential === null) throw new DOMException('no credential', 'NotAllowedError');
      const done = await confirmKey.run({ body: { response: credential.toJSON() as never } });
      if (done.ok) {
        factors.refetch();
        say('Security key added');
      }
    } catch (error) {
      setKeyProblem(error instanceof Error && error.message === 'unsupported'
        ? 'This browser cannot register a security key here.' : 'The security key was not registered. Try again.');
    }
  };
  const linkProvider = async (providerId: string) => {
    const started = await link.run({ body: { providerId } });
    if (!started.ok) return;
    window.sessionStorage.setItem(SSO_FLOW_KEY, JSON.stringify({ binding: started.data.binding, next: '/account/security/' }));
    window.location.assign(started.data.redirectUrl);
  };

  const keys = typeof window !== 'undefined' && 'PublicKeyCredential' in window;
  const linked = new Set(identities.data?.identities.map((i) => i.identityProviderId) ?? []);

  return (
    <Page title="Security" description="How you sign in: your second factors and the identities linked to your account." width="narrow">
      <Section title="Second factors" description="A code from an authenticator app, or a security key, after your password."
        actions={<>
          <Button icon="plus" onClick={() => void addAuthenticator()} pending={startTotp.pending} blocked={startTotp.blocked}>Authenticator app</Button>
          {keys ? <Button icon="key" onClick={() => void addKey()} pending={startKey.pending || confirmKey.pending} blocked={startKey.blocked}>Security key</Button> : null}
        </>}>
        {startTotp.error !== undefined ? <ErrorMessage error={startTotp.error} /> : null}
        {keyProblem !== undefined ? <Banner tone="danger">{keyProblem}</Banner> : null}
        {confirmKey.error !== undefined ? <ErrorMessage error={confirmKey.error} /> : null}
        {enrolment !== undefined ? (
          <Panel>
            <form className={styles.enrol} onSubmit={(e) => void confirm(e)}>
              <p>Add Silo to your authenticator app with this key, then enter the code it shows.</p>
              <p className={styles.secret}>{secretOf(enrolment.otpauthUri)}</p>
              <a href={enrolment.otpauthUri}>Open in an authenticator app on this device</a>
              <TextField label="Code" inputMode="numeric" autoComplete="one-time-code" maxLength={8} required value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
              {confirmTotp.error !== undefined ? <ErrorMessage error={confirmTotp.error} /> : null}
              <div className={styles.actions}>
                <Button onClick={() => setEnrolment(undefined)}>Cancel</Button>
                <Button type="submit" variant="primary" pending={confirmTotp.pending} disabled={code.replace(/\s/g, '').length < 6}>Confirm</Button>
              </div>
            </form>
          </Panel>
        ) : null}
        <QueryView query={factors} what="Your second factors" isEmpty={(d) => d.factors.length === 0}
          empty={<EmptyState icon="lock" title="No second factor yet">Add an authenticator app or a security key.</EmptyState>}>
          {(d) => (
            <DataTable label="Second factors" rows={d.factors} rowKey={(f) => f.id} columns={[
              { id: 'kind', header: 'Factor', primary: true, cell: (f) => (f.kind === 'webauthn' ? 'Security key' : 'Authenticator app') },
              { id: 'added', header: 'Added', cell: (f) => <Time value={f.createdAt} /> },
              { id: 'used', header: 'Last used', cell: (f) => (f.lastUsedAt === null ? 'Not yet' : <Time value={f.lastUsedAt} />) },
              { id: 'remove', header: <span className="visually-hidden">Remove</span>, align: 'end', cell: (f) => (
                <Button size="sm" variant="ghost" blocked={d.factors.length === 1 ? 'Your last second factor stays: add another before removing it' : remove.blocked}
                  onClick={() => setRemoving({ id: f.id, label: f.kind === 'webauthn' ? 'this security key' : 'this authenticator app' })}>Remove</Button>
              ) },
            ]} />
          )}
        </QueryView>
      </Section>
      <Section title="Linked identities" description="Accounts at your organisation's identity providers that sign you in to Silo.">
        {link.error !== undefined ? <ErrorMessage error={link.error} /> : null}
        <QueryView query={identities} what="Your linked identities" isEmpty={(d) => d.identities.length === 0}
          empty={<EmptyState icon="link" title="None linked">You sign in with your password.</EmptyState>}>
          {(d) => (
            <DataTable label="Linked identities" rows={d.identities} rowKey={(i) => i.id} columns={[
              { id: 'issuer', header: 'Identity provider', primary: true, cell: (i) => i.issuer },
              { id: 'kind', header: 'Kind', cell: (i) => i.providerKind.toUpperCase() },
              { id: 'linked', header: 'Linked', cell: (i) => <Time value={i.linkedAt} /> },
              { id: 'unlink', header: <span className="visually-hidden">Unlink</span>, align: 'end', cell: (i) => (
                <Button size="sm" variant="ghost" blocked={unlink.blocked} onClick={() => setUnlinking({ id: i.id, label: i.issuer })}>Unlink</Button>
              ) },
            ]} />
          )}
        </QueryView>
        {(providers.data?.providers ?? []).filter((p) => !linked.has(p.providerId)).map((p) => (
          <div key={p.providerId}>
            <Button icon="link" pending={link.pending} blocked={link.blocked} onClick={() => void linkProvider(p.providerId)}>
              Link your {p.kind.toUpperCase()} account
            </Button>
          </div>
        ))}
      </Section>
      <ConfirmDialog open={removing !== undefined} onClose={() => setRemoving(undefined)} title="Remove this second factor?" confirmLabel="Remove" tone="danger"
        onConfirm={async () => {
          const outcome = await remove.run({ params: { factorId: removing!.id } });
          if (outcome.ok) say('Second factor removed');
          return outcome;
        }}>
        <p>You will no longer be able to use {removing?.label} to confirm it is you.</p>
      </ConfirmDialog>
      <ConfirmDialog open={unlinking !== undefined} onClose={() => setUnlinking(undefined)} title="Unlink this identity?" confirmLabel="Unlink" tone="danger"
        onConfirm={async () => {
          const outcome = await unlink.run({ params: { identityId: unlinking!.id } });
          if (outcome.ok) say('Identity unlinked');
          return outcome;
        }}>
        <p>{unlinking?.label} will no longer sign you in to Silo.</p>
      </ConfirmDialog>
    </Page>
  );
}
