'use client';

// The steps a pipeline (D235) and a notebook's transform cell (D239) apply to a table in order:
// keep rows where a condition holds, add a computed column, choose and rename columns, join
// another input, group and measure, remove duplicates, sort and keep the first rows. Conditions
// and expressions are CEL over the columns; the cell checks them, not the browser. A list field
// keeps what is typed while it is typed, so a comma or a half-written "as" is never taken away.

import { useEffect, useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Button } from '../../components/button.component.tsx';
import { SelectField, TextField } from '../../components/field.component.tsx';
import styles from './studio.view.module.css';

export type Step = Output<'getPipeline'>['document']['steps'][number];

export const STEP_LABEL: Record<Step['op'], string> = {
  filter: 'Keep rows where', compute: 'Add a column', select: 'Choose columns', join: 'Join', aggregate: 'Group and measure', dedupe: 'Remove duplicates', sort: 'Sort', limit: 'Keep the first',
};

export function blankStep(op: Step['op']): Step {
  switch (op) {
    case 'filter': return { op, cel: 'true' };
    case 'compute': return { op, as: 'new_column', cel: '1' };
    case 'select': return { op, columns: [{ from: '' }] };
    case 'join': return { op, input: '', on: [['', '']], kind: 'left' };
    case 'aggregate': return { op, by: [], measures: [{ as: 'count', fn: 'count' }] };
    case 'dedupe': return { op, by: [] };
    case 'sort': return { op, by: [{ column: '', direction: 'asc' }] };
    case 'limit': return { op, rows: 100 };
  }
}

const list = (text: string) => text.split(',').map((x) => x.trim()).filter((x) => x !== '');

/** A text field over a structured value: what is typed stays as typed; a change from outside is taken. */
function ParsedField<T>({ label, value, format, parse, onChange, hint }: {
  label: string; value: T; format: (v: T) => string; parse: (text: string) => T; onChange: (v: T) => void; hint?: string;
}) {
  const shown = format(value);
  const [text, setText] = useState(shown);
  useEffect(() => {
    setText((now) => (format(parse(now)) === shown ? now : shown));
    // Only a change from outside resets the text.
  }, [shown]);
  return <TextField label={label} hint={hint} className={styles.mono} value={text} onChange={(e) => {
    setText(e.target.value);
    onChange(parse(e.target.value));
  }} />;
}

export function StepEditor({ step, inputs, onChange }: { step: Step; inputs: readonly string[]; onChange: (s: Step) => void }) {
  switch (step.op) {
    case 'filter':
      return <TextField label="Condition" className={styles.mono} value={step.cel} hint="CEL over the columns, such as pressure > 4 && site == 'North'." onChange={(e) => onChange({ ...step, cel: e.target.value })} />;
    case 'compute':
      return (
        <div className={styles.fields}>
          <TextField label="Column" className={styles.mono} value={step.as} onChange={(e) => onChange({ ...step, as: e.target.value })} />
          <TextField label="Expression" className={styles.mono} value={step.cel} hint="CEL over the columns." onChange={(e) => onChange({ ...step, cel: e.target.value })} />
        </div>
      );
    case 'select':
      return (
        <ParsedField label="Columns, in order" hint="Separated by commas; rename with as, such as site as location." value={step.columns}
          format={(cs) => cs.map((c) => (c.as === undefined ? c.from : `${c.from} as ${c.as}`)).join(', ')}
          parse={(t) => list(t).map((x) => {
            const m = /^(\S+)\s+as\s+(\S+)$/.exec(x);
            return m === null ? { from: x } : { from: m[1]!, as: m[2]! };
          })}
          onChange={(columns) => onChange({ ...step, columns })} />
      );
    case 'join':
      return (
        <div className={styles.fields}>
          <SelectField label="With" value={step.input} placeholder="Choose an input" onChange={(e) => onChange({ ...step, input: e.target.value })}
            options={inputs.map((i) => ({ value: i, label: i }))} hint={inputs.length === 0 ? 'Add another input to join it.' : undefined} />
          <ParsedField label="Where" hint="This column = its column, separated by commas." value={step.on}
            format={(on) => on.map(([a, b]) => `${a} = ${b}`).join(', ')}
            parse={(t) => list(t).map((x) => {
              const [a, b] = x.split('=').map((y) => y.trim());
              return [a ?? '', b ?? ''] as [string, string];
            })}
            onChange={(on) => onChange({ ...step, on })} />
          <SelectField label="Rows without a match" value={step.kind} onChange={(e) => onChange({ ...step, kind: e.target.value as 'inner' | 'left' })}
            options={[{ value: 'left', label: 'Kept' }, { value: 'inner', label: 'Dropped' }]} />
        </div>
      );
    case 'aggregate':
      return (
        <div className={styles.fields}>
          <ParsedField label="Group by" hint="Columns, separated by commas." value={step.by} format={(by) => by.join(', ')} parse={list} onChange={(by) => onChange({ ...step, by })} />
          <ParsedField label="Measures" hint="name = fn(column): count, count_distinct, sum, avg, min or max." value={step.measures}
            format={(ms) => ms.map((m) => `${m.as} = ${m.fn}(${m.column ?? ''})`).join(', ')}
            parse={(t) => list(t).map((x) => {
              const m = /^(\w+)\s*=\s*(count|count_distinct|sum|avg|min|max)\((\w*)\)$/.exec(x);
              return m === null ? { as: 'count', fn: 'count' as const } : { as: m[1]!, fn: m[2] as 'count', ...(m[3] === '' ? {} : { column: m[3]! }) };
            })}
            onChange={(measures) => onChange({ ...step, measures })} />
        </div>
      );
    case 'dedupe':
      return <ParsedField label="On columns" hint="Separated by commas; blank compares whole rows." value={step.by} format={(by) => by.join(', ')} parse={list} onChange={(by) => onChange({ ...step, by })} />;
    case 'sort':
      return (
        <ParsedField label="By" hint="column asc or column desc, separated by commas." value={step.by}
          format={(by) => by.map((b) => `${b.column} ${b.direction}`).join(', ')}
          parse={(t) => list(t).map((x) => {
            const [c, d] = x.split(/\s+/);
            return { column: c ?? '', direction: (d === 'desc' ? 'desc' : 'asc') as 'asc' | 'desc' };
          })}
          onChange={(by) => onChange({ ...step, by })} />
      );
    case 'limit':
      return <TextField label="Rows" type="number" min={1} value={step.rows} onChange={(e) => onChange({ ...step, rows: Math.max(1, Number(e.target.value) || 1) })} />;
  }
}

/** A list of steps: each with its editor, moved and removed; and a step added at the end. */
export function Steps({ steps, inputs, onChange }: { steps: readonly Step[]; inputs: readonly string[]; onChange: (steps: Step[]) => void }) {
  const [adding, setAdding] = useState<Step['op']>('filter');
  const move = (i: number, by: -1 | 1) => {
    const next = [...steps];
    const [s] = next.splice(i, 1);
    next.splice(i + by, 0, s!);
    onChange(next);
  };
  return (
    <div className={styles.stackTight}>
      {steps.length === 0 ? <p className={styles.muted}>No steps: the input passes through as it is.</p> : null}
      <ol className={styles.listItems}>{steps.map((s, i) => (
        <li key={i} className={styles.card} aria-label={`Step ${i + 1}: ${STEP_LABEL[s.op]}`}>
          <div className={styles.cardHead}>
            <strong>{i + 1}. {STEP_LABEL[s.op]}</strong>
            <Button size="sm" variant="ghost" icon="chevronUp" disabled={i === 0} onClick={() => move(i, -1)}>Up</Button>
            <Button size="sm" variant="ghost" icon="chevronDown" disabled={i === steps.length - 1} onClick={() => move(i, 1)}>Down</Button>
            <Button size="sm" variant="ghost" icon="trash" onClick={() => onChange(steps.filter((_, j) => j !== i))}>Remove</Button>
          </div>
          <StepEditor step={s} inputs={inputs} onChange={(x) => onChange(steps.map((y, j) => (j === i ? x : y)))} />
        </li>
      ))}</ol>
      <form className={styles.rowEnd} aria-label="Add a step" onSubmit={(e) => {
        e.preventDefault();
        onChange([...steps, blankStep(adding)]);
      }}>
        <SelectField label="Step" value={adding} onChange={(e) => setAdding(e.target.value as Step['op'])}
          options={(Object.keys(STEP_LABEL) as Step['op'][]).map((o) => ({ value: o, label: STEP_LABEL[o] }))} />
        <Button type="submit" icon="plus">Add the step</Button>
      </form>
    </div>
  );
}
