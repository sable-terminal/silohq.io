'use client';

// The estate map (spec 31): every connected system, the object types they feed, the agents that
// reach them and the change streams they send, with each one's health; what is missing from the
// picture said plainly. Snapshots keep how the estate stood at a moment, and two compare: what
// was added and what went.

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge, Status } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { SelectField } from '../../components/field.component.tsx';
import { Page, Panel, Properties, Section, Toolbar } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { ErrorMessage } from '../../components/states.component.tsx';
import { TabPanel, Tabs, useTab, type TabDef } from '../../components/tabs.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { connectionHref, typeHref } from '../../navigation/links.navigation.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { formatNumber } from '../../utils/format.util.ts';
import styles from './clones.view.module.css';

type EstateNode = Output<'getEstateMap'>['nodes'][number];

const KIND: Record<EstateNode['kind'], string> = { connection: 'Connection', object_type: 'Object type', agent: 'Silo Agent', change_stream: 'Change stream' };
const SIZE: Record<EstateNode['size']['measure'], string> = {
  connections_served: 'connections served', contributing_connections: 'systems feeding it', mapped_properties: 'properties mapped', objects_streamed: 'objects streamed',
};
const HEALTH_TONE: Record<NonNullable<EstateNode['health']>, 'ok' | 'warn' | 'danger' | 'neutral' | 'info'> = { normal: 'ok', warning: 'warn', failed: 'danger', stale: 'neutral', unknown: 'info' };
const MISSING: Record<Output<'getEstateMap'>['missing'][number]['kind'], string> = {
  change_streams: 'Change streams', discovered_systems: 'Systems discovery found', object_counts: 'Object counts', siloes: 'Siloes', source_structure: 'Source structure',
};

function nodeHref(n: EstateNode): string | undefined {
  if (n.kind === 'connection') return connectionHref(n.id);
  if (n.kind === 'object_type') return typeHref(n.id);
  if (n.kind === 'agent') return '/connect/agents/';
  return undefined;
}

function Map() {
  const people = useDirectory();
  const [params, set] = useParams();
  const kind = params.get('kind') ?? '';
  const estate = useQuery('getEstateMap', {}, { refreshMs: 60_000 });
  const rows = useMemo(() => (estate.data?.nodes ?? []).filter((n) => kind === '' || n.kind === kind), [estate.data, kind]);
  const byId = useMemo(() => new globalThis.Map((estate.data?.nodes ?? []).map((n) => [n.id, n])), [estate.data]);
  return (
    <QueryView query={estate} what="The estate">
      {(e) => (
        <div className={styles.stack}>
          {e.statement !== null ? <Banner tone="info">{e.statement}</Banner> : null}
          {e.missing.length > 0 ? (
            <Banner tone="warn" title="Not in the picture">{e.missing.map((m) => `${MISSING[m.kind]}: ${m.reason}`).join('; ')}.</Banner>
          ) : null}
          <Properties columns={3} items={(Object.keys(KIND) as EstateNode['kind'][]).map((k) => [KIND[k], formatNumber(e.nodes.filter((n) => n.kind === k).length)] as const)} />
          <Toolbar end={<span className={styles.muted}>Drawn <Time value={e.generatedAt} /></span>}>
            <SelectField label="Show" hideLabel value={kind} onChange={(ev) => set({ kind: ev.target.value })} placeholder="Everything"
              options={(Object.keys(KIND) as EstateNode['kind'][]).map((k) => ({ value: k, label: KIND[k] }))} />
          </Toolbar>
          <DataTable label="Estate" rows={rows} rowKey={(n) => `${n.kind}:${n.id}`} rowHref={nodeHref} columns={[
            { id: 'label', header: 'What', primary: true, sortValue: (n) => n.label, cell: (n) => <span className={styles.stackTight}>{n.label}<span className={styles.muted}>{KIND[n.kind]}</span></span> },
            { id: 'health', header: 'Health', width: 'md', sortValue: (n) => n.health, cell: (n) => (n.health === null ? '—' : <span className={styles.stackTight}><Status tone={HEALTH_TONE[n.health]}>{n.health}</Status>{n.healthReason !== null ? <span className={styles.muted}>{n.healthReason}</span> : null}</span>) },
            { id: 'size', header: 'Size', width: 'md', sortValue: (n) => n.size.value, cell: (n) => `${formatNumber(n.size.value)} ${SIZE[n.size.measure]}` },
            { id: 'links', header: 'Connected to', cell: (n) => {
              const out = e.edges.filter((x) => x.from === n.id).map((x) => byId.get(x.to)?.label).filter(Boolean);
              return <span className={styles.muted}>{out.slice(0, 4).join(', ')}{out.length > 4 ? `, and ${out.length - 4} more` : ''}</span>;
            } },
            { id: 'owner', header: 'Owner', width: 'md', cell: (n) => (n.ownerMembershipId === null ? '—' : people.nameOf(n.ownerMembershipId)) },
            { id: 'tier', header: '', width: 'sm', cell: (n) => (n.trustTier === null ? null : <Badge>{n.trustTier}</Badge>) },
          ]} />
          <p className={styles.muted}>{formatNumber(e.edges.filter((x) => x.confirmed).length)} confirmed relationships, {formatNumber(e.edges.filter((x) => !x.confirmed).length)} not yet confirmed.</p>
        </div>
      )}
    </QueryView>
  );
}

function Snapshots() {
  const say = useToast();
  const list = useQuery('listEstateSnapshots', { query: { limit: 50 } });
  const take = useMutation('takeEstateSnapshot', { invalidates: ['listEstateSnapshots'] });
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const compare = useQuery('compareEstateSnapshots', from !== '' && to !== '' && from !== to ? { query: { from, to } } : null);
  const snaps = list.data?.snapshots ?? [];
  return (
    <div className={styles.stack}>
      <Panel>
        <div className={styles.next}>
          <p className={styles.muted}>A snapshot keeps how the estate stood now: what is connected, mapped and streaming, counted.</p>
          <Button pending={take.pending} blocked={take.blocked} onClick={async () => {
            const r = await take.run({ body: {} });
            if (r.ok) say('Snapshot taken');
          }}>Take a snapshot</Button>
        </div>
        {take.error !== undefined ? <ErrorMessage error={take.error} /> : null}
      </Panel>
      <QueryView query={list} what="Snapshots" isEmpty={(d) => d.snapshots.length === 0} empty={<p className={styles.muted}>No snapshot yet.</p>}>
        {(d) => (
          <DataTable label="Snapshots" rows={d.snapshots} rowKey={(x) => x.id} dense columns={[
            { id: 'at', header: 'Taken', primary: true, cell: (x) => <Time value={x.takenAt} exact /> },
            { id: 'run', header: 'With', cell: (x) => (x.discoveryRunId === null ? 'Connections only' : 'A discovery scan') },
          ]} />
        )}
      </QueryView>
      {snaps.length >= 2 ? (
        <Section title="Compare two">
          <Toolbar>
            <SelectField label="From" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="Choose" options={snaps.map((x) => ({ value: x.id, label: new Date(x.takenAt).toLocaleString('en-GB') }))} />
            <SelectField label="To" value={to} onChange={(e) => setTo(e.target.value)} placeholder="Choose" options={snaps.map((x) => ({ value: x.id, label: new Date(x.takenAt).toLocaleString('en-GB') }))} />
          </Toolbar>
          {compare.data !== undefined ? (
            <div className={styles.stack}>
              {compare.data.statement !== null ? <p className={styles.muted}>{compare.data.statement}</p> : null}
              <div className={styles.split}>
                <Panel><h3 className={styles.subheading}>Added</h3><ul className={styles.plainList}>{Object.entries(compare.data.added).map(([k, v]) => <li key={k}>{v.length} {k.replaceAll('_', ' ')}</li>)}</ul></Panel>
                <Panel><h3 className={styles.subheading}>Gone</h3><ul className={styles.plainList}>{Object.entries(compare.data.removed).map(([k, v]) => <li key={k}>{v.length} {k.replaceAll('_', ' ')}</li>)}</ul></Panel>
              </div>
            </div>
          ) : compare.error !== undefined ? <ErrorMessage error={compare.error} /> : null}
        </Section>
      ) : null}
    </div>
  );
}

export function EstateMap() {
  usePageContext({ scope: { kind: 'page', page: 'clones' }, scopeLabel: 'the estate map' });
  const tabs: readonly TabDef<'map' | 'snapshots'>[] = [{ id: 'map', label: 'Now' }, { id: 'snapshots', label: 'Snapshots' }];
  const [tab, setTab] = useTab(tabs);
  return (
    <Page title="Estate map" description="Every connected system, the types it feeds, the agents that reach it and the changes it streams, with each one's health." crumbs={[{ label: 'Clones' }]}
      actions={<Link href="/connect/discovery/">Find more systems</Link>}>
      <Tabs label="Estate map" tabs={tabs} current={tab} onChange={setTab} />
      <TabPanel id={tab}>{tab === 'map' ? <Map /> : <Snapshots />}</TabPanel>
    </Page>
  );
}
