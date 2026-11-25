'use client';

// Analysis over object sets (spec 37.8): a chain built by hand, step by step. A fresh set of a type
// (from here, from Explorer with its filters, or an object and a link group from its view), then filters, links followed, values computed by
// the engine, groups, a series over time, a pivot, two sets compared, and back to the objects behind
// any group. Every step's output can be seen. A step over its bound is refused, naming the step, the
// bound and the count, and nothing after it runs; the steps before it stay as they were (and the
// refusal is recorded, analysis_step_refused). Saved as a view of kind analysis, which re-runs free.

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Banner } from '../../components/banner.component.tsx';
import { Button, IconButton } from '../../components/button.component.tsx';
import { Dialog } from '../../components/dialog.component.tsx';
import { Checkbox, FormActions, SelectField, TextField } from '../../components/field.component.tsx';
import { Menu, type MenuEntry } from '../../components/menu.component.tsx';
import { Page, Panel } from '../../components/page.component.tsx';
import { EmptyState, ErrorMessage, Loading } from '../../components/states.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useData, useMutation, useQuery } from '../../data/query.data.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { useVocabulary, type Lookup, type ObjectType } from '../../hooks/vocabulary.hook.ts';
import { viewHref } from '../../navigation/links.navigation.ts';
import { ResultByRef, type SelectionActions } from '../../results/result.result.tsx';
import { filtersFromParam } from '../../utils/plan.util.ts';
import {
  draftsOf, isSet, lastSet, OPERATION_LABEL, requestOf, stepWords, typeAt,
  type FilterDraft, type FilterOp, type KeyDraft, type MeasureDraft, type MeasureFn, type Operation, type Scalar, type StepDraft, type Unit,
} from './chain.view.ts';
import styles from './analysis.view.module.css';

type Outcome = Output<'runWorkspaceAnalysis'>['steps'][number];
type Compiled = { manifestId: string; analysisId: string };

const crumbs = [{ label: 'Explorer', href: '/explorer/types/' }];
const NUMBER = new Set(['integer', 'decimal', 'money', 'duration']);
const TIME = new Set(['date', 'timestamp']);
const ORDERED = new Set([...NUMBER, ...TIME, 'string']);
const OPS: { value: FilterOp; label: string; needs: 'value' | 'none' }[] = [
  { value: 'eq', label: 'is', needs: 'value' }, { value: 'ne', label: 'is not', needs: 'value' }, { value: 'gt', label: 'is above', needs: 'value' },
  { value: 'gte', label: 'is at least', needs: 'value' }, { value: 'lt', label: 'is below', needs: 'value' }, { value: 'lte', label: 'is at most', needs: 'value' },
  { value: 'contains', label: 'contains', needs: 'value' }, { value: 'starts_with', label: 'starts with', needs: 'value' },
  { value: 'is_null', label: 'is empty', needs: 'none' }, { value: 'is_not_null', label: 'is not empty', needs: 'none' },
];
const FNS: { value: MeasureFn; label: string }[] = [
  { value: 'count', label: 'How many' }, { value: 'sum', label: 'Total' }, { value: 'avg', label: 'Average' }, { value: 'min', label: 'Lowest' },
  { value: 'max', label: 'Highest' }, { value: 'count_distinct', label: 'Distinct values' },
];
const UNITS: { value: Unit; label: string }[] = [
  { value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }, { value: 'quarter', label: 'Quarter' },
  { value: 'year', label: 'Year' }, { value: 'financial_quarter', label: 'Financial quarter' }, { value: 'financial_year', label: 'Financial year' },
];
const MONTHS: Readonly<Record<Unit, { months: number; days: number }>> = {
  day: { months: 0, days: 1 }, week: { months: 0, days: 7 }, month: { months: 1, days: 0 }, quarter: { months: 3, days: 0 }, year: { months: 12, days: 0 },
  financial_quarter: { months: 3, days: 0 }, financial_year: { months: 12, days: 0 },
};

/** The first day of the period after a bucket's start: a selected bucket is its start up to that day. */
function nextPeriod(start: string, unit: Unit): string {
  const [y, m, d] = start.split('-').map(Number) as [number, number, number];
  const step = MONTHS[unit];
  const next = new Date(Date.UTC(y, m - 1 + step.months, d + step.days));
  return next.toISOString().slice(0, 10);
}

const alias = (fn: MeasureFn, apiName: string | undefined) => (fn === 'count' ? 'how_many' : `${fn}_${(apiName ?? 'value').toLowerCase().replace(/[^a-z0-9]+/g, '_')}`.slice(0, 60));
const valueOf = (text: string, dataType: string | undefined): Scalar => (dataType !== undefined && NUMBER.has(dataType) && text.trim() !== '' && !Number.isNaN(Number(text)) ? Number(text) : text);

export function Analyses() {
  const router = useRouter();
  const say = useToast();
  const { api } = useData();
  const { data: vocabulary, lookup } = useVocabulary();
  const [params, set] = useParams();
  const [steps, setSteps] = useState<StepDraft[]>([]);
  const [compiled, setCompiled] = useState<Compiled | undefined>();
  const [outcomes, setOutcomes] = useState<Outcome[] | undefined>();
  const [problem, setProblem] = useState<{ position?: number; reason: string } | undefined>();
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [startType, setStartType] = useState('');
  const create = useMutation('createWorkspaceAnalysis', { refresh: false });
  const runIt = useMutation('runWorkspaceAnalysis', { refresh: false });
  const save = useMutation('saveWorkspaceView', { invalidates: ['listWorkspaceViews'] });
  const manifestParam = params.get('manifest');
  const analysisParam = params.get('analysis');
  const reopened = useQuery('readWorkspaceAnalysis', manifestParam !== null ? { params: { manifestId: manifestParam }, query: analysisParam !== null ? { analysisId: analysisParam } : {} } : null);

  // Opening: a kept analysis with its values, or a fresh set of a type (from Explorer, with its filters).
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    if (manifestParam !== null) {
      if (reopened.data === undefined) return;
      opened.current = true;
      setSteps(draftsOf(reopened.data.steps, reopened.data.parameters));
      if (analysisParam !== null && reopened.data.parameters !== null) setCompiled({ manifestId: manifestParam, analysisId: analysisParam });
      return;
    }
    const type = params.get('type');
    if (type !== null) {
      opened.current = true;
      const filters = filtersFromParam(params.get('f')).map((f): FilterDraft => ('values' in f ? { property: f.property, op: 'in', value: f.values } : 'value' in f ? { property: f.property, op: f.op, value: f.value } : { property: f.property, op: f.op }));
      // From an object view's link group: the object, then the objects it links to (37.8).
      const follow = params.get('follow');
      setSteps(follow !== null ? [{ operation: 'filter', base: type, filters }, { operation: 'traverse', input: 1, linkTypeId: follow, filters: [] }] : [{ operation: 'filter', base: type, filters }]);
    }
  }, [manifestParam, analysisParam, reopened.data, params]);

  // A kept chain whose values are its maker's runs on opening.
  const ranOnOpen = useRef(false);
  useEffect(() => {
    if (compiled !== undefined && outcomes === undefined && !ranOnOpen.current) {
      ranOnOpen.current = true;
      void runSteps(compiled);
    }
  });

  const change = (next: StepDraft[]) => {
    setSteps(next);
    setCompiled(undefined);
    setOutcomes(undefined);
    setProblem(undefined);
  };

  async function runSteps(c: Compiled) {
    const ran = await runIt.run({ params: { manifestId: c.manifestId }, body: { analysisId: c.analysisId } });
    if (!ran.ok) return;
    setOutcomes(ran.data.steps);
    const refused = ran.data.steps.find((s): s is Extract<Outcome, { outcome: 'refused' }> => s.outcome === 'refused');
    if (refused !== undefined && refused.refusal.bound !== undefined) {
      void api.call('recordWorkspaceInteraction', { body: {
        event: 'analysis_step_refused', step: refused.operation, stepIndex: refused.position - 1,
        bound: refused.refusal.bound.name.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 60), count: Math.max(0, Math.round(refused.refusal.bound.observed ?? 0)),
      } }).catch(() => undefined);
    }
  }

  async function run() {
    setBusy(true);
    setProblem(undefined);
    try {
      let c = compiled;
      if (c === undefined) {
        const made = await create.run({ body: requestOf(steps) });
        if (!made.ok) return;
        if (made.data.outcome === 'refusal') {
          setProblem({ position: made.data.refused.position, reason: made.data.refused.refusal.reason });
          return;
        }
        c = { manifestId: made.data.manifestId, analysisId: made.data.analysisId };
        setCompiled(c);
        set({ manifest: c.manifestId, analysis: c.analysisId, type: undefined, f: undefined });
      }
      await runSteps(c);
    } finally {
      setBusy(false);
    }
  }

  const add = (operation: Operation) => {
    if (lookup === undefined) return;
    const from = lastSet(steps) ?? 1;
    const typeId = typeAt(steps, from, lookup);
    const type = typeId !== undefined ? lookup.types.get(typeId) : undefined;
    const first = type?.properties.find((p) => p.effect === 'allow');
    const time = type?.properties.find((p) => p.effect === 'allow' && (p.isTimeField || TIME.has(p.dataType)));
    const count: MeasureDraft = { fn: 'count', as: 'how_many' };
    const next: StepDraft | undefined = operation === 'filter' ? { operation: 'filter', input: from, filters: first !== undefined ? [{ property: first.identityId, op: 'eq', value: '' }] : [] }
      : operation === 'traverse' ? (() => {
        const link = vocabulary?.linkTypes.find((l) => l.fromTypeId === typeId || l.toTypeId === typeId);
        return link === undefined ? undefined : { operation: 'traverse', input: from, linkTypeId: link.id, filters: [] } as StepDraft;
      })()
      : operation === 'derive' ? (first !== undefined ? { operation: 'derive', input: from, properties: [first.identityId] } : undefined)
      : operation === 'group' ? (first !== undefined ? { operation: 'group', input: from, groupBy: [{ property: first.identityId }], measures: [count] } : undefined)
      : operation === 'time_series' ? (time !== undefined ? { operation: 'time_series', input: from, property: time.identityId, unit: 'month', measures: [count] } : undefined)
      : operation === 'pivot' ? (() => {
        const keys = type?.properties.filter((p) => p.effect === 'allow' && !NUMBER.has(p.dataType)) ?? [];
        return keys.length < 2 ? undefined : { operation: 'pivot', input: from, rows: keys[0]!.identityId, columns: keys[1]!.identityId, measure: count } as StepDraft;
      })()
      : operation === 'compare' ? (() => {
        const sets = steps.map((s, i) => (isSet(s) ? i + 1 : 0)).filter((p) => p > 0);
        return sets.length < 2 ? undefined : { operation: 'compare', inputs: [sets.at(-2)!, sets.at(-1)!], measures: [count] } as StepDraft;
      })()
      : undefined;
    if (next !== undefined) change([...steps, next]);
  };

  const canAdd = (operation: Operation): string | undefined => {
    if (lookup === undefined || steps.length === 0) return 'Start from a type first';
    const typeId = typeAt(steps, lastSet(steps) ?? 1, lookup);
    const type = typeId !== undefined ? lookup.types.get(typeId) : undefined;
    if (operation === 'traverse' && !(vocabulary?.linkTypes.some((l) => l.fromTypeId === typeId || l.toTypeId === typeId) ?? false)) return 'These objects have no link you may follow';
    if (operation === 'time_series' && !(type?.properties.some((p) => p.effect === 'allow' && (p.isTimeField || TIME.has(p.dataType))) ?? false)) return 'These objects have no date or time';
    if (operation === 'pivot' && (type?.properties.filter((p) => p.effect === 'allow' && !NUMBER.has(p.dataType)).length ?? 0) < 2) return 'A pivot needs two properties to group by';
    if (operation === 'compare' && steps.filter(isSet).length < 2) return 'Compare needs two sets of objects';
    return undefined;
  };
  const menu: MenuEntry[] = (['filter', 'traverse', 'derive', 'group', 'time_series', 'pivot', 'compare'] as const).map((op) => ({
    label: OPERATION_LABEL[op], disabled: canAdd(op) !== undefined, ...(canAdd(op) !== undefined ? { description: canAdd(op) } : {}), onSelect: () => add(op),
  }));

  /** On a grouped step's output: the objects behind the group selected, as a new step. */
  const behind = (position: number): SelectionActions => (selection) => {
    const grouped = steps[position - 1];
    if (selection.group === undefined || lookup === undefined || grouped === undefined || !('input' in grouped) || grouped.input === undefined) return null;
    const typeId = typeAt(steps, grouped.input, lookup);
    const type = typeId !== undefined ? lookup.types.get(typeId) : undefined;
    const key = Object.entries(selection.group).flatMap(([apiName, value]): KeyDraft[] => {
      const p = type?.properties.find((x) => x.apiName === apiName);
      if (p === undefined) return [];
      const bucket = grouped.operation === 'time_series' && grouped.property === p.identityId ? grouped.unit
        : grouped.operation === 'group' ? grouped.groupBy.find((g) => g.property === p.identityId)?.bucket : undefined;
      if (value === null || value === undefined) return [{ property: p.identityId, value: null }];
      return bucket !== undefined && typeof value === 'string' ? [{ property: p.identityId, value, to: nextPeriod(value, bucket) }] : [{ property: p.identityId, value: value as Scalar }];
    });
    if (key.length === 0) return null;
    return <Button size="sm" onClick={() => change([...steps, { operation: 'select', input: position, key }])}>Continue with the objects behind it</Button>;
  };

  if (vocabulary === undefined || lookup === undefined) return <Page title="Analysis" crumbs={crumbs}><Loading label="Reading your types" /></Page>;
  if (manifestParam !== null && reopened.status === 'error') return <Page title="Analysis" crumbs={crumbs}><ErrorMessage error={reopened.error} onRetry={reopened.refetch} /></Page>;

  return (
    <Page title="Analysis" crumbs={crumbs} width="full"
      description="A chain of steps over sets of objects. Each step is bounded and can be seen; built by hand, it is never charged."
      actions={steps.length > 0 ? (
        <div className={styles.bar}>
          <Menu label="Add a step" items={menu} renderTrigger={(p) => <Button {...p} icon="plus">Add a step</Button>} />
          <Button blocked={save.blocked} disabled={compiled === undefined || outcomes === undefined} onClick={() => setSaving(true)}>Save as a view</Button>
          <Button variant="primary" icon="play" pending={busy} blocked={create.blocked ?? runIt.blocked} onClick={() => void run()}>{compiled === undefined ? 'Run' : 'Run again'}</Button>
        </div>
      ) : undefined}>
      <div className={styles.stack}>
        {steps.length === 0 ? (
          <Panel>
            <EmptyState icon="chart" title="Start from a type">Choose which objects to begin with; filter them, follow their links, group them, and see each step as you go.</EmptyState>
            <form className={styles.start} onSubmit={(e) => {
              e.preventDefault();
              if (startType !== '') change([{ operation: 'filter', base: startType, filters: [] }]);
            }}>
              <SelectField label="Begin with" value={startType} placeholder="Choose a type" onChange={(e) => setStartType(e.target.value)}
                options={vocabulary.objectTypes.map((t) => ({ value: t.id, label: t.pluralName }))} />
              <Button type="submit" variant="primary" disabled={startType === ''}>Start</Button>
            </form>
          </Panel>
        ) : null}
        {create.error !== undefined ? <ErrorMessage error={create.error} /> : null}
        {runIt.error !== undefined ? <ErrorMessage error={runIt.error} /> : null}
        {problem !== undefined ? <Banner tone="warn" title={problem.position !== undefined ? `Step ${problem.position} cannot be planned` : 'It cannot be planned'}>{problem.reason}</Banner> : null}
        <ol className={styles.steps} aria-label="Steps">
          {steps.map((step, i) => {
            const position = i + 1;
            const outcome = outcomes?.find((o) => o.position === position);
            const usedLater = steps.slice(i + 1).some((s) => ('input' in s && s.input === position) || (s.operation === 'compare' && s.inputs.includes(position)));
            return (
              <li key={position} className={[styles.step, outcome?.outcome === 'refused' ? styles.stepRefused : ''].join(' ')} aria-label={`Step ${position}`}>
                <div className={styles.stepHead}>
                  <h2 className={styles.stepTitle}><span className={styles.position}>{position}</span>{OPERATION_LABEL[step.operation]}</h2>
                  <IconButton icon="trash" label={`Remove step ${position}`} blocked={usedLater ? 'A later step reads it' : undefined}
                    onClick={() => change(steps.filter((_, j) => j !== i))} />
                </div>
                <span className={styles.words}>{stepWords(steps, position, lookup)}</span>
                <StepEditor steps={steps} position={position} lookup={lookup} vocabulary={vocabulary.linkTypes} onChange={(next) => change(steps.map((s, j) => (j === i ? next : s)))} />
                {outcome !== undefined ? (
                  <div className={styles.output}>
                    {outcome.outcome === 'refused' ? (
                      <Banner tone="warn" title={`Refused at step ${position}`}>
                        {outcome.refusal.reason}{outcome.refusal.remedy !== undefined ? ` (${outcome.refusal.remedy}.)` : ''} The steps before it stand; nothing after it ran.
                      </Banner>
                    ) : outcome.outcome === 'not_run' ? <p className={styles.muted}>Not run: an earlier step was refused.</p> : (
                      <div className={outcome.results.length > 1 ? styles.pair : undefined}>
                        {outcome.results.map((r, k) => (
                          <div key={r.queryId}>
                            {outcome.results.length > 1 ? <p className={styles.muted}>Step {(step.operation === 'compare' ? step.inputs : [])[k]}</p> : null}
                            <ResultByRef queryId={r.queryId} label={`Step ${position}${outcome.results.length > 1 ? `, side ${k + 1}` : ''}`}
                              selectionActions={step.operation === 'group' || step.operation === 'time_series' || step.operation === 'pivot' ? behind(position) : undefined} />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      </div>
      <Dialog open={saving} onClose={() => setSaving(false)} title="Save as a view" size="sm" busy={save.pending}
        description="The view keeps its own copy of the values, re-runs each step on opening, and is never charged.">
        <form onSubmit={async (e) => {
          e.preventDefault();
          if (compiled === undefined || name.trim() === '') return;
          const r = await save.run({ body: { kind: 'analysis', name: name.trim(), manifestId: compiled.manifestId, fromBindingId: compiled.analysisId } });
          if (r.ok) {
            setSaving(false);
            say('Saved');
            router.push(viewHref(r.data.id, 'analysis') as never);
          }
        }}>
          <TextField label="Name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
          {save.error !== undefined ? <ErrorMessage error={save.error} /> : null}
          <FormActions><Button onClick={() => setSaving(false)}>Cancel</Button><Button type="submit" variant="primary" pending={save.pending} disabled={name.trim() === ''}>Save</Button></FormActions>
        </form>
      </Dialog>
    </Page>
  );
}

/** One step's own settings: what it reads and how. */
function StepEditor({ steps, position, lookup, vocabulary, onChange }: {
  steps: StepDraft[]; position: number; lookup: Lookup; vocabulary: Output<'readVocabulary'>['linkTypes']; onChange: (step: StepDraft) => void;
}) {
  const step = steps[position - 1]!;
  const sets = steps.slice(0, position - 1).map((s, i) => ({ s, p: i + 1 })).filter(({ s }) => isSet(s));
  const inputType = 'input' in step && step.input !== undefined && step.operation !== 'select' ? typeAt(steps, step.input, lookup) : undefined;
  const ownType = typeAt(steps, position, lookup);
  const typeOf = (id: string | undefined): ObjectType | undefined => (id === undefined ? undefined : lookup.types.get(id));
  const props = (type: ObjectType | undefined, keep: (dataType: string) => boolean = () => true) =>
    (type?.properties ?? []).filter((p) => p.effect === 'allow' && keep(p.dataType)).map((p) => ({ value: p.identityId, label: p.displayName }));
  const fromStep = 'input' in step && step.operation !== 'select' && step.input !== undefined && !(step.operation === 'filter' && step.base !== undefined) ? (
    <SelectField label="From step" value={String(step.input)} onChange={(e) => onChange({ ...step, input: Number(e.target.value) } as StepDraft)}
      options={sets.map(({ p }) => ({ value: String(p), label: `${p}: ${stepWords(steps, p, lookup)}` }))} />
  ) : null;
  const bound = (
    <TextField label={isSet(step) ? 'At most, members' : 'At most, groups'} type="number" min={1} max={isSet(step) ? 100_000 : 10_000}
      value={step.bound === undefined ? '' : String(step.bound)} placeholder={isSet(step) ? '10,000' : '1,000'}
      onChange={(e) => onChange({ ...step, bound: e.target.value === '' ? undefined : Math.max(1, Number(e.target.value) || 1) } as StepDraft)} />
  );
  const measureEditor = (m: MeasureDraft, type: ObjectType | undefined, set: (m: MeasureDraft) => void, label = 'Measure') => {
    const allowed = (dataType: string) => (m.fn === 'sum' || m.fn === 'avg' ? NUMBER.has(dataType) : m.fn === 'min' || m.fn === 'max' ? ORDERED.has(dataType) : true);
    const options = props(type, allowed);
    return (
      <>
        <SelectField label={label} value={m.fn} onChange={(e) => {
          const fn = e.target.value as MeasureFn;
          const property = fn === 'count' ? undefined : m.property ?? props(type, (d) => (fn === 'sum' || fn === 'avg' ? NUMBER.has(d) : true))[0]?.value;
          set({ fn, property, as: alias(fn, property !== undefined ? lookup.properties.get(property)?.property.apiName : undefined) });
        }} options={FNS} />
        {m.fn !== 'count' ? (
          <SelectField label="Of" value={m.property ?? ''} placeholder="Choose" onChange={(e) => set({ ...m, property: e.target.value, as: alias(m.fn, lookup.properties.get(e.target.value)?.property.apiName) })} options={options} />
        ) : null}
      </>
    );
  };
  const conditions = (filters: FilterDraft[], type: ObjectType | undefined, set: (filters: FilterDraft[]) => void) => (
    <div className={styles.conditions}>
      {filters.map((f, i) => {
        const dataType = lookup.properties.get(f.property)?.property.dataType;
        const op = OPS.find((o) => o.value === f.op);
        const update = (next: FilterDraft) => set(filters.map((x, j) => (j === i ? next : x)));
        return (
          <div key={i} className={styles.condition} role="group" aria-label={`Condition ${i + 1}`}>
            <SelectField label="Where" value={f.property} onChange={(e) => update({ ...f, property: e.target.value })} options={props(type)} />
            <SelectField label="It" value={f.op} onChange={(e) => {
              const next = e.target.value as FilterOp;
              update(OPS.find((o) => o.value === next)?.needs === 'none' ? { property: f.property, op: next } : { ...f, op: next, value: f.value ?? '' });
            }} options={OPS.map((o) => ({ value: o.value, label: o.label }))} />
            {op?.needs === 'value' ? (
              <TextField label="Value" type={dataType !== undefined && NUMBER.has(dataType) ? 'number' : dataType === 'date' ? 'date' : 'text'}
                value={f.value === undefined ? '' : Array.isArray(f.value) ? f.value.join(', ') : String(f.value)}
                onChange={(e) => update({ ...f, value: valueOf(e.target.value, dataType) })} />
            ) : null}
            <IconButton icon="close" label={`Remove condition ${i + 1}`} onClick={() => set(filters.filter((_, j) => j !== i))} />
          </div>
        );
      })}
      <div><Button size="sm" icon="plus" disabled={props(type).length === 0} onClick={() => set([...filters, { property: props(type)[0]!.value, op: 'eq', value: '' }])}>Add a condition</Button></div>
    </div>
  );

  switch (step.operation) {
    case 'filter': {
      const type = typeOf(step.base ?? inputType);
      return (
        <>
          <div className={styles.editor}>{fromStep}{bound}</div>
          {conditions(step.filters, type, (filters) => onChange({ ...step, filters }))}
        </>
      );
    }
    case 'traverse': {
      const links = vocabulary.filter((l) => l.fromTypeId === inputType || l.toTypeId === inputType);
      return (
        <>
          <div className={styles.editor}>
            {fromStep}
            <SelectField label="Follow" value={step.linkTypeId} onChange={(e) => onChange({ ...step, linkTypeId: e.target.value, filters: [] })}
              options={links.map((l) => ({ value: l.id, label: l.fromTypeId === inputType ? l.forwardName : l.reverseName }))} />
            {bound}
          </div>
          {conditions(step.filters, typeOf(ownType), (filters) => onChange({ ...step, filters }))}
        </>
      );
    }
    case 'derive':
      return (
        <>
          <div className={styles.editor}>{fromStep}{bound}</div>
          <fieldset className={styles.checks}>
            <legend className={styles.muted}>Values to show with each, computed where the type defines them</legend>
            {props(typeOf(inputType)).map((p) => (
              <Checkbox key={p.value} label={p.label} checked={step.properties.includes(p.value)}
                onChange={(e) => onChange({ ...step, properties: e.target.checked ? [...step.properties, p.value] : step.properties.filter((x) => x !== p.value) })} />
            ))}
          </fieldset>
        </>
      );
    case 'select':
      return (
        <div className={styles.editor}>
          {step.key.map((k, i) => (
            <TextField key={i} label={lookup.propertyName(k.property)} value={k.value === null ? '' : String(k.value)} placeholder={k.value === null ? 'Empty' : undefined}
              onChange={(e) => onChange({ ...step, key: step.key.map((x, j) => (j === i ? { ...x, value: e.target.value === '' ? null : valueOf(e.target.value, lookup.properties.get(k.property)?.property.dataType) } : x)) })} />
          ))}
          {bound}
        </div>
      );
    case 'group': {
      const type = typeOf(inputType);
      const key = step.groupBy[0];
      const keyType = key === undefined ? undefined : lookup.properties.get(key.property)?.property.dataType;
      return (
        <div className={styles.editor}>
          {fromStep}
          <SelectField label="By" value={key?.property ?? ''} placeholder="Everything at once" onChange={(e) => onChange({ ...step, groupBy: e.target.value === '' ? [] : [{ property: e.target.value }] })} options={props(type)} />
          {key !== undefined && keyType !== undefined && TIME.has(keyType) ? (
            <SelectField label="Each" value={key.bucket ?? ''} placeholder="Exact value" onChange={(e) => onChange({ ...step, groupBy: [{ property: key.property, ...(e.target.value !== '' ? { bucket: e.target.value as Unit } : {}) }] })} options={UNITS} />
          ) : null}
          {measureEditor(step.measures[0]!, type, (m) => onChange({ ...step, measures: [m, ...step.measures.slice(1)] }))}
          {bound}
        </div>
      );
    }
    case 'time_series': {
      const type = typeOf(inputType);
      return (
        <div className={styles.editor}>
          {fromStep}
          <SelectField label="Over" value={step.property} onChange={(e) => onChange({ ...step, property: e.target.value })} options={props(type, (d) => TIME.has(d))} />
          <SelectField label="Each" value={step.unit} onChange={(e) => onChange({ ...step, unit: e.target.value as Unit })} options={UNITS} />
          {measureEditor(step.measures[0]!, type, (m) => onChange({ ...step, measures: [m, ...step.measures.slice(1)] }))}
          {bound}
        </div>
      );
    }
    case 'pivot': {
      const type = typeOf(inputType);
      return (
        <div className={styles.editor}>
          {fromStep}
          <SelectField label="Rows" value={step.rows} onChange={(e) => onChange({ ...step, rows: e.target.value })} options={props(type)} />
          <SelectField label="Columns" value={step.columns} onChange={(e) => onChange({ ...step, columns: e.target.value })} options={props(type)} />
          {measureEditor(step.measure, type, (m) => onChange({ ...step, measure: m }))}
          {bound}
        </div>
      );
    }
    case 'compare': {
      const type = typeOf(typeAt(steps, step.inputs[0], lookup));
      const options = sets.map(({ p }) => ({ value: String(p), label: `${p}: ${stepWords(steps, p, lookup)}` }));
      return (
        <div className={styles.editor}>
          <SelectField label="This set" value={String(step.inputs[0])} onChange={(e) => onChange({ ...step, inputs: [Number(e.target.value), step.inputs[1]] })} options={options} />
          <SelectField label="Against" value={String(step.inputs[1])} onChange={(e) => onChange({ ...step, inputs: [step.inputs[0], Number(e.target.value)] })} options={options} />
          {measureEditor(step.measures[0]!, type, (m) => onChange({ ...step, measures: [m, ...step.measures.slice(1)] }))}
          {bound}
        </div>
      );
    }
  }
}

