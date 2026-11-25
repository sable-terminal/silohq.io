// Conditions (spec 40.3), evaluated over one run's answer and the state kept from the last.
// Pure: the facts and the previous state come in, the outcome and the next state go out.
//
// Result conditions read the answer's size; "differs from previous" compares a keyed hash of
// the whole answer with the last run's, never the rows. Value conditions read one figure: a
// measure of a single-group answer, or a property of a single object. A figure that is
// disputed, empty, masked, redacted or left with excluded inputs is indeterminate, and so is
// any condition over it, because a condition over an undecided value produces an answer that
// looks right.
//
// The first run has nothing to compare with: "differs from previous", "changed by
// proportion" and "unchanged for" are not met on it, and it records the baseline. A count
// "crossed" a threshold when it is on the stated side now and was not at the last run (the
// first run: when it is on the stated side).
//
// Finding conditions read the findings a detector raised on a type since the last check (the
// Cron's creation, before its first run): raised, any; score_above, any scoring above the
// threshold; recurred, any whose latest earlier finding on the same objects had gone away (was
// superseded before the new one was raised, not by it). Findings that could not be read are
// indeterminate.
//
// Composites: AND is not met if any operand is not met, else indeterminate if any is, else
// met. OR is met if any operand is met, else indeterminate if any is, else not met.

import type { ConditionView, Figure } from '../../contracts/scheduler/cron.contract.ts';

export type Outcome = 'met' | 'not_met' | 'indeterminate';

export interface FigureState { v: number; changedAt: string }

export interface RunFacts {
  /** Objects or groups in the answer. */
  total: number;
  /** Hex of the keyed hash of the whole answer, when a condition needs it. */
  resultHash: string | undefined;
  /** One figure, or undefined when the answer does not decide it. */
  figure(f: Figure): number | undefined;
  /** A finding condition's findings (raised since before the last check, superseded too), or undefined where they could not be read. */
  findings?(condition: ConditionView): readonly FindingFact[] | undefined;
}

export interface FindingFact { objectIds: readonly string[]; score: number; raisedAt: string; supersededAt: string | null }

export interface PreviousState {
  resultHash: string | null;
  rowCount: number | null;
  figures: Record<string, FigureState>;
  /** When findings were last checked: a finding raised after it is new. */
  findingsSince?: string | undefined;
}

export interface Evaluation {
  outcome: Outcome;
  /** The state to keep for the next run. */
  next: { resultHash: string | undefined; rowCount: number; figures: Record<string, FigureState> };
}

export const figureKey = (f: Figure): string => ('measure' in f ? `measure:${f.measure}` : `property:${f.property}`);

/** Whether any condition in the tree needs the answer's hash. */
export function needsHash(node: ConditionView | null): boolean {
  if (node === null) return false;
  if (node.kind === 'result' && node.operator === 'differs_from_previous') return true;
  return node.operands.some(needsHash);
}

/** The finding conditions in the tree. */
export function findingNodes(node: ConditionView | null): ConditionView[] {
  if (node === null) return [];
  if (node.kind === 'finding') return [node];
  return node.operands.flatMap(findingNodes);
}

/** The figures the tree reads. */
export function figuresOf(node: ConditionView | null): Figure[] {
  if (node === null) return [];
  if (node.kind === 'value') return [node.target as Figure];
  return node.operands.flatMap(figuresOf);
}

function evaluateNode(node: ConditionView, facts: RunFacts, previous: PreviousState, now: number): Outcome {
  if (node.kind === 'composite') {
    const outcomes = node.operands.map((o) => evaluateNode(o, facts, previous, now));
    if (node.combinator === 'AND') {
      if (outcomes.includes('not_met')) return 'not_met';
      return outcomes.includes('indeterminate') ? 'indeterminate' : 'met';
    }
    if (outcomes.includes('met')) return 'met';
    return outcomes.includes('indeterminate') ? 'indeterminate' : 'not_met';
  }
  const value = (node.value ?? {}) as { threshold?: number; direction?: 'above' | 'below'; proportion?: number; hours?: number };
  if (node.kind === 'result') {
    switch (node.operator) {
      case 'returned_rows': return facts.total > 0 ? 'met' : 'not_met';
      case 'returned_none': return facts.total === 0 ? 'met' : 'not_met';
      case 'count_crossed': {
        const side = (count: number) => (value.direction === 'above' ? count > value.threshold! : count < value.threshold!);
        if (!side(facts.total)) return 'not_met';
        return previous.rowCount === null || !side(previous.rowCount) ? 'met' : 'not_met';
      }
      case 'differs_from_previous':
        return previous.resultHash !== null && facts.resultHash !== undefined && facts.resultHash !== previous.resultHash ? 'met' : 'not_met';
      default: return 'indeterminate';
    }
  }
  if (node.kind === 'value') {
    const f = node.target as Figure;
    const current = facts.figure(f);
    if (current === undefined) return 'indeterminate';
    const before = previous.figures[figureKey(f)];
    switch (node.operator) {
      case 'above': return current > value.threshold! ? 'met' : 'not_met';
      case 'below': return current < value.threshold! ? 'met' : 'not_met';
      case 'changed_by_proportion': {
        if (before === undefined) return 'not_met';
        if (before.v === 0) return current !== 0 ? 'met' : 'not_met';
        return Math.abs(current - before.v) / Math.abs(before.v) > value.proportion! ? 'met' : 'not_met';
      }
      case 'unchanged_for': {
        if (before === undefined || before.v !== current) return 'not_met';
        return now - Date.parse(before.changedAt) >= value.hours! * 3_600_000 ? 'met' : 'not_met';
      }
      default: return 'indeterminate';
    }
  }
  if (node.kind === 'finding') {
    const found = facts.findings?.(node);
    if (found === undefined) return 'indeterminate';
    const since = previous.findingsSince === undefined ? Number.NEGATIVE_INFINITY : Date.parse(previous.findingsSince);
    const fresh = found.filter((f) => Date.parse(f.raisedAt) > since);
    const objects = (f: FindingFact) => [...f.objectIds].sort().join(',');
    switch (node.operator) {
      case 'raised': return fresh.length > 0 ? 'met' : 'not_met';
      case 'score_above': return fresh.some((f) => f.score > value.threshold!) ? 'met' : 'not_met';
      case 'recurred':
        // The latest earlier finding on the same objects had gone away before this one was raised:
        // raised again in the very next run, it never went away.
        return fresh.some((f) => {
          const earlier = found.filter((e) => e !== f && objects(e) === objects(f) && Date.parse(e.raisedAt) < Date.parse(f.raisedAt))
            .sort((a, b) => Date.parse(b.raisedAt) - Date.parse(a.raisedAt))[0];
          return earlier !== undefined && earlier.supersededAt !== null && Date.parse(earlier.supersededAt) < Date.parse(f.raisedAt);
        }) ? 'met' : 'not_met';
      default: return 'indeterminate';
    }
  }
  return 'indeterminate';
}

export function evaluate(tree: ConditionView | null, facts: RunFacts, previous: PreviousState, now: number): Evaluation {
  const outcome = tree === null ? 'met' : evaluateNode(tree, facts, previous, now);
  const figures: Record<string, FigureState> = { ...previous.figures };
  for (const f of figuresOf(tree)) {
    const current = facts.figure(f);
    if (current === undefined) continue;
    const key = figureKey(f);
    const before = figures[key];
    figures[key] = before !== undefined && before.v === current ? before : { v: current, changedAt: new Date(now).toISOString() };
  }
  return { outcome, next: { resultHash: facts.resultHash ?? previous.resultHash ?? undefined, rowCount: facts.total, figures } };
}
