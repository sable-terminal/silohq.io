'use client';

// The archetypes drawn (spec 31.3, 31.6): each from the one result object, in SVG with sizes as
// attributes (never a style attribute), marks neutral, the accent marking only what is selected,
// and an outlier marked with a sign and a word as well as colour. Every element can be selected
// from the keyboard, and selecting one is the first of the three moves (31.5). Nothing animates.

import Link from 'next/link';
import { useId, useMemo, type KeyboardEvent, type ReactNode } from 'react';
import { layout } from '../canvas/layouts.canvas.ts';
import { objectHref } from '../navigation/links.navigation.ts';
import { formatNumber, plural } from '../utils/format.util.ts';
import { formatValue, type DataType } from '../utils/value.util.ts';
import { measureName, type Names } from './prose.result.ts';
import type { Archetype, Result, Shape } from './structure.result.ts';
import styles from './result.result.module.css';

export interface ChartProps {
  result: Result;
  shape: Shape;
  names: Names;
  /** The selected element: a group's key as JSON, or an object's id. */
  selected: string | undefined;
  onSelect: (key: string) => void;
  /** Drawn at tile size: fewer labels, the first rows only. */
  compact?: boolean;
}

export const keyOfGroup = (key: Record<string, unknown>) => JSON.stringify(key);
const W = 640;

/** An element the keyboard can select: Enter or Space, as a button. */
function selectable(key: string, label: string, onSelect: (key: string) => void, selected: boolean) {
  return {
    role: 'button', tabIndex: 0, 'aria-label': label, 'aria-pressed': selected,
    onClick: () => onSelect(key),
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelect(key);
      }
    },
  } as const;
}

const keyText = (result: Result, key: Record<string, unknown>) => Object.entries(key).map(([api, v]) => {
  const column = result.columns.find((c) => c.apiName === api);
  return v === null || v === undefined ? 'None' : formatValue(column?.dataType as DataType | undefined, v);
}).join(' · ');

/** Groups with their first measure: the rows of a ranking, a series and a composition. */
function measured(result: Result) {
  const m = result.measures[0];
  return result.page.groups.map((g) => ({ key: keyOfGroup(g.key), label: keyText(result, g.key), raw: g.key, value: m === undefined ? null : g.measures[m.as] ?? null }));
}

function Frame({ caption, children, note }: { caption: string; children: ReactNode; note?: ReactNode }) {
  return (
    <figure className={styles.figure}>
      {children}
      <figcaption className={styles.caption}>{caption}{note !== undefined ? <> {note}</> : null}</figcaption>
    </figure>
  );
}

export function FigureView({ result, names }: ChartProps) {
  const m = result.measures[0]!;
  const value = result.page.groups[0]?.measures[m.as] ?? null;
  return (
    <figure className={styles.single}>
      <p className={styles.singleValue}>{formatNumber(value, 2)}</p>
      <figcaption className={styles.caption}>{measureName(m, names)}, over {plural(result.page.groups[0]?.objects ?? 0, 'object')}</figcaption>
    </figure>
  );
}

export function RankingView({ result, names, selected, onSelect, compact }: ChartProps) {
  const rows = useMemo(() => {
    if (result.kind === 'groups') return measured(result).filter((r) => r.value !== null).sort((a, b) => b.value! - a.value!);
    return [];
  }, [result]);
  const objectRows = useMemo(() => {
    if (result.kind !== 'objects') return [];
    const n = result.columns.find((c) => ['integer', 'decimal', 'money', 'duration'].includes(c.dataType) && c.effect === 'allow');
    const title = result.columns.find((c) => c !== n);
    if (n === undefined) return [];
    return result.page.objects.filter((o) => typeof o.values[n.apiName] === 'number' && !o.disputed.includes(n.apiName))
      .map((o) => ({ key: o.id, label: title !== undefined ? formatValue(title.dataType as DataType, o.values[title.apiName]) : o.id.slice(0, 8), value: o.values[n.apiName] as number }))
      .sort((a, b) => b.value - a.value);
  }, [result]);
  const all = result.kind === 'groups' ? rows.map((r) => ({ key: r.key, label: r.label, value: r.value! })) : objectRows;
  const shown = all.slice(0, compact ? 6 : 25);
  const max = Math.max(...shown.map((r) => Math.abs(r.value)), 1);
  const rowH = 24;
  const caption = result.kind === 'groups' ? `${measureName(result.measures[0]!, names)}, highest first` : 'Highest first';
  return (
    <Frame caption={caption} note={all.length > shown.length ? `The ${shown.length} highest of ${formatNumber(all.length)}; all of them in Data.` : undefined}>
      <svg viewBox={`0 0 ${W} ${shown.length * rowH + 8}`} className={styles.svg} role="group" aria-label={caption}>
        {shown.map((r, i) => {
          const width = Math.max(1, ((W - 260) * Math.abs(r.value)) / max);
          const on = selected === r.key;
          return (
            <g key={r.key} transform={`translate(0 ${i * rowH + 4})`} className={styles.element} {...selectable(r.key, `${r.label}: ${formatNumber(r.value, 2)}`, onSelect, on)}>
              <text x={170} y={15} textAnchor="end" className={styles.label}>{r.label.length > 26 ? `${r.label.slice(0, 25)}…` : r.label}</text>
              <rect x={178} y={3} height={16} width={width} className={on ? styles.markOn : styles.mark} />
              <text x={184 + width} y={15} className={styles.number}>{formatNumber(r.value, 2)}</text>
            </g>
          );
        })}
      </svg>
    </Frame>
  );
}

export function SeriesView({ result, shape, names, selected, onSelect, compact }: ChartProps) {
  const time = shape.time!;
  const points = useMemo(() => {
    if (result.kind === 'groups') {
      return measured(result).map((r) => ({ key: r.key, label: r.label, t: Date.parse(String(r.raw[time.apiName] ?? '')), value: r.value }));
    }
    const n = shape.number!;
    return result.page.objects.filter((o) => !o.disputed.includes(n.apiName)).map((o) => ({
      key: o.id, label: formatValue(time.dataType as DataType, o.values[time.apiName]), t: Date.parse(String(o.values[time.apiName] ?? '')),
      value: typeof o.values[n.apiName] === 'number' ? o.values[n.apiName] as number : null,
    }));
  }, [result, shape, time]);
  const valid = points.filter((p): p is typeof p & { value: number } => !Number.isNaN(p.t) && p.value !== null).sort((a, b) => a.t - b.t);
  const H = compact ? 160 : 240;
  const pad = { l: 56, r: 16, t: 12, b: 28 };
  const t0 = valid[0]?.t ?? 0;
  const t1 = valid.at(-1)?.t ?? 1;
  const lo = Math.min(0, ...valid.map((p) => p.value));
  const hi = Math.max(...valid.map((p) => p.value), lo + 1);
  const x = (t: number) => pad.l + ((W - pad.l - pad.r) * (t - t0)) / Math.max(1, t1 - t0);
  const y = (v: number) => H - pad.b - ((H - pad.t - pad.b) * (v - lo)) / (hi - lo);
  const measure = result.kind === 'groups' ? measureName(result.measures[0]!, names) : shape.number!.displayName;
  const caption = `${measure} over ${time.displayName.toLowerCase()}`;
  const missing = points.length - valid.length;
  return (
    <Frame caption={caption} note={missing > 0 ? `${plural(missing, 'point')} without a value or a time ${missing === 1 ? 'is' : 'are'} not drawn.` : undefined}>
      <svg viewBox={`0 0 ${W} ${H}`} className={styles.svg} role="group" aria-label={caption}>
        <line x1={pad.l} y1={H - pad.b} x2={W - pad.r} y2={H - pad.b} className={styles.axis} />
        <line x1={pad.l} y1={pad.t} x2={pad.l} y2={H - pad.b} className={styles.axis} />
        <text x={pad.l - 6} y={pad.t + 10} textAnchor="end" className={styles.label}>{formatNumber(hi, 2)}</text>
        <text x={pad.l - 6} y={H - pad.b} textAnchor="end" className={styles.label}>{formatNumber(lo, 2)}</text>
        {valid.length > 0 ? <text x={pad.l} y={H - 8} className={styles.label}>{valid[0]!.label}</text> : null}
        {valid.length > 1 ? <text x={W - pad.r} y={H - 8} textAnchor="end" className={styles.label}>{valid.at(-1)!.label}</text> : null}
        <polyline points={valid.map((p) => `${x(p.t)},${y(p.value)}`).join(' ')} className={styles.line} />
        {valid.map((p) => {
          const on = selected === p.key;
          return (
            <circle key={p.key} cx={x(p.t)} cy={y(p.value)} r={on ? 6 : 4} className={[styles.element, on ? styles.markOn : styles.mark].join(' ')}
              {...selectable(p.key, `${p.label}: ${formatNumber(p.value, 2)}`, onSelect, on)} />
          );
        })}
      </svg>
    </Frame>
  );
}

/** Values beyond 1.5 interquartile ranges of the middle half: the outliers a distribution marks. */
function fences(values: number[]): { low: number; high: number } {
  const s = [...values].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]!;
  const iqr = q(0.75) - q(0.25);
  return { low: q(0.25) - 1.5 * iqr, high: q(0.75) + 1.5 * iqr };
}

export function DistributionView({ result, shape, selected, onSelect, compact }: ChartProps) {
  const n = shape.number!;
  const title = result.columns.find((c) => c !== n);
  const items = result.page.objects.filter((o) => typeof o.values[n.apiName] === 'number' && !o.disputed.includes(n.apiName))
    .map((o) => ({ key: o.id, label: title !== undefined ? formatValue(title.dataType as DataType, o.values[title.apiName]) : o.id.slice(0, 8), value: o.values[n.apiName] as number }));
  const values = items.map((i) => i.value);
  const { low, high } = fences(values);
  const min = Math.min(...values);
  const max = Math.max(...values, min + 1);
  const bins = compact ? 10 : 20;
  const width = (max - min) / bins;
  const counts = new Array<number>(bins).fill(0);
  for (const v of values) counts[Math.min(bins - 1, Math.floor((v - min) / width))]! += 1;
  const H = compact ? 140 : 200;
  const pad = { l: 40, r: 16, t: 12, b: 28 };
  const top = Math.max(...counts, 1);
  const bw = (W - pad.l - pad.r) / bins;
  const outliers = items.filter((i) => i.value < low || i.value > high).sort((a, b) => b.value - a.value);
  const caption = `${n.displayName} across ${plural(values.length, 'object')}`;
  return (
    <Frame caption={caption} note={outliers.length > 0 ? `${plural(outliers.length, 'outlier')}, beyond one and a half times the spread of the middle half, marked ▲.` : 'No outliers.'}>
      <svg viewBox={`0 0 ${W} ${H}`} className={styles.svg} role="group" aria-label={caption}>
        {counts.map((c, i) => {
          const h = ((H - pad.t - pad.b) * c) / top;
          const from = min + i * width;
          return <rect key={i} x={pad.l + i * bw + 1} y={H - pad.b - h} width={Math.max(1, bw - 2)} height={h} className={styles.mark}><title>{`${formatNumber(from, 2)} to ${formatNumber(from + width, 2)}: ${c}`}</title></rect>;
        })}
        <line x1={pad.l} y1={H - pad.b} x2={W - pad.r} y2={H - pad.b} className={styles.axis} />
        <text x={pad.l} y={H - 8} className={styles.label}>{formatValue(n.dataType as DataType, min)}</text>
        <text x={W - pad.r} y={H - 8} textAnchor="end" className={styles.label}>{formatValue(n.dataType as DataType, max)}</text>
        <text x={pad.l - 6} y={pad.t + 10} textAnchor="end" className={styles.label}>{top}</text>
        {outliers.map((o) => {
          const on = selected === o.key;
          const cx = pad.l + ((W - pad.l - pad.r) * (o.value - min)) / (max - min);
          return (
            <text key={o.key} x={cx} y={H - pad.b + 2} textAnchor="middle" className={[styles.element, on ? styles.outlierOn : styles.outlier].join(' ')}
              {...selectable(o.key, `Outlier ${o.label}: ${formatValue(n.dataType as DataType, o.value)}`, onSelect, on)}>▲</text>
          );
        })}
      </svg>
      {outliers.length > 0 && !compact ? (
        <ul className={styles.outliers} aria-label="Outliers">
          {outliers.slice(0, 10).map((o) => <li key={o.key}><span aria-hidden="true">▲ </span><Link href={objectHref({ objectTypeId: result.page.objects.find((x) => x.id === o.key)!.objectTypeId, objectId: o.key }) as never}>{o.label}</Link> {formatValue(n.dataType as DataType, o.value)}</li>)}
        </ul>
      ) : null}
    </Frame>
  );
}

export function CompositionView({ result, names, selected, onSelect }: ChartProps) {
  const parts = measured(result).filter((p) => p.value !== null && p.value > 0).sort((a, b) => b.value! - a.value!);
  const total = parts.reduce((s, p) => s + p.value!, 0);
  const caption = `${measureName(result.measures[0]!, names)}: the parts of ${formatNumber(total, 2)}`;
  let at = 0;
  return (
    <Frame caption={caption}>
      <svg viewBox={`0 0 ${W} 36`} className={styles.svg} role="group" aria-label={caption}>
        {parts.map((p, i) => {
          const w = (W * p.value!) / total;
          const x = at;
          at += w;
          const on = selected === p.key;
          return (
            <rect key={p.key} x={x} y={4} width={Math.max(1, w - 2)} height={28} className={[styles.element, on ? styles.markOn : i % 2 === 0 ? styles.mark : styles.markAlt].join(' ')}
              {...selectable(p.key, `${p.label}: ${formatNumber(p.value!, 2)}, ${formatNumber((100 * p.value!) / total, 1)}%`, onSelect, on)} />
          );
        })}
      </svg>
      <ol className={styles.parts}>
        {parts.map((p) => <li key={p.key} className={selected === p.key ? styles.partOn : undefined}><span>{p.label}</span> <span className={styles.numeric}>{formatNumber(p.value!, 2)} ({formatNumber((100 * p.value!) / total, 1)}%)</span></li>)}
      </ol>
    </Frame>
  );
}

/** Comparison (31.3): the measure two systems should agree on, with every object they disagree on shown as theirs, never averaged. */
export function ComparisonView({ result, shape, selected, onSelect }: ChartProps) {
  const c = shape.disputed!;
  const title = result.columns.find((x) => x !== c);
  const sources = result.lineage.find((l) => l.node === c.node && l.propertyIdentityId === c.property)?.sources ?? [];
  const disagree = result.page.objects.filter((o) => o.disputed.includes(c.apiName));
  return (
    <Frame caption={`${c.displayName}: ${plural(sources.length, 'system')} hold it, and disagree on ${plural(disagree.length, 'object')}`}>
      <table className={styles.compare} aria-label={`${c.displayName}, where the systems disagree`}>
        <thead><tr><th scope="col">{title?.displayName ?? 'Object'}</th><th scope="col">{c.displayName}</th><th scope="col"><span className="visually-hidden">Open</span></th></tr></thead>
        <tbody>
          {disagree.map((o) => (
            <tr key={o.id} aria-selected={selected === o.id} className={selected === o.id ? styles.rowOn : undefined}>
              <th scope="row"><button type="button" className={styles.rowButton} onClick={() => onSelect(o.id)}>{title !== undefined ? formatValue(title.dataType as DataType, o.values[title.apiName]) : o.id.slice(0, 8)}</button></th>
              <td><span aria-hidden="true">≠ </span>The systems disagree</td>
              <td><Link href={objectHref({ objectTypeId: o.objectTypeId, objectId: o.id }) as never}>See each system&rsquo;s value</Link></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Frame>
  );
}

/** Chain, hierarchy and network (31.3): rows and the edges between them, placed by the canvas's own layouts. */
export function GraphView({ result, shape, selected, onSelect, archetype }: ChartProps & { archetype: Extract<Archetype, 'chain' | 'hierarchy' | 'network'> }) {
  const title = result.columns[0];
  const arrow = `arrow${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const placed = useMemo(() => {
    const ids = [...new Set(shape.edges.flat())];
    const index = new Map(ids.map((id, i) => [id, i]));
    const out = layout({
      kind: archetype === 'network' ? 'graph_force' : archetype === 'hierarchy' ? 'hierarchy' : 'graph_layered',
      nodes: ids.map((id) => ({ id })), edges: shape.edges.map(([a, b]) => [index.get(a)!, index.get(b)!] as [number, number]),
    });
    const pts = out.positions.map((p): [number, number] => p ?? [0, 0]);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    return { ids, index, pts, x0, x1: Math.max(x1, x0 + 1), y0, y1: Math.max(y1, y0 + 1), back: new Set(out.backEdges) };
  }, [shape.edges, archetype]);
  const H = 320;
  const sx = (x: number) => 40 + ((W - 80) * (x - placed.x0)) / (placed.x1 - placed.x0);
  const sy = (y: number) => 24 + ((H - 48) * (y - placed.y0)) / (placed.y1 - placed.y0);
  const labelOf = (id: string) => {
    const o = result.page.objects.find((x) => x.id === id);
    return o !== undefined && title !== undefined ? formatValue(title.dataType as DataType, o.values[title.apiName]) : id.slice(0, 8);
  };
  const caption = `${plural(placed.ids.length, 'object')} and ${plural(shape.edges.length, 'link')} between them`;
  return (
    <Frame caption={caption}>
      <svg viewBox={`0 0 ${W} ${H}`} className={styles.svg} role="group" aria-label={caption}>
        <defs><marker id={arrow} viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" className={styles.arrow} /></marker></defs>
        {shape.edges.map(([a, b], i) => {
          const pa = placed.pts[placed.index.get(a)!]!;
          const pb = placed.pts[placed.index.get(b)!]!;
          return <line key={i} x1={sx(pa[0])} y1={sy(pa[1])} x2={sx(pb[0])} y2={sy(pb[1])} className={placed.back.has(i) ? styles.edgeBack : styles.edge} markerEnd={shape.structure.edgesDirected ? `url(#${arrow})` : undefined} />;
        })}
        {placed.ids.map((id, i) => {
          const [x, y] = placed.pts[i]!;
          const on = selected === id;
          const label = labelOf(id);
          return (
            <g key={id} transform={`translate(${sx(x)} ${sy(y)})`} className={styles.element} {...selectable(id, label, onSelect, on)}>
              <circle r={on ? 8 : 6} className={on ? styles.markOn : styles.mark} />
              <text y={-10} textAnchor="middle" className={styles.label}>{label.length > 18 ? `${label.slice(0, 17)}…` : label}</text>
            </g>
          );
        })}
      </svg>
    </Frame>
  );
}
