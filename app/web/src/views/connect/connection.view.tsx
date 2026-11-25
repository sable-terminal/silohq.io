'use client';

// One connection (spec 14.7, 15, 17, 18): where it stands and what moves it on; its settings
// and credentials as its connector declares them (a secret is never shown back, only its last
// four); the tests that verified it and the write test that earns writes; its health, the
// re-checks and the repairs they propose; its change stream, object by object, never calling a
// polled object live; and who may use it. Each part is a tab kept in the address (?tab=).

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button, IconButton } from '../../components/button.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { fieldError, FormActions, TextArea, TextField } from '../../components/field.component.tsx';
import { Menu } from '../../components/menu.component.tsx';
import { Page, Panel, Properties, Section } from '../../components/page.component.tsx';
import { EmptyState, ErrorMessage, ErrorState, Loading } from '../../components/states.component.tsx';
import { TabPanel, Tabs, useTab, type TabDef } from '../../components/tabs.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { isApiError } from '../../api/client.api.ts';
import { useMutation, usePermits, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { Access } from './access.view.tsx';
import { Health } from './health.view.tsx';
import { Stream } from './stream.view.tsx';
import { Tests } from './tests.view.tsx';
import { NEXT, STATUS, type Connection, type Move } from './words.view.ts';
import styles from './connect.view.module.css';

type Setup = Output<'getConnectorSetup'>;
type TabId = 'overview' | 'setup' | 'tests' | 'health' | 'stream' | 'access';

const OAUTH_SIGN_IN = new Set<Setup['auth']['strategy']>(['oauth2_code', 'oauth2_code_pkce']);

const AUTH: Record<Setup['auth']['strategy'], string> = {
  none: 'No sign-in', api_key: 'API key', basic: 'User name and password', bearer: 'Bearer token', expression: 'A computed credential',
  jwt_bearer: 'Signed JWT', mtls: 'Client certificate (mutual TLS)', oauth2_client_credentials: 'OAuth client credentials', oauth2_code: 'OAuth sign-in',
  oauth2_code_pkce: 'OAuth sign-in', oauth2_refresh: 'OAuth refresh token', session_cookie: 'Session cookie', ssh_key: 'SSH key',
  username_password: 'User name and password', ws_security: 'WS-Security', x509: 'X.509 certificate',
};

/** A move on the connection, with the reason a halt needs. */
function useMove(connection: Connection) {
  const say = useToast();
  const change = useMutation('changeConnectionStatus', { invalidates: ['listConnections', 'readStream'] });
  const run = async (move: Move, reason?: string) => {
    const r = await change.run({ params: { connectionId: connection.id }, body: { move, version: connection.version, ...(reason !== undefined ? { reason } : {}) } });
    if (r.ok) say(move === 'revoke' ? 'Connection revoked: its credentials were destroyed' : `${connection.name}: ${STATUS[r.data.status].label.toLowerCase()}`);
    return r;
  };
  return { run, pending: change.pending, error: change.error, blocked: change.blocked };
}

function HaltDialog({ connection, open, onClose }: { connection: Connection; open: boolean; onClose: () => void }) {
  const move = useMove(connection);
  const [reason, setReason] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const r = await move.run('halt', reason.trim());
    if (r.ok) onClose();
  };
  return (
    <Dialog open={open} onClose={onClose} title={`Halt ${connection.name}?`} size="sm" busy={move.pending}
      description="Every read and write through it stops until someone resumes it. People who query it are told it is halted, and why.">
      <form onSubmit={submit} className={styles.form}>
        <TextArea label="Why it is halted" required rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} data-autofocus
          hint="Shown to people who query it. Say what is wrong, not any value from the system." error={fieldError(move.error, 'reason')} />
        {move.error !== undefined && fieldError(move.error, 'reason') === undefined ? <ErrorMessage error={move.error} /> : null}
        <FormActions>
          <Button onClick={onClose} disabled={move.pending}>Cancel</Button>
          <Button type="submit" variant="danger" pending={move.pending} disabled={reason.trim() === ''}>Halt it</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

function RevokeDialog({ connection, open, onClose }: { connection: Connection; open: boolean; onClose: () => void }) {
  const move = useMove(connection);
  return (
    <ConfirmDialog open={open} onClose={onClose} title={`Revoke ${connection.name}?`} confirmLabel="Revoke for good" tone="danger"
      typeToConfirm={connection.name} onConfirm={() => move.run('revoke')}>
      <p>Its credentials are destroyed and it serves nothing again: queries, Crons and apps that read it are told it is revoked. This cannot be undone; connect the system again to use it.</p>
    </ConfirmDialog>
  );
}

function RenameDialog({ connection, open, onClose }: { connection: Connection; open: boolean; onClose: () => void }) {
  const say = useToast();
  const rename = useMutation('renameConnection', { invalidates: ['listConnections'] });
  const [name, setName] = useState(connection.name);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const r = await rename.run({ params: { connectionId: connection.id }, body: { name: name.trim(), version: connection.version } });
    if (r.ok) {
      say('Connection renamed');
      onClose();
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Rename the connection" size="sm" busy={rename.pending}>
      <form onSubmit={submit} className={styles.form}>
        <TextField label="Name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} data-autofocus error={fieldError(rename.error, 'name')} />
        {rename.error !== undefined && fieldError(rename.error, 'name') === undefined ? <ErrorMessage error={rename.error} /> : null}
        <FormActions>
          <Button onClick={onClose} disabled={rename.pending}>Cancel</Button>
          <Button type="submit" variant="primary" pending={rename.pending} disabled={name.trim() === '' || name.trim() === connection.name}>Rename</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

function Overview({ connection, setup }: { connection: Connection; setup: Setup | undefined }) {
  const people = useDirectory();
  const move = useMove(connection);
  const next = NEXT[connection.status];
  const [halting, setHalting] = useState(false);
  return (
    <div className={styles.stack}>
      {connection.status === 'halted' ? (
        <Banner tone="warn" title="Halted" urgent>
          {connection.haltedReason ?? 'It serves nothing until it is resumed.'}{connection.haltedAt !== null ? <> Since <Time value={connection.haltedAt} />.</> : null}
        </Banner>
      ) : null}
      {connection.status === 'revoked' ? (
        <Banner tone="danger" title="Revoked">Its credentials were destroyed and it serves nothing. Its history stays.</Banner>
      ) : null}
      {next !== undefined ? (
        <Panel>
          <div className={styles.next}>
            <div>
              <h2 className={styles.subheading}>What happens next</h2>
              <p className={styles.muted}>{next.hint}</p>
            </div>
            {next.move === 'halt'
              ? <Button variant="danger" icon="pause" blocked={move.blocked} onClick={() => setHalting(true)}>Halt</Button>
              : <Button variant="primary" pending={move.pending} blocked={move.blocked} onClick={() => void move.run(next.move)}>{next.label}</Button>}
          </div>
          {move.error !== undefined ? <ErrorMessage error={move.error} /> : null}
        </Panel>
      ) : null}
      <Section title="About">
        <Properties items={[
          ['System', connection.provider],
          ['Connector', setup === undefined ? '—' : `${connection.trustTier === 'certified' ? 'Certified by Silo' : 'Your organisation\'s'}, version ${setup.version}, ${setup.protocol.toUpperCase()}`],
          ['Status', <Badge key="s" tone={STATUS[connection.status].tone}>{STATUS[connection.status].label}</Badge>],
          ['Last healthy', connection.lastHealthyAt === null ? 'Not yet' : <Time key="h" value={connection.lastHealthyAt} />],
          ['Writes', connection.writesEnabled ? 'Enabled: governed Actions may change records here' : 'Read only'],
          ['Sign-in', setup === undefined ? '—' : AUTH[setup.auth.strategy]],
          ['Owned by', people.scopeName(connection.owningScopeId)],
          ['Created by', people.nameOf(connection.owningMembershipId)],
          connection.agentPoolId !== null ? ['Reached through', <Link key="a" href="/connect/agents/">the Silo Agent{connection.credentialCustody === 'agent' ? ', which keeps its login on the agent\'s host' : ''}</Link>] : null,
          ['Approval policy set by', connection.policyAuthority === 'owner_set' ? 'Its owner' : connection.policyAuthority === 'delegated' ? 'A named admin' : 'Super admins only'],
          ['Created', <Time key="c" value={connection.createdAt} />],
        ]} />
      </Section>
      {setup !== undefined && setup.objects.length > 0 ? (
        <Section title="What it reads" description="The objects its connector declares. Map them to types in the ontology to query them as objects.">
          <ul className={styles.chips}>{setup.objects.map((o) => <li key={o.name}>{o.label ?? o.name}</li>)}</ul>
          <p className={styles.muted}><Link href={`/ontology/derive/?connection=${connection.id}`}>Derive types from it</Link></p>
        </Section>
      ) : null}
      <HaltDialog connection={connection} open={halting} onClose={() => setHalting(false)} />
    </div>
  );
}

function SettingsForm({ connection, setup }: { connection: Connection; setup: Setup }) {
  const say = useToast();
  const save = useMutation('setConnectionParameters', { invalidates: ['listConnections'] });
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(setup.params.map((p) => [p.name, connection.parameters[p.name] ?? ''])));
  if (setup.params.length === 0) return null;
  const changed = setup.params.some((p) => (values[p.name] ?? '') !== (connection.parameters[p.name] ?? ''));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parameters = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v !== ''));
    const r = await save.run({ params: { connectionId: connection.id }, body: { parameters, version: connection.version } });
    if (r.ok) say('Settings saved: test it again to check they work');
  };
  return (
    <Section title="Settings" description="As its connector declares them. Changing them takes effect on the next request.">
      <form onSubmit={submit} className={styles.form}>
        {setup.params.map((p) => (
          <TextField key={p.name} label={p.label} required={p.required} value={values[p.name] ?? ''} pattern={p.pattern ?? undefined}
            onChange={(e) => setValues({ ...values, [p.name]: e.target.value })} error={fieldError(save.error, `parameters.${p.name}`)} />
        ))}
        {save.error !== undefined ? <ErrorMessage error={save.error} /> : null}
        <FormActions>
          <Button type="submit" pending={save.pending} blocked={save.blocked} disabled={!changed}>Save settings</Button>
        </FormActions>
      </form>
    </Section>
  );
}

function CredentialsForm({ connection, setup }: { connection: Connection; setup: Setup }) {
  const say = useToast();
  const save = useMutation('setConnectionSecrets');
  const oauth = useMutation('startOAuthFlow');
  const [values, setValues] = useState<Record<string, string>>({});
  const [sealed, setSealed] = useState<Output<'setConnectionSecrets'>['fields'] | undefined>(undefined);
  if (connection.credentialCustody === 'agent') {
    return (
      <Section title="Credentials">
        <p className={styles.muted}>Its login is kept on the Silo Agent's host; Silo holds none. Set it where the agent runs.</p>
      </Section>
    );
  }
  if (setup.auth.strategy === 'none') {
    return <Section title="Credentials"><p className={styles.muted}>This system needs no sign-in.</p></Section>;
  }
  const given = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ''));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (Object.keys(given).length === 0) return;
    const r = await save.run({ params: { connectionId: connection.id }, body: { values: given } });
    if (r.ok) {
      setSealed(r.data.fields);
      setValues({});
      say('Credentials sealed. Silo never shows a secret again.');
    }
  };
  const signIn = async () => {
    const r = await oauth.run({ body: { connectionId: connection.id } });
    if (r.ok) window.location.assign(r.data.authorisationUrl);
  };
  return (
    <Section title="Credentials" description={`${AUTH[setup.auth.strategy]}. Sealed when saved: Silo shows only the last four characters of a secret, never the secret.`}>
      {OAUTH_SIGN_IN.has(setup.auth.strategy) ? (
        <Panel>
          <div className={styles.next}>
            <p className={styles.muted}>You are sent to {connection.provider} to allow access, then brought back here. Silo keeps the token it is given, sealed.</p>
            <Button variant="primary" icon="external" pending={oauth.pending} blocked={oauth.blocked} onClick={() => void signIn()}>Sign in to {connection.provider}</Button>
          </div>
          {oauth.error !== undefined ? <ErrorMessage error={oauth.error} /> : null}
        </Panel>
      ) : null}
      {setup.auth.fields.length > 0 ? (
        <form onSubmit={submit} className={styles.form} autoComplete="off">
          {setup.auth.fields.map((f) => {
            const last = sealed?.find((s) => s.name === f.name)?.lastFour;
            return (
              <TextField key={f.name} label={f.label} type={f.kind === 'secret' ? 'password' : 'text'} autoComplete={f.kind === 'secret' ? 'new-password' : 'off'}
                spellCheck={false} value={values[f.name] ?? ''} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                hint={last != null ? `Sealed; ends ${last}` : f.kind === 'secret' ? 'Leave empty to keep what is sealed.' : undefined}
                error={fieldError(save.error, `values.${f.name}`)} />
            );
          })}
          {save.error !== undefined ? <ErrorMessage error={save.error} /> : null}
          <FormActions>
            <Button type="submit" pending={save.pending} blocked={save.blocked} disabled={Object.keys(given).length === 0}>Save credentials</Button>
          </FormActions>
        </form>
      ) : null}
    </Section>
  );
}

export function ConnectionPage({ connectionId }: { connectionId: string }) {
  const read = useQuery('getConnection', { params: { connectionId } });
  const connection = read.data;
  const setup = useQuery('getConnectorSetup', connection === undefined ? null : { params: { connectorId: connection.connectorId }, query: { manifestId: connection.manifestId } }, { staleMs: 10 * 60_000 });
  const permits = usePermits();
  const waiting = useQuery('listHealProposals', { query: { connectionId, disposition: 'awaiting_review' } }, { staleMs: 60_000 });
  const [renaming, setRenaming] = useState(false);
  const [revoking, setRevoking] = useState(false);
  usePageContext({ scope: { kind: 'page', page: 'connect' }, scopeLabel: connection?.name ?? 'a connection' });

  const revoked = connection?.status === 'revoked';
  const tabs: readonly TabDef<TabId>[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'setup', label: 'Settings and credentials', disabled: revoked ? 'A revoked connection keeps no settings or credentials' : undefined },
    { id: 'tests', label: 'Tests and writes' },
    { id: 'health', label: 'Health', count: waiting.data !== undefined && waiting.data.proposals.length > 0 ? waiting.data.proposals.length : undefined },
    { id: 'stream', label: 'Change stream', disabled: permits('readStream')?.message },
    { id: 'access', label: 'Access' },
  ];
  const [tab, setTab] = useTab(tabs);

  if (connection === undefined) {
    if (read.status === 'error') {
      return (
        <Page title="Connection" crumbs={[{ label: 'Connect' }, { label: 'Connections', href: '/connect/connections/' }]}>
          {isApiError(read.error) && read.error.status === 404
            ? <EmptyState icon="plug" title="No such connection" action={<Link href="/connect/connections/">Back to Connections</Link>}>It may have been removed, or you may not see it.</EmptyState>
            : <ErrorState error={read.error} what="The connection" onRetry={read.refetch} />}
        </Page>
      );
    }
    return <Loading label="Reading the connection" />;
  }

  return (
    <Page title={connection.name} crumbs={[{ label: 'Connect' }, { label: 'Connections', href: '/connect/connections/' }]}
      meta={<span className={styles.row}>
        <Badge tone={STATUS[connection.status].tone}>{STATUS[connection.status].label}</Badge>
        <span>{connection.provider}</span>
        {connection.writesEnabled ? <Badge tone="accent">Writes enabled</Badge> : null}
      </span>}
      actions={revoked ? undefined : (
        <Menu label="More for this connection" items={[
          { label: 'Rename', icon: 'edit', onSelect: () => setRenaming(true), blocked: permits('renameConnection') },
          { separator: true },
          { label: 'Revoke…', icon: 'trash', tone: 'danger', onSelect: () => setRevoking(true), blocked: permits('changeConnectionStatus') },
        ]} renderTrigger={(p) => <IconButton {...p} label="More for this connection" icon="more" />} />
      )}>
      <Tabs label="Connection" tabs={tabs} current={tab} onChange={setTab} />
      <TabPanel id={tab}>
        {tab === 'overview' ? <Overview connection={connection} setup={setup.data} /> : null}
        {tab === 'setup' ? (setup.data === undefined
          ? (setup.status === 'error' ? <ErrorMessage error={setup.error} onRetry={setup.refetch} /> : <Loading label="Reading its connector" />)
          : (
            <div className={styles.stack}>
              <SettingsForm key={`s${connection.version}`} connection={connection} setup={setup.data} />
              <CredentialsForm connection={connection} setup={setup.data} />
            </div>
          )) : null}
        {tab === 'tests' ? <Tests connection={connection} setup={setup.data} /> : null}
        {tab === 'health' ? <Health connection={connection} /> : null}
        {tab === 'stream' ? <Stream connection={connection} /> : null}
        {tab === 'access' ? <Access connection={connection} /> : null}
      </TabPanel>
      {renaming ? <RenameDialog connection={connection} open onClose={() => setRenaming(false)} /> : null}
      <RevokeDialog connection={connection} open={revoking} onClose={() => setRevoking(false)} />
    </Page>
  );
}
