'use client';

// OAuth apps (spec 15.4–15.6): the OAuth clients Silo signs in to providers with, for this
// organisation. Its own clients (bring your own) come first for a connector, then one Silo
// registered for it automatically, then Silo's own. A client's secret is sealed when given and
// shredded when the client is revoked; the redirect address shown at registration is the one
// the provider must allow. A provider the catalogue does not know is discovered from its
// metadata, with nothing typed by hand.

import { useMemo, useState, type FormEvent } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { CopyButton } from '../../components/copy.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { Checkbox, fieldError, FormActions, SelectField, TextField } from '../../components/field.component.tsx';
import { Page, Properties, Section, Toolbar } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useBlocked, useMutation, usePermit, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import styles from './connect.view.module.css';

type Client = Output<'listOAuthClients'>['clients'][number];
type Metadata = Output<'discoverOAuthProvider'>;

const ORIGIN: Record<Client['origin'], string> = { bring_your_own: 'Your own', dynamic_registration: 'Registered by Silo for you', silo_registered: 'Silo\'s' };

function useConnectorNames() {
  const permit = usePermit('browseConnectorCatalogue');
  const catalogue = useQuery('browseConnectorCatalogue', permit.allowed === true ? { query: { limit: 200 } } : null, { staleMs: 10 * 60_000 });
  return useMemo(() => {
    const entries = catalogue.data?.connectors ?? [];
    const names = new Map(entries.map((c) => [c.id, c.name]));
    return { entries, nameOf: (id: string) => names.get(id) ?? 'a connector' };
  }, [catalogue.data]);
}

function RegisterDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const connectors = useConnectorNames();
  const register = useMutation('registerOAuthClient', { invalidates: ['listOAuthClients'] });
  const [connectorId, setConnectorId] = useState('');
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await register.run({ body: { connectorId, clientId: clientId.trim(), ...(secret !== '' ? { clientSecret: secret } : {}) } });
  };
  const done = register.data;
  const close = () => {
    register.reset();
    onClose();
  };
  return (
    <Dialog open={open} onClose={close} title="Register your own OAuth client" size="md" busy={register.pending}
      description="Use your organisation's own application with the provider, rather than Silo's. Connections made from this connector sign in with it from now on.">
      {done !== undefined ? (
        <div className={styles.stack}>
          <Banner tone="ok" title="Registered">The provider must allow this redirect address for the application, or sign-ins will be refused.</Banner>
          <div className={styles.secret}>
            <span className={styles.secretLabel}>Redirect address</span>
            <code className={styles.mono}>{done.redirectUri}</code>
            <CopyButton value={done.redirectUri} label="Copy the redirect address" />
          </div>
          <FormActions><Button variant="primary" onClick={close}>Done</Button></FormActions>
        </div>
      ) : (
        <form onSubmit={submit} className={styles.form} autoComplete="off">
          <SelectField label="Connector" required value={connectorId} onChange={(e) => setConnectorId(e.target.value)} placeholder="Choose a connector"
            options={connectors.entries.filter((c) => c.status === 'active').map((c) => ({ value: c.id, label: `${c.name} (${c.provider})` }))}
            error={fieldError(register.error, 'connectorId')} />
          <TextField label="Client ID" required maxLength={500} value={clientId} onChange={(e) => setClientId(e.target.value)} spellCheck={false}
            error={fieldError(register.error, 'clientId')} />
          <TextField label="Client secret (optional)" type="password" autoComplete="new-password" value={secret} onChange={(e) => setSecret(e.target.value)}
            hint="Leave empty for a public client, which signs in with PKCE. Sealed when saved; never shown again." error={fieldError(register.error, 'clientSecret')} />
          {register.error !== undefined && ['connectorId', 'clientId', 'clientSecret'].every((f) => fieldError(register.error, f) === undefined) ? <ErrorMessage error={register.error} /> : null}
          <FormActions>
            <Button onClick={close} disabled={register.pending}>Cancel</Button>
            <Button type="submit" variant="primary" pending={register.pending} blocked={register.blocked} disabled={connectorId === '' || clientId.trim() === ''}>Register</Button>
          </FormActions>
        </form>
      )}
    </Dialog>
  );
}

function DiscoverDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const discover = useMutation('discoverOAuthProvider');
  const [url, setUrl] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await discover.run({ body: { url: url.trim() } });
  };
  const found: Metadata | undefined = discover.data;
  return (
    <Dialog open={open} onClose={() => {
      discover.reset();
      onClose();
    }} title="Discover a provider" size="lg" busy={discover.pending}
      description="Read a provider's published OAuth metadata: its endpoints, flows and scopes, for writing a connector for it.">
      <form onSubmit={submit} className={styles.form}>
        <TextField label="The provider's address" type="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://login.example.com"
          hint="Its issuer, or the address of its metadata document." data-autofocus error={fieldError(discover.error, 'url')} />
        {discover.error !== undefined && fieldError(discover.error, 'url') === undefined ? <ErrorMessage error={discover.error} /> : null}
        <FormActions>
          <Button type="submit" variant="primary" pending={discover.pending} blocked={discover.blocked} disabled={url.trim() === ''}>Discover</Button>
        </FormActions>
      </form>
      {found !== undefined ? (
        <Section title={found.issuer}>
          <Properties columns={1} items={[
            ['Sign-in address', found.authorizationEndpoint ?? 'None: it signs in machines only'],
            ['Token address', found.tokenEndpoint],
            ['Revocation', found.revocationEndpoint ?? 'Not offered'],
            ['Registers clients itself', found.registrationEndpoint === null ? 'No: register an application with it by hand' : 'Yes: Silo can register one for you'],
            ['Flows', found.grantTypesSupported.length === 0 ? '—' : found.grantTypesSupported.join(', ')],
            ['PKCE', found.codeChallengeMethodsSupported.length === 0 ? 'Not offered' : found.codeChallengeMethodsSupported.join(', ')],
            ['Scopes', found.scopesSupported.length === 0 ? 'Not published' : found.scopesSupported.join(', ')],
            ['Metadata', <span key="m" className={styles.mono}>{found.metadataUrl}</span>],
          ]} />
        </Section>
      ) : null}
    </Dialog>
  );
}

export function OAuthApps() {
  const say = useToast();
  const people = useDirectory();
  const connectors = useConnectorNames();
  const [params, set] = useParams();
  const ended = params.get('ended') === '1';
  const clients = useQuery('listOAuthClients', { query: ended ? { includeRevoked: 'true' } : {} });
  const revoke = useMutation('revokeOAuthClient', { invalidates: ['listOAuthClients'] });
  const registerBlocked = useBlocked('registerOAuthClient');
  const discoverBlocked = useBlocked('discoverOAuthProvider');
  const [revoking, setRevoking] = useState<Client | undefined>(undefined);
  usePageContext({ scope: { kind: 'page', page: 'connect' }, scopeLabel: 'OAuth apps' });
  return (
    <Page title="OAuth apps" description="The applications Silo signs in to providers with. Your own come first for a connector; otherwise Silo registers one for you or uses its own."
      crumbs={[{ label: 'Connect' }]}
      actions={<>
        <Button icon="search" blocked={discoverBlocked} onClick={() => set({ discover: '1' })}>Discover a provider</Button>
        <Button variant="primary" icon="plus" blocked={registerBlocked} onClick={() => set({ new: '1' })}>Register a client</Button>
      </>}>
      <Toolbar>
        <Checkbox label="Show revoked clients" checked={ended} onChange={() => set({ ended: ended ? undefined : '1' })} />
      </Toolbar>
      <QueryView query={clients} what="OAuth clients" isEmpty={(d) => d.clients.length === 0}
        empty={<EmptyState icon="key" title="No clients of your own">Connections sign in with a client Silo registers for you, or with Silo's own. Register yours to use your organisation's application.</EmptyState>}>
        {(d) => (
          <DataTable label="OAuth clients" rows={d.clients} rowKey={(c) => c.id} columns={[
            { id: 'connector', header: 'Connector', primary: true, sortValue: (c) => connectors.nameOf(c.connectorId), cell: (c) => connectors.nameOf(c.connectorId) },
            { id: 'client', header: 'Client ID', cell: (c) => <span className={styles.mono}>{c.clientId}</span> },
            { id: 'origin', header: 'Whose', width: 'md', cell: (c) => ORIGIN[c.origin] },
            { id: 'kind', header: 'Kind', width: 'sm', cell: (c) => (c.confidential ? 'Confidential' : 'Public (PKCE)') },
            { id: 'by', header: 'Registered', width: 'md', sortValue: (c) => c.createdAt, cell: (c) => <span>{c.createdBy === null ? 'Silo' : people.nameOf(c.createdBy)}, <Time value={c.createdAt} /></span> },
            { id: 'state', header: 'State', width: 'sm', cell: (c) => (c.revokedAt === null ? <Badge tone="ok">In use</Badge> : <Badge>Revoked</Badge>) },
            { id: 'revoke', header: <span className="visually-hidden">Revoke</span>, width: 'sm', align: 'end', cell: (c) => (c.revokedAt === null && c.origin !== 'silo_registered'
              ? <Button size="sm" variant="ghost" blocked={revoke.blocked} onClick={() => setRevoking(c)}>Revoke</Button> : null) },
          ]} />
        )}
      </QueryView>
      {params.get('new') !== null ? <RegisterDialog open onClose={() => set({ new: undefined })} /> : null}
      {params.get('discover') !== null ? <DiscoverDialog open onClose={() => set({ discover: undefined })} /> : null}
      <ConfirmDialog open={revoking !== undefined} onClose={() => setRevoking(undefined)} title="Revoke this client?" confirmLabel="Revoke" tone="danger"
        onConfirm={async () => {
          const r = await revoke.run({ params: { clientId: revoking!.id } });
          if (r.ok) say('Client revoked: its secret is shredded');
          return r;
        }}>
        <p>No new sign-in uses it, and its secret is shredded. Connections already signed in keep their tokens until they expire; new sign-ins use the next client for the connector.</p>
      </ConfirmDialog>
    </Page>
  );
}
