// State rule compilation and evaluation (spec 28.4, 28.5): one implementation, shared by
// the state plane (in process) and mirrored by the client, keyed by the compiled hash.
// Pure: no I/O. No model is involved (invariant 5).
//
// A condition is CEL over self (the declared inputs, by API name) and now. What it reads is
// found statically: self.<name> occurrences outside string literals. Indexing self, using
// self bare, or naming anything but a declared input fails validation at save, so the
// inputs a rule declares are exactly what the state plane must subscribe to.
//
// Evaluation, for one object under one viewer:
// 1. each condition, in order: if it reads an input the viewer may not see, the state is
//    unknown ("depends on a field not visible to you"), since a state derived from a hidden
//    field would disclose it; if it reads a null input, unknown; if it fails on its input,
//    unknown; if true, its state; if false, the next. None true: normal;
// 2. staleness first in what is shown: when any input is stale and the walk did not end on
//    a hidden input, the state is stale, carrying the last known state the walk reached.

import { canonicalJsonBytes } from '../../utils/canonicalJson.util.ts';
import { sha256 } from '../../utils/crypto.util.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import type { CloneState, StateRuleEntry } from '../../contracts/canvas-layout/stateRule.contract.ts';
import { compileCel, type CompiledCel } from '../expression-evaluator/cel.service.ts';

/** Each condition is bounded from inside, as every expression is (spec 14.2). */
const BOUNDS = { steps: 10_000, timeMs: 10 };

export interface RuleInput {
  propertyIdentityId: string;
  apiName: string;
  dataType: string;
}

export interface CompiledRule {
  state: StateRuleEntry['state'];
  reason: string;
  reads: string[];
  program: CompiledCel;
}

export interface CompiledStateRules {
  hash: string;
  inputs: RuleInput[];
  rules: CompiledRule[];
}

export interface RuleIssue {
  rule: number;
  code: 'parse' | 'undeclared_input' | 'self_misused' | 'function_unavailable' | 'reads_nothing';
  message: string;
}

/** Removes string literals, so a name inside quotes is never taken for a read. */
const withoutStrings = (source: string): string =>
  source.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, '""');

/** The inputs a condition reads, or the issue that refuses it. */
export function readsOf(when: string, declared: ReadonlySet<string>): { reads: string[] } | { issue: RuleIssue['code']; message: string } {
  const code = withoutStrings(when);
  if (/\bfn\s*\./.test(code)) {
    return { issue: 'function_unavailable', message: 'ontology Functions are not read in state rules yet: compare inputs and now directly' };
  }
  const reads = new Set<string>();
  const selfUse = /\bself\b(\s*\.\s*([A-Za-z_][A-Za-z0-9_]*))?/g;
  for (const match of code.matchAll(selfUse)) {
    const name = match[2];
    if (name === undefined) return { issue: 'self_misused', message: 'self is read only as self.<input>' };
    if (!declared.has(name)) return { issue: 'undeclared_input', message: `${name} is not a declared input` };
    reads.add(name);
  }
  return { reads: [...reads].sort() };
}

export function compiledHash(inputs: readonly RuleInput[], rules: readonly StateRuleEntry[], freshnessWindowSeconds: number): string {
  return sha256(canonicalJsonBytes({
    inputs: [...inputs].map((i) => i.propertyIdentityId).sort(), rules, freshnessWindowSeconds,
  })).toString('hex');
}

/** Validates and compiles. Every issue is returned at once, so a person can fix them together. */
export function compileStateRules(inputs: readonly RuleInput[], rules: readonly StateRuleEntry[], freshnessWindowSeconds: number)
  : { compiled: CompiledStateRules } | { issues: RuleIssue[] } {
  const declared = new Set(inputs.map((i) => i.apiName));
  const issues: RuleIssue[] = [];
  const out: CompiledRule[] = [];
  rules.forEach((rule, index) => {
    const found = readsOf(rule.when, declared);
    if ('issue' in found) {
      issues.push({ rule: index, code: found.issue, message: found.message });
      return;
    }
    let program: CompiledCel;
    try {
      program = compileCel(rule.when, { self: 'map', now: 'timestamp' });
    } catch (error) {
      issues.push({ rule: index, code: 'parse', message: isAppError(error) ? error.message : 'the condition does not compile' });
      return;
    }
    out.push({ state: rule.state, reason: rule.reason, reads: found.reads, program });
  });
  if (issues.length > 0) return { issues };
  return { compiled: { hash: compiledHash(inputs, rules, freshnessWindowSeconds), inputs: [...inputs], rules: out } };
}

export interface InputState {
  /** The resolved value; null when the source holds none. */
  value: unknown;
  /** False when the viewer may not see the property (marking, field policy, grant). */
  visible: boolean;
  /** Older than its source's staleness threshold (28.5). */
  stale?: boolean;
}

export interface EvaluatedState {
  state: CloneState;
  reason: string;
  /** For stale: the state the inputs last gave. */
  lastKnown?: Exclude<CloneState, 'stale'>;
}

const HIDDEN_REASON = 'depends on a field not visible to you';

function typed(input: RuleInput, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if ((input.dataType === 'timestamp' || input.dataType === 'date') && typeof value === 'string') return new Date(value);
  return value;
}

/** One object's state under one viewer. `inputs` is keyed by property identity id. */
export function evaluateState(rules: CompiledStateRules, inputs: Readonly<Record<string, InputState>>, now: Date): EvaluatedState {
  const byName = new Map(rules.inputs.map((i) => [i.apiName, i]));
  const self: Record<string, unknown> = {};
  for (const input of rules.inputs) self[input.apiName] = typed(input, inputs[input.propertyIdentityId]?.value ?? null);

  let walked: EvaluatedState = { state: 'normal', reason: 'no warning or failed condition matched' };
  for (const rule of rules.rules) {
    const states = rule.reads.map((name) => inputs[byName.get(name)!.propertyIdentityId]);
    if (states.some((s) => s === undefined || !s.visible)) return { state: 'unknown', reason: HIDDEN_REASON };
    const missing = rule.reads.find((name) => self[name] === null);
    if (missing !== undefined) {
      walked = { state: 'unknown', reason: `${missing} has no value` };
      break;
    }
    let matched: unknown;
    try {
      matched = rule.program.evaluate({ self, now }, BOUNDS);
    } catch (error) {
      if (!isAppError(error)) throw error;
      walked = { state: 'unknown', reason: 'the rule could not be evaluated on this object' };
      break;
    }
    if (matched === true) {
      walked = { state: rule.state, reason: rule.reason };
      break;
    }
    if (matched !== false) {
      walked = { state: 'unknown', reason: 'the rule does not give true or false on this object' };
      break;
    }
  }
  const stale = rules.inputs.some((i) => inputs[i.propertyIdentityId]?.stale === true);
  if (stale) return { state: 'stale', reason: 'an input is older than its source allows', lastKnown: walked.state as Exclude<CloneState, 'stale'> };
  return walked;
}

/** Refuses a set of rules whose issues were found, naming the first. */
export function refuseIssues(issues: readonly RuleIssue[]): AppError {
  const first = issues[0]!;
  return new AppError('validation', `rule ${first.rule + 1}: ${first.message}`, {
    code: 'clone.state_rule_invalid', details: { rule: first.rule, reason: first.code, issues: issues.length },
  });
}
