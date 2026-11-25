'use client';

// Connections (spec 14.7): every system Silo reads and writes, where each stands, and what
// waits on a person (a repair to review, a halted connection). One opens to its page
// (?connection=); "New connection" opens the catalogue (?new=1). The organisation's private
// network links, which connections reach their systems over, are listed beneath.

import { useMemo } from 'react';
import { Badge } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button, LinkButton } from '../../components/button.component.tsx';
import { SelectField } from '../../components/field.component.tsx';
import { Page, Section, Toolbar } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { SearchInput } from '../../components/search.component.tsx';
import { EmptyState } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useBlocked, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { connectionHref } from '../../navigation/links.navigation.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { plural } from '../../utils/format.util.ts';
import { ConnectionPage } from './connection.view.tsx';
import { NewConnection } from './newConnection.view.tsx';
import { STATUS, type ConnectionStatus } from './words.view.ts';
import styles from './connect.view.module.css';

const STATUS_FILTER: readonly { value: ConnectionStatus | 'attention'; label: string }[] = [
  { value: 'attention', label: 'Needs attention' },
  ...(Object.keys(STATUS) as ConnectionStatus[]).map((s) => ({ value: s, label: STATUS[s].label })),
];

function PrivateLinks() {
  const links = useQuery('listPrivateLinks', { query: {} }, { staleMs: 5 * 60_000 });
  const live = (links.data?.privateLinks ?? []).filter((l) => l.status === 'active');
  if (links.data !== undefined && live.length === 0) return null;
  return (
    <Section title="Private network links" description="Connections reach systems in your cloud over these links, never the public internet. Silo's operations team adds and removes them on request.">
      <QueryView query={links} what="Private links">
        {() => (
          <DataTable label="Private network links" rows={live} rowKey={(l) => l.id} dense columns={[
            { id: 'name', header: 'Link', primary: true, cell: (l) => l.name },
            { id: 'kind', header: 'Kind', width: 'md', cell: (l) => (l.linkKind === 'private_service_connect' ? 'Private Service Connect' : 'VPC peering') },
            { id: 'network', header: 'Network', cell: (l) => <span className={styles.mono}>{l.network}</span> },
            { id: 'since', header: 'Since', width: 'sm', cell: (l) => <Time value={l.createdAt} /> },
          ]} />
        )}
      </QueryView>
    </Section>
  );
}

function ConnectionList() {
  const [params, set] = useParams();
  const people = useDirectory();
  const create = useBlocked('createConnection');
  const list = useQuery('listConnections', { query: { limit: 500 } });
  const waiting = useQuery('listHealProposals', { query: { disposition: 'awaiting_review', limit: 200 } }, { staleMs: 60_000 });
  const text = params.get('q') ?? '';
  const filter = params.get('status') ?? '';
  usePageContext({ scope: { kind: 'page', page: 'connect' }, scopeLabel: 'Connections' });

  const repairs = useMemo(() => {
    const by = new Map<string, number>();
    for (const p of waiting.data?.proposals ?? []) by.set(p.connectionId, (by.get(p.connectionId) ?? 0) + 1);
    return by;
  }, [waiting.data]);
  const rows = useMemo(() => {
    const q = text.trim().toLowerCase();
    return (list.data?.connections ?? []).filter((c) => {
      if (q !== '' && !c.name.toLowerCase().includes(q) && !c.provider.toLowerCase().includes(q)) return false;
      if (filter === 'attention') return c.status === 'halted' || repairs.has(c.id);
      if (filter === '') return c.status !== 'revoked';
      return c.status === filter;
    });
  }, [list.data, text, filter, repairs]);
  const halted = (list.data?.connections ?? []).filter((c) => c.status === 'halted').length;
  const repairCount = waiting.data?.proposals.length ?? 0;

  return (
    <Page title="Connections" description="Every system Silo reads and writes: where each stands, its health, and how its changes reach Silo."
      crumbs={[{ label: 'Connect' }]}
      actions={create === undefined
        ? <LinkButton href="/connect/connections/?new=1" variant="primary" icon="plus">New connection</LinkButton>
        : <Button variant="primary" icon="plus" blocked={create}>New connection</Button>}>
      {halted > 0 || repairCount > 0 ? (
        <Banner tone="warn" title="Waiting on a person"
          action={filter !== 'attention' ? <Button size="sm" onClick={() => set({ status: 'attention' })}>Show them</Button> : undefined}>
          {[halted > 0 ? `${plural(halted, 'connection')} halted` : '', repairCount > 0 ? `${plural(repairCount, 'repair')} to review` : ''].filter(Boolean).join('; ')}.
        </Banner>
      ) : null}
      <Toolbar>
        <SearchInput label="Find a connection" placeholder="Name or system" value={text} onChange={(v) => set({ q: v })} />
        <SelectField label="Status" hideLabel value={filter} onChange={(e) => set({ status: e.target.value })}
          placeholder="All but revoked" options={STATUS_FILTER} />
      </Toolbar>
      <QueryView query={list} what="Connections" isEmpty={(d) => d.connections.length === 0}
        empty={<EmptyState icon="plug" title="No connections yet"
          action={create === undefined ? <LinkButton href="/connect/connections/?new=1" variant="primary">Connect a system</LinkButton> : undefined}>
          Connect a system from the catalogue: Silo reads it where it is, without copying it.
        </EmptyState>}>
        {() => (rows.length === 0 ? <p className={styles.muted}>No connection matches.</p> : (
          <DataTable label="Connections" rows={rows} rowKey={(c) => c.id} rowHref={(c) => connectionHref(c.id)} columns={[
            { id: 'name', header: 'Connection', primary: true, sortValue: (c) => c.name, cell: (c) => c.name },
            { id: 'system', header: 'System', sortValue: (c) => c.provider, cell: (c) => (
              <span className={styles.row}>{c.provider}{c.trustTier === 'private' ? <Badge>Your connector</Badge> : null}</span>
            ) },
            { id: 'status', header: 'Status', width: 'md', sortValue: (c) => c.status, cell: (c) => (
              <span className={styles.row}>
                <Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge>
                {repairs.has(c.id) ? <Badge tone="warn" icon="warning">{plural(repairs.get(c.id)!, 'repair')}</Badge> : null}
              </span>
            ) },
            { id: 'writes', header: 'Writes', width: 'sm', cell: (c) => (c.writesEnabled ? <Badge tone="accent">Enabled</Badge> : 'Read only') },
            { id: 'healthy', header: 'Last healthy', width: 'md', sortValue: (c) => c.lastHealthyAt, cell: (c) => (c.lastHealthyAt === null ? 'Not yet' : <Time value={c.lastHealthyAt} />) },
            { id: 'scope', header: 'Owned by', width: 'md', cell: (c) => people.scopeName(c.owningScopeId) },
          ]} />
        ))}
      </QueryView>
      <PrivateLinks />
    </Page>
  );
}

export function Connections() {
  const [params] = useParams();
  const id = params.get('connection');
  if (id !== null) return <ConnectionPage key={id} connectionId={id} />;
  if (params.get('new') !== null) return <NewConnection />;
  return <ConnectionList />;
}
