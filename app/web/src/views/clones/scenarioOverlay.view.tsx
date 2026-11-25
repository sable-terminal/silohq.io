'use client';

// A scenario over the live set (spec 30.9, 39): the latest run as stored, its affected objects
// carrying a badge distinct from their state (the delay, or that they fail; in probabilistic mode
// the probability with each edge's sample size), paths through a soft edge apart from hard-only
// ones, and every stop named. Where the confirmed graph has changed since the run, it says so and
// offers a re-run, metered as a simulation. A branch's staged Actions appear as proposed values
// beside live ones, labelled "Scenario: staged, not executed", once the branch is opened
// (metered as a re-run); promoting one enters approval. Nothing here writes, and nothing of the
// scenario is drawn as current: every overlaid element carries the scenario's label.

import { useEffect, useMemo, useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Banner } from '../../components/banner.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { SelectField } from '../../components/field.component.tsx';
import { ErrorMessage } from '../../components/states.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import styles from './clones.view.module.css';

type Latest = Output<'readLatestSimulationRun'>;
type Run = NonNullable<Latest['run']>;

export interface Overlay { label: string; badges: Map<string, string> }

const show = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** An ISO 8601 duration as people read it: "3 d 4 h", "12 h", "30 min". */
export function duration(iso: string | null): string {
  if (iso === null) return '';
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso);
  if (m === null) return iso;
  let seconds = Number(m[1] ?? 0) * 86_400 + Number(m[2] ?? 0) * 3_600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
  const d = Math.floor(seconds / 86_400);
  seconds -= d * 86_400;
  const h = Math.floor(seconds / 3_600);
  seconds -= h * 3_600;
  const min = Math.round(seconds / 60);
  return [d > 0 ? `${d} d` : '', h > 0 ? `${h} h` : '', min > 0 && d === 0 ? `${min} min` : ''].filter((x) => x !== '').join(' ') || '0 min';
}

/** One affected object's badge: what the scenario says of it, with the scenario's label. */
export function badgeOf(r: Run['reached'][number], label: string): string {
  const effect = r.effect === 'fails' ? (r.unavailableFor !== null ? `out for ${duration(r.unavailableFor)}` : 'fails')
    : r.effect === 'constrained' ? `short ${Math.round((r.shortfall ?? 0) * 100)}% a ${r.period ?? 'period'}` : `late ${duration(r.delay)}`;
  const samples = r.path.map((p) => p.sampleSize).filter((n): n is number => n !== null);
  const odds = r.probability === null ? '' : `, ${Math.round(r.probability * 100)}%${samples.length > 0 ? ` (n=${Math.min(...samples)})` : ''}`;
  return `${label}: ${effect}${odds}${r.viaSoftEdge ? ', via a soft edge' : ''}`;
}

export function ScenarioOverlay({ canvasViewId, initialScenarioId, inSet, labelOf, onChange }: {
  canvasViewId: string; initialScenarioId: string | null; inSet: ReadonlySet<string>; labelOf: (id: string) => string; onChange: (overlay: Overlay | undefined, scenarioId: string | undefined) => void;
}) {
  const mine = useQuery('listSimulationScenarios', { query: { filter: 'mine' } }, { staleMs: 60_000 });
  const shared = useQuery('listSimulationScenarios', { query: { filter: 'shared' } }, { staleMs: 60_000 });
  const scenarios = useMemo(() => [...(mine.data?.scenarios ?? []), ...(shared.data?.scenarios ?? []).filter((s) => !(mine.data?.scenarios ?? []).some((m) => m.id === s.id))], [mine.data, shared.data]);
  const [chosen, setChosen] = useState(initialScenarioId ?? '');
  const latest = useQuery('readLatestSimulationRun', chosen === '' ? null : { params: { scenarioId: chosen } });
  const branchesRead = useQuery('listSimulationBranches', chosen === '' ? null : { params: { scenarioId: chosen } });
  const branches = (branchesRead.data?.branches ?? []).filter((b) => b.status === 'open');
  const rerun = useMutation('runSimulationScenario', { invalidates: ['readLatestSimulationRun'] });
  const openBranch = useMutation('openSimulationBranch');
  const promote = useMutation('promoteSimulationBranch', { invalidates: ['listMutations'] });
  const opened = openBranch.data;
  const scenario = scenarios.find((s) => s.id === chosen);
  const label = scenario === undefined ? 'Scenario' : `Scenario "${scenario.name}"`;
  const run = opened?.run ?? latest.data?.run ?? null;

  // The badges: the scenario's run, or an opened branch's run, over the objects in this set.
  useEffect(() => {
    if (chosen === '') {
      onChange(undefined, undefined);
      return;
    }
    const badges = new Map<string, string>();
    for (const r of run?.reached ?? []) if (r.objectId !== null && inSet.has(r.objectId)) badges.set(r.objectId, badgeOf(r, opened !== undefined ? `${label}, branch` : label));
    onChange({ label, badges }, chosen);
  }, [run, opened, chosen, inSet.size, label]);

  const reachedHere = run?.reached.filter((r) => r.objectId !== null && inSet.has(r.objectId)) ?? [];
  const error = latest.error ?? rerun.error ?? openBranch.error ?? promote.error;
  return (
    <section aria-label="Scenario overlay" className={styles.stack}>
      <SelectField label="Scenario overlay" value={chosen} onChange={(e) => {
        openBranch.reset();
        setChosen(e.target.value);
      }} placeholder="None" options={scenarios.map((s) => ({ value: s.id, label: s.name }))} />
      {error !== undefined ? <ErrorMessage error={error} /> : null}
      {chosen !== '' && latest.data !== undefined ? (
        <div className={styles.scenario}>
          <p><strong>{label}</strong>: simulated, not current; nothing here writes.</p>
          {run === null ? <p className={styles.muted}>Not run yet.</p> : (
            <>
              <p className={styles.muted}>
                {reachedHere.length} of this set affected ({reachedHere.filter((r) => !r.viaSoftEdge).length} by hard-only paths, {reachedHere.filter((r) => r.viaSoftEdge).length} through a soft edge)
                {run.reached.length > reachedHere.length ? `; ${run.reached.length - reachedHere.length} more outside it` : ''}.
              </p>
              {run.stopped.length > 0 ? (
                <ul className={styles.plainList}>{run.stopped.map((s, i) => (
                  <li key={i}>Stopped: {s.stop?.reason === 'unconfirmed_edge' ? 'at an unconfirmed edge' : s.stop?.reason === 'bounded_hop' ? `at the bound, hop ${s.stop.hop ?? '?'}` : 'at a type you are not cleared for'}</li>
                ))}</ul>
              ) : null}
              {run.statement !== null ? <p className={styles.muted}>{run.statement}</p> : null}
            </>
          )}
          {latest.data.graphChanged && opened === undefined ? (
            <Banner tone="warn" action={<Button size="sm" pending={rerun.pending} blocked={rerun.blocked} onClick={() => void rerun.run({ params: { scenarioId: chosen } })}>Run it again</Button>}>
              The confirmed graph has changed since this run. Running it again is metered as a simulation.
            </Banner>
          ) : null}
          {branches.length > 0 && opened === undefined ? (
            <ul className={styles.plainList}>{branches.map((b) => (
              <li key={b.id}>{b.label}: {b.stagedActions.length} staged <Button size="sm" variant="link" pending={openBranch.pending} onClick={() => void openBranch.run({ params: { branchId: b.id } })}>Open to compare (metered as a re-run)</Button></li>
            ))}</ul>
          ) : null}
          {opened !== undefined ? (
            <>
              <p><strong>{opened.branch.label}</strong>: Scenario: staged, not executed.</p>
              {opened.checks.map((c) => (
                <div key={c.stagedActionId} className={styles.stackTight}>
                  {c.targets.slice(0, 50).map((t) => (
                    <span key={t.objectId} className={styles.muted}>
                      {labelOf(t.objectId)}: {t.properties.map((p) => `${p.property.replaceAll('_', ' ')} now ${show(p.current)}, staged ${p.branchUnknown ? 'unknown until it runs' : show(p.branch)}`).join('; ')}
                    </span>
                  ))}
                  {c.refusal !== null ? <span className={styles.muted}>Not promotable: {c.refusal.reason}</span>
                    : <Button size="sm" pending={promote.pending} blocked={promote.blocked} onClick={() => void promote.run({ params: { branchId: opened.branch.id }, body: { stagedActionIds: [c.stagedActionId], canvasViewId } })}>Promote into approval</Button>}
                </div>
              ))}
              {promote.data !== undefined ? <p role="status">{promote.data.promoted.length > 0 ? 'Promoted: it enters approval as a proposal.' : `Not promoted${promote.data.notPromoted[0] !== undefined ? `: ${promote.data.notPromoted[0].statement}` : ''}.`}</p> : null}
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
