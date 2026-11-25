// The three history detectors (spec 38.2, 67.1): timing deviation, drift and recurrence,
// arithmetic over the transitions Siloes Capture holds for one property of a type. Like the
// federated detectors they state a fact, never a judgement; no model takes part; a finding
// names objects and carries statistics, never a record value (not even the state an object
// lingered in).
//
// Each compares an object with a population by the modified z-score of Iglewicz and Hoaglin,
// 0.6745 (x - median) / MAD, falling back to the mean absolute deviation (x - median) /
// (1.253314 * MeanAD) when the MAD is zero; with no spread at all there is nothing unusual.
// The threshold is derived from the sample the first time (3.5, or 5 under 30), persisted and
// tuned like any other (38.5).
//
// - timing deviation: how long objects stay in each state of the property, from one
//   transition to the next. An object whose stay, finished or still running, is unusually
//   long against every stay in that state is raised (once, at its longest).
// - drift: a numeric property against the object's own past. Its latest values moved steadily
//   in one direction and their median sits unusually far from the median of what came before.
// - recurrence: how often an object returns to a state it held before, against the population.

export const HISTORY_DETECTORS = ['timing_deviation', 'drift', 'recurrence'] as const;
export type HistoryDetector = (typeof HISTORY_DETECTORS)[number];
export const isHistory = (key: string): key is HistoryDetector => (HISTORY_DETECTORS as readonly string[]).includes(key);

export interface Transition {
  objectRef: string;
  previousValue: unknown;
  newValue: unknown;
  observedAt: string;
}

export interface HistoryFinding {
  objectIds: string[];
  properties: string[];
  statistic: string;
  value: number;
  threshold: number;
  sampleSize: number;
  score: number;
}

/** Fewer comparable observations than this, and a state, an object or a population is not judged. */
export const MIN_SAMPLE = 5;
/** Drift: the latest values that must have moved one way. */
export const DRIFT_RECENT = 3;

export const deriveHistoryThreshold = (sample: number): number => (sample >= 30 ? 3.5 : 5);

const round = (n: number, places = 4): number => Number(n.toFixed(places));
const key = (v: unknown): string => JSON.stringify(v ?? null);

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** The modified z-score of x against a sample; undefined when the sample has no spread. */
export function modifiedZ(x: number, sample: readonly number[]): number | undefined {
  const m = median(sample);
  const mad = median(sample.map((v) => Math.abs(v - m)));
  if (mad > 0) return (0.6745 * (x - m)) / mad;
  const meanAd = sample.reduce((s, v) => s + Math.abs(v - m), 0) / sample.length;
  return meanAd > 0 ? (x - m) / (1.253314 * meanAd) : undefined;
}

const byObject = (transitions: readonly Transition[]): Map<string, Transition[]> => {
  const out = new Map<string, Transition[]>();
  for (const t of transitions) out.set(t.objectRef, [...(out.get(t.objectRef) ?? []), t]);
  for (const list of out.values()) list.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  return out;
};

const score = (z: number, threshold: number): number => round(Math.min(1, z / (2 * threshold)));

export function timingDeviation(transitions: readonly Transition[], property: string, now: Date, thresholdOf: (sample: number) => number)
  : { findings: HistoryFinding[]; sample: number; detail: Record<string, number> } {
  const stays = new Map<string, { objectRef: string; ms: number; open: boolean }[]>();
  for (const [objectRef, list] of byObject(transitions)) {
    list.forEach((t, i) => {
      const end = i + 1 < list.length ? Date.parse(list[i + 1]!.observedAt) : now.getTime();
      const state = key(t.newValue);
      stays.set(state, [...(stays.get(state) ?? []), { objectRef, ms: Math.max(0, end - Date.parse(t.observedAt)), open: i + 1 === list.length }]);
    });
  }
  const findings = new Map<string, HistoryFinding>();
  let judged = 0;
  let thin = 0;
  for (const list of stays.values()) {
    // The population is every finished stay in the state; a running stay is judged against it.
    const finished = list.filter((s) => !s.open).map((s) => s.ms);
    if (finished.length < MIN_SAMPLE) { thin += 1; continue; }
    judged += finished.length;
    const threshold = thresholdOf(finished.length);
    for (const s of list) {
      const z = modifiedZ(s.ms, finished);
      if (z === undefined || z < threshold) continue;
      const prior = findings.get(s.objectRef);
      if (prior !== undefined && prior.value >= z) continue;
      findings.set(s.objectRef, {
        objectIds: [s.objectRef], properties: [property], statistic: s.open ? 'running_stay_modified_z' : 'stay_modified_z', value: round(z),
        threshold, sampleSize: finished.length, score: score(z, threshold),
      });
    }
  }
  return { findings: [...findings.values()], sample: judged, detail: { states: stays.size, thinStates: thin } };
}

export function drift(transitions: readonly Transition[], property: string, thresholdOf: (sample: number) => number)
  : { findings: HistoryFinding[]; sample: number; detail: Record<string, number> } {
  const findings: HistoryFinding[] = [];
  let judged = 0;
  let notNumeric = 0;
  for (const [objectRef, list] of byObject(transitions)) {
    const values = list.map((t) => (typeof t.newValue === 'number' ? t.newValue : typeof t.newValue === 'string' && t.newValue.trim() !== '' ? Number(t.newValue) : NaN));
    if (values.some((v) => !Number.isFinite(v))) { notNumeric += 1; continue; }
    const past = values.slice(0, -DRIFT_RECENT);
    const recent = values.slice(-DRIFT_RECENT);
    if (past.length < MIN_SAMPLE) continue;
    judged += 1;
    const steps = recent.slice(1).map((v, i) => v - recent[i]!);
    const steady = steps.every((d) => d > 0) || steps.every((d) => d < 0);
    const z = modifiedZ(median(recent), past);
    const threshold = thresholdOf(past.length);
    if (!steady || z === undefined || Math.abs(z) < threshold) continue;
    findings.push({
      objectIds: [objectRef], properties: [property], statistic: z > 0 ? 'drift_up_modified_z' : 'drift_down_modified_z', value: round(Math.abs(z)),
      threshold, sampleSize: past.length, score: score(Math.abs(z), threshold),
    });
  }
  return { findings, sample: judged, detail: { notNumeric } };
}

export function recurrence(transitions: readonly Transition[], property: string, thresholdOf: (sample: number) => number)
  : { findings: HistoryFinding[]; sample: number; detail: Record<string, number> } {
  const counts = new Map<string, number>();
  for (const [objectRef, list] of byObject(transitions)) {
    const held = new Set<string>(list.length > 0 ? [key(list[0]!.previousValue)] : []);
    let returns = 0;
    for (const t of list) {
      const state = key(t.newValue);
      if (held.has(state)) returns += 1;
      held.add(state);
    }
    counts.set(objectRef, returns);
  }
  const sample = [...counts.values()];
  if (sample.length < MIN_SAMPLE) return { findings: [], sample: sample.length, detail: { objects: sample.length } };
  const threshold = thresholdOf(sample.length);
  const findings: HistoryFinding[] = [];
  for (const [objectRef, returns] of counts) {
    const z = modifiedZ(returns, sample);
    if (returns < 2 || z === undefined || z < threshold) continue;
    findings.push({
      objectIds: [objectRef], properties: [property], statistic: 'recurrences_modified_z', value: round(z), threshold, sampleSize: sample.length,
      score: score(z, threshold),
    });
  }
  return { findings, sample: sample.length, detail: { objects: sample.length } };
}
