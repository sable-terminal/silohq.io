'use client';

// A run's result (spec 39.4 to 39.6): the objects reached, each with how (fails, delayed or
// constrained), the accumulated delay, and the path of confirmed edges with each edge's evidence;
// paths through a soft edge apart from hard-only ones; where the walk stopped and why; for a
// probabilistic run each object's probability with its interval, never one headline figure. A
// scenario names what is reached and how; it never says one thing caused another.

import Link from 'next/link';
import type { Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useVocabulary } from '../../hooks/vocabulary.hook.ts';
import { objectHref } from '../../navigation/links.navigation.ts';
import { formatNumber, plural } from '../../utils/format.util.ts';
import { duration, EDGE_SOURCE, percent, STOP_REASON } from './words.view.ts';
import styles from './scenarios.view.module.css';

export type Run = Output<'readSimulationRun'>;
type Result = Run['reached'][number];

function pathOf(r: Result): string {
  return r.path.map((e) => `${e.kind}, ${EDGE_SOURCE[e.source]}${e.sampleSize !== null ? ` (${plural(e.sampleSize, 'observation')})` : ''}`).join(' → ') || 'the failing object itself';
}

export function RunView({ run }: { run: Run }) {
  const { lookup } = useVocabulary();
  const typeName = (id: string | null) => (id === null ? 'Object' : lookup?.typeName(id) ?? 'Object');
  const hard = run.reached.filter((r) => !r.viaSoftEdge);
  const soft = run.reached.filter((r) => r.viaSoftEdge);
  return (
    <section aria-label="Run" className={styles.stack}>
      <p className={styles.row}>
        <strong>{run.status === 'running' ? 'Running' : run.status === 'failed' ? 'The run failed' : `Reached ${plural(run.reached.length, 'object')}`}{run.stopped.length > 0 ? `; stopped on ${plural(run.stopped.length, 'path')}` : ''}</strong>
        <span className={styles.muted}>{run.mode}{run.iterations !== null ? `, ${formatNumber(run.iterations)} iterations` : ''} · graph version {run.graphVersion} · <Time value={run.startedAt} exact /></span>
        {run.charge !== null ? <Badge>{run.charge.operation === 'simulation_rerun' ? 'Charged as a re-run' : 'Charged as a run'}</Badge> : null}
      </p>
      {run.boundedAtHop !== null ? <Banner tone="warn" title="Incomplete">The walk reached its bound at hop {run.boundedAtHop}: objects beyond it are not shown.</Banner> : null}
      {run.statement !== null ? <p className={styles.muted} role="note">{run.statement}</p> : null}
      {run.inferred && run.inferenceStatement !== null ? <p className={styles.muted} role="note">{run.inferenceStatement}</p> : null}
      {run.withheld > 0 ? <p className={styles.muted}>{plural(run.withheld, 'result')} of a type you may not see, so not shown.</p> : null}
      {hard.length > 0 ? <Results caption="Reached through hard edges only" results={hard} typeName={typeName} /> : null}
      {soft.length > 0 ? <Results caption="Reached through a soft edge: they continue, degraded" results={soft} typeName={typeName} /> : null}
      {run.status === 'completed' && run.reached.length === 0 && run.stopped.length === 0 ? <p className={styles.muted}>Nothing downstream is reached through confirmed edges.</p> : null}
      {run.stopped.length > 0 ? (
        <DataTable label="Where the walk stopped" rows={run.stopped} rowKey={(s) => `${s.objectId ?? ''}:${s.stop?.edgeId ?? ''}:${s.stop?.hop ?? ''}:${pathOf(s)}`} columns={[
          { id: 'at', header: 'At', primary: true, cell: (s) => `${typeName(s.stop?.objectTypeId ?? s.objectTypeId)}${s.stop?.hop != null ? `, hop ${s.stop.hop}` : ''}` },
          { id: 'why', header: 'Why', cell: (s) => (s.stop === null ? '—' : STOP_REASON[s.stop.reason]) },
          { id: 'path', header: 'Path so far', cell: (s) => <span className={styles.path}>{pathOf(s)}</span> },
        ]} />
      ) : null}
    </section>
  );
}

function Results({ caption, results, typeName }: { caption: string; results: Result[]; typeName: (id: string | null) => string }) {
  const probabilistic = results.some((r) => r.probability !== null);
  return (
    <DataTable label={caption} rows={results} rowKey={(r) => `${r.objectId ?? ''}:${pathOf(r)}`} columns={[
      { id: 'object', header: 'Object', primary: true, cell: (r) => (r.objectId !== null && r.objectTypeId !== null
        ? <Link href={objectHref({ objectTypeId: r.objectTypeId, objectId: r.objectId }) as never}>{typeName(r.objectTypeId)} {r.objectId.slice(0, 8)}</Link> : typeName(r.objectTypeId)) },
      { id: 'effect', header: 'Effect', cell: (r) => `${r.effect === 'constrained' && r.shortfall !== null ? `constrained: ${percent(r.shortfall)} of demand unmet per ${r.period ?? 'period'}` : r.effect ?? '—'}${r.unavailableFor !== null ? `, out for ${duration(r.unavailableFor)}` : ''}` },
      { id: 'delay', header: 'Delay', cell: (r) => (
        <>{r.effect === 'fails' ? '—' : duration(r.delay)}{r.spread !== null && r.spread.p10 !== null ? <span className={styles.muted}> (10–90%: {duration(r.spread.p10)} to {duration(r.spread.p90)})</span> : null}</>
      ) },
      ...(probabilistic ? [{ id: 'probability', header: 'Probability', cell: (r: Result) => (r.probability === null ? <span className={styles.muted}>from stated lead times</span>
        : `${percent(r.probability)}${r.probabilityInterval !== null ? ` (${percent(r.probabilityInterval[0])}–${percent(r.probabilityInterval[1])})` : ''}`) }] : []),
      { id: 'path', header: 'Path', cell: (r) => <span className={styles.path}>{pathOf(r)}{r.pathMode === 'deterministic' && probabilistic ? <> <Badge>stated</Badge></> : null}</span> },
    ]} />
  );
}
