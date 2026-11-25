'use client';

// Derive (spec 22): object types and links drafted from what a connection holds: its declared
// schema and keys, field names, concept templates, field profiles and, where it helps, value
// overlap with types that exist. Nothing is decided here: derivation makes a proposal on its own
// branch, each decision with its confidence and evidence, for a person to accept, correct or
// reject. Profiling first gives derivation the fields' shapes, counts only.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Banner } from '../../components/banner.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { Checkbox, FormActions, SelectField } from '../../components/field.component.tsx';
import { Page, Panel, Section } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { formatNumber, plural } from '../../utils/format.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import styles from './ontology.view.module.css';

export function Derive() {
  const say = useToast();
  const router = useRouter();
  const [params, set] = useParams();
  const connections = useQuery('listConnections', { query: { limit: 500 } });
  const usable = (connections.data?.connections ?? []).filter((c) => c.status === 'active' || c.status === 'verified');
  const connectionId = params.get('connection') ?? usable[0]?.id;
  const profiles = useQuery('listOntologyFieldProfiles', connectionId === undefined ? null : { params: { connectionId }, query: {} });
  const profile = useMutation('profileOntologyConnection', { invalidates: ['listOntologyFieldProfiles'] });
  const derive = useMutation('startOntologyDerivation', { invalidates: ['listOntologyProposals', 'listOntologyBranches'] });
  const [useProfiles, setUseProfiles] = useState(true);
  const [overlap, setOverlap] = useState(true);
  usePageContext({ scope: { kind: 'page', page: 'ontology' }, scopeLabel: 'Derive types' });
  const objects = [...new Set((profiles.data?.profiles ?? []).map((p) => p.sourceObject))];
  return (
    <Page title="Derive" description="Draft object types and links from what a connected system holds. You decide each one in the proposal it makes."
      crumbs={[{ label: 'Ontology' }]}>
      <QueryView query={connections} what="Connections" isEmpty={() => usable.length === 0}
        empty={<EmptyState icon="plug" title="No active connection">Connect a system and activate it first; derivation reads its declared schema.</EmptyState>}>
        {() => (
          <div className={styles.stack}>
            <SelectField label="Connection" value={connectionId ?? ''} onChange={(e) => set({ connection: e.target.value })} options={usable.map((c) => ({ value: c.id, label: c.name }))} />
            <Section title="Field profiles" description="The shape of each field, counts only: how many values, distinct, empty, and whether they fit their type."
              actions={connectionId !== undefined ? <Button icon="refresh" pending={profile.pending} blocked={profile.blocked} onClick={async () => {
                const r = await profile.run({ params: { connectionId }, body: {} }, { timeoutMs: 120_000 });
                if (r.ok) say(`${plural(r.data.profiled.length, 'object')} profiled${r.data.failed.length > 0 ? `; ${r.data.failed.length} could not be read` : ''}`);
              }}>Profile it</Button> : undefined}>
              {profile.data !== undefined && profile.data.failed.length > 0 ? <Banner tone="warn">Not read: {profile.data.failed.map((f) => `${f.object} (${f.code})`).join(', ')}.</Banner> : null}
              {profile.error !== undefined ? <ErrorMessage error={profile.error} /> : null}
              <QueryView query={profiles} what="Profiles" isEmpty={(d) => d.profiles.length === 0} empty={<p className={styles.muted}>Not profiled yet.</p>}>
                {(d) => (
                  <>
                    <p className={styles.muted}>{plural(objects.length, 'object')}, {plural(d.profiles.length, 'field')}.</p>
                    <DataTable label="Field profiles" rows={d.profiles} rowKey={(p) => `${p.sourceObject}.${p.fieldPath}`} dense columns={[
                      { id: 'field', header: 'Field', primary: true, sortValue: (p) => `${p.sourceObject}.${p.fieldPath}`, cell: (p) => <span className={styles.mono}>{p.sourceObject}.{p.fieldPath}</span> },
                      { id: 'rows', header: 'Rows', width: 'sm', align: 'end', cell: (p) => formatNumber(p.rowCount) },
                      { id: 'distinct', header: 'Distinct', width: 'sm', align: 'end', cell: (p) => (p.distinctCount === null ? '—' : formatNumber(p.distinctCount)) },
                      { id: 'empty', header: 'Empty', width: 'sm', align: 'end', cell: (p) => formatNumber(p.nullCount + p.emptyCount) },
                      { id: 'fit', header: 'Fits its type', width: 'sm', align: 'end', cell: (p) => (p.rowCount === 0 ? '—' : `${Math.round((p.typeConformanceCount / p.rowCount) * 100)}%`) },
                      { id: 'at', header: 'Profiled', width: 'sm', cell: (p) => <Time value={p.profiledAt} /> },
                    ]} />
                  </>
                )}
              </QueryView>
            </Section>
            <Panel>
              <div className={styles.stack}>
                <Checkbox label="Use the field profiles" checked={useProfiles} onChange={() => setUseProfiles(!useProfiles)} hint="Better names, types and identifiers from the fields' shapes." />
                <Checkbox label="Look for overlap with types that exist" checked={overlap} onChange={() => setOverlap(!overlap)}
                  hint="Compares a bounded sample of identifying values in memory, never stored, to propose that a system holds more of a type you have." />
                {derive.error !== undefined ? <ErrorMessage error={derive.error} /> : null}
                <FormActions>
                  <Button variant="primary" icon="sparkle" pending={derive.pending} blocked={derive.blocked} disabled={connectionId === undefined} onClick={async () => {
                    const r = await derive.run({ body: { connectionId: connectionId!, profile: useProfiles, overlap } }, { timeoutMs: 180_000 });
                    if (r.ok) {
                      say(`Derived: ${plural(r.data.decisions.length, 'decision')} for you to make`);
                      router.push(hrefWith('/ontology/proposals/', { proposal: r.data.id }) as never);
                    }
                  }}>Derive types</Button>
                </FormActions>
              </div>
            </Panel>
          </div>
        )}
      </QueryView>
    </Page>
  );
}
