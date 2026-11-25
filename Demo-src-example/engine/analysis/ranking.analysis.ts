/**
 * §5 — AI ranking. The one stage where a model participates, and the stage
 * where lineage could break.
 *
 * ── Where it sits ───────────────────────────────────────────────────────────
 *
 * §5.1: after detection and association. It reads a structured summary of
 * computed findings and reorders, groups and explains them. It does not detect,
 * it does not compute, and it cannot reach a source. Everything it ranks was
 * already true before it ran.
 *
 * ── The three hard constraints, and where each is enforced ─────────────────
 *
 * NO BUSINESS DATA IN THE PROMPT — `summarise`, below. The summary carries
 * entity references, measures, counts and statistics. Not values. `observed`
 * and `expected` are the customer's figures and are stripped here; `deviation`
 * is the same fact normalised, which is a statistic and is what the model
 * actually needs to order anything.
 *
 * CANNOT INTRODUCE A FINDING — `validate`, below. Output is references plus
 * commentary, checked against the finding set the same way a manifest is
 * checked against its schema. A statement with no underlying finding is a
 * hallucination wearing the appearance of analysis, and it is REJECTED rather
 * than repaired — repairing it would produce an analysis nobody wrote.
 *
 * MUST CITE — the shape of `Ranked` makes a rationale without a finding id
 * unrepresentable. Somebody challenging a ranking is shown the computation, not
 * an assertion.
 */

export type FindingRow = {
  id: string;
  detector: string;
  conceptId: string;
  conceptName: string;
  measure: string;
  entityRef: string;
  observed: number | null;
  expected: number | null;
  deviation: number | null;
  populationN: number;
  confidence: number | null;
  occurredAt: string | null;
};

export type AssociationRow = {
  a: { detector: string; conceptId: string; measure: string };
  b: { detector: string; conceptId: string; measure: string };
  coOccurrence: number;
  sampleSize: number;
  lift: number;
  temporalOrder: string;
  structuralDirection: string;
};

export type OutcomeRow = {
  conceptId: string;
  fieldPath: string;
  direction: 'higher_is_worse' | 'lower_is_worse';
  label: string | null;
};

/**
 * §5.5 — what this organisation's map has learned about a detector.
 *
 * DIFFERENT FROM A DISMISSAL RATE, THOUGH BOTH COME FROM DISPOSITIONS. A rate
 * is what happened: forty raised, thirty dismissed. A weight is what the map
 * DECIDED as a result, accumulated over time and scoped to the map somebody is
 * working in — two teams looking at the same estate can reasonably weigh the
 * same detector differently, and the rate cannot express that.
 */
export type DetectorWeightRow = {
  conceptId: string;
  detector: string;
  /** One is neutral. Below one this map has learned to look at it less. */
  weight: number;
  signalCount: number;
  noiseCount: number;
};

/** §5.5 — how often findings of this shape have been dismissed here. */
export type DismissalRow = {
  detector: string;
  conceptId: string;
  measure: string;
  raised: number;
  dismissed: number;
};

/* ── The summary ─────────────────────────────────────────────────────────── */

export type SummaryFinding = {
  id: string;
  detector: string;
  concept: string;
  measure: string;
  entityRef: string;
  /** Normalised magnitude. A statistic, not a figure read from a record. */
  deviation: number | null;
  populationN: number;
  confidence: number | null;
  occurredAt: string | null;
};

export type Summary = {
  findings: SummaryFinding[];
  associations: Array<{
    a: string;
    b: string;
    coOccurrence: number;
    sampleSize: number;
    lift: number;
    temporalOrder: string;
    structuralDirection: string;
  }>;
  outcomes: Array<{ concept: string; fieldPath: string; direction: string; label: string | null }>;
  /** §5.5 — the feedback signal, as a rate rather than as a list of opinions. */
  dismissalRates: Array<{ condition: string; raised: number; dismissed: number }>;
  /**
   * §5.5 — what this map has learned to weigh, and how much evidence is behind
   * each figure.
   *
   * THE COUNTS TRAVEL WITH THE WEIGHT. A weight of 0.4 from two dispositions
   * and one from two hundred are different claims, and a model shown only the
   * number would treat one person's bad afternoon as settled policy.
   */
  detectorWeights: Array<{
    condition: string;
    weight: number;
    signal: number;
    noise: number;
  }>;
};

/**
 * FIELDS THAT NEVER REACH THE PROMPT, named so the rule is greppable.
 *
 * §5.2 — "The summary carries entity references, measures, counts and
 * statistics. Not values." `observed` and `expected` are the customer's own
 * figures: the total on an invoice, the balance in a ledger. `deviation` is
 * those two subtracted and normalised, which is a statistic about them and
 * carries what ordering actually needs.
 *
 * IT COSTS THE MODEL ALMOST NOTHING. "This is 40% out over a population of
 * 12,000" is what decides a rank. "£4,820.55 against £3,442.53" adds the two
 * numbers the model must not see and nothing it could use.
 */
export const NEVER_SUMMARISED = ['observed', 'expected'] as const;

const conditionOf = (row: { detector: string; conceptId: string; measure: string }, names: Map<string, string>) =>
  `${row.detector} on ${names.get(row.conceptId) ?? row.conceptId}.${row.measure}`;

/**
 * Build what the model is allowed to see.
 *
 * NAMES ARE NOT VALUES. A concept is called "invoice" because somebody in this
 * organisation confirmed that it is, and the compile path already sends the
 * ontology for the same reason: the model has to know what it is ordering. What
 * it must never receive is what any particular invoice says.
 */
export function summarise(input: {
  findings: FindingRow[];
  associations: AssociationRow[];
  outcomes: OutcomeRow[];
  dismissals: DismissalRow[];
  /** Absent where the reader has no map, which is a real state and not zero. */
  weights?: DetectorWeightRow[];
}): Summary {
  const names = new Map(input.findings.map((row) => [row.conceptId, row.conceptName]));

  return {
    findings: input.findings.map((row) => ({
      id: row.id,
      detector: row.detector,
      concept: row.conceptName,
      measure: row.measure,
      entityRef: row.entityRef,
      deviation: row.deviation,
      populationN: row.populationN,
      confidence: row.confidence,
      occurredAt: row.occurredAt,
    })),

    associations: input.associations.map((row) => ({
      a: conditionOf(row.a, names),
      b: conditionOf(row.b, names),
      coOccurrence: row.coOccurrence,
      sampleSize: row.sampleSize,
      lift: row.lift,
      temporalOrder: row.temporalOrder,
      structuralDirection: row.structuralDirection,
    })),

    outcomes: input.outcomes.map((row) => ({
      concept: names.get(row.conceptId) ?? row.conceptId,
      fieldPath: row.fieldPath,
      direction: row.direction,
      label: row.label,
    })),

    dismissalRates: input.dismissals.map((row) => ({
      condition: conditionOf(row, names),
      raised: row.raised,
      dismissed: row.dismissed,
    })),

    /*
     * ONLY WEIGHTS ABOUT CONCEPTS IN THIS SUMMARY. A map accumulates weights
     * for everything it has ever seen; sending the lot would fill the prompt
     * with judgements about findings the model is not looking at, and every one
     * of them is a chance to reorder something it cannot see.
     *
     * `measure` IS NOT PART OF A WEIGHT — it is learned per concept and
     * detector — so the condition it names is deliberately coarser than the
     * one a dismissal rate names.
     */
    detectorWeights: (input.weights ?? [])
      .filter((row) => names.has(row.conceptId))
      .map((row) => ({
        condition: `${row.detector} on ${names.get(row.conceptId) ?? row.conceptId}`,
        weight: row.weight,
        signal: row.signalCount,
        noise: row.noiseCount,
      })),
  };
}

/* ── Validating what came back ───────────────────────────────────────────── */

export type Ranked = { findingId: string; rank: number; rationale: string };
export type Grouping = { findingIds: string[]; sharedFactor: string };
export type Omission = { findingId: string; reason: string };

export type Ranking = {
  ordered: Ranked[];
  groupings: Grouping[];
  omitted: Omission[];
};

export class RankingRejected extends Error {
  constructor(readonly reason: string, readonly detail: Record<string, unknown> = {}) {
    super(reason);
    this.name = 'RankingRejected';
  }
}

/**
 * Check the model's output against the findings that actually exist.
 *
 * §5.2 — REJECTED, NEVER REPAIRED. This is the same rule `draftManifest`
 * follows: a manifest that fails validation is thrown away rather than patched,
 * because a patched one is a connector nobody wrote. A ranking citing a finding
 * that does not exist is worse — it reads as analysis, it carries a plausible
 * rationale, and the id is the only thing that would have given it away.
 *
 * ── The one thing that is filled in rather than refused ────────────────────
 *
 * A finding the model did not mention at all. That is not a fabrication and
 * refusing the whole ranking over it would throw away work that is otherwise
 * sound — but §5.3 says omitted findings remain visible and the model never
 * removes evidence, so it goes into `omitted` with a reason saying plainly that
 * the model did not address it. Losing it silently is the one outcome that is
 * not allowed.
 */
export function validate(raw: unknown, findings: FindingRow[]): Ranking {
  if (typeof raw !== 'object' || raw === null) {
    throw new RankingRejected('The model returned something that is not a ranking.');
  }

  const body = raw as Record<string, unknown>;
  const known = new Set(findings.map((finding) => finding.id));
  const seen = new Set<string>();

  const cite = (value: unknown, where: string): string => {
    if (typeof value !== 'string' || !known.has(value)) {
      /* THE HALLUCINATION CASE. An id nobody computed is a statement with no
         underlying finding, and §5.2 says reject. */
      throw new RankingRejected('The ranking cites a finding that does not exist.', {
        where,
        findingId: typeof value === 'string' ? value : null,
      });
    }
    if (seen.has(value)) {
      throw new RankingRejected('The ranking places one finding twice.', { findingId: value });
    }
    seen.add(value);
    return value;
  };

  const ordered: Ranked[] = asArray(body.ordered_findings ?? body.ordered).map((row, index) => {
    const rationale = typeof row.rationale === 'string' ? row.rationale.trim() : '';

    /*
     * §5.2 — MUST CITE. A rank with no reasoning is an assertion, and the whole
     * point of this stage is that somebody challenging it is shown why rather
     * than told again.
     */
    if (rationale === '') {
      throw new RankingRejected('A ranked finding arrived with no rationale.', { index });
    }

    return {
      findingId: cite(row.finding_id ?? row.findingId, 'ordered'),
      /* The model's own rank is not trusted: position in the list is the rank,
         and a duplicated or skipped number would silently reorder the result. */
      rank: index + 1,
      rationale,
    };
  });

  const omitted: Omission[] = asArray(body.omitted).map((row) => {
    const reason = typeof row.reason === 'string' ? row.reason.trim() : '';

    if (reason === '') {
      throw new RankingRejected('A finding was set aside with no reason given.');
    }

    return { findingId: cite(row.finding_id ?? row.findingId, 'omitted'), reason };
  });

  /*
   * GROUPINGS MAY REPEAT WHAT IS ALREADY RANKED, which is the one place a
   * finding legitimately appears twice — a grouping is a second statement about
   * the same finding, not a second placement of it. So they are checked for
   * existence and not against `seen`.
   */
  const groupings: Grouping[] = asArray(body.groupings).map((row) => {
    const factor = typeof row.shared_factor === 'string' ? row.shared_factor : row.sharedFactor;

    if (typeof factor !== 'string' || factor.trim() === '') {
      throw new RankingRejected('A grouping arrived without saying what is shared.');
    }

    const raw = row.finding_ids ?? row.findingIds;
    const ids = (Array.isArray(raw) ? raw : []).map((id) => {
      if (typeof id !== 'string' || !known.has(id)) {
        throw new RankingRejected('A grouping cites a finding that does not exist.', {
          findingId: typeof id === 'string' ? id : null,
        });
      }
      return id;
    });

    if (ids.length < 2) {
      throw new RankingRejected('A grouping of fewer than two findings is not a grouping.');
    }

    return { findingIds: ids, sharedFactor: factor.trim() };
  });

  /* Nothing disappears. §5.3 — the model narrows attention; it never removes
     evidence. */
  for (const finding of findings) {
    if (seen.has(finding.id)) continue;
    omitted.push({
      findingId: finding.id,
      reason: 'The ranking did not address this one.',
    });
  }

  return { ordered, groupings, omitted };
}

/**
 * The array, with anything that is not an object dropped.
 *
 * A `null` IN THE LIST USED TO THROW A TypeError STRAIGHT OUT OF `validate`,
 * past the `RankingRejected` catch in the service and out as a 500. Models emit
 * `[{...}, null]` more often than one would like, and the whole point of this
 * file is that malformed output is REJECTED rather than crashing — a rejection
 * the caller can explain, not a stack trace.
 *
 * Dropping the entry rather than rejecting the ranking is right because nothing
 * is lost: a null cites no finding, and §5.3's guarantee is that every finding
 * is accounted for, which the sweep at the end of `validate` still does.
 */
function asArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null && !Array.isArray(entry),
  );
}
