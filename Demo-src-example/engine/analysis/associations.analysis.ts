/**
 * §4 — association analysis. What moves with what.
 *
 * ── The sentence this file is allowed to produce ────────────────────────────
 *
 * *These move together, 78 of 94 times, in this order.*
 *
 * And never *this causes that*. §4.2 — confounding cannot be ruled out from
 * observational data without stated domain assumptions, and stating those is
 * the modelling engagement §1 refuses to be. Nothing here computes a cause,
 * `associations` has no column to keep one in, and the two facts are the same
 * decision written twice.
 *
 * THIS IS THE STRONGER POSITION WITH A TECHNICAL AUDIENCE. A causal claim gets
 * dismantled the moment somebody asks what was controlled for. "They co-occur,
 * here is n" survives the question, and survives it in front of the person whose
 * job it is to ask.
 *
 * ── Conditions, not findings ────────────────────────────────────────────────
 *
 * A finding is about one entity. Two of them co-occur with a sample size of
 * one, which is not a statement anybody should act on. What recurs is a
 * CONDITION — one detector's verdict on one measure of one concept — and the
 * count is over the entities that showed it. That is where "78 of 94" comes
 * from and why the unit here is a condition.
 *
 * ── Arithmetic, like the detectors ─────────────────────────────────────────
 *
 * No model participates, the same findings produce the same associations, and
 * every figure can be explained by showing the counting. §5's ranking layer
 * reads what comes out of here; it does not get to reach in.
 */

export type FindingFact = {
  id: string;
  detector: string;
  conceptId: string;
  measure: string;
  entityRef: string;
  /** What this finding was measured against. §4.1 — stated always. */
  populationN?: number;
  /**
   * When the thing the finding is about HAPPENED, where the detector knew.
   *
   * NEVER `detected_at`. That records when a detector ran, so ordering by it
   * would report the order the engine happened to execute in as a fact about
   * the customer's business — an artefact indistinguishable, on screen, from a
   * discovery. `unknown` is the right answer far more often than a made-up one.
   */
  occurredAt?: string | null;
};

export type Condition = { detector: string; conceptId: string; measure: string };

export type TemporalOrder = 'a_first' | 'b_first' | 'concurrent' | 'unknown';
export type StructuralDirection = 'a_to_b' | 'b_to_a' | 'none' | 'unknown';

export type Association = {
  a: Condition;
  b: Condition;
  /** Entities showing both. */
  coOccurrence: number;
  /** Entities showing either. §4.1 — stated always. */
  sampleSize: number;
  /** Co-occurrence over the union. Symmetric, like the pair. */
  strength: number;
  /** Observed co-occurrence over what independence would predict. */
  lift: number;
  temporalOrder: TemporalOrder;
  structuralDirection: StructuralDirection;
};

/**
 * How many entities must show both before it is worth saying.
 *
 * TWO THINGS HAPPENING TO THE SAME FIVE ENTITIES IS A COINCIDENCE. The floor is
 * not statistical rigour — it is the difference between a finding somebody acts
 * on and a screen full of pairs that evaporate on the next run.
 */
const MIN_CO_OCCURRENCE = 5;

/**
 * How much more often than chance.
 *
 * LIFT, NOT RATE, IS THE TEST. Two conditions that each hold on nearly every
 * entity co-occur constantly and mean nothing; a raw co-occurrence rate cannot
 * tell that apart from a real pattern, and would rank the meaningless pair
 * first every time because its numbers are the biggest.
 */
const MIN_LIFT = 1.2;

/**
 * How much of a related population must show both, for a cross-concept pair.
 *
 * ── Why lift cannot be the test here ───────────────────────────────────────
 *
 * Lift needs a population that is not conditioned on the thing being measured.
 * Within one concept that exists: the entities the detectors examined, which
 * `population_n` states.
 *
 * Across two concepts it does not. A link between instances is captured on a
 * FINDING, so every related pair this layer can see already has at least one —
 * the population is conditioned on something having been found, P(A) and P(B)
 * are both inflated towards one, and lift collapses to about 1 however strong
 * the relationship is. Ten invoices that all disagree, all belonging to ten
 * late orders, scores a lift of exactly 1.0 and would be discarded.
 *
 * The statistic that IS meaningful over that population is the share: of the
 * related pairs we can see, how many showed both. "Of the 94 invoices belonging
 * to late orders, 78 disagree" is a sentence somebody can act on, and it does
 * not pretend to know about the pairs where nothing was found.
 */
const MIN_CROSS_STRENGTH = 0.5;

/**
 * How consistent an ordering has to be before it is called one.
 *
 * SOMETIMES ONE AND SOMETIMES THE OTHER IS NOT AN ORDER. A 55/45 split is two
 * things happening in whatever sequence, and reporting the majority as "in this
 * order" turns noise into a claim.
 */
const TEMPORAL_MAJORITY = 0.6;

/* ── Ordering a pair ─────────────────────────────────────────────────────── */

/**
 * THE SAME COMPARISON THE DATABASE MAKES. `associations_canonical_order` checks
 * `(detector, concept, measure) < (detector, concept, measure)` as a row, so
 * this compares field by field rather than joining into a string — a joined key
 * agrees with a row comparison almost always, and the exception would be an
 * insert rejected by a constraint nobody could reproduce.
 *
 * IT RELIES ON THE IDS BEING LOWERCASE. Postgres orders `uuid` by its binary
 * value; a JS string comparison matches that only for canonical lowercase hex,
 * which is what `randomUUID` emits and what the driver reads back.
 */
function compareCondition(a: Condition, b: Condition): number {
  if (a.detector !== b.detector) return a.detector < b.detector ? -1 : 1;
  if (a.conceptId !== b.conceptId) return a.conceptId < b.conceptId ? -1 : 1;
  if (a.measure !== b.measure) return a.measure < b.measure ? -1 : 1;
  return 0;
}

/**
 * WHICH ENTITY A FINDING IS ABOUT, scoped to the concept it belongs to.
 *
 * KEYING ON THE REFERENCE ALONE FABRICATED ASSOCIATIONS. `INV-001` under
 * `invoice` and `INV-001` under `purchase order` became one entity, so two
 * conditions on two unrelated concepts co-occurred perfectly whenever a
 * customer's systems numbered things the same way — which is most of the time,
 * and produced a confident finding with a real-looking sample size.
 *
 * Cross-concept pairs now almost never co-occur, and that is correct: an order
 * is not an invoice. What relates two concepts is the foreign key between them,
 * which `structuralDirection` reads.
 */
/**
 * The unordered pair of concepts, so a relationship declared one way answers a
 * question asked the other. Co-occurrence is symmetric even where the key is not.
 */
const conceptPair = (a: Condition, b: Condition) =>
  a.conceptId < b.conceptId
    ? `${a.conceptId}\u0000${b.conceptId}`
    : `${b.conceptId}\u0000${a.conceptId}`;

/**
 * How two sets of entities pair up across the links their rows carried.
 *
 * COUNTED OVER PAIRS, NOT ENTITIES. One order with three invoices is three
 * related pairs, and an order whose invoices all disagree is a different fact
 * from one where one of three does. Collapsing to entities would lose that.
 *
 * `visible` IS EVERY RELATED PAIR THIS LAYER CAN SEE, which is only those where
 * a finding was raised on at least one side — links live on findings. Lift over
 * it is conditional on something having been found, and that is the honest
 * denominator for what was actually looked at rather than a guess at what was
 * not.
 */
function pairsAcross(
  from: ReadonlySet<string>,
  to: ReadonlySet<string>,
  related: ReadonlyArray<{ from: string; to: string }>,
): { both: string[]; either: number; fromSeen: number; toSeen: number; visible: number } {
  const both: string[] = [];
  let either = 0;
  let fromSeen = 0;
  let toSeen = 0;
  let visible = 0;

  for (const link of related) {
    /* A link is directional; the conditions are not, so try it both ways. */
    for (const [a, b] of [
      [link.from, link.to],
      [link.to, link.from],
    ] as const) {
      if (!from.has(a) && !to.has(b)) continue;

      visible += 1;
      if (from.has(a)) fromSeen += 1;
      if (to.has(b)) toSeen += 1;

      if (from.has(a) && to.has(b)) both.push(`${a} ${b}`);
      either += 1;
    }
  }

  return { both: [...new Set(both)], either, fromSeen, toSeen, visible };
}

const entityOf = (finding: FindingFact) =>
  `${finding.conceptId}\u0000${finding.entityRef}`;

const keyOf = (condition: Condition) =>
  `${condition.detector}\u0000${condition.conceptId}\u0000${condition.measure}`;

/* ── Temporal ordering ───────────────────────────────────────────────────── */

function orderOf(
  shared: string[],
  whenA: Map<string, number>,
  whenB: Map<string, number>,
): TemporalOrder {
  let aFirst = 0;
  let bFirst = 0;
  let together = 0;

  for (const entity of shared) {
    const a = whenA.get(entity);
    const b = whenB.get(entity);
    /* §4.1 — "where timestamps permit". An entity missing either side is not
       evidence of simultaneity; it is not evidence of anything. */
    if (a === undefined || b === undefined) continue;

    if (a < b) aFirst += 1;
    else if (b < a) bFirst += 1;
    else together += 1;
  }

  const comparable = aFirst + bFirst + together;
  if (comparable === 0) return 'unknown';

  if (together / comparable >= 0.5) return 'concurrent';
  if (aFirst / comparable >= TEMPORAL_MAJORITY) return 'a_first';
  if (bFirst / comparable >= TEMPORAL_MAJORITY) return 'b_first';

  return 'unknown';
}

/* ── Structural direction ────────────────────────────────────────────────── */

export type ConceptEdge = { from: string; to: string };

/**
 * §4.1 — which way a relationship COULD run, from the schema rather than the
 * data.
 *
 * THE WEAKEST DIRECTIONAL CLAIM AVAILABLE, AND THE ONLY DEFENSIBLE ONE. A line
 * item cannot precede its order in a data model, whatever the rows say, and
 * that is a fact about the model — not about cause, and not something a p-value
 * could overturn.
 *
 * `unknown` AND `none` ARE DIFFERENT ANSWERS. Nothing was known about the
 * schema, versus the schema was read and connects these two in neither
 * direction. The first is a gap; the second is evidence.
 */
export function directionOf(
  a: Condition,
  b: Condition,
  edges: ConceptEdge[] | undefined,
): StructuralDirection {
  if (!edges) return 'unknown';
  if (a.conceptId === b.conceptId) return 'none';

  const forward = edges.some((edge) => edge.from === a.conceptId && edge.to === b.conceptId);
  const backward = edges.some((edge) => edge.from === b.conceptId && edge.to === a.conceptId);

  /* Pointing at each other constrains nothing, which is not the same as not
     being connected — but it is the same answer, because neither could be said
     to come first. */
  if (forward && backward) return 'none';
  if (forward) return 'a_to_b';
  if (backward) return 'b_to_a';

  return 'none';
}

/* ── Entry point ─────────────────────────────────────────────────────────── */

export type AssociateOptions = {
  /** Directed concept-to-concept edges read out of the manifests' foreign keys. */
  edges?: ConceptEdge[];
  /**
   * HOW MANY ENTITIES THE DETECTORS ACTUALLY EXAMINED, which is not the number
   * that produced a finding.
   *
   * LIFT IS MEANINGLESS WITHOUT IT. Measured against the entities that showed
   * SOMETHING, every condition holds on most of the population by construction,
   * so independence predicts near-total overlap and nothing ever clears the
   * bar. Thirty disagreements and thirty-one outliers among eleven thousand
   * invoices is a strong pattern; among the sixty entities that had any finding
   * at all it is arithmetic noise.
   *
   * `findings.population_n` is where this comes from — §4.1 requires it stated
   * on every finding, and this is the second job that requirement does.
   *
   * Omitted, it falls back to the entities seen here, which suppresses
   * associations rather than inventing them.
   */
  population?: number;
  minCoOccurrence?: number;
  minLift?: number;

  /**
   * §4 — WHICH INSTANCES ARE RELATED TO WHICH, one hop, from the keys their
   * rows actually carried.
   *
   * Two conditions on different concepts co-occur when the SAME PAIR of related
   * instances shows both — that invoice and that order, not any invoice and any
   * order. Without this the layer could only compare entities to themselves,
   * which is why cross-concept pairs were refused rather than guessed at.
   *
   * Keys are `entityOf`'s: a concept and a reference. Direction is the key's,
   * from the row that carried it.
   */
  related?: ReadonlyArray<{ from: string; to: string }>;
};


/**
 * The same computation, saying what it could not evaluate.
 *
 * §4.1 REQUIRES THE SAMPLE SIZE STATED ALWAYS, and "how many pairs were not
 * looked at" is the same kind of honesty one level up. A caller that reports
 * three associations without saying forty pairs were skipped has reported
 * "these are the relationships" when it means "these are the ones we can see".
 */
export function associateWithCoverage(
  findings: FindingFact[],
  options: AssociateOptions = {},
): { associations: Association[]; crossConceptSkipped: number } {
  const minCoOccurrence = options.minCoOccurrence ?? MIN_CO_OCCURRENCE;
  const minLift = options.minLift ?? MIN_LIFT;

  const conditions = new Map<
    string,
    { condition: Condition; entities: Set<string>; when: Map<string, number> }
  >();
  const everyEntity = new Set<string>();
  /** Per concept, the largest population any of its findings was measured against. */
  const examined = new Map<string, number>();

  for (const finding of findings) {
    const condition: Condition = {
      detector: finding.detector,
      conceptId: finding.conceptId,
      measure: finding.measure,
    };

    const key = keyOf(condition);
    const held = conditions.get(key) ?? {
      condition,
      entities: new Set<string>(),
      when: new Map<string, number>(),
    };

    /*
     * AN ENTITY IS A CONCEPT PLUS A REFERENCE, NOT A REFERENCE. Keying on the
     * reference alone made `INV-001` under `invoice` and `INV-001` under
     * `purchase order` the same entity — so two conditions on two unrelated
     * concepts co-occurred perfectly whenever the customer's systems happened to
     * number things the same way, which is most of the time. That is a
     * fabricated association with a real-looking sample size behind it.
     *
     * The consequence is that cross-concept pairs now almost never co-occur,
     * and that is correct: an order is not an invoice. What relates two concepts
     * is the foreign key between them, which `structuralDirection` reads.
     */
    const entity = entityOf(finding);
    held.entities.add(entity);

    if (finding.occurredAt) {
      const at = Date.parse(finding.occurredAt);
      /*
       * THE EARLIEST OCCURRENCE IS THE ONE THAT ORDERS. An entity showing a
       * condition twice was in that state from the first time; taking the later
       * one would report an ordering that depends on how much data was read.
       */
      if (!Number.isNaN(at) && at < (held.when.get(entity) ?? Infinity)) {
        held.when.set(entity, at);
      }
    }

    conditions.set(key, held);
    everyEntity.add(entity);

    /*
     * §4.1 — THE DENOMINATOR IS PER CONCEPT, because `population_n` means
     * different things to different detectors: rows examined for absence,
     * distinct nodes for concentration, keyed rows for duplication. Taking one
     * maximum across all of them divided invoices by suppliers.
     */
    examined.set(
      finding.conceptId,
      Math.max(examined.get(finding.conceptId) ?? 0, finding.populationN ?? 0),
    );
  }

  /*
   * Never below what was actually observed: a population smaller than the
   * entities in front of us is a caller mistake, and believing it would inflate
   * every lift in the result.
   */
  const populationOf = (a: Condition, b: Condition): number => {
    const stated = options.population ?? 0;
    const perConcept = Math.max(
      examined.get(a.conceptId) ?? 0,
      examined.get(b.conceptId) ?? 0,
    );
    return Math.max(stated, perConcept, everyEntity.size);
  };

  if (everyEntity.size === 0) return { associations: [], crossConceptSkipped: 0 };

  const related = options.related ?? [];

  /*
   * A CONCEPT PAIR IS RELATABLE ONLY IF THE SCHEMA SAYS SO. The instance links
   * say which rows point at which; the declared relationships say whether that
   * link is one the customer's model actually describes. Both are required —
   * a key value matching across two concepts nobody connected is a coincidence,
   * which is the class of finding this layer used to fabricate.
   */
  const relatedConcepts = new Set(
    (options.edges ?? []).map((edge) =>
      edge.from < edge.to
        ? `${edge.from}\u0000${edge.to}`
        : `${edge.to}\u0000${edge.from}`,
    ),
  );

  const all = [...conditions.values()];
  const associations: Association[] = [];
  /** Pairs spanning two concepts, which this layer cannot evaluate. See below. */
  let skipped = 0;

  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      const crossConcept = all[i]!.condition.conceptId !== all[j]!.condition.conceptId;

      /*
       * ── Two concepts need a declared relationship, not a coincidence ──────
       *
       * Entities are scoped to their concept, so two conditions on different
       * concepts share no entity by construction and have nothing to count.
       * What relates them is a key one of their rows CARRIED — this invoice
       * naming that order — which arrives as `related`.
       *
       * A pair with no declared relationship between the concepts is still
       * refused and counted. Two things co-occurring across a link the
       * customer's schema never declared is the coincidence this layer used to
       * report as a finding.
       */
      if (crossConcept) {
        if (!relatedConcepts.has(conceptPair(all[i]!.condition, all[j]!.condition))) {
          skipped += 1;
          continue;
        }
      }

      /* Canonical order, so the pair is stored the way the constraint expects
         and a recompute cannot produce its mirror image. */
      const [first, second] =
        compareCondition(all[i]!.condition, all[j]!.condition) <= 0
          ? [all[i]!, all[j]!]
          : [all[j]!, all[i]!];

      /*
       * SAME CONCEPT COMPARES AN ENTITY WITH ITSELF; DIFFERENT CONCEPTS COMPARE
       * A PAIR. The second is over the related pairs that are VISIBLE — a link
       * exists only where a finding was raised, so this cannot see two related
       * instances that were both clean. The ratio is therefore conditional on
       * something having been found, which is stated rather than hidden: it is
       * the honest denominator for what was actually looked at.
       */
      const paired = crossConcept
        ? pairsAcross(first.entities, second.entities, related)
        : null;

      const shared = paired
        ? paired.both
        : [...first.entities].filter((entity) => second.entities.has(entity));

      if (shared.length < minCoOccurrence) continue;

      const union = paired
        ? paired.either
        : new Set([...first.entities, ...second.entities]).size;

      /*
       * What independence would predict: the two rates multiplied, over the
       * population. Written as `|A| * |B| / N` because that is the same number
       * with one fewer division to round.
       */
      const expected = paired
        ? (paired.fromSeen * paired.toSeen) / Math.max(1, paired.visible)
        : (first.entities.size * second.entities.size) /
          populationOf(first.condition, second.condition);

      const lift = expected === 0 ? 0 : shared.length / expected;
      const strength = union === 0 ? 0 : shared.length / union;

      /*
       * TWO GATES, BECAUSE THEY ARE TWO DIFFERENT POPULATIONS. Within a concept
       * the denominator is unconditioned and lift is the right test — it is what
       * separates a real pattern from two conditions that are merely both
       * common. Across concepts the denominator is conditioned on a finding
       * existing, so lift is near 1 by construction and the share is the only
       * honest measure. See `MIN_CROSS_STRENGTH`.
       */
      if (paired ? strength < MIN_CROSS_STRENGTH : lift < minLift) continue;

      associations.push({
        a: first.condition,
        b: second.condition,
        coOccurrence: shared.length,
        sampleSize: union,
        strength: Math.round(strength * 1000) / 1000,
        lift: Math.round(lift * 1000) / 1000,
        temporalOrder: orderOf(shared, first.when, second.when),
        structuralDirection: directionOf(first.condition, second.condition, options.edges),
      });
    }
  }

  /*
   * STRONGEST FIRST, WITH A TOTAL ORDER UNDERNEATH. Lift decides, strength
   * breaks the tie, and the canonical keys break that — so the same findings
   * always list in the same order and a reviewer can tell a new association
   * from a reordered one.
   */
  /*
   * STRONGEST FIRST, WITH A TOTAL ORDER UNDERNEATH. Lift decides, strength
   * breaks the tie, and the canonical keys break that — compared as plain
   * strings rather than with `localeCompare`, whose result depends on the
   * runtime's ICU data and would order findings differently on two machines
   * running the same build.
   */
  const ordered = associations.sort(
    (x, y) =>
      y.lift - x.lift ||
      y.strength - x.strength ||
      (keyOf(x.a) < keyOf(y.a) ? -1 : keyOf(x.a) > keyOf(y.a) ? 1 : 0) ||
      (keyOf(x.b) < keyOf(y.b) ? -1 : keyOf(x.b) > keyOf(y.b) ? 1 : 0),
  );

  return { associations: ordered, crossConceptSkipped: skipped };
}
