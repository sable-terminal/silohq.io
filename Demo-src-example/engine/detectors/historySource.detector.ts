import type { ManifestObject } from '../../schemas/manifest.schema';

/**
 * §3 — where the history for a detector can be read from.
 *
 * ── The gate that was wrong ─────────────────────────────────────────────────
 *
 * Timing deviation, drift and recurrence were gated on whether Siloes were
 * enabled. That gate was incorrect, and expensively so: these detectors need
 * HISTORICAL DATA, not Silo storage. In many cases the source system already
 * holds the history and a federated query can reach it — an order table with
 * created and completed timestamps answers timing deviation directly, with
 * nothing stored anywhere and no setting turned on.
 *
 * A storage gate turned "we can answer this today" into "enable storage first",
 * which is both untrue and the worst possible first impression of a feature
 * whose whole pitch is that it works against systems as they are.
 *
 * ── What replaces it ───────────────────────────────────────────────────────
 *
 * A capability check. Before running any of the three, resolve where the
 * required history lives. Three possible places, in this order:
 *
 *   1. THE SOURCE SYSTEM — preferred. Live, complete, requires no storage.
 *   2. A SILO — when the source cannot supply it.
 *   3. BOTH — Silo for the baseline, source for the current period.
 *
 * The Silo is second because it is a copy, and a copy is only ever worth
 * reading when the original cannot answer.
 */

/* ── What each detector needs ────────────────────────────────────────────── */

export type HistoryKind =
  /** Dated rows. Counting them over a range is enough. */
  | 'events'
  /** What a record LOOKED LIKE at a time, which an overwriting source destroys. */
  | 'state';

export type Requirement = {
  detector: HistoryDetector;
  kind: HistoryKind;
  /** How far back the detector needs to see. */
  rangeDays: number;
  /**
   * §3 — MINIMUM BASELINE, AND IT IS NOT OPTIONAL. Drift computed from four
   * data points is technically correct and practically noise; shipping that
   * teaches people the detector is broken, and they are not wrong.
   */
  minimumInstances: number;
  minimumSpanDays: number;
};

export type HistoryDetector = 'timing_deviation' | 'drift' | 'recurrence';

/**
 * The three, and what each one is actually asking for.
 *
 * TIMING DEVIATION NEEDS EVENTS, NOT STATE. "How long did this take" is two
 * timestamps on one row, which an overwriting source keeps perfectly well — so
 * this is the one most often answerable straight from the source, and the
 * reason the storage gate was costing the most.
 *
 * DRIFT NEEDS THE LONGEST RANGE AND THE MOST POINTS. "A previously stable rate
 * that has changed" contains two claims, and the first one — that it was stable
 * — is what needs the history. A rate that has always been jumpy moving again is
 * not drift, and separating those takes enough buckets to measure the jumpiness.
 *
 * RECURRENCE IS CHEAPEST. Counting dated rows per source over a range needs no
 * point-in-time reconstruction at all, which is why any dated record set
 * supports it.
 */
const REQUIREMENTS: Record<HistoryDetector, Omit<Requirement, 'detector'>> = {
  timing_deviation: {
    kind: 'events',
    rangeDays: 90,
    /* A median duration over fewer than this is one slow week. */
    minimumInstances: 20,
    minimumSpanDays: 14,
  },
  drift: {
    kind: 'state',
    rangeDays: 180,
    minimumInstances: 60,
    /* Six buckets of a fortnight: enough to say whether it WAS stable. */
    minimumSpanDays: 84,
  },
  recurrence: {
    kind: 'events',
    rangeDays: 90,
    minimumInstances: 10,
    minimumSpanDays: 21,
  },
};

export function requirementFor(detector: HistoryDetector, over?: Partial<Requirement>): Requirement {
  return { detector, ...REQUIREMENTS[detector], ...over };
}

/* ── What a source can offer ─────────────────────────────────────────────── */

export type SourceCapability = {
  connectionId: string;
  objectName: string;
  /** Field names holding a `date` or `datetime`, read from the manifest. */
  datedFields: string[];
  appendOnly: boolean;
  /** Days of history the source keeps. Null means unbounded or unknown. */
  retentionDays: number | null;
};

/**
 * Read a manifest object's history capability.
 *
 * DATEDNESS IS INFERRED AND THE OTHER TWO ARE DECLARED, which is the split the
 * manifest schema makes and for the reason stated there: a date column is
 * visible, an overwrite is not.
 */
export function capabilityOf(connectionId: string, object: ManifestObject): SourceCapability {
  return {
    connectionId,
    objectName: object.name,
    datedFields: object.fields
      .filter((field) => field.type === 'date' || field.type === 'datetime')
      .map((field) => field.name),
    appendOnly: object.history.appendOnly,
    retentionDays: object.history.retentionDays ?? null,
  };
}

/* ── What storage can offer ──────────────────────────────────────────────── */

export type SiloCoverage =
  /**
   * §3 — SOVEREIGN DEPLOYMENTS. Storage is compiled out, so the Silo path does
   * not exist. This is a property of the deployment rather than a setting
   * anybody can change, and the message has to say so rather than offering to
   * turn something on.
   */
  | { state: 'compiled_out' }
  /** Available, and the customer has not turned it on. This one is an offer. */
  | { state: 'off' }
  /** On, but holding nothing for this concept yet. */
  | { state: 'empty' }
  /** On, and holding history from this instant onwards. */
  | { state: 'covering'; siloId: string; from: string };

/* ── The answer ──────────────────────────────────────────────────────────── */

export type UnavailableReason =
  | 'source_overwrites'
  | 'source_not_dated'
  | 'retention_too_short'
  | 'storage_off'
  | 'storage_compiled_out'
  | 'no_source';

export type HistoryPlan =
  | { from: 'source'; connections: string[] }
  | { from: 'silo'; siloId: string }
  /**
   * §3 — WHERE THE RANGES OVERLAP, THE SOURCE WINS. It is authoritative and the
   * Silo is a copy. `mergeBoundary` is the instant from which source rows are
   * used; everything before it comes from the Silo.
   */
  | { from: 'both'; connections: string[]; siloId: string; mergeBoundary: string }
  | { from: 'unavailable'; reason: UnavailableReason; needed: Requirement };

/**
 * Decide where a detector's history comes from.
 *
 * PURE, SO THE DECISION IS TESTABLE WITHOUT A DATABASE OR A NETWORK. Whether
 * this product will tell somebody "enable storage" or "your ERP already knows"
 * is one of the higher-stakes sentences it produces, and it should not require
 * eight systems to be connected to check which one it picks.
 *
 * THE SOURCE IS TRIED FIRST, ALWAYS. Not because it is faster — because a Silo
 * is a copy, and reading a copy when the original can answer means every
 * staleness bug in the copy becomes a wrong finding with full confidence.
 */
export function resolve(input: {
  requirement: Requirement;
  sources: SourceCapability[];
  silo: SiloCoverage;
  /** Now, so a caller can compute a boundary without this reading the clock. */
  at?: Date;
}): HistoryPlan {
  const { requirement, sources, silo } = input;
  const now = input.at ?? new Date();

  if (sources.length === 0) {
    return { from: 'unavailable', reason: 'no_source', needed: requirement };
  }

  /*
   * TWO QUESTIONS, NOT ONE, AND CONFLATING THEM HIDES THE MERGE CASE. Whether a
   * source has the right SHAPE — dated, and append-only where point-in-time
   * state is needed — is a different question from whether it holds ENOUGH of
   * it. A source with the right shape and ninety days of retention cannot
   * answer a six-month question alone and is exactly the source a Silo
   * completes. Asking both at once means that source looks useless and the
   * answer comes back "silo only", throwing away the authoritative half.
   */
  const shaped = sources.filter((source) => hasShape(source, requirement));
  const siloId = silo.state === 'covering' ? silo.siloId : null;

  if (shaped.length === 0) {
    if (siloId) return { from: 'silo', siloId };
    return { from: 'unavailable', reason: unavailableReason(sources, requirement, silo), needed: requirement };
  }

  const connections = [...new Set(shaped.map((source) => source.connectionId))].sort();

  /* Retention unknown is not retention short: a source that never declared one
     is asked and found out rather than assumed useless. */
  const covering = shaped.filter(
    (source) => source.retentionDays === null || source.retentionDays >= requirement.rangeDays,
  );

  if (covering.length > 0) {
    return {
      from: 'source',
      connections: [...new Set(covering.map((source) => source.connectionId))].sort(),
    };
  }

  /*
   * §3 — BOTH. The source covers the current period and the Silo covers the
   * baseline. The boundary is where the source's own retention begins, because
   * where the ranges overlap THE SOURCE WINS: it is authoritative and the Silo
   * is a copy.
   */
  if (siloId && silo.state === 'covering') {
    const shortest = Math.min(...shaped.map((source) => source.retentionDays!));
    const boundary = new Date(now.getTime() - shortest * DAY);

    /* Only where the Silo actually reaches further back than the source keeps.
       Two answers where one would do is two chances to be wrong. */
    if (Date.parse(silo.from) < boundary.getTime()) {
      return { from: 'both', connections, siloId, mergeBoundary: boundary.toISOString() };
    }

    return { from: 'source', connections };
  }

  /*
   * THE SOURCE HAS THE RIGHT SHAPE AND NOT ENOUGH OF IT, which is precisely the
   * case storage exists to solve — so where storage could be turned on, that is
   * the reason worth surfacing rather than a retention figure the customer
   * cannot change.
   */
  return {
    from: 'unavailable',
    reason:
      silo.state === 'compiled_out'
        ? 'storage_compiled_out'
        : silo.state === 'off'
          ? 'storage_off'
          : 'retention_too_short',
    needed: requirement,
  };
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Does this object have the right shape for the question?
 *
 * STATE NEEDS APPEND-ONLY AND EVENTS DO NOT. That single line is most of the
 * change: "how long did this take" is two timestamps on one row, which an
 * overwriting table keeps perfectly, while "what was this a month ago" is
 * exactly what an overwriting table destroys.
 *
 * IT SAYS NOTHING ABOUT RANGE, deliberately. How much history a source holds is
 * the caller's next question and has a different answer — see `resolve`.
 */
function hasShape(source: SourceCapability, requirement: Requirement): boolean {
  if (source.datedFields.length === 0) return false;
  if (requirement.kind === 'state' && !source.appendOnly) return false;
  return true;
}

/**
 * The most useful thing to say when nothing has the right shape.
 *
 * THE MOST ACTIONABLE REASON WINS, not the first one found. A source with no
 * dates at all is one the customer should point somewhere else; a source that
 * overwrites is one storage would fix. Telling somebody to enable storage when
 * the real problem is that they aimed the detector at a lookup table wastes
 * both their time and their trust.
 */
function unavailableReason(
  sources: SourceCapability[],
  requirement: Requirement,
  silo: SiloCoverage,
): UnavailableReason {
  const dated = sources.filter((source) => source.datedFields.length > 0);
  if (dated.length === 0) return 'source_not_dated';

  if (silo.state === 'compiled_out') return 'storage_compiled_out';

  /* Dated, and it overwrites — which for a point-in-time question is the whole
     problem, and is the one a Silo genuinely solves. */
  return requirement.kind === 'state' ? 'source_overwrites' : 'retention_too_short';
}

/* ── Whether there is enough of it ───────────────────────────────────────── */

export type Baseline =
  | { state: 'sufficient' }
  /**
   * §3 — A THIRD STATE, DISTINCT FROM AVAILABLE AND UNAVAILABLE. A Silo enabled
   * today holds no history yet, and so does a source that only started being
   * written last week. Neither is "unavailable" — nothing is wrong and nothing
   * needs deciding — and neither is available. It is accumulating, and saying so
   * with numbers is the difference between a feature that looks broken and one
   * that looks like it is warming up.
   */
  | { state: 'accumulating'; haveInstances: number; needInstances: number; haveSpanDays: number; needSpanDays: number };

/**
 * Is there enough history to run against?
 *
 * CHECKED AFTER FETCHING, BECAUSE COUNTING NEEDS THE ROWS. The resolver answers
 * where history lives from declarations alone; how much of it there turned out
 * to be is only knowable once it has been read.
 *
 * BOTH CONDITIONS, NOT EITHER. Sixty rows from one afternoon is not six months
 * of stability, and six months holding four rows is not a population. Each
 * detector states both minimums because both failure modes produce findings
 * that are arithmetically correct and worth nothing.
 */
export function baselineOf(
  requirement: Requirement,
  observed: { instances: number; earliest: string | null; latest: string | null },
): Baseline {
  const spanDays =
    observed.earliest && observed.latest
      ? Math.max(0, (Date.parse(observed.latest) - Date.parse(observed.earliest)) / DAY)
      : 0;

  if (
    observed.instances >= requirement.minimumInstances &&
    spanDays >= requirement.minimumSpanDays
  ) {
    return { state: 'sufficient' };
  }

  return {
    state: 'accumulating',
    haveInstances: observed.instances,
    needInstances: requirement.minimumInstances,
    haveSpanDays: Math.round(spanDays),
    needSpanDays: requirement.minimumSpanDays,
  };
}

/* ── Saying it in words ──────────────────────────────────────────────────── */

/**
 * Why a detector could not run, in a sentence somebody can act on.
 *
 * THE OFFER ONLY APPEARS WHERE IT IS TRUE. §3 says to offer enabling a Silo at
 * the moment the reason is that storage is off, because the user then has a
 * concrete reason rather than an abstract setting. It says equally clearly that
 * a sovereign deployment must not be offered a switch it does not have.
 */
export function explain(plan: Extract<HistoryPlan, { from: 'unavailable' }>): {
  message: string;
  offerStorage: boolean;
} {
  const needed = `${plan.needed.rangeDays} days of ${plan.needed.kind === 'state' ? 'point-in-time history' : 'dated records'}`;

  switch (plan.reason) {
    case 'no_source':
      return { message: `Nothing readable holds ${needed}.`, offerStorage: false };
    case 'source_not_dated':
      return {
        message: `The objects behind this concept carry no dates, so ${needed} cannot be read from them.`,
        offerStorage: false,
      };
    case 'source_overwrites':
      return {
        message:
          `This needs ${needed}, and the source overwrites records rather than appending — ` +
          'a value that changed leaves no record of the change.',
        offerStorage: true,
      };
    case 'retention_too_short':
      return {
        message: `The source keeps less than the ${needed} this needs.`,
        offerStorage: true,
      };
    case 'storage_off':
      return {
        message: `This needs ${needed} and the source cannot supply it. A Silo would retain it from now on.`,
        offerStorage: true,
      };
    case 'storage_compiled_out':
      return {
        message: `This needs ${needed} and the source cannot supply it. This deployment has no storage.`,
        offerStorage: false,
      };
  }
}
