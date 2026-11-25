'use client';

// Time scrubbing and compare (spec 30.8): the set as Siloes Capture saw it at a past time, with
// states from the type's active rules, and, given a second time, the differences between the two
// (changed states, changed properties with both values, objects present at only one time). Over
// Capture history only: a value never captured is "not captured", never its current value, and
// without Capture the bar says why and nothing is drawn as past. Live changes keep arriving in
// the change rail while the canvas shows the past.

import { useState, type FormEvent } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Banner } from '../../components/banner.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { TextField } from '../../components/field.component.tsx';
import { ErrorMessage } from '../../components/states.component.tsx';
import { useData } from '../../data/query.data.ts';
import type { State } from '../../canvas/lod.canvas.ts';
import styles from './clones.view.module.css';

type At = Output<'getCloneStatesAt'>;
export interface PastView {
  at: string;
  compareTo: string | undefined;
  /** Each object's state at the time; null where Capture had not yet observed it. */
  states: Map<string, { state: State; reason: string } | null>;
  /** Compare: what changed per object, as a short label ("warning → failed", "score 15 → 16"). */
  changes: Map<string, string>;
  statement: string;
  notCaptured: string[];
  onlyAt: string[];
  onlyCompareTo: string[];
}

const BATCH = 500;
const show = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const local = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

export function TimeBar({ objectTypeId, ids, properties, past, onChange }: {
  objectTypeId: string; ids: string[]; properties: string[]; past: PastView | undefined; onChange: (past: PastView | undefined) => void;
}) {
  const { api } = useData();
  const [at, setAt] = useState('');
  const [compareTo, setCompareTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(undefined);
  const [unavailable, setUnavailable] = useState<string | undefined>(undefined);

  const read = async (event: FormEvent) => {
    event.preventDefault();
    if (at === '' || ids.length === 0) return;
    setBusy(true);
    setProblem(undefined);
    setUnavailable(undefined);
    try {
      const atIso = new Date(at).toISOString();
      const compareIso = compareTo === '' ? undefined : new Date(compareTo).toISOString();
      const answers: At[] = [];
      for (let i = 0; i < ids.length; i += BATCH) {
        answers.push(await api.call('getCloneStatesAt', {
          body: { objectTypeId, objectRefs: ids.slice(i, i + BATCH), properties: properties.slice(0, 100), at: atIso, ...(compareIso !== undefined ? { compareTo: compareIso } : {}) },
        }));
      }
      const first = answers[0]!;
      if (!first.available) {
        setUnavailable(first.reason ?? 'this type has no Capture history');
        onChange(undefined);
        return;
      }
      const states = new Map<string, { state: State; reason: string } | null>();
      const changes = new Map<string, string>();
      const onlyAt: string[] = [];
      const onlyCompareTo: string[] = [];
      for (const a of answers) {
        for (const o of a.at) states.set(o.objectRef, o.observed && o.state !== null ? { state: o.state.state as State, reason: o.state.reason } : null);
        for (const d of a.differences?.states ?? []) changes.set(d.objectRef, `${d.compareTo} → ${d.at}`);
        for (const d of a.differences?.properties ?? []) {
          const before = changes.get(d.objectRef);
          const text = `${d.property.replaceAll('_', ' ')} ${show(d.compareTo.value)} → ${show(d.at.value)}`;
          changes.set(d.objectRef, before === undefined ? text : `${before}; ${text}`);
        }
        onlyAt.push(...(a.differences?.onlyAt ?? []));
        onlyCompareTo.push(...(a.differences?.onlyCompareTo ?? []));
      }
      const notObserved = [...states.values()].filter((s) => s === null).length;
      const gaps = first.gaps.length === 0 ? '' : ` History has ${first.gaps.length} gap${first.gaps.length === 1 ? '' : 's'}, from ${local(first.gaps[0]!.from)}.`;
      const statement = `As Capture saw the set at ${local(atIso)}${compareIso !== undefined ? `, compared with ${local(compareIso)}` : ''}: past, not current. `
        + `${first.historyBegins === null ? '' : `History begins ${local(first.historyBegins)}. `}${notObserved > 0 ? `${notObserved} not yet observed then. ` : ''}${gaps}`;
      onChange({
        at: atIso, compareTo: compareIso, states, changes, statement: statement.trim(),
        notCaptured: first.properties.filter((p) => p.availability === 'not_captured').map((p) => p.property), onlyAt, onlyCompareTo,
      });
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(false);
    }
  };

  const now = new Date().toISOString().slice(0, 16);
  return (
    <form className={styles.timeBar} aria-label="Time" onSubmit={read}>
      <TextField label="Show the set at" type="datetime-local" value={at} max={now} onChange={(e) => setAt(e.target.value)} />
      <TextField label="Compare with (optional)" type="datetime-local" value={compareTo} max={now} onChange={(e) => setCompareTo(e.target.value)} />
      <div className={styles.row}>
        <Button type="submit" pending={busy} disabled={at === ''}>{compareTo === '' ? 'Show' : 'Compare'}</Button>
        {past !== undefined ? <Button variant="ghost" onClick={() => onChange(undefined)}>Back to live</Button> : null}
      </div>
      {unavailable !== undefined ? <Banner tone="info" title="Not available">{unavailable}.</Banner> : null}
      {problem !== undefined ? <ErrorMessage error={problem} /> : null}
      {past !== undefined ? (
        <Banner tone="warn" title="Past, not current">
          {past.statement}
          {past.notCaptured.length > 0 ? ` Not captured, so not shown for then: ${past.notCaptured.map((p) => p.replaceAll('_', ' ')).join(', ')}.` : ''}
          {past.compareTo !== undefined ? ` ${past.changes.size} changed; ${past.onlyAt.length} only at the first time; ${past.onlyCompareTo.length} only at the second.` : ''}
        </Banner>
      ) : null}
    </form>
  );
}
