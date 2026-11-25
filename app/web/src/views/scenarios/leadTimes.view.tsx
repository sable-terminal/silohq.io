'use client';

// Lead times observed from history (spec 39.3, 67.4): for a proposed edge, how long the
// downstream waits on the upstream, measured in what Siloes Capture holds: for each upstream
// object's transition of a property, the time to the next transition of a property on each object
// it links to. With enough observations the edge is proposed with source history, its lead time
// the median and its evidence the distribution; with too few, nothing is proposed, and it says how
// many there are and how many are needed. Only durations are shown, never a record value.

import { useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { SelectField } from '../../components/field.component.tsx';
import { Page } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage } from '../../components/states.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useVocabulary } from '../../hooks/vocabulary.hook.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { formatNumber, plural } from '../../utils/format.util.ts';
import { edgeWords, type Edge } from './graph.view.tsx';
import { seconds } from './words.view.ts';
import styles from './scenarios.view.module.css';

type Observed = Output<'observeSimulationLeadTimes'>;

export function LeadTimes() {
  const { lookup } = useVocabulary();
  const edges = useQuery('listSimulationEdges', { query: { status: 'proposed' } });
  usePageContext({ scope: { kind: 'page', page: 'scenarios' }, scopeLabel: 'Lead times' });
  const typeName = (id: string) => lookup?.typeName(id) ?? 'a type';
  return (
    <Page title="Lead times" description="How long one thing waits on another, observed from the history Siloes Capture keeps. An observed lead time is proposed with its evidence; a person still confirms the edge."
      crumbs={[{ label: 'Scenarios', href: '/scenarios/list/' }]}>
      <QueryView query={edges} what="Proposed edges" isEmpty={(d) => d.edges.length === 0}
        empty={<EmptyState icon="clock" title="No proposed edges">Propose edges on the dependency graph first; their lead times are observed here.</EmptyState>}>
        {(d) => (
          <ul className={styles.stack} aria-label="Proposed edges">
            {d.edges.map((e) => <li key={e.id} className={styles.card}><Observe edge={e} typeName={typeName} /></li>)}
          </ul>
        )}
      </QueryView>
    </Page>
  );
}

function Observe({ edge, typeName }: { edge: Edge; typeName: (id: string) => string }) {
  const say = useToast();
  const { data: vocabulary } = useVocabulary();
  const observe = useMutation('observeSimulationLeadTimes', { invalidates: ['listSimulationEdges'] });
  const [upstream, setUpstream] = useState('');
  const [downstream, setDownstream] = useState('');
  const props = (typeId: string) => (vocabulary?.objectTypes.find((t) => t.id === typeId)?.properties ?? []).map((p) => ({ value: p.apiName, label: p.displayName }));
  const out: Observed | undefined = observe.data;
  return (
    <div className={styles.stackTight}>
      <strong>{edgeWords(edge, typeName)}</strong>
      <form className={styles.rowEnd} aria-label={`Observe ${typeName(edge.toObjectTypeId)} waiting on ${typeName(edge.fromObjectTypeId)}`} onSubmit={(e) => {
        e.preventDefault();
        void observe.run({ params: { edgeId: edge.id }, body: { upstreamProperty: upstream, downstreamProperty: downstream, version: edge.version } })
          .then((r) => r.ok && say(r.data.state === 'observed' ? 'Observed: the edge is proposed with this lead time' : 'Not enough history yet'));
      }}>
        <SelectField label={`When ${typeName(edge.fromObjectTypeId)} changes`} value={upstream} placeholder="Choose a property" onChange={(e) => setUpstream(e.target.value)} options={props(edge.fromObjectTypeId)} />
        <SelectField label={`Until ${typeName(edge.toObjectTypeId)} changes`} value={downstream} placeholder="Choose a property" onChange={(e) => setDownstream(e.target.value)} options={props(edge.toObjectTypeId)} />
        <Button type="submit" pending={observe.pending} blocked={observe.blocked} disabled={upstream === '' || downstream === ''}>Observe</Button>
      </form>
      {observe.error !== undefined ? <ErrorMessage error={observe.error} /> : null}
      {out !== undefined ? (
        out.state === 'observed' && out.distribution !== null ? (
          <div className={styles.stackTight} role="status">
            <span className={styles.row}><Badge tone="ok">Observed</Badge><span className={styles.muted}>{plural(out.distribution.observations, 'observation')}</span></span>
            <dl className={styles.distribution}>
              {([['Shortest', out.distribution.min], ['10%', out.distribution.p10], ['Median', out.distribution.p50], ['90%', out.distribution.p90], ['Longest', out.distribution.max]] as const).map(([label, v]) => (
                <div key={label}><dt>{label}</dt><dd>{seconds(v)}</dd></div>
              ))}
            </dl>
          </div>
        ) : (
          <Banner tone="info" title={out.state === 'building' ? 'Not enough history yet' : 'Not observable'}>
            {out.state === 'building' ? `${formatNumber(out.have)} of the ${formatNumber(out.need)} observations needed so far. Capture keeps adding them.` : 'Capture holds no history of these properties for these objects.'}
          </Banner>
        )
      ) : null}
    </div>
  );
}
