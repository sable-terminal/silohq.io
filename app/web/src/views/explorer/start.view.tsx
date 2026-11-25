'use client';

// An analysis started from somewhere else (spec 37.8): an Ask answer or a Studio chart, made steps
// on the server and kept under the analysis's own id. With nothing lost on the way it opens in
// Analysis at once; otherwise what the steps do not keep is said here first, plainly, with the way
// to open it, so a difference from the answer or chart is never discovered by surprise. A shape
// that is not a chain, or a step refused, says why.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Banner } from '../../components/banner.component.tsx';
import { Button, LinkButton } from '../../components/button.component.tsx';
import { ErrorMessage } from '../../components/states.component.tsx';
import type { Blocked } from '../../data/query.data.ts';
import { hrefWith } from '../../utils/href.util.ts';
import styles from './start.view.module.css';

export type Started = Output<'createWorkspaceAnalysisFromTurn'> | Output<'createWorkspaceAnalysisFromAppChart'>;

const analysisHref = (s: { manifestId: string; analysisId: string }) => hrefWith('/explorer/analyses/', { manifest: s.manifestId, analysis: s.analysisId });

export function StartAnalysis({ label, pending, blocked, error, start }: {
  label: string;
  pending: boolean;
  blocked: Blocked | undefined;
  error: unknown;
  /** Makes the analysis: its outcome, or undefined when the call failed (the error says why). */
  start: () => Promise<Started | undefined>;
}) {
  const router = useRouter();
  const [started, setStarted] = useState<Started | undefined>();
  const begin = async () => {
    setStarted(undefined);
    const out = await start();
    if (out === undefined) return;
    if (out.outcome === 'analysis' && out.notes.length === 0) router.push(analysisHref(out) as never);
    else setStarted(out);
  };
  return (
    <div className={styles.start}>
      <Button size="sm" icon="chart" pending={pending} blocked={blocked} onClick={() => void begin()}>{label}</Button>
      {started?.outcome === 'analysis' ? (
        <Banner tone="info" title="The analysis is ready, with these differences">
          <ul className={styles.notes}>{started.notes.map((n) => <li key={n}>{n}</li>)}</ul>
          <LinkButton size="sm" href={analysisHref(started)}>Open the analysis</LinkButton>
        </Banner>
      ) : started?.outcome === 'not_steps' ? (
        <p className={styles.muted} role="status">Not as steps: {started.refusal.reason}.</p>
      ) : started?.outcome === 'refusal' ? (
        <p className={styles.muted} role="status">Not as steps: step {started.refused.position}, {started.refused.refusal.reason}.</p>
      ) : null}
      {error !== undefined ? <ErrorMessage error={error} /> : null}
    </div>
  );
}
