'use client';

// Adding a connection (spec 14.9, 16.6): pick a connector from the catalogue (Silo's certified
// ones and the organisation's own), then name the connection, choose the scope that owns it
// from those where the person may create one, give the settings its connector declares, and,
// for a connector that runs through the Silo Agent, the pool and where its login is kept.
// Credentials follow on the connection's page, where a secret is sealed and never shown again.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Button, LinkButton } from '../../components/button.component.tsx';
import { fieldError, FormActions, RadioGroup, SelectField, TextField } from '../../components/field.component.tsx';
import { Page, Panel, Section, Toolbar } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { SearchInput } from '../../components/search.component.tsx';
import { EmptyState, ErrorMessage, Loading } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { plural } from '../../utils/format.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import styles from './connect.view.module.css';

type Entry = Output<'browseConnectorCatalogue'>['connectors'][number];

const TIER: Record<Entry['trustTier'], string> = { certified: 'Certified by Silo', private: 'Your organisation\'s' };

function Catalogue({ onChoose }: { onChoose: (connectorId: string) => void }) {
  const [params, set] = useParams();
  const q = params.get('q') ?? '';
  const tier = params.get('tier') ?? '';
  const catalogue = useQuery('browseConnectorCatalogue', {
    query: { ...(q.trim().length >= 2 ? { q: q.trim() } : {}), ...(tier === 'certified' || tier === 'private' ? { tier } : {}), limit: 200 },
  }, { keepPrevious: true });
  const usable = (catalogue.data?.connectors ?? []).filter((e) => e.current !== null && e.status === 'active');
  return (
    <>
      <Toolbar end={<LinkButton href="/connect/builder/?new=1" icon="edit">Build a connector</LinkButton>}>
        <SearchInput label="Find a system" placeholder="Salesforce, Postgres, SAP…" value={q} onChange={(v) => set({ q: v })} />
        <SelectField label="Made by" hideLabel value={tier} onChange={(e) => set({ tier: e.target.value })} placeholder="Every connector"
          options={[{ value: 'certified', label: TIER.certified }, { value: 'private', label: TIER.private }]} />
      </Toolbar>
      <QueryView query={catalogue} what="The catalogue" isEmpty={() => usable.length === 0}
        empty={<EmptyState icon="search" title="No connector matches"
          action={<span className={styles.row}><LinkButton href="/connect/builder/?new=1">Build one</LinkButton><LinkButton href="/connect/fde/?new=1">Ask the AI FDE</LinkButton></span>}>
          Build a connector from the system's documentation, or let the AI forward-deployed engineer onboard it.
        </EmptyState>}>
        {() => (
          <DataTable label="Connectors" rows={usable} rowKey={(e) => e.id} rowHref={(e) => hrefWith('/connect/connections/', { new: '1', connector: e.id })} columns={[
            { id: 'name', header: 'Connector', primary: true, sortValue: (e) => e.name, cell: (e) => e.name },
            { id: 'provider', header: 'System', sortValue: (e) => e.provider, cell: (e) => e.provider },
            { id: 'tier', header: 'Made by', width: 'md', cell: (e) => <Badge tone={e.trustTier === 'certified' ? 'ok' : 'neutral'}>{TIER[e.trustTier]}</Badge> },
            { id: 'protocol', header: 'Protocol', width: 'sm', cell: (e) => e.current!.protocol.toUpperCase() },
            { id: 'about', header: 'About', cell: (e) => <span className={styles.muted}>{e.description ?? ''}</span> },
            { id: 'choose', header: <span className="visually-hidden">Choose</span>, width: 'sm', align: 'end', cell: (e) => <Button size="sm" onClick={() => onChoose(e.id)}>Choose</Button> },
          ]} />
        )}
      </QueryView>
    </>
  );
}

function CreateForm({ connectorId, defaultName }: { connectorId: string; defaultName: string | undefined }) {
  const router = useRouter();
  const say = useToast();
  const setup = useQuery('getConnectorSetup', { params: { connectorId }, query: {} });
  const scopes = useQuery('listMyPermittedScopes', { query: { permission: 'connection.create' } });
  const viaAgent = setup.data?.viaAgent === true;
  const pools = useQuery('listAgentPools', viaAgent ? {} : null);
  const create = useMutation('createConnection', { invalidates: ['listConnections'] });
  const [name, setName] = useState<string | undefined>(undefined);
  const [scopeId, setScopeId] = useState<string | undefined>(undefined);
  const [poolId, setPoolId] = useState('');
  const [custody, setCustody] = useState<'cell' | 'agent'>('cell');
  const [values, setValues] = useState<Record<string, string>>({});

  if (setup.data === undefined) return setup.status === 'error' ? <ErrorMessage error={setup.error} onRetry={setup.refetch} /> : <Loading label="Reading the connector" />;
  const s = setup.data;
  const livePools = (pools.data?.pools ?? []).filter((p) => p.status === 'active');
  const scopeChoice = scopeId ?? (scopes.data?.scopes.length === 1 ? scopes.data.scopes[0]!.id : '');
  const nameValue = name ?? defaultName ?? '';
  const missing = s.params.filter((p) => p.required && (values[p.name] ?? '').trim() === '');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parameters = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v !== ''));
    const r = await create.run({
      body: {
        connectorId, manifestId: s.manifestId, name: nameValue.trim(), owningScopeId: scopeChoice,
        ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
        ...(viaAgent ? { agentPoolId: poolId, credentialCustody: custody } : {}),
      },
    });
    if (r.ok) {
      say(`${r.data.name} created: add its credentials, then test it`);
      router.push(hrefWith('/connect/connections/', { connection: r.data.id, tab: 'setup' }) as never);
    }
  };

  return (
    <form onSubmit={submit} className={styles.form} noValidate>
      <Panel>
        <p className={styles.muted}>
          Version {s.version}, over {s.protocol.toUpperCase()}. It reads {plural(s.objects.length, 'object')}
          {s.objects.length > 0 ? `: ${s.objects.slice(0, 8).map((o) => o.label ?? o.name).join(', ')}${s.objects.length > 8 ? ', …' : ''}` : ''}.
          {viaAgent ? ' It runs through the Silo Agent inside your network.' : ''}
        </p>
      </Panel>
      <TextField label="Name" required value={nameValue} maxLength={200} onChange={(e) => setName(e.target.value)} hint="How people will know it: “Finance Salesforce”, “Plant 2 historian”."
        error={fieldError(create.error, 'name')} data-autofocus />
      <SelectField label="Owned by" required value={scopeChoice} onChange={(e) => setScopeId(e.target.value)} error={fieldError(create.error, 'owningScopeId')}
        hint="Who may manage it follows the scope: its admins, and people granted it."
        placeholder={scopes.data === undefined ? 'Reading your scopes…' : scopes.data.scopes.length === 0 ? 'You may not create a connection in any scope' : 'Choose a scope'}
        options={(scopes.data?.scopes ?? []).map((sc) => ({ value: sc.id, label: `${'  '.repeat(Math.max(0, sc.depth - 1))}${sc.name}` }))} />
      {s.params.length > 0 ? (
        <Section title="Settings" description="As its connector declares them. You can change them later.">
          {s.params.map((p) => (
            <TextField key={p.name} label={p.label} required={p.required} value={values[p.name] ?? ''} pattern={p.pattern ?? undefined}
              onChange={(e) => setValues({ ...values, [p.name]: e.target.value })} error={fieldError(create.error, `parameters.${p.name}`)} />
          ))}
        </Section>
      ) : null}
      {viaAgent ? (
        <Section title="Silo Agent" description="The agent reaches the system from inside your network; Silo never opens a way in.">
          <SelectField label="Agent pool" required value={poolId} onChange={(e) => setPoolId(e.target.value)} error={fieldError(create.error, 'agentPoolId')}
            placeholder={pools.data === undefined ? 'Reading pools…' : livePools.length === 0 ? 'No pool yet' : 'Choose a pool'}
            options={livePools.map((p) => ({ value: p.id, label: `${p.name} (${plural(p.agents.filter((a) => a.status === 'healthy').length, 'healthy agent')})` }))}
            hint={pools.data !== undefined && livePools.length === 0 ? <Link href="/connect/agents/?new=1">Create an agent pool first</Link> : undefined} />
          <RadioGroup name="custody" label="Where its login is kept" value={custody} onChange={setCustody} options={[
            { value: 'cell', label: 'Sealed in Silo', hint: 'Passed to the agent for each call.' },
            { value: 'agent', label: 'On the agent\'s host only', hint: 'Silo holds none. Fixed for the connection\'s life.' },
          ]} />
        </Section>
      ) : null}
      {create.error !== undefined && fieldError(create.error, 'name') === undefined ? <ErrorMessage error={create.error} /> : null}
      <FormActions>
        <LinkButton href="/connect/connections/?new=1">Back to the catalogue</LinkButton>
        <Button type="submit" variant="primary" pending={create.pending} blocked={create.blocked}
          disabled={nameValue.trim() === '' || scopeChoice === '' || missing.length > 0 || (viaAgent && poolId === '')}>Create the connection</Button>
      </FormActions>
    </form>
  );
}

export function NewConnection() {
  const [params, set] = useParams();
  const connectorId = params.get('connector') ?? undefined;
  const entry = useQuery('getConnector', connectorId === undefined ? null : { params: { connectorId } });
  usePageContext({ scope: { kind: 'page', page: 'connect' }, scopeLabel: 'New connection' });
  return (
    <Page title={connectorId === undefined ? 'New connection' : `Connect ${entry.data?.name ?? 'a system'}`} width={connectorId === undefined ? 'wide' : 'narrow'}
      description={connectorId === undefined ? 'Pick the system to connect. Silo reads it where it is, as the person asking, without copying it.' : undefined}
      crumbs={[{ label: 'Connect' }, { label: 'Connections', href: '/connect/connections/' }]}>
      {connectorId === undefined ? <Catalogue onChoose={(id) => set({ connector: id }, { push: true })} /> : <CreateForm connectorId={connectorId} defaultName={entry.data?.name} />}
    </Page>
  );
}
