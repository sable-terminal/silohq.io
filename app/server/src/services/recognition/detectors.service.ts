// The federated detectors (spec 38.2, 38.4): arithmetic over a population read through the
// executor. Each states a fact, never a judgement; no model takes part, so the same inputs,
// threshold and version give the same findings. A finding names objects by Silo object id
// and carries statistics, never a record value: a duplicate is "these three objects share
// one value of registration", never the value.
//
// Thresholds are derived from the population the first time (persisted, then reused and
// tuned only by organisation dispositions, spec 38.5). Every comparison is "at least"
// (ge): raising a threshold makes a detector raise fewer findings, so "mostly dismissed
// raises it" holds for every detector alike.
//
// The six federated detectors other than disagreement are not named by the spec (38.2,
// open decision). These four are generic facts over a population, named here until the
// v1 catalogue is carried over: missing_value, outlier, duplicate_value, unmatched_record.

import { probabilityAbove } from '../../utils/bayes.util.ts';

export const DETECTOR_VERSION = '1.0.0';

export const FEDERATED_DETECTORS = ['disagreement', 'missing_value', 'outlier', 'duplicate_value', 'unmatched_record', 'uniqueness', 'timeliness'] as const;
export type FederatedDetector = (typeof FEDERATED_DETECTORS)[number];
export const isFederated = (key: string): key is FederatedDetector => (FEDERATED_DETECTORS as readonly string[]).includes(key);

/** Does the detector keep one threshold per property, or one per object type? */
export const PER_PROPERTY: Readonly<Record<FederatedDetector, boolean>> = {
  disagreement: false, missing_value: true, outlier: true, duplicate_value: true, unmatched_record: false, uniqueness: false, timeliness: false,
};

export interface PopulationObject {
  id: string;
  /** Values by property API name. Held only for the run, in the data plane; never stored. */
  values: Record<string, unknown>;
  disputed: string[];
  unmatched: boolean;
}

export interface ExaminedProperty { apiName: string; dataType: string }

export interface RawFinding {
  objectIds: string[];
  properties: string[];
  statistic: string;
  /** A computed figure (a z-score, a fill rate, a group size), never a record value. */
  value: number;
  threshold: number;
  thresholdProperty: string | null;
  sampleSize: number;
  score: number;
}

export interface DetectorOutcome {
  findings: RawFinding[];
  /** Identifiers and counts about what was not examined, e.g. a non-numeric property for outlier. */
  detail: Record<string, number>;
}

const NUMERIC = new Set(['integer', 'decimal']);
const round = (n: number, places = 4): number => Number(n.toFixed(places));
const isEmpty = (o: PopulationObject, property: string): boolean =>
  !o.disputed.includes(property) && (o.values[property] === null || o.values[property] === undefined || o.values[property] === '');

/** The threshold a detector derives from the population it first examines (38.5). Deterministic. */
export function deriveThreshold(detector: FederatedDetector, population: number): number {
  switch (detector) {
    // Any disagreement is a fact: one disputed property is enough.
    case 'disagreement': return 1;
    // A gap is worth stating where the property is otherwise well filled; the larger the
    // population, the fuller "well filled" is (1 - 3/sqrt(N)), never below a half.
    case 'missing_value': return round(Math.max(0.5, 1 - 3 / Math.sqrt(Math.max(population, 1))));
    // The modified z-score bound of Iglewicz and Hoaglin (3.5), stricter (5) on a population under 30.
    case 'outlier': return population >= 30 ? 3.5 : 5;
    // A value shared by two objects.
    case 'duplicate_value': return 2;
    // A record that stood alone for want of a match key.
    case 'unmatched_record': return 1;
    // Two objects agreeing on every property named (decision 2026-11-14).
    case 'uniqueness': return 2;
    // An age far above the population's by the modified z-score, as for outlier, one-sided.
    case 'timeliness': return population >= 30 ? 3.5 : 5;
  }
}

export type ThresholdOf = (property: string | null) => number;

export function runDetector(detector: FederatedDetector, objects: readonly PopulationObject[], properties: readonly ExaminedProperty[],
  thresholdOf: ThresholdOf): DetectorOutcome {
  const population = objects.length;
  const findings: RawFinding[] = [];
  const detail: Record<string, number> = {};
  switch (detector) {
    case 'disagreement': {
      const threshold = thresholdOf(null);
      const names = properties.map((p) => p.apiName);
      for (const o of objects) {
        const disputed = names.filter((n) => o.disputed.includes(n));
        if (disputed.length > 0 && disputed.length >= threshold) {
          findings.push({
            objectIds: [o.id], properties: disputed, statistic: 'disputed_properties', value: disputed.length, threshold,
            thresholdProperty: null, sampleSize: names.length, score: round(disputed.length / names.length),
          });
        }
      }
      break;
    }
    case 'missing_value': {
      for (const p of properties) {
        const threshold = thresholdOf(p.apiName);
        const empty = objects.filter((o) => isEmpty(o, p.apiName));
        if (population === 0 || empty.length === 0) continue;
        const fill = round((population - empty.length) / population);
        if (fill < threshold) continue;
        for (const o of empty) {
          findings.push({
            objectIds: [o.id], properties: [p.apiName], statistic: 'fill_rate', value: fill, threshold, thresholdProperty: p.apiName,
            sampleSize: population, score: fill,
          });
        }
      }
      break;
    }
    case 'outlier': {
      for (const p of properties) {
        if (!NUMERIC.has(p.dataType)) {
          detail['notNumeric'] = (detail['notNumeric'] ?? 0) + 1;
          continue;
        }
        const threshold = thresholdOf(p.apiName);
        const sample = objects.flatMap((o) => {
          const v = o.values[p.apiName];
          const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
          return o.disputed.includes(p.apiName) || !Number.isFinite(n) ? [] : [{ id: o.id, n }];
        });
        if (sample.length < 3) continue;
        const median = medianOf(sample.map((s) => s.n));
        const mad = medianOf(sample.map((s) => Math.abs(s.n - median)));
        if (mad === 0) {
          detail['noSpread'] = (detail['noSpread'] ?? 0) + 1;
          continue;
        }
        for (const s of sample) {
          const z = round(Math.abs(0.6745 * (s.n - median) / mad), 2);
          if (z >= threshold) {
            findings.push({
              objectIds: [s.id], properties: [p.apiName], statistic: 'robust_z', value: z, threshold, thresholdProperty: p.apiName,
              sampleSize: sample.length, score: z,
            });
          }
        }
      }
      break;
    }
    case 'duplicate_value': {
      for (const p of properties) {
        const threshold = thresholdOf(p.apiName);
        const groups = new Map<string, string[]>();
        for (const o of objects) {
          if (isEmpty(o, p.apiName) || o.disputed.includes(p.apiName)) continue;
          const key = JSON.stringify(o.values[p.apiName]);
          groups.set(key, [...(groups.get(key) ?? []), o.id]);
        }
        let sampleSize = 0;
        for (const ids of groups.values()) sampleSize += ids.length;
        for (const ids of groups.values()) {
          if (ids.length >= 2 && ids.length >= threshold) {
            findings.push({
              objectIds: [...ids].sort(), properties: [p.apiName], statistic: 'group_size', value: ids.length, threshold,
              thresholdProperty: p.apiName, sampleSize, score: ids.length,
            });
          }
        }
      }
      break;
    }
    case 'uniqueness': {
      // Whole objects held twice: every named property filled, undisputed, and equal after
      // trimming and case folding. One property alone is duplicate_value's question.
      const threshold = thresholdOf(null);
      if (properties.length < 2) {
        detail['tooFewProperties'] = 1;
        break;
      }
      const names = properties.map((p) => p.apiName);
      const groups = new Map<string, string[]>();
      for (const o of objects) {
        if (names.some((n) => isEmpty(o, n) || o.disputed.includes(n))) continue;
        const key = JSON.stringify(names.map((n) => normalised(o.values[n])));
        groups.set(key, [...(groups.get(key) ?? []), o.id]);
      }
      let sampleSize = 0;
      for (const ids of groups.values()) sampleSize += ids.length;
      for (const ids of groups.values()) {
        if (ids.length >= 2 && ids.length >= threshold) {
          findings.push({
            objectIds: [...ids].sort(), properties: names, statistic: 'duplicate_entities', value: ids.length, threshold, thresholdProperty: null,
            sampleSize, score: ids.length,
          });
        }
      }
      break;
    }
    case 'timeliness': {
      // The time field is the one property examined: its age now, in days, against the
      // population's by the modified z-score, only where older than the median.
      const threshold = thresholdOf(null);
      const field = properties[0];
      if (field === undefined) break;
      const now = Date.now();
      const sample = objects.flatMap((o) => {
        const v = o.values[field.apiName];
        const at = typeof v === 'string' || typeof v === 'number' ? new Date(v).getTime() : NaN;
        if (o.disputed.includes(field.apiName) || !Number.isFinite(at)) return [];
        return [{ id: o.id, age: (now - at) / 86_400_000 }];
      });
      detail['notATime'] = objects.length - sample.length;
      if (sample.length < 3) break;
      const median = medianOf(sample.map((s) => s.age));
      const mad = medianOf(sample.map((s) => Math.abs(s.age - median)));
      if (mad === 0) {
        detail['noSpread'] = 1;
        break;
      }
      for (const s of sample) {
        if (s.age <= median) continue;
        const z = round(0.6745 * (s.age - median) / mad, 2);
        if (z >= threshold) {
          findings.push({
            objectIds: [s.id], properties: [field.apiName], statistic: 'age_robust_z', value: z, threshold, thresholdProperty: null,
            sampleSize: sample.length, score: z,
          });
        }
      }
      break;
    }
    case 'unmatched_record': {
      const threshold = thresholdOf(null);
      for (const o of objects) {
        if (o.unmatched && 1 >= threshold) {
          findings.push({
            objectIds: [o.id], properties: [], statistic: 'unmatched', value: 1, threshold, thresholdProperty: null, sampleSize: population, score: 1,
          });
        }
      }
      break;
    }
  }
  // Deterministic order: by statistic strength, then the objects named.
  findings.sort((a, b) => b.score - a.score || a.objectIds.join().localeCompare(b.objectIds.join()));
  return { findings, detail };
}

/** A value for comparison: trimmed, case-folded text; other values as JSON. */
const normalised = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : JSON.stringify(v));

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Spec 38.5, read as evidence (decision 2026-11-11): no adjustment before five organisation
 * dispositions; mostly dismissed raises and mostly confirmed lowers, where "mostly" means the
 * posterior (a uniform prior over that share of all dispositions) is at least 80% sure it is
 * over half; and the step is a quarter of the current value at most, scaled by how far apart
 * the two shares' posterior means lie, so a thin or slim majority moves the threshold little.
 * Deferrals count in the total and in neither direction.
 */
export const TUNING_FLOOR = 5;
export const TUNING_CAP = 0.25;
export const TUNING_CREDIBILITY = 0.8;

export function tunedThreshold(current: number, evidence: { confirmed: number; dismissed: number; deferred: number }, ceiling?: number)
  : number | undefined {
  const total = evidence.confirmed + evidence.dismissed + evidence.deferred;
  if (total < TUNING_FLOOR) return undefined;
  const mostlyDismissed = probabilityAbove(0.5, evidence.dismissed, total) >= TUNING_CREDIBILITY;
  const mostlyConfirmed = probabilityAbove(0.5, evidence.confirmed, total) >= TUNING_CREDIBILITY;
  if (!mostlyDismissed && !mostlyConfirmed) return undefined;
  // The posterior means of the two shares, apart: deferrals pull both toward none.
  const margin = Math.abs(evidence.dismissed - evidence.confirmed) / (total + 2);
  const step = Math.abs(current) * TUNING_CAP * margin;
  if (step === 0) return undefined;
  let next = mostlyDismissed ? current + step : current - step;
  if (ceiling !== undefined) next = Math.min(next, ceiling);
  next = round(Math.max(next, 0));
  return next === current ? undefined : next;
}

/** The ceiling a threshold never tunes past: a fill rate is at most 1. */
export const CEILING: Partial<Record<FederatedDetector, number>> = { missing_value: 1 };
