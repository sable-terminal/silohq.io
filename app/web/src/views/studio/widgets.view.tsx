'use client';

// The widget catalogue as the runtime renders it (spec 35.5). Every data-bearing widget reads its
// set whole under the viewer's access and shows a refusal in place when the set exceeds a bound,
// never a part as if complete; a disputed or withheld value says so. Selecting a row puts it in
// the selection variable the widget names. The Clone Canvas, map, scenario control and Ask panel
// widgets are in embeds.view.tsx.

import { Fragment, useEffect, useState } from 'react';
import { Button } from '../../components/button.component.tsx';
import { Checkbox, SelectField, TextField } from '../../components/field.component.tsx';
import { EmptyState, ErrorMessage, Loading } from '../../components/states.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useQuery } from '../../data/query.data.ts';
import { useVocabulary } from '../../hooks/vocabulary.hook.ts';
import { formatNumber, plural } from '../../utils/format.util.ts';
import { ActionForm, ObjectPanel } from '../explorer/object.view.tsx';
import { ApprovalInbox as Inbox } from '../governance/approvals.view.tsx';
import { labelOf, useRows, useRuntime, useSelected, type Of, type ResultObject, type Rows } from './runtime.view.ts';
import styles from './studio.view.module.css';

function Value({ o, apiName }: { o: ResultObject; apiName: string | undefined }) {
  if (apiName === undefined) return <span className={styles.muted}>—</span>;
  if (o.disputed.includes(apiName)) return <span className={styles.muted}>Systems disagree</span>;
  if (o.masked.includes(apiName) || o.redacted.includes(apiName)) return <span className={styles.muted}>Not visible to you</span>;
  const v = o.values[apiName];
  return v === null || v === undefined ? <span className={styles.muted}>—</span> : <>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</>;
}

/** Why a widget's set has no answer: still reading, refused at a bound, or failed. */
export function Unanswered({ rows }: { rows: Exclude<Rows, { state: 'answer' }> }) {
  if (rows.state === 'loading') return <Loading label="Reading" block={false} />;
  if (rows.state === 'refusal') return <p className={styles.muted} role="status">Not shown: {rows.reason}</p>;
  return <ErrorMessage error={rows.error} />;
}

const apiOf = (rows: Extract<Rows, { state: 'answer' }>, identityId: string | undefined) =>
  identityId === undefined ? undefined : rows.columns.find((c) => c.property === identityId)?.apiName;

export function ObjectTable({ w }: { w: Of<'objectTable'> }) {
  const r = useRuntime();
  const rows = useRows(w.source, w.columns, r.refreshOf(w.id));
  const { lookup } = useVocabulary();
  if (rows.state !== 'answer') return <Unanswered rows={rows} />;
  const into = w.emits?.selectionChanged;
  const picked = new Set(into === undefined ? [] : r.selections[into] ?? []);
  return (
    <div className={styles.tableWrap}>
      <table className={styles.dataTable}>
        <caption className={styles.muted}>{plural(rows.total, 'object')}{rows.reduced ? '; some values are not visible to you' : ''}</caption>
        <thead><tr>{w.columns.map((c) => <th key={c} scope="col">{lookup?.propertyName(c) ?? rows.columns.find((x) => x.property === c)?.displayName ?? 'Withheld'}</th>)}</tr></thead>
        <tbody>{rows.objects.map((o) => (
          <tr key={o.id} aria-selected={into === undefined ? undefined : picked.has(o.id)} className={picked.has(o.id) ? styles.picked : undefined}>
            {w.columns.map((c, i) => (
              <td key={c}>{i === 0 && into !== undefined
                ? <button type="button" className={styles.rowButton} onClick={() => r.emit(w, 'selectionChanged', [o.id])}><Value o={o} apiName={apiOf(rows, c)} /></button>
                : <Value o={o} apiName={apiOf(rows, c)} />}</td>
            ))}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

export function ObjectList({ w }: { w: Of<'objectList'> }) {
  const r = useRuntime();
  const rows = useRows(w.source, w.properties, r.refreshOf(w.id));
  const { lookup } = useVocabulary();
  if (rows.state !== 'answer') return <Unanswered rows={rows} />;
  if (rows.objects.length === 0) return <p className={styles.muted}>Nothing here.</p>;
  const type = lookup?.types.get(rows.objects[0]!.objectTypeId);
  const title = type === undefined ? undefined : type.properties.find((p) => p.identityId === type.titleProperty)?.apiName;
  const into = w.emits?.selectionChanged;
  const picked = new Set(into === undefined ? [] : r.selections[into] ?? []);
  return (
    <ul className={styles.listItems}>{rows.objects.map((o) => (
      <li key={o.id} className={`${styles.listItem} ${picked.has(o.id) ? styles.picked : ''}`}>
        {into !== undefined
          ? <button type="button" className={styles.rowButton} aria-pressed={picked.has(o.id)} onClick={() => r.emit(w, 'selectionChanged', [o.id])}><Value o={o} apiName={title} /></button>
          : <strong><Value o={o} apiName={title} /></strong>}
        {w.properties.length > 0 ? (
          <dl className={styles.facts}>{w.properties.map((p) => <Fragment key={p}><dt>{lookup?.propertyName(p) ?? 'Withheld'}</dt><dd><Value o={o} apiName={apiOf(rows, p)} /></dd></Fragment>)}</dl>
        ) : null}
      </li>
    ))}</ul>
  );
}

export function PropertyList({ w }: { w: Of<'propertyList'> }) {
  const selected = useSelected(w.source);
  const { lookup } = useVocabulary();
  const read = useQuery('readObjectView', selected === undefined ? null : { body: { objectTypeId: selected.objectTypeId, object: { objectId: selected.objectId } } });
  if (selected === undefined) return <p className={styles.muted}>Choose an object to see its properties.</p>;
  if (read.data === undefined) return read.status === 'error' ? <ErrorMessage error={read.error} onRetry={read.refetch} /> : <Loading label="Reading it" block={false} />;
  if (read.data.outcome !== 'object') return <p className={styles.muted}>{read.data.outcome === 'refusal' ? read.data.refusal.reason : 'There is no such object, or none you may see.'}</p>;
  const view = read.data.view;
  return (
    <dl className={styles.facts}>{w.properties.map((id) => {
      const p = view.properties.find((x) => x.identityId === id);
      return (
        <Fragment key={id}>
          <dt>{p?.displayName ?? lookup?.propertyName(id) ?? 'Withheld'}</dt>
          <dd>{p === undefined ? <span className={styles.muted}>Not visible to you</span> : p.state === 'disputed' ? <span className={styles.muted}>Systems disagree</span>
            : p.value === null || p.value === undefined ? '—' : typeof p.value === 'object' ? JSON.stringify(p.value) : String(p.value)}</dd>
        </Fragment>
      );
    })}</dl>
  );
}

export function ObjectViewEmbed({ w }: { w: Of<'objectViewEmbed'> }) {
  const selected = useSelected(w.source);
  if (selected === undefined) return <p className={styles.muted}>Choose an object to open it here.</p>;
  return <ObjectPanel key={selected.objectId} address={selected} />;
}

type Aggregate = 'count' | 'sum' | 'avg' | 'min' | 'max';
const AGGREGATE: Record<Aggregate, string> = { count: 'Count', sum: 'Total', avg: 'Average', min: 'Lowest', max: 'Highest' };

function aggregate(rows: Extract<Rows, { state: 'answer' }>, fn: Aggregate, apiName: string | undefined): number | undefined {
  if (fn === 'count') return rows.total;
  if (apiName === undefined) return undefined;
  const numbers = rows.objects.filter((o) => !o.disputed.includes(apiName)).map((o) => Number(o.values[apiName])).filter((n) => Number.isFinite(n));
  if (numbers.length === 0) return undefined;
  if (fn === 'sum') return numbers.reduce((a, b) => a + b, 0);
  if (fn === 'avg') return numbers.reduce((a, b) => a + b, 0) / numbers.length;
  return fn === 'min' ? Math.min(...numbers) : Math.max(...numbers);
}

export function Metric({ w }: { w: Of<'metric'> }) {
  const r = useRuntime();
  const rows = useRows(w.source, w.property === undefined ? [] : [w.property], r.refreshOf(w.id));
  const { lookup } = useVocabulary();
  if (w.functionId !== undefined) return <p className={styles.muted}>A metric from a Function is shown where its Function runs; it is not computed in the browser.</p>;
  if (rows.state !== 'answer') return <Unanswered rows={rows} />;
  const apiName = apiOf(rows, w.property);
  const value = aggregate(rows, w.aggregate, apiName);
  const disputed = apiName === undefined ? 0 : rows.objects.filter((o) => o.disputed.includes(apiName)).length;
  return (
    <figure className={styles.metric}>
      <p className={styles.metricValue}>{value === undefined ? '—' : formatNumber(value, 2)}</p>
      <figcaption className={styles.muted}>
        {w.aggregate === 'count' ? 'objects' : `${AGGREGATE[w.aggregate].toLowerCase()} of ${lookup?.propertyName(w.property ?? '') ?? 'a property'}`}
        {disputed > 0 ? `; ${plural(disputed, 'disputed value')} left out` : ''}
      </figcaption>
    </figure>
  );
}

export function Chart({ w }: { w: Of<'chart'> }) {
  const r = useRuntime();
  const select = [...(w.groupBy === undefined ? [] : [w.groupBy]), ...(w.measure.property === undefined ? [] : [w.measure.property])];
  const rows = useRows(w.source, select, r.refreshOf(w.id));
  const { lookup } = useVocabulary();
  if (rows.state !== 'answer') return <Unanswered rows={rows} />;
  const groupApi = apiOf(rows, w.groupBy);
  const measureApi = apiOf(rows, w.measure.property);
  const groups = new Map<string, ResultObject[]>();
  for (const o of rows.objects) {
    const key = groupApi === undefined ? 'All' : o.disputed.includes(groupApi) ? 'Systems disagree' : String(o.values[groupApi] ?? 'None');
    groups.set(key, [...(groups.get(key) ?? []), o]);
  }
  const bars = [...groups.entries()].map(([label, objects]) => ({ label, value: aggregate({ ...rows, objects, total: objects.length }, w.measure.aggregate, measureApi) ?? 0 }))
    .sort((a, b) => b.value - a.value).slice(0, 20);
  const max = Math.max(...bars.map((b) => b.value), 1);
  const measure = w.measure.aggregate === 'count' ? 'Objects' : `${AGGREGATE[w.measure.aggregate]} of ${lookup?.propertyName(w.measure.property ?? '') ?? 'a property'}`;
  return (
    <table className={styles.bars}>
      <caption className={styles.muted}>{measure}{w.groupBy !== undefined ? ` by ${lookup?.propertyName(w.groupBy) ?? 'a property'}` : ''}{groups.size > 20 ? `; the 20 largest of ${groups.size}` : ''}</caption>
      <tbody>{bars.map((b) => (
        <tr key={b.label}>
          <th scope="row">{w.groupBy !== undefined ? <button type="button" className={styles.rowButton} onClick={() => r.emit(w, 'elementSelected')}>{b.label}</button> : b.label}</th>
          <td className={styles.barCell}><meter className={styles.bar} min={0} max={max} value={b.value} aria-label={`${b.label}: ${formatNumber(b.value, 2)}`} /></td>
          <td className={styles.number}>{formatNumber(b.value, 2)}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}

export function FilterControls({ w }: { w: Of<'filterControls'> }) {
  const r = useRuntime();
  const rows = useRows(w.target, w.facets, r.refreshOf(w.id));
  const { lookup } = useVocabulary();
  const current = r.narrowing[w.target] ?? { facets: {}, search: '' };
  // The values each facet takes, counted over the whole set before it is narrowed.
  const [base, setBase] = useState<Extract<Rows, { state: 'answer' }> | undefined>();
  const unnarrowed = Object.values(current.facets).every((v) => v === null) && current.search === '';
  useEffect(() => {
    if (rows.state === 'answer' && unnarrowed) setBase(rows);
  }, [rows, unnarrowed]);
  const set = (facets: Record<string, string | null>, search: string) => {
    r.setNarrowing(w.target, { facets, search });
    r.emit(w, 'changed');
  };
  if (rows.state !== 'answer' && base === undefined) return <Unanswered rows={rows as Exclude<Rows, { state: 'answer' }>} />;
  return (
    <form className={styles.fields} onSubmit={(e) => e.preventDefault()} aria-label="Filters">
      {w.search ? <TextField label="Search" type="search" value={current.search} onChange={(e) => set(current.facets, e.target.value)} /> : null}
      {w.facets.map((id) => {
        const apiName = base === undefined ? undefined : apiOf(base, id);
        const counts = new Map<string, number>();
        for (const o of base?.objects ?? []) {
          if (apiName === undefined || o.disputed.includes(apiName) || o.values[apiName] == null) continue;
          const v = String(o.values[apiName]);
          counts.set(v, (counts.get(v) ?? 0) + 1);
        }
        return (
          <SelectField key={id} label={lookup?.propertyName(id) ?? 'Withheld'} value={current.facets[id] ?? ''} placeholder="Any"
            onChange={(e) => set({ ...current.facets, [id]: e.target.value === '' ? null : e.target.value }, current.search)}
            options={[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => ({ value: v, label: `${v} (${formatNumber(n)})` }))} />
        );
      })}
      {!unnarrowed ? <Button variant="ghost" onClick={() => set({}, '')}>Clear</Button> : null}
    </form>
  );
}

/** A parameter variable's control, shown above the page for each parameter the app declares. */
export function ParameterControl({ name }: { name: string }) {
  const r = useRuntime();
  const v = r.definition.variables[name];
  if (v === undefined || v.kind !== 'parameter') return null;
  const value = r.parameters[name] ?? null;
  const label = labelOf(name);
  if (v.type === 'boolean') return <Checkbox label={label} checked={value === true} onChange={(e) => r.setParameter(name, e.target.checked)} />;
  if (v.type === 'enumeration') {
    return <SelectField label={label} value={value === null ? '' : String(value)} placeholder="Any" onChange={(e) => r.setParameter(name, e.target.value === '' ? null : e.target.value)}
      options={(v.options ?? []).map((o) => ({ value: o, label: o }))} />;
  }
  return (
    <TextField label={label} type={v.type === 'number' ? 'number' : v.type === 'date' ? 'date' : 'text'} value={value === null ? '' : String(value)}
      onChange={(e) => r.setParameter(name, e.target.value === '' ? null : v.type === 'number' ? Number(e.target.value) : e.target.value)} />
  );
}

/** An Action over the selected object: its form as the object view gives it (criteria checked, the target its record). */
export function AppActionForm({ actionTypeId, objectTypeId, objectId, onProposed }: {
  actionTypeId: string; objectTypeId: string | undefined; objectId: string | undefined; onProposed?: (() => void) | undefined;
}) {
  const read = useQuery('readObjectView', objectId === undefined || objectTypeId === undefined ? null : { body: { objectTypeId, object: { objectId } } });
  if (objectId === undefined || objectTypeId === undefined) return <p className={styles.muted}>Choose an object first.</p>;
  if (read.data === undefined) return read.status === 'error' ? <ErrorMessage error={read.error} onRetry={read.refetch} /> : <Loading label="Reading it" block={false} />;
  if (read.data.outcome !== 'object') return <p className={styles.muted}>The object could not be read for you.</p>;
  const action = read.data.view.actions?.find((a) => a.actionTypeId === actionTypeId);
  if (action === undefined) return <p className={styles.muted}>This Action is not available to you on this object.</p>;
  if (action.state === 'criteria_failed') return <p className={styles.muted}>Not available on this object: {action.criterion}</p>;
  if (action.target === null) return <p className={styles.muted}>This object has no record the Action can write to.</p>;
  return <ActionForm action={action} target={action.target} onProposed={onProposed} />;
}

export function ActionWidget({ w, disabled }: { w: Of<'actionForm'> | Of<'actionButton'>; disabled: string | undefined }) {
  const r = useRuntime();
  const [opened, setOpened] = useState(w.kind === 'actionForm');
  const source = Object.values(w.params)[0];
  const variable = source === undefined ? undefined : r.definition.variables[source];
  const objectTypeId = variable !== undefined && variable.kind === 'selection' ? variable.objectTypeId : undefined;
  const objectId = source === undefined ? undefined : r.selections[source]?.[0];
  const label = w.kind === 'actionButton' ? w.label : 'Open the form';
  if (disabled !== undefined) return <Button blocked={disabled}>{label}</Button>;
  if (!opened) {
    return <Button variant="primary" icon="play" blocked={objectId === undefined ? 'Choose an object first' : undefined} onClick={() => {
      setOpened(true);
      r.emit(w, 'clicked');
    }}>{label}</Button>;
  }
  return <AppActionForm actionTypeId={w.actionTypeId} objectTypeId={objectTypeId} objectId={objectId} onProposed={() => r.emit(w, 'submitted')} />;
}

export function Timeline({ w }: { w: Of<'timeline'> }) {
  const selected = useSelected(w.source);
  const commits = useQuery('listObjectCommits', selected === undefined ? null : { params: { objectId: selected.objectId }, query: {} });
  if (selected === undefined) return <p className={styles.muted}>Choose an object to see its changes.</p>;
  if (commits.data === undefined) return commits.status === 'error' ? <ErrorMessage error={commits.error} onRetry={commits.refetch} /> : <Loading label="Reading its changes" block={false} />;
  if (commits.data.commits.length === 0) return <p className={styles.muted}>No change made through Silo yet.</p>;
  return (
    <ol className={styles.plainList}>{commits.data.commits.map((c) => (
      <li key={c.id}><Time value={c.committedAt} exact />: {c.fieldsChanged.join(', ') || 'no fields'} <span className={styles.muted}>{c.outcome.replaceAll('_', ' ')}</span></li>
    ))}</ol>
  );
}

/** Static text: {{label:<objectTypeId>}} and {{count:<variable>}} filled in; never a property value (35.5). */
export function Markdown({ w }: { w: Of<'markdown'> }) {
  const { lookup } = useVocabulary();
  const counts = [...new Set([...w.text.matchAll(/\{\{count:([a-zA-Z0-9_]+)\}\}/g)].map((m) => m[1]!))];
  return <WithCounts text={w.text} variables={counts} label={(id) => lookup?.typeName(id, true) ?? 'objects'} />;
}

function Count({ variable, children }: { variable: string; children: (n: number | undefined) => React.ReactNode }) {
  const rows = useRows(variable, []);
  return <>{children(rows.state === 'answer' ? rows.total : undefined)}</>;
}

function WithCounts({ text, variables, label }: { text: string; variables: string[]; label: (id: string) => string }) {
  if (variables.length > 0) {
    const [first, ...rest] = variables;
    return <Count variable={first!}>{(n) => <WithCounts text={text.replaceAll(`{{count:${first}}}`, n === undefined ? '…' : formatNumber(n))} variables={rest} label={label} />}</Count>;
  }
  const filled = text.replace(/\{\{label:([0-9a-f-]{36})\}\}/g, (_m, id: string) => label(id));
  return (
    <div className={styles.prose}>{filled.split(/\n{2,}/).map((block, i) => {
      if (block.startsWith('## ')) return <h3 key={i}>{block.slice(3)}</h3>;
      if (block.startsWith('# ')) return <h2 key={i}>{block.slice(2)}</h2>;
      if (block.split('\n').every((l) => l.startsWith('- '))) return <ul key={i}>{block.split('\n').map((l, j) => <li key={j}>{l.slice(2)}</li>)}</ul>;
      return <p key={i}>{block}</p>;
    })}</div>
  );
}

export function ApprovalInbox() {
  return <Inbox forMe chainParam="approval" />;
}

/** A widget whose kind this client does not know: said, never guessed at. */
export function UnknownWidget({ kind }: { kind: string }) {
  return <EmptyState icon="info" title="Not shown here">A {kind} widget is not drawn by this version of the web client.</EmptyState>;
}
