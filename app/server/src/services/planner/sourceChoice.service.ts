// Choosing a source for one request (spec 69.6; decision 2026-11-14), in this order:
//
// 1. Coverage first. A source is eligible only if it holds every property, filter field and
//    the time range the request needs. An ineligible source is never used for part of an
//    answer without saying so: the choice names each one passed over and what it lacked.
// 2. Current state goes to the live sources by default (pushdown first), except:
// 3. the Object Index answers lookup, search and filtering on indexed properties of an
//    opted-in object type, when its watermark is within the request's freshness tolerance;
// 4. the Warehouse answers aggregation over large sets, history, time ranges, point-in-time
//    ("as of") questions, and properties that exist only in Siloes.
// 5. Freshness: every source declares a watermark; an Index or Warehouse staler than the
//    tolerance gives way to live pushdown. The default tolerance is 15 minutes for current
//    state and none for history (history does not go stale; its range must still be held).
// 6. Ties: the fresher, then the lower estimated cost.
// Pure: the planner gathers the candidates; this decides, and says why.

export type SourceKind = 'live' | 'index' | 'warehouse';
export type RequestShape = 'lookup' | 'filter' | 'search' | 'aggregate';

export const CURRENT_STATE_TOLERANCE_SECONDS = 15 * 60;

export interface SourceCandidate {
  kind: SourceKind;
  /** Property identity ids it holds. */
  holds: ReadonlySet<string>;
  /** The time range it holds history for, ISO instants; null bounds are open. Live and the Index hold current state only. */
  history: { from: string | null; to: string | null } | null;
  /** When its data was last brought up to date; null for a live source (now). */
  watermark: string | null;
  /** A relative cost the planner estimated (rows read, bytes scanned). */
  estimatedCost: number;
}

export interface SourceNeed {
  shape: RequestShape;
  /** Every property selected, filtered, sorted, grouped or measured. */
  properties: readonly string[];
  /** A time range asked over (history), or an as-of instant; null for current state. */
  timeRange: { from: string | null; to: string | null } | null;
  asOf: string | null;
  /** Aggregation over a set the planner judged large (past the live bound, or an estimate over it). */
  largeSet: boolean;
  /** Freshness tolerance in seconds; default 15 minutes for current state, none for history. */
  toleranceSeconds?: number | undefined;
}

export interface Passed { kind: SourceKind; missing: string[]; reason: 'coverage' | 'time_range' | 'stale' | 'shape' }
export interface SourceChoice {
  kind: SourceKind;
  reason: string;
  passedOver: Passed[];
  /** Older than the tolerance, chosen because nothing fresher holds what is asked: the answer states its as-of time. */
  stale?: true;
}

const historical = (need: SourceNeed): boolean => need.timeRange !== null || need.asOf !== null;

/** Whether a candidate holds the time range (or as-of instant) asked for. */
function holdsRange(c: SourceCandidate, need: SourceNeed): boolean {
  if (!historical(need)) return true;
  if (c.history === null) return false;
  const from = need.asOf ?? need.timeRange?.from ?? null;
  const to = need.asOf ?? need.timeRange?.to ?? null;
  // Its history starts no later than the range does (an open start needs all of it) and
  // reaches the range's end; an open end is answered up to its watermark, and says so.
  const startOk = c.history.from === null || (from !== null && Date.parse(from) >= Date.parse(c.history.from));
  const end = c.history.to ?? c.watermark;
  const endOk = end === null || to === null || Date.parse(to) <= Date.parse(end);
  return startOk && endOk;
}

const ageSeconds = (c: SourceCandidate, now: number): number => (c.watermark === null ? 0 : Math.max(0, (now - Date.parse(c.watermark)) / 1000));

export function chooseSource(need: SourceNeed, candidates: readonly SourceCandidate[], now = Date.now()): SourceChoice | { kind: null; reason: string; passedOver: Passed[] } {
  const passedOver: Passed[] = [];
  const tolerance = need.toleranceSeconds ?? (historical(need) ? Number.POSITIVE_INFINITY : CURRENT_STATE_TOLERANCE_SECONDS);
  const eligible: SourceCandidate[] = [];
  const staleCovering: SourceCandidate[] = [];
  for (const c of candidates) {
    const missing = need.properties.filter((p) => !c.holds.has(p));
    if (missing.length > 0) { passedOver.push({ kind: c.kind, missing, reason: 'coverage' }); continue; }
    if (!holdsRange(c, need)) { passedOver.push({ kind: c.kind, missing: [], reason: 'time_range' }); continue; }
    if (c.kind !== 'live' && ageSeconds(c, now) > tolerance) {
      passedOver.push({ kind: c.kind, missing: [], reason: 'stale' });
      staleCovering.push(c);
      continue;
    }
    eligible.push(c);
  }
  const best = (list: SourceCandidate[]): SourceCandidate | undefined =>
    [...list].sort((a, b) => ageSeconds(a, now) - ageSeconds(b, now) || a.estimatedCost - b.estimatedCost)[0];
  const of = (kind: SourceKind) => eligible.filter((c) => c.kind === kind);

  // History, as-of, aggregation over large sets, and anything only a Silo holds: the Warehouse.
  const liveHolds = of('live').length > 0;
  if (historical(need) || (need.shape === 'aggregate' && need.largeSet) || (!liveHolds && of('warehouse').length > 0 && of('index').length === 0)) {
    const w = best(of('warehouse'));
    if (w) return { kind: 'warehouse', reason: historical(need) ? 'history or a point in time' : need.largeSet ? 'aggregation over a large set' : 'held only in a Silo', passedOver };
    if (historical(need)) return { kind: null, reason: 'no source holds that time range', passedOver };
  }
  // Lookup, search and filtering on indexed properties, fresh enough: the Object Index.
  if (need.shape !== 'aggregate') {
    const i = best(of('index'));
    if (i) return { kind: 'index', reason: 'indexed properties, within the freshness tolerance', passedOver };
  } else if (of('index').length > 0) {
    passedOver.push({ kind: 'index', missing: [], reason: 'shape' });
  }
  // Current state, by default: the live sources.
  const l = best(of('live'));
  if (l) return { kind: 'live', reason: 'current state, pushed down to the systems', passedOver };
  const any = best(eligible);
  if (any) return { kind: any.kind, reason: 'the only source holding everything asked', passedOver };
  // Nothing fresh holds it, and no live system does: the freshest Silo source, stated as of its watermark.
  const old = best(staleCovering);
  if (old) return { kind: old.kind, reason: 'the only source holding everything asked, older than the tolerance', passedOver, stale: true };
  return { kind: null, reason: 'no source holds everything asked', passedOver };
}
