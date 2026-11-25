import { createHash } from 'node:crypto';

/**
 * §3 — what has to be true for an automation to act.
 *
 * ── The digest is how "did it change" exists in a product that stores nothing ─
 *
 * "The result differs from the previous run... it needs the previous result
 * retained. Not the rows, a hash plus the count, which holds the no-values
 * line." So `digestOf` reduces an answer to a fixed-width string that cannot be
 * read back into values, and the count travels beside it because a digest alone
 * cannot say whether an empty result is empty or broken.
 *
 * ── Left to right, with no precedence ──────────────────────────────────────
 *
 * §3 bounds conditions at a small depth and says anything deeper is a question.
 * So `A or B and C` is read strictly left to right — ((A or B) and C) — rather
 * than giving `and` the precedence it has in every programming language.
 * Borrowing that precedence would mean the builder shows a flat list and the
 * engine evaluates a tree, and the two would disagree about an automation
 * somebody is relying on. A flat list evaluated flatly is the only version a
 * person can check by reading it.
 */

export type ConditionKind = 'result' | 'finding' | 'value';

export type Condition = {
  kind: ConditionKind;
  target: string | null;
  operator: string;
  value: unknown;
  combinator: 'and' | 'or';
  sequence: number;
};

/** §3's result operators. The kinds that need run state are named as such. */
export const RESULT_OPERATORS = [
  'any_rows',
  'no_rows',
  'row_count_above',
  'row_count_below',
  'changed',
] as const;

export type ResultOperator = (typeof RESULT_OPERATORS)[number];

/**
 * §3's finding operators.
 *
 * `detector_raised` IS THE ONE §3 CALLS MOST POWERFUL, because the checks
 * already run: the automation is "tell me when this kind of problem appears"
 * and there is no question to author at all.
 */
export const FINDING_OPERATORS = ['detector_raised', 'score_above', 'recurred'] as const;

export type FindingOperator = (typeof FINDING_OPERATORS)[number];

/**
 * §3's value operators, evaluated against a single figure the question returns.
 *
 * `crossed_`, NOT `is_`. §3's word is "crossed", and the difference is the
 * whole usefulness of it: "is above 100,000" is true every run once it is true,
 * so it notifies every morning until somebody turns it off. A crossing fires on
 * the run where it happened and then goes quiet.
 */
export const VALUE_OPERATORS = ['crossed_above', 'crossed_below', 'changed_by', 'unchanged_for'] as const;

export type ValueOperator = (typeof VALUE_OPERATORS)[number];

/** What matched, reduced to what a condition needs. Never an entity reference. */
export type RaisedFinding = {
  id: string;
  detector: string;
  conceptId: string;
  score: number | null;
  raisedCount: number;
};

export type Facts = {
  rowCount: number;
  resultHash: string;
  previous: { resultHash: string | null; rowCount: number | null } | null;
  /*
   * §3 — what the ten checks raised since this automation last looked. Empty
   * for a view automation, which has no findings to answer about.
   */
  findings?: readonly RaisedFinding[];
  /*
   * §3 — "a single figure the question returns". Null where the question
   * returned no figure to compare, which is NOT zero: a sum of nothing is not
   * nought, and treating it as nought would fire every "below" condition on
   * the morning a question stopped matching anything.
   */
  figure?: number | null;
  previousFigure?: number | null;
  /** When the figure last took a different value. */
  unchangedSince?: Date | null;
  now?: Date;
};

export type Outcome = {
  met: boolean;
  /** One line per condition, in order, for the run record and for a person. */
  because: string[];
};

/**
 * A stable digest of an answer.
 *
 * SORTED AND CANONICAL, because two runs that returned the same entities in a
 * different order have not changed, and a digest that said they had would fire
 * an automation every morning for no reason — which is how somebody learns to
 * ignore it.
 */
export function digestOf(entities: ReadonlyArray<{ members: ReadonlyArray<{ connectionId: string; ref: string }> }>): string {
  const refs = entities
    .map((entity) =>
      entity.members
        .map((member) => `${member.connectionId}:${member.ref}`)
        .sort()
        .join('|'),
    )
    .sort();

  return createHash('sha256').update(refs.join('\n')).digest('hex');
}

/**
 * Whether the conditions hold.
 *
 * NO CONDITIONS IS TRUE, and §2 says so outright: "A question with no condition
 * is a schedule that always fires." It is a valid automation, not a broken one.
 */
export function evaluate(conditions: readonly Condition[], facts: Facts): Outcome {
  if (conditions.length === 0) {
    return { met: true, because: ['No condition, so the schedule always fires.'] };
  }

  const ordered = [...conditions].sort((a, b) => a.sequence - b.sequence);
  const because: string[] = [];
  let running: boolean | null = null;

  for (const condition of ordered) {
    const { met, why } = one(condition, facts);
    because.push(why);

    /* The first condition's combinator is meaningless: there is nothing to its
       left. Recorded on the row anyway so the order can be changed without
       rewriting what each row means. */
    running = running === null ? met : condition.combinator === 'or' ? running || met : running && met;
  }

  return { met: running ?? false, because };
}

function one(condition: Condition, facts: Facts): { met: boolean; why: string } {
  if (condition.kind === 'finding') return finding(condition, facts.findings ?? []);
  if (condition.kind === 'value') return figure(condition, facts);

  if (condition.kind !== 'result') {
    /*
     * An unevaluable kind is refused rather than treated as false: an
     * automation that silently never fires looks exactly like one whose
     * condition is never true, and the owner would have no way to tell which
     * they had.
     */
    throw new Error(`Condition kind "${condition.kind}" is not evaluated yet.`);
  }

  const threshold = typeof condition.value === 'number' ? condition.value : Number(condition.value);

  switch (condition.operator as ResultOperator) {
    case 'any_rows':
      return { met: facts.rowCount > 0, why: `Returned ${facts.rowCount} row(s).` };

    case 'no_rows':
      return { met: facts.rowCount === 0, why: `Returned ${facts.rowCount} row(s).` };

    case 'row_count_above':
      return {
        met: facts.rowCount > threshold,
        why: `Row count ${facts.rowCount} against a threshold of ${threshold}.`,
      };

    case 'row_count_below':
      return {
        met: facts.rowCount < threshold,
        why: `Row count ${facts.rowCount} against a threshold of ${threshold}.`,
      };

    /*
     * §3 — "The result differs from the previous run... The last is the one
     * people actually want."
     *
     * THE FIRST RUN DOES NOT FIRE. With nothing to compare against, "changed"
     * has no answer, and treating it as changed would make every new automation
     * notify once for nothing on the morning it was created.
     */
    case 'changed': {
      if (!facts.previous || facts.previous.resultHash === null) {
        return { met: false, why: 'First run, so there is nothing to compare against yet.' };
      }

      const changed =
        facts.previous.resultHash !== facts.resultHash || facts.previous.rowCount !== facts.rowCount;

      return {
        met: changed,
        why: changed
          ? `Result differs from the previous run (${facts.previous.rowCount} row(s) then, ${facts.rowCount} now).`
          : 'Result is the same as the previous run.',
      };
    }

    default:
      throw new Error(`Unknown result operator "${condition.operator}".`);
  }
}

/**
 * §3 — evaluated against what the ten checks raised.
 *
 * THE SET IS ALREADY NARROWED BY THE TIME IT ARRIVES. Which detector, which
 * concept and how recent are all decided in SQL, because they are a query and
 * not a judgement. What is left here is the part that has to be read back to a
 * person: whether anything survived that narrowing, and why.
 *
 * COUNTS, NEVER REFERENCES. A finding names an entity, and an automation that
 * put those into an email or a run record would carry customer identifiers out
 * of the trail's narrow shape. The answer is how many, and of what kind.
 */
function finding(condition: Condition, raised: readonly RaisedFinding[]): { met: boolean; why: string } {
  const named = condition.target ? raised.filter((one) => one.detector === condition.target) : raised;
  const detectorSaid = condition.target ? `"${condition.target}"` : 'a check';

  switch (condition.operator as FindingOperator) {
    case 'detector_raised':
      return {
        met: named.length > 0,
        why: `${detectorSaid} raised ${named.length} finding(s) since the last run.`,
      };

    case 'score_above': {
      /*
       * THE THRESHOLD IS APPLIED IN SQL TOO, and re-applied here rather than
       * trusted. The query narrows for speed; this is what the run record says
       * happened, and the two agreeing is what makes the record checkable.
       */
      const threshold = Number(condition.value ?? 0);
      const over = named.filter((one) => one.score !== null && one.score >= threshold);
      return {
        met: over.length > 0,
        why: `${over.length} finding(s) at or above a score of ${threshold}.`,
      };
    }

    /*
     * §3 — "A finding recurred."
     *
     * A RECURRENCE IS A ROW RAISED MORE THAN ONCE, not a second row. The same
     * fact found twice is one finding with its count moved, which is what makes
     * "this keeps happening" answerable at all — and it is why the default is
     * twice rather than once.
     */
    case 'recurred': {
      const times = Math.max(2, Number(condition.value ?? 2));
      const again = named.filter((one) => one.raisedCount >= times);
      return {
        met: again.length > 0,
        why: `${again.length} finding(s) raised ${times} or more times.`,
      };
    }

    default:
      throw new Error(`Unknown finding operator "${condition.operator}".`);
  }
}

/**
 * §3 — evaluated against a single figure the question returns.
 *
 * ── A MISSING FIGURE IS NOT A ZERO, AND NOTHING HERE PRETENDS OTHERWISE ────
 *
 * `Aggregated.value` is deliberately nullable: "a sum of nothing is not nought,
 * and reporting it as nought would be a figure somebody could act on". So a
 * null figure means every value condition is unanswerable rather than false —
 * because false is a claim, and the honest state is that the question stopped
 * returning the thing being watched. The owner is told that instead.
 */
function figure(condition: Condition, facts: Facts): { met: boolean; why: string } {
  const now = facts.figure ?? null;

  if (now === null) {
    return { met: false, why: 'The question returned no figure to compare, so nothing could be decided.' };
  }

  const previous = facts.previousFigure ?? null;
  const operand = Number(condition.value ?? 0);

  switch (condition.operator as ValueOperator) {
    /*
     * CROSSED, NOT IS. It fires on the run where the figure went past the line
     * and then stops. A first run with no previous reading counts as a crossing
     * if it is already past: the alternative is silence about a threshold that
     * is already breached, which is the opposite of what somebody asked for.
     */
    case 'crossed_above': {
      const over = now > operand;
      const wasOver = previous !== null && previous > operand;
      return {
        met: over && !wasOver,
        why: over
          ? wasOver
            ? `Still above ${operand} (${now}), as it was last run.`
            : `Rose past ${operand} to ${now}.`
          : `At ${now}, below ${operand}.`,
      };
    }

    case 'crossed_below': {
      const under = now < operand;
      const wasUnder = previous !== null && previous < operand;
      return {
        met: under && !wasUnder,
        why: under
          ? wasUnder
            ? `Still below ${operand} (${now}), as it was last run.`
            : `Fell past ${operand} to ${now}.`
          : `At ${now}, above ${operand}.`,
      };
    }

    /*
     * §3 — "Changed by more than a proportion since the last run."
     *
     * A PROPORTION OF WHAT IT WAS, so a move from 0 has no proportion to be
     * measured against. Reporting that as an infinite change would fire on
     * every figure that started at nothing, which is most of them on the day a
     * connection is added.
     */
    case 'changed_by': {
      if (previous === null) {
        return { met: false, why: 'First run, so there is nothing to measure a change against yet.' };
      }
      if (previous === 0) {
        return {
          met: false,
          why: `Was nothing and is now ${now}; a proportion of nothing cannot be measured.`,
        };
      }

      const moved = Math.abs(now - previous) / Math.abs(previous);
      return {
        met: moved > operand,
        why: `Moved ${(moved * 100).toFixed(1)}% (${previous} to ${now}) against a limit of ${(operand * 100).toFixed(1)}%.`,
      };
    }

    /*
     * §3 — "Has not changed in a stated period."
     *
     * THE ONE CONDITION THAT FIRES BECAUSE NOTHING HAPPENED, which is why it
     * needs a remembered instant rather than a comparison. A figure still at
     * 400 may have been still for six months or since yesterday, and two
     * consecutive readings cannot tell the difference.
     */
    case 'unchanged_for': {
      if (!facts.unchangedSince) {
        return { met: false, why: 'Not yet seen twice, so how long it has been still is unknown.' };
      }

      const days = (((facts.now ?? new Date()).getTime() - facts.unchangedSince.getTime()) / 86_400_000);
      return {
        met: days >= operand,
        why: `Unchanged at ${now} for ${days.toFixed(1)} day(s), against ${operand}.`,
      };
    }

    default:
      throw new Error(`Unknown value operator "${condition.operator}".`);
  }
}
