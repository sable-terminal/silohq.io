'use client';

// Single sign-on (spec 55): the organisation's identity providers, OpenID Connect or SAML. A
// provider is made or changed at the version read; a SAML provider is given its metadata document
// (which is also how a signing certificate rolls over) or its settings, and Silo's own service
// provider metadata is linked for the provider's administrator. People may be made on their first
// sign-in with a default role and scope; the provider's second factor may be trusted. A client
// secret is written, never shown again.

import { useState } from 'react';
import type { Input, Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { Dialog } from '../../components/dialog.component.tsx';
import { Checkbox, FormActions, RadioGroup, SelectField, Switch, TextArea, TextField } from '../../components/field.component.tsx';
import { Page } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage, Loading } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { useWorkspace } from '../../shell/context.shell.tsx';
import { hrefWith } from '../../utils/href.util.ts';
import { idFrom } from '../studio/kit.view.tsx';
import styles from './settings.view.module.css';

type Provider = Output<'readIdentityProvider'>;
type Body = NonNullable<Input<'configureIdentityProvider'>['body']>;
const crumbs = [{ label: 'Settings', href: '/settings/' }];
const list = (s: string) => s.split(',').map((x) => x.trim()).filter((x) => x !== '');

/** Silo's own SAML service provider metadata, for the provider's administrator. */
function SpMetadata({ providerId }: { providerId: string }) {
  const workspace = useWorkspace();
  const url = `${typeof window === 'undefined' ? '' : window.location.origin}/api/v1/sso/saml/metadata?organisationId=${workspace.session.organisationId}&providerId=${providerId}`;
  return <p className={styles.muted}>Give your identity provider Silo&apos;s metadata: <a href={url} className={styles.mono}>{url}</a></p>;
}

export function SingleSignOn() {
  const [params, set] = useParams();
  const providers = useQuery('listIdentityProviders', {});
  const [making, setMaking] = useState<'oidc' | 'saml' | undefined>();
  const open = idFrom(params.get('provider'));
  return (
    <Page title="Single sign-on" description="How your people sign in. Without a provider, they use a password and a second factor." crumbs={crumbs} width="full"
      actions={
        <div className={styles.row}>
          <Button onClick={() => setMaking('saml')}>Add a SAML provider</Button>
          <Button variant="primary" onClick={() => setMaking('oidc')}>Add an OpenID Connect provider</Button>
        </div>
      }>
      <QueryView query={providers} what="Identity providers" isEmpty={(d) => d.providers.length === 0}
        empty={<EmptyState icon="lock" title="No identity provider">Members sign in with a password and a second factor.</EmptyState>}>
        {(d) => (
          <DataTable label="Identity providers" rows={d.providers} rowKey={(p) => p.providerId} rowHref={(p) => hrefWith('/settings/sso/', { provider: p.providerId })} columns={[
            { id: 'issuer', header: 'Provider', primary: true, cell: (p) => <span className={styles.mono}>{p.issuer}</span> },
            { id: 'kind', header: 'Kind', width: 'sm', cell: (p) => (p.kind === 'oidc' ? 'OpenID Connect' : 'SAML') },
            { id: 'state', header: 'State', width: 'sm', cell: (p) => (p.active ? <Badge tone="ok">Active</Badge> : <Badge>Off</Badge>) },
            { id: 'jit', header: 'New people', cell: (p) => (p.jitProvisioning ? 'Made on first sign-in' : 'Invited first') },
          ]} />
        )}
      </QueryView>
      {making !== undefined ? <ProviderDialog kind={making} onClose={() => setMaking(undefined)} /> : null}
      {open !== undefined ? <ProviderDrawer providerId={open} onClose={() => set({ provider: undefined })} /> : null}
    </Page>
  );
}

function ProviderDrawer({ providerId, onClose }: { providerId: string; onClose: () => void }) {
  const read = useQuery('readIdentityProvider', { params: { providerId } });
  return (
    <Dialog open onClose={onClose} drawer title="Identity provider">
      {read.data === undefined ? (read.status === 'error' ? <ErrorMessage error={read.error} onRetry={read.refetch} /> : <Loading label="Reading it" />)
        : <ProviderForm key={read.data.version} provider={read.data} kind={read.data.config.kind} providerId={providerId} onDone={onClose} />}
    </Dialog>
  );
}

function ProviderDialog({ kind, onClose }: { kind: 'oidc' | 'saml'; onClose: () => void }) {
  const [providerId] = useState(() => crypto.randomUUID());
  return (
    <Dialog open onClose={onClose} title={kind === 'oidc' ? 'Add an OpenID Connect provider' : 'Add a SAML provider'} size="lg">
      <ProviderForm kind={kind} providerId={providerId} onDone={onClose} />
    </Dialog>
  );
}

function ProviderForm({ provider, kind, providerId, onDone }: { provider?: Provider; kind: 'oidc' | 'saml'; providerId: string; onDone: () => void }) {
  const say = useToast();
  const roles = useQuery('listRoles', {});
  const scopes = useQuery('listScopes', { query: {} });
  const configure = useMutation('configureIdentityProvider', { invalidates: ['listIdentityProviders', 'readIdentityProvider'] });
  const oidc = provider?.config.kind === 'oidc' ? provider.config : undefined;
  const saml = provider?.config.kind === 'saml' ? provider.config.settings : undefined;
  const [active, setActive] = useState(provider?.active ?? true);
  const [jit, setJit] = useState(provider?.jitProvisioning ?? false);
  const [roleId, setRoleId] = useState(provider?.defaultRoleId ?? '');
  const [scopeId, setScopeId] = useState(provider?.defaultScopeId ?? '');
  // OpenID Connect
  const [issuer, setIssuer] = useState(provider?.issuer ?? '');
  const [clientId, setClientId] = useState(oidc?.settings.clientId ?? '');
  const [secret, setSecret] = useState('');
  const [clientAuth, setClientAuth] = useState(oidc?.settings.clientAuth ?? 'client_secret_basic');
  const [scopesText, setScopesText] = useState((oidc?.settings.scopes ?? ['openid', 'email', 'profile']).join(', '));
  const [emailClaim, setEmailClaim] = useState(oidc?.settings.emailClaim ?? 'email');
  const [trustMfa, setTrustMfa] = useState(oidc?.settings.trustProviderMfa ?? saml?.trustProviderMfa ?? false);
  const [amr, setAmr] = useState((oidc?.settings.mfaAmrValues ?? ['mfa']).join(', '));
  // SAML
  const [samlSource, setSamlSource] = useState<'metadata' | 'settings'>(saml === undefined ? 'metadata' : 'settings');
  const [metadata, setMetadata] = useState('');
  const [entityId, setEntityId] = useState(saml?.entityId ?? '');
  const [ssoUrl, setSsoUrl] = useState(saml?.ssoUrl ?? '');
  const [certs, setCerts] = useState((saml?.signingCertificates ?? []).join('\n\n'));
  const [encrypted, setEncrypted] = useState(saml?.requireEncryptedAssertions ?? false);
  const [responseSigned, setResponseSigned] = useState(saml?.wantResponseSigned ?? true);
  const [emailAttribute, setEmailAttribute] = useState(saml?.emailAttribute ?? 'email');
  const config: Body['config'] = kind === 'oidc'
    ? { kind, issuer: issuer.trim(), settings: { clientId: clientId.trim(), clientAuth, scopes: list(scopesText), emailClaim: emailClaim.trim(), trustProviderMfa: trustMfa, mfaAmrValues: list(amr) }, ...(secret === '' ? {} : { clientSecret: secret }) }
    : samlSource === 'metadata' && metadata.trim() !== ''
      ? { kind, metadataXml: metadata, overrides: { emailAttribute: emailAttribute.trim(), trustProviderMfa: trustMfa, wantResponseSigned: responseSigned, requireEncryptedAssertions: encrypted } }
      : { kind, settings: { entityId: entityId.trim(), ssoUrl: ssoUrl.trim(), signingCertificates: certs.split(/\n\s*\n/).map((c) => c.trim()).filter((c) => c !== ''),
        requireEncryptedAssertions: encrypted, wantResponseSigned: responseSigned, emailAttribute: emailAttribute.trim(), trustProviderMfa: trustMfa } };
  // A SAML provider is saved from a new metadata document, or else from its settings (as read, or as typed).
  const ready = kind === 'oidc' ? issuer.trim() !== '' && clientId.trim() !== ''
    : metadata.trim() !== '' || (entityId.trim() !== '' && ssoUrl.trim() !== '' && certs.trim() !== '');
  return (
    <form className={styles.form} onSubmit={async (e) => {
      e.preventDefault();
      const r = await configure.run({ params: { providerId }, body: {
        expectedVersion: provider?.version ?? null, active, jitProvisioning: jit, defaultRoleId: roleId === '' ? null : roleId, defaultScopeId: scopeId === '' ? null : scopeId, config,
      } });
      if (r.ok) {
        say(provider === undefined ? 'Added: people can sign in with it' : 'Saved');
        onDone();
      }
    }}>
      {kind === 'saml' ? <SpMetadata providerId={providerId} /> : null}
      {kind === 'oidc' ? (
        <>
          <TextField label="Issuer" required type="url" value={issuer} placeholder="https://login.microsoftonline.com/…/v2.0" onChange={(e) => setIssuer(e.target.value)} />
          <div className={styles.fields}>
            <TextField label="Client ID" required value={clientId} onChange={(e) => setClientId(e.target.value)} />
            <TextField label={oidc?.hasClientSecret === true ? 'Client secret (kept; type to replace)' : 'Client secret'} type="password" autoComplete="new-password" value={secret} onChange={(e) => setSecret(e.target.value)} />
            <SelectField label="Sends the secret" value={clientAuth} onChange={(e) => setClientAuth(e.target.value as typeof clientAuth)}
              options={[{ value: 'client_secret_basic', label: 'In the header' }, { value: 'client_secret_post', label: 'In the body' }, { value: 'none', label: 'No secret (PKCE only)' }]} />
          </div>
          <div className={styles.fields}>
            <TextField label="Scopes" value={scopesText} onChange={(e) => setScopesText(e.target.value)} hint="Separated by commas." />
            <TextField label="Email claim" value={emailClaim} onChange={(e) => setEmailClaim(e.target.value)} />
          </div>
        </>
      ) : (
        <>
          <RadioGroup label="Set it up from" name="samlsource" value={samlSource} onChange={(v) => setSamlSource(v as typeof samlSource)}
            options={[{ value: 'metadata', label: 'Its metadata document', hint: 'A new document is also how its signing certificate rolls over' }, { value: 'settings', label: 'Its settings, by hand' }]} />
          {samlSource === 'metadata' ? (
            <TextArea label="Metadata XML" rows={8} className={styles.mono} value={metadata} onChange={(e) => setMetadata(e.target.value)}
              hint={provider !== undefined ? 'Leave empty to keep its current settings; paste a new document to replace them.' : 'Paste the document your identity provider gives you.'} />
          ) : (
            <>
              <div className={styles.fields}>
                <TextField label="Entity ID" required value={entityId} onChange={(e) => setEntityId(e.target.value)} />
                <TextField label="Sign-in URL" required type="url" value={ssoUrl} onChange={(e) => setSsoUrl(e.target.value)} />
              </div>
              <TextArea label="Signing certificates" required rows={6} className={styles.mono} value={certs} onChange={(e) => setCerts(e.target.value)} hint="PEM; separate more than one with a blank line." />
            </>
          )}
          <div className={styles.fields}>
            <TextField label="Email attribute" value={emailAttribute} onChange={(e) => setEmailAttribute(e.target.value)} />
          </div>
          <Checkbox label="Require the whole response to be signed" checked={responseSigned} onChange={(e) => setResponseSigned(e.target.checked)} />
          <Checkbox label="Refuse assertions not encrypted to Silo" checked={encrypted} onChange={(e) => setEncrypted(e.target.checked)} />
        </>
      )}
      <Checkbox label="Trust its second factor" checked={trustMfa} onChange={(e) => setTrustMfa(e.target.checked)} hint="Then people it signs in with a second factor are not asked for Silo's." />
      {kind === 'oidc' && trustMfa ? <TextField label="Second-factor methods it reports" value={amr} onChange={(e) => setAmr(e.target.value)} hint="amr values, separated by commas." /> : null}
      <Switch label="Make people on their first sign-in" checked={jit} onChange={setJit} hint="Otherwise they are invited first." />
      {jit ? (
        <div className={styles.fields}>
          <SelectField label="With the role" value={roleId} placeholder="None" onChange={(e) => setRoleId(e.target.value)} options={(roles.data?.roles ?? []).filter((r) => r.retiredAt === null).map((r) => ({ value: r.id, label: r.name }))} />
          <SelectField label="In" value={scopeId} onChange={(e) => setScopeId(e.target.value)} options={[{ value: '', label: 'The organisation' }, ...(scopes.data?.scopes ?? []).map((s) => ({ value: s.id, label: s.name }))]} />
        </div>
      ) : null}
      <Switch label="Active" checked={active} onChange={setActive} hint="Off, no one signs in with it." />
      {provider !== undefined && provider.configuredBy !== null ? <p className={styles.muted}>Version {provider.version}.</p> : null}
      {configure.error !== undefined ? <ErrorMessage error={configure.error} /> : null}
      {!active ? <Banner tone="warn" title="It is off">No one signs in with it until it is turned on.</Banner> : null}
      <FormActions>
        <Button onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" pending={configure.pending} blocked={configure.blocked} disabled={!ready}>{provider === undefined ? 'Add it' : 'Save'}</Button>
      </FormActions>
    </form>
  );
}
