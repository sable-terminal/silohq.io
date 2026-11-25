// A notebook's statistics and charts (D239), over a table as the reader read it. Pure: no I/O.
// A column is numeric where every value that is not empty is a number (or text that is one);
// its median and 90th percentile are interpolated between neighbours, its spread is the sample
// standard deviation. A chart reads at most MAX_POINTS rows; what it cannot draw (an x or y that is
// not a number where one is drawn) is counted as omitted, never guessed.

import type { Cell, Table } from './pipelineEngine.service.ts';

export const MAX_POINTS = 5_000;
const MAX_BARS = 50;

const isEmpty = (v: Cell) => v === null || v === '';
const numberOf = (v: Cell): number | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v.trim())) return Number(v);
  return undefined;
};

/** The q-th quantile of sorted numbers, interpolated between neighbours. */
export function quantileOf(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

export interface ColumnStats {
  name: string; count: number; empty: number; distinct: number;
  numeric: { min: number; max: number; mean: number; median: number; p90: number; stddev: number } | null;
  top: { value: Cell; count: number }[];
}

export function statsOf(table: Table, columns: readonly string[]): ColumnStats[] {
  const names = columns.length === 0 ? table.columns : columns;
  return names.map((name) => {
    const at = table.columns.indexOf(name);
    if (at < 0) throw new Error(`there is no column ${name}`);
    const values = table.rows.map((r) => r[at] ?? null);
    const present = values.filter((v) => !isEmpty(v));
    const counts = new Map<string, { value: Cell; count: number }>();
    for (const v of present) {
      const key = JSON.stringify(v);
      const seen = counts.get(key);
      if (seen) seen.count += 1; else counts.set(key, { value: v, count: 1 });
    }
    const numbers = present.map(numberOf);
    let numeric: ColumnStats['numeric'] = null;
    if (present.length > 0 && numbers.every((n) => n !== undefined)) {
      const sorted = (numbers as number[]).slice().sort((a, b) => a - b);
      const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
      const variance = sorted.length < 2 ? 0 : sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / (sorted.length - 1);
      numeric = { min: sorted[0]!, max: sorted.at(-1)!, mean, median: quantileOf(sorted, 0.5), p90: quantileOf(sorted, 0.9), stddev: Math.sqrt(variance) };
    }
    const top = [...counts.values()].sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value))).slice(0, 5);
    return { name, count: values.length, empty: values.length - present.length, distinct: counts.size, numeric, top };
  });
}

export type ChartOf =
  | { kind: 'chart'; bars: { label: string; value: number }[]; omitted: number }
  | { kind: 'chart'; points: [number, number][]; omitted: number }
  | { kind: 'chart'; bins: { from: number; to: number; count: number }[]; omitted: number };

export function chartOf(table: Table, spec: { chart: 'bar' | 'line' | 'scatter' | 'histogram'; x: string; y: string | null; bins: number }): ChartOf {
  const col = (name: string) => {
    const at = table.columns.indexOf(name);
    if (at < 0) throw new Error(`there is no column ${name}`);
    return at;
  };
  const x = col(spec.x);
  const y = spec.y === null ? undefined : col(spec.y);
  const rows = table.rows.slice(0, MAX_POINTS);
  let omitted = table.rows.length - rows.length;
  if (spec.chart === 'bar') {
    const totals = new Map<string, number>();
    for (const r of rows) {
      const label = isEmpty(r[x] ?? null) ? '(empty)' : String(r[x]);
      const add = y === undefined ? 1 : numberOf(r[y] ?? null);
      if (add === undefined) { omitted += 1; continue; }
      totals.set(label, (totals.get(label) ?? 0) + add);
    }
    const bars = [...totals].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
    return { kind: 'chart', bars: bars.slice(0, MAX_BARS), omitted: omitted + bars.slice(MAX_BARS).length };
  }
  if (spec.chart === 'histogram') {
    const values: number[] = [];
    for (const r of rows) {
      const n = numberOf(r[x] ?? null);
      if (n === undefined) omitted += 1; else values.push(n);
    }
    if (values.length === 0) return { kind: 'chart', bins: [], omitted };
    const min = Math.min(...values);
    const max = Math.max(...values);
    const width = max === min ? 1 : (max - min) / spec.bins;
    const count = max === min ? 1 : spec.bins;
    const bins = Array.from({ length: count }, (_, i) => ({ from: min + i * width, to: min + (i + 1) * width, count: 0 }));
    for (const v of values) bins[Math.min(count - 1, Math.floor((v - min) / width))]!.count += 1;
    return { kind: 'chart', bins, omitted };
  }
  if (y === undefined) throw new Error(`a ${spec.chart} chart plots a y column against x`);
  const points: [number, number][] = [];
  for (const r of rows) {
    const px = numberOf(r[x] ?? null);
    const py = numberOf(r[y] ?? null);
    if (px === undefined || py === undefined) omitted += 1; else points.push([px, py]);
  }
  if (spec.chart === 'line') points.sort((a, b) => a[0] - b[0]);
  return { kind: 'chart', points, omitted };
}
