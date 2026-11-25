// Machine learning models (D240): the arithmetic, pure, with no library. A table of features is
// encoded (a number standardised, its gaps the mean; a category one-hot over its most frequent
// values and "other"; true and false as 1 and 0), and a model fitted on the rows a stable hash of
// each object's id puts in training (four in five), evaluated on the rest:
// - regression: ridge, solved in closed form (Cholesky) with the intercept unpenalised; RMSE, MAE, R²;
// - classification: multinomial logistic regression with L2, fitted by Adam over seeded mini-batches;
//   accuracy, macro F1, log loss, the confusion matrix, each class's precision and recall.
// Importance is how far each feature moves the model's score across the training population: the
// spread (standard deviation) of its contribution, a number's weight on the standardised scale and
// a category's weights spread over its training shares, so a category with many values is not
// counted once per value (D246). Drift
// compares a population with the training one, feature by feature, by the population stability
// index over the training deciles (numbers) or category shares (categories).

import { createHash } from 'node:crypto';

export type Value = string | number | boolean | null;
export type Task = 'regression' | 'classification';

export const MAX_TRAINING_ROWS = 20_000;
export const MAX_CATEGORIES = 10;
export const MAX_CLASSES = 10;
export const MAX_COLUMNS = 400;

export type FeatureEncoding =
  | { name: string; kind: 'number'; mean: number; std: number; deciles: number[]; shares: number[] }
  | { name: string; kind: 'category'; values: string[]; shares: number[] };

export interface Encoder { features: FeatureEncoding[]; columns: number }

const numberOf = (v: Value): number | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v.trim())) return Number(v);
  return undefined;
};
const empty = (v: Value) => v === null || v === '';
const categoryOf = (v: Value) => (empty(v) ? '' : String(v));

/** Whether an object is held out for testing: a stable hash of its id, one in five. */
export const heldOut = (objectId: string): boolean => createHash('sha256').update(objectId).digest()[0]! % 5 === 0;

function quantiles(sorted: readonly number[], qs: readonly number[]): number[] {
  return qs.map((q) => {
    if (sorted.length === 0) return 0;
    const at = (sorted.length - 1) * q;
    const lo = Math.floor(at);
    return sorted[lo]! + (sorted[Math.ceil(at)]! - sorted[lo]!) * (at - lo);
  });
}
const DECILES = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
const binOf = (edges: readonly number[], v: number) => { let i = 0; while (i < edges.length && v > edges[i]!) i++; return i; };

/** An encoder fitted on the training rows: each feature numeric where every value present is a number. */
export function fitEncoder(names: readonly string[], rows: readonly Value[][]): Encoder {
  const features: FeatureEncoding[] = names.map((name, f) => {
    const present = rows.map((r) => r[f] ?? null).filter((v) => !empty(v));
    const numbers = present.map(numberOf);
    if (present.length > 0 && numbers.every((n) => n !== undefined)) {
      const xs = (numbers as number[]).slice().sort((a, b) => a - b);
      const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
      const std = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, xs.length - 1)) || 1;
      const deciles = quantiles(xs, DECILES);
      const counts = new Array<number>(deciles.length + 1).fill(0);
      for (const x of xs) counts[binOf(deciles, x)]! += 1;
      return { name, kind: 'number', mean, std, deciles, shares: counts.map((c) => c / xs.length) };
    }
    const counts = new Map<string, number>();
    for (const v of rows.map((r) => categoryOf(r[f] ?? null))) counts.set(v, (counts.get(v) ?? 0) + 1);
    const values = [...counts].filter(([v]) => v !== '').sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_CATEGORIES).map(([v]) => v);
    const kept = values.map((v) => (counts.get(v) ?? 0) / Math.max(1, rows.length));
    return { name, kind: 'category', values, shares: [...kept, Math.max(0, 1 - kept.reduce((a, b) => a + b, 0))] };
  });
  const columns = features.reduce((n, e) => n + (e.kind === 'number' ? 1 : e.values.length + 1), 0);
  if (columns > MAX_COLUMNS) throw new RangeError(`the features make ${columns} columns; at most ${MAX_COLUMNS}`);
  return { features, columns };
}

export function encode(encoder: Encoder, row: readonly Value[]): Float64Array {
  const x = new Float64Array(encoder.columns);
  let at = 0;
  encoder.features.forEach((e, f) => {
    const v = row[f] ?? null;
    if (e.kind === 'number') {
      const n = numberOf(v);
      x[at++] = n === undefined ? 0 : (n - e.mean) / e.std;
    } else {
      const i = e.values.indexOf(categoryOf(v));
      x[at + (i < 0 ? e.values.length : i)] = 1;
      at += e.values.length + 1;
    }
  });
  return x;
}

/** Solves A x = b for a symmetric positive definite A (Cholesky). */
function solve(a: Float64Array[], b: Float64Array): Float64Array {
  const n = b.length;
  const l = a.map(() => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = a[i]![j]!;
      for (let k = 0; k < j; k++) sum -= l[i]![k]! * l[j]![k]!;
      if (i === j) l[i]![i] = Math.sqrt(Math.max(sum, 1e-12));
      else l[i]![j] = sum / l[j]![j]!;
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = b[i]!; for (let k = 0; k < i; k++) s -= l[i]![k]! * y[k]!; y[i] = s / l[i]![i]!; }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = y[i]!; for (let k = i + 1; k < n; k++) s -= l[k]![i]! * x[k]!; x[i] = s / l[i]![i]!; }
  return x;
}

export interface Regression { task: 'regression'; intercept: number; weights: number[]; lambda: number }
export interface Classification { task: 'classification'; classes: string[]; intercepts: number[]; weights: number[][]; lambda: number }
export type Fitted = Regression | Classification;

/** A row's non-zero columns (a one-hot row is mostly zeros), with the intercept's 1 first when asked. */
function sparse(x: Float64Array, intercept: boolean): { at: Int32Array; v: Float64Array } {
  const at: number[] = intercept ? [0] : [];
  const v: number[] = intercept ? [1] : [];
  const shift = intercept ? 1 : 0;
  for (let j = 0; j < x.length; j++) if (x[j] !== 0) { at.push(j + shift); v.push(x[j]!); }
  return { at: Int32Array.from(at), v: Float64Array.from(v) };
}

export function fitRegression(xs: readonly Float64Array[], ys: readonly number[], lambda = 1): Regression {
  const d = xs[0]?.length ?? 0;
  const n = d + 1;
  const a = Array.from({ length: n }, () => new Float64Array(n));
  const b = new Float64Array(n);
  xs.forEach((x, r) => {
    const { at, v } = sparse(x, true);
    for (let p = 0; p < at.length; p++) {
      const i = at[p]!;
      b[i]! += v[p]! * ys[r]!;
      for (let q = 0; q <= p; q++) a[i]![at[q]!]! += v[p]! * v[q]!;
    }
  });
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) a[j]![i] = a[i]![j]!;
  for (let i = 1; i < n; i++) a[i]![i]! += lambda;
  const w = solve(a, b);
  return { task: 'regression', intercept: w[0]!, weights: [...w.subarray(1)], lambda };
}

/** A small deterministic generator (mulberry32), for shuffling mini-batches the same way each time. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function softmax(z: Float64Array): Float64Array {
  let max = -Infinity;
  for (const v of z) max = Math.max(max, v);
  let sum = 0;
  const p = new Float64Array(z.length);
  for (let i = 0; i < z.length; i++) { p[i] = Math.exp(z[i]! - max); sum += p[i]!; }
  for (let i = 0; i < z.length; i++) p[i]! /= sum;
  return p;
}

export function fitClassification(xs: readonly Float64Array[], ys: readonly number[], classes: readonly string[], options: { lambda?: number; epochs?: number; batch?: number; seed?: number } = {}): Classification {
  const k = classes.length;
  const d = xs[0]?.length ?? 0;
  const lambda = options.lambda ?? 1e-3;
  const w = Array.from({ length: k }, () => new Float64Array(d + 1));
  const m = w.map(() => new Float64Array(d + 1));
  const v = w.map(() => new Float64Array(d + 1));
  const [b1, b2, rate, eps] = [0.9, 0.999, 0.05, 1e-8];
  const next = random(options.seed ?? 7);
  const order = xs.map((_, i) => i);
  const batch = options.batch ?? 256;
  const rowsOf = xs.map((x) => sparse(x, false));
  let t = 0;
  for (let epoch = 0; epoch < (options.epochs ?? 40); epoch++) {
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [order[i], order[j]] = [order[j]!, order[i]!]; }
    for (let start = 0; start < order.length; start += batch) {
      const rows = order.slice(start, start + batch);
      const g = w.map(() => new Float64Array(d + 1));
      for (const r of rows) {
        const { at, v: x } = rowsOf[r]!;
        const z = new Float64Array(k);
        for (let c = 0; c < k; c++) { let s = w[c]![0]!; for (let q = 0; q < at.length; q++) s += w[c]![at[q]! + 1]! * x[q]!; z[c] = s; }
        const p = softmax(z);
        for (let c = 0; c < k; c++) {
          const e = (p[c]! - (ys[r] === c ? 1 : 0)) / rows.length;
          g[c]![0]! += e;
          for (let q = 0; q < at.length; q++) g[c]![at[q]! + 1]! += e * x[q]!;
        }
      }
      t += 1;
      for (let c = 0; c < k; c++) {
        for (let j = 0; j <= d; j++) {
          const grad = g[c]![j]! + (j === 0 ? 0 : lambda * w[c]![j]!);
          m[c]![j] = b1 * m[c]![j]! + (1 - b1) * grad;
          v[c]![j] = b2 * v[c]![j]! + (1 - b2) * grad * grad;
          w[c]![j]! -= (rate * (m[c]![j]! / (1 - b1 ** t))) / (Math.sqrt(v[c]![j]! / (1 - b2 ** t)) + eps);
        }
      }
    }
  }
  return { task: 'classification', classes: [...classes], intercepts: w.map((c) => c[0]!), weights: w.map((c) => [...c.subarray(1)]), lambda };
}

export function predictValue(model: Regression, x: Float64Array): number {
  let s = model.intercept;
  for (let j = 0; j < x.length; j++) s += model.weights[j]! * x[j]!;
  return s;
}

export function predictClass(model: Classification, x: Float64Array): { label: string; probability: number; probabilities: number[] } {
  const z = new Float64Array(model.classes.length);
  model.weights.forEach((w, c) => { let s = model.intercepts[c]!; for (let j = 0; j < x.length; j++) s += w[j]! * x[j]!; z[c] = s; });
  const p = softmax(z);
  let best = 0;
  for (let c = 1; c < p.length; c++) if (p[c]! > p[best]!) best = c;
  return { label: model.classes[best]!, probability: p[best]!, probabilities: [...p] };
}

export interface RegressionMetrics { kind: 'regression'; rmse: number; mae: number; r2: number }
export interface ClassificationMetrics {
  kind: 'classification'; accuracy: number; macroF1: number; logLoss: number;
  classes: string[]; confusion: number[][]; precision: number[]; recall: number[];
}

export function regressionMetrics(actual: readonly number[], predicted: readonly number[]): RegressionMetrics {
  const n = Math.max(1, actual.length);
  const mean = actual.reduce((a, b) => a + b, 0) / n;
  let se = 0; let ae = 0; let st = 0;
  actual.forEach((y, i) => { se += (y - predicted[i]!) ** 2; ae += Math.abs(y - predicted[i]!); st += (y - mean) ** 2; });
  return { kind: 'regression', rmse: Math.sqrt(se / n), mae: ae / n, r2: st === 0 ? 0 : 1 - se / st };
}

export function classificationMetrics(classes: readonly string[], actual: readonly number[], probabilities: readonly number[][]): ClassificationMetrics {
  const k = classes.length;
  const confusion = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  let correct = 0; let loss = 0;
  actual.forEach((y, i) => {
    const p = probabilities[i]!;
    let best = 0;
    for (let c = 1; c < k; c++) if (p[c]! > p[best]!) best = c;
    confusion[y]![best]! += 1;
    if (best === y) correct += 1;
    loss -= Math.log(Math.max(p[y]!, 1e-15));
  });
  const precision = classes.map((_, c) => { const col = confusion.reduce((s, r) => s + r[c]!, 0); return col === 0 ? 0 : confusion[c]![c]! / col; });
  const recall = classes.map((_, c) => { const row = confusion[c]!.reduce((s, v) => s + v, 0); return row === 0 ? 0 : confusion[c]![c]! / row; });
  const f1 = classes.map((_, c) => (precision[c]! + recall[c]! === 0 ? 0 : (2 * precision[c]! * recall[c]!) / (precision[c]! + recall[c]!)));
  const n = Math.max(1, actual.length);
  return { kind: 'classification', accuracy: correct / n, macroF1: f1.reduce((a, b) => a + b, 0) / Math.max(1, k), logLoss: loss / n, classes: [...classes], confusion, precision, recall };
}

/**
 * Each feature's importance as shares of the whole: the spread of its contribution to the score over
 * the training population (a class's score, averaged over the classes). A number is standardised, so
 * its spread is its weight; a category's is the standard deviation of its values' weights, each
 * weighed by its training share, which a constant added to every value's weight does not change.
 */
export function importance(encoder: Encoder, model: Fitted): { feature: string; weight: number }[] {
  const rows = model.task === 'regression' ? [model.weights] : model.weights;
  let at = 0;
  const raw = encoder.features.map((e) => {
    const width = e.kind === 'number' ? 1 : e.values.length + 1;
    const spread = rows.reduce((total, w) => {
      if (e.kind === 'number') return total + Math.abs(w[at]!);
      let mean = 0;
      for (let i = 0; i < width; i++) mean += e.shares[i]! * w[at + i]!;
      let variance = 0;
      for (let i = 0; i < width; i++) variance += e.shares[i]! * (w[at + i]! - mean) ** 2;
      return total + Math.sqrt(variance);
    }, 0) / rows.length;
    at += width;
    return { feature: e.name, weight: spread };
  });
  const total = raw.reduce((s, r) => s + r.weight, 0) || 1;
  return raw.map((r) => ({ feature: r.feature, weight: r.weight / total })).sort((a, b) => b.weight - a.weight);
}

/** The population stability index of each feature: this population's shares against the training ones. */
export function drift(encoder: Encoder, rows: readonly Value[][]): { feature: string; psi: number; level: 'stable' | 'moderate' | 'shifted' }[] {
  return encoder.features.map((e, f) => {
    const expected = e.shares;
    const counts = new Array<number>(expected.length).fill(0);
    for (const r of rows) {
      const v = r[f] ?? null;
      if (e.kind === 'number') {
        const n = numberOf(v);
        if (n !== undefined) counts[binOf(e.deciles, n)]! += 1;
      } else {
        const i = e.values.indexOf(categoryOf(v));
        counts[i < 0 ? e.values.length : i]! += 1;
      }
    }
    const total = counts.reduce((a, b) => a + b, 0) || 1;
    const psi = expected.reduce((s, ex, i) => {
      const a = Math.max(counts[i]! / total, 1e-4);
      const b = Math.max(ex, 1e-4);
      return s + (a - b) * Math.log(a / b);
    }, 0);
    return { feature: e.name, psi, level: psi < 0.1 ? 'stable' : psi < 0.25 ? 'moderate' : 'shifted' };
  });
}
