// Probabilistic record matching (decision 2026-11-11; D74), only where the organisation turns
// resolution inference on. What exact keys and confirmed rules left apart across systems is
// compared on the properties both systems map: each candidate pair's agreement (equal after
// trimming and case folding), disagreement, or absence (a value missing on either side) is
// weighed Fellegi-Sunter fashion, with each field's agreement rates among matches (m) and
// non-matches (u) learnt from earlier inferred pairs people confirmed or rejected (priors 0.9
// and 0.1 until they have), and a prior match rate from the candidates (each record in the
// smaller system has at most one partner). Pairs at or above PROPOSE_AT are proposed as a pair
// list, one-to-one, most probable first; a person confirms or rejects them, and nothing merges
// on inference alone. Values live only in this process's memory for the run.

import { fieldWeights, matchProbability, type FieldEvidence } from '../../utils/bayes.util.ts';

export const PROPOSE_AT = 0.9;
export const MAX_PAIRS = 100;
/** Comparisons per run: candidates are blocked on a shared value, then bounded. */
export const MAX_COMPARISONS = 50_000;

export interface InferenceRecord {
  /** Its Silo object today. */
  object: string;
  /** Index of the contributing object. */
  source: number;
  /** Comparison values in field order; null where the record has none. */
  values: readonly (string | null)[];
}

export interface InferredPair {
  from: string;
  to: string;
  probability: number;
  agreement: (boolean | null)[];
}

/** A comparison value: trimmed and case-folded text, or null. */
export function comparable(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = (typeof value === 'object' ? JSON.stringify(value) : String(value)).trim().toLowerCase();
  return text.length === 0 ? null : text;
}

/** Each field's evidence from earlier decided inferred pairs: their agreement patterns and outcomes. */
export function evidenceFrom(decided: readonly { confirmed: boolean; agreement: readonly (boolean | null)[] }[], fields: number): FieldEvidence[] {
  return Array.from({ length: fields }, (_, i) => {
    const e = { matchesCompared: 0, matchesAgreeing: 0, nonMatchesCompared: 0, nonMatchesAgreeing: 0 };
    for (const d of decided) {
      const a = d.agreement[i];
      if (a === null || a === undefined) continue;
      if (d.confirmed) {
        e.matchesCompared += 1;
        if (a) e.matchesAgreeing += 1;
      } else {
        e.nonMatchesCompared += 1;
        if (a) e.nonMatchesAgreeing += 1;
      }
    }
    return e;
  });
}

/** The pairs to propose (see the header): pure, deterministic, bounded. */
export function inferPairs(records: readonly InferenceRecord[], evidence: readonly FieldEvidence[]): { pairs: InferredPair[]; compared: number } {
  const weights = evidence.map((e) => fieldWeights(e));
  // Candidates across systems that share at least one comparison value (blocking).
  const byValue = new Map<string, number[]>();
  records.forEach((r, i) => r.values.forEach((v, f) => {
    if (v !== null) byValue.set(`${f}\u0000${v}`, [...(byValue.get(`${f}\u0000${v}`) ?? []), i]);
  }));
  const seen = new Set<string>();
  const candidates: [number, number][] = [];
  for (const group of byValue.values()) {
    for (let a = 0; a < group.length && candidates.length < MAX_COMPARISONS; a++) {
      for (let b = a + 1; b < group.length && candidates.length < MAX_COMPARISONS; b++) {
        const [i, j] = [group[a]!, group[b]!];
        if (records[i]!.source === records[j]!.source || records[i]!.object === records[j]!.object) continue;
        const key = i < j ? `${i}/${j}` : `${j}/${i}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(i < j ? [i, j] : [j, i]);
      }
    }
  }
  if (candidates.length === 0) return { pairs: [], compared: 0 };
  const perSource = new Map<number, number>();
  for (const r of records) perSource.set(r.source, (perSource.get(r.source) ?? 0) + 1);
  const smaller = Math.min(...perSource.values());
  const prior = Math.min(0.5, Math.max(0.01, smaller / candidates.length));
  const scored = candidates.map(([i, j]) => {
    const agreement = records[i]!.values.map((v, f) => {
      const w = records[j]!.values[f];
      return v === null || w === null || w === undefined ? null : v === w;
    });
    return { i, j, agreement, probability: matchProbability(agreement.map((a) => (a === null ? undefined : a)), weights, prior) };
  }).sort((a, b) => b.probability - a.probability || a.i - b.i || a.j - b.j);
  // One-to-one, most probable first.
  const used = new Set<string>();
  const pairs: InferredPair[] = [];
  for (const s of scored) {
    if (s.probability < PROPOSE_AT || pairs.length >= MAX_PAIRS) break;
    const [from, to] = [records[s.i]!.object, records[s.j]!.object];
    if (used.has(from) || used.has(to)) continue;
    used.add(from);
    used.add(to);
    pairs.push({ from, to, probability: Math.round(s.probability * 10_000) / 10_000, agreement: s.agreement });
  }
  return { pairs, compared: candidates.length };
}
