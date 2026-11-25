import { at, deviationOf, keyOf, numeric, type Row } from './shared.detector';
/*
 * FROM THE MODEL, NOT THE SERVICE. A type import is still an import: it makes
 * the engine's build depend on a module that opens transactions and checks
 * permissions, and the next person needing a value rather than a type has a
 * path already drawn for them. §3.3's determinism rests on this layer reaching
 * nothing.
 */
import type { ContributingObject } from '../../models/concept.model';
import { certaintyOf, type Certainty } from '../ontology/merge.ontology';

/**
 * §3 — Disagreement. Two systems reporting different values for the same entity
 * and measure.
 *
 * THE FIRST DETECTOR BECAUSE IT IS THE THING NO DASHBOARD CAN DO. A dashboard
 * reads one system and renders it faithfully. It cannot notice that the other
 * system says something else, because it never asked the other system. This is
 * the whole argument for federation in one computation.
 *
 * ARITHMETIC, AND NOTHING ELSE. §3.3 — no model participates, the same data
 * produces the same findings, and every finding can be explained by showing the
 * subtraction. What is hard here is not the maths; it is being honest about
 * which rows are the same entity, and that answer comes from the ontology
 * rather than from this file.
 *
 * EXACT RESOLUTION, NEVER FUZZY. §2.6. Two rows are the same entity when their
 * match keys are equal, string for string. Where they are not, this does not
 * reach for a similarity score — it emits an unresolved pair and stops. A wrong
 * merge produces a confident finding about an entity that does not exist, which
 * is worse than no finding at all.
 */

function withCertainty<T extends { fieldPath: string }>(reading: T, row: Row): T & { certainty?: Certainty } {
  const certainty = certaintyOf(row as Record<string, unknown>, reading.fieldPath);
  return certainty ? { ...reading, certainty } : reading;
}

export type SourceRows = {
  connectionId: string;
  object: ContributingObject;
  rows: Row[];
};

export type Disagreement = {
  entityRef: string;
  measure: string;
  /** Per source, so the finding can name both sides. */
  readings: Array<{ connectionId: string; value: number; fieldPath: string; certainty?: Certainty }>;
  observed: number;
  expected: number;
  deviation: number;
};

export type Unresolved = {
  connectionA: string;
  valueRefA: string;
  connectionB: string;
  valueRefB: string;
};

export type DisagreementOutcome = {
  findings: Disagreement[];
  unresolved: Unresolved[];
  /** How many entities were compared, which §4.1 requires stated always. */
  compared: number;
};

/*
 * `keyOf` LIVES IN `shared.ts`, with the trimming-and-case rule and the reason
 * a partial key is no key. Every detector has to answer those the same way or
 * their findings cannot be compared, which §5's ranking layer has to do.
 *
 * ORDERED, AND ALL OF THEM: an entity may need more than one field to be
 * identified — an invoice number is unique per supplier, not globally.
 */

/**
 * Compare one measure across exactly two sources.
 *
 * TWO, NOT N. Three systems disagreeing is three pairwise disagreements, and
 * flattening them into one finding loses which pair differs — which is the only
 * thing anybody can act on. The caller pairs the sources; this compares a pair.
 */
export function detectDisagreement(
  a: SourceRows,
  b: SourceRows,
  measure: { fieldPathA: string; fieldPathB: string; name: string },
  options: {
    tolerance: number;
    /**
     * §2.6 — pairs a person has already confirmed are the same entity.
     *
     * ── Why a detector has to know about these ────────────────────────────
     *
     * Without them, confirming a resolution SILENCES A QUESTION WITHOUT
     * ANSWERING IT. The unresolved pair leaves the queue because it is marked
     * confirmed, and the two rows still fail to match on the next run — so the
     * records somebody took the trouble to reconcile are never compared with
     * each other, and never will be. The screen says resolved and nothing is.
     *
     * APPLIED AS FACT, NEVER RE-INFERRED. §2.6 — a person said these two are
     * one thing. Nothing here weighs that against the match keys or second
     * guesses it; it is used exactly where the keys came up empty.
     */
    aliases?: ReadonlyArray<{
      connectionA: string;
      valueRefA: string;
      connectionB: string;
      valueRefB: string;
    }>;
  },
): DisagreementOutcome {
  const index = new Map<string, Row>();

  /*
   * Rows of B by their own identifier, for the confirmed-pair path below.
   *
   * AMBIGUOUS IS THE SAME AS ABSENT. Two rows whose identifiers differ only in
   * case or spacing normalise to one string, and the first version let the
   * second overwrite the first — so a confirmation could be honoured against
   * whichever row happened to be indexed last, producing a confident
   * disagreement about a record nobody confirmed. That is a duplication finding
   * in B's own system; here it means the confirmation cannot be placed, and
   * saying so is the only safe answer.
   */
  const byRef = new Map<string, Row | null>();

  for (const row of b.rows) {
    const ref = String(at(row, b.object.identifierField) ?? '').trim().toLowerCase();
    if (ref !== '') byRef.set(ref, byRef.has(ref) ? null : row);

    const key = keyOf(row, b.object.matchKeys);
    if (key === null) continue;
    index.set(key, row);
  }

  /*
   * WHICH REF IN A NAMES WHICH REF IN B, in whichever order the pair was
   * stored. `confirmed_resolutions` keeps one canonical row per mapping —
   * ordered by connection id — so both orientations have to be read here.
   */
  const confirmed = new Map<string, string>();
  for (const alias of options.aliases ?? []) {
    if (alias.connectionA === a.connectionId && alias.connectionB === b.connectionId) {
      confirmed.set(alias.valueRefA.trim().toLowerCase(), alias.valueRefB.trim().toLowerCase());
    } else if (alias.connectionB === a.connectionId && alias.connectionA === b.connectionId) {
      confirmed.set(alias.valueRefB.trim().toLowerCase(), alias.valueRefA.trim().toLowerCase());
    }
  }

  const findings: Disagreement[] = [];
  const unresolved: Unresolved[] = [];
  let compared = 0;

  for (const rowA of a.rows) {
    const key = keyOf(rowA, a.object.matchKeys);
    const refA = String(at(rowA, a.object.identifierField) ?? '');

    /*
     * ── THE CONFIRMED PAIR IS CONSULTED EVEN WITHOUT A MATCH KEY ────────────
     *
     * This lookup used to sit after a `continue` on a null key, so a
     * confirmation stopped applying the moment the match-key field was blanked
     * in either system — and the row then vanished from the findings AND from
     * the review queue, because neither branch had been reached. A person had
     * already said these two records are the same thing; a missing key in a
     * column they were not asked about does not withdraw that.
     */
    const named = confirmed.get(refA.trim().toLowerCase());
    const viaConfirmation = named ? byRef.get(named) ?? undefined : undefined;

    if (key === null && !viaConfirmation) {
      /* Nothing to match on and nobody has said otherwise. Not a disagreement;
         not silently dropped either. */
      continue;
    }

    /*
     * THE KEYS FIRST, THEN WHAT SOMEBODY CONFIRMED. A confirmed pair is only
     * consulted where the match keys found nothing — it exists precisely for
     * the rows the keys could not join, and letting it override a key match
     * would let an old confirmation outrank current data.
     */
    const rowB = (key === null ? undefined : index.get(key)) ?? viaConfirmation;

    if (!rowB) {
      /*
       * §2.6 — DELEGATED, NOT GUESSED. There is a row here and no row there
       * under the same key, and nobody has said the two are one thing. That is
       * either a genuinely missing record or two spellings of one entity, and
       * this detector cannot tell the difference. It says so, and a person
       * decides.
       */
      unresolved.push({
        connectionA: a.connectionId,
        valueRefA: refA,
        connectionB: b.connectionId,
        valueRefB: '',
      });
      continue;
    }

    const valueA = numeric(at(rowA, measure.fieldPathA));
    const valueB = numeric(at(rowB, measure.fieldPathB));

    /*
     * ABSENCE IS A DIFFERENT DETECTOR'S JOB. One side holding no figure is not
     * two systems disagreeing about a figure — §3's `absence` detector is where
     * that belongs, and reporting it here would put the wrong name on it.
     */
    if (valueA === null || valueB === null) continue;

    compared += 1;

    const difference = Math.abs(valueA - valueB);
    if (difference === 0) continue;

    /* Normalised against the larger side — see `deviationOf`, which every
       detector shares so their findings can be ranked against each other. */
    const deviation = deviationOf(valueA, valueB);

    if (deviation <= options.tolerance) continue;

    findings.push({
      entityRef: refA,
      measure: measure.name,
      /* Import §5 — into findings: a side read from a document says so. */
      readings: [
        withCertainty({ connectionId: a.connectionId, value: valueA, fieldPath: measure.fieldPathA }, rowA),
        withCertainty({ connectionId: b.connectionId, value: valueB, fieldPath: measure.fieldPathB }, rowB),
      ],
      /*
       * `observed` AND `expected` ARE A AND B IN THE ORDER GIVEN, and neither is
       * the truth. Calling one expected would be the detector picking a winner
       * between two systems it knows nothing about; the pair is the finding.
       */
      observed: valueA,
      expected: valueB,
      deviation,
    });
  }

  return { findings, unresolved, compared };
}

/**
 * §3.4 — the first threshold, derived from the question rather than configured.
 *
 * DERIVED, SO A NEWLY CONNECTED SYSTEM WORKS IMMEDIATELY. No stored setting is
 * required for a first run. The model tunes it afterwards and the tuning
 * persists against the concept and detector, so the second run uses what was
 * learned rather than this.
 *
 * SMALLER POPULATIONS TOLERATE LESS. Over a handful of entities every
 * difference is worth seeing; over ten thousand, a half-percent difference on
 * every row is a rounding convention between two systems rather than ten
 * thousand things to look at.
 */
export function deriveTolerance(populationN: number): number {
  if (populationN <= 20) return 0;
  if (populationN <= 500) return 0.005;
  return 0.01;
}
