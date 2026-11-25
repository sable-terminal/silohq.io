// JSONata, for reshaping (spec 14.2): unwrapping envelopes, flattening records, computing a
// field from a record, building a write body from values.
//
// JSONata is not loop-free: lambdas recurse. Its evaluation runs in microtasks, so a timer
// beside it never fires; the bounds act from inside instead. Every node evaluated calls
// the library's entry hook, which counts steps against the budget, and the library's own
// guardrails stop a deep stack or an evaluation past its deadline. Sequences are bounded,
// and the output size is checked before it is returned.
//
// Refused at compile, rather than repaired (spec 14.2): $eval (a source could supply code
// at read time), $random and $shuffle (two reads would disagree), recursive user-defined
// functions, and a range (..) other than a small constant one. $now and $millis read the
// injected now, fixed per request; the real clock is never reachable.

import jsonata from 'jsonata';
import { AppError } from '../../utils/errors.util.ts';
import { parseLinkHeader, sha256, hex } from './library.service.ts';

export interface JsonataBounds {
  steps: number;
  timeMs: number;
  maxOutputBytes: number;
}

const ENTRY = Symbol.for('jsonata.__evaluate_entry');
const FORBIDDEN = new Set(['eval', 'random', 'shuffle']);
const MAX_RANGE = 1_000;
const MAX_PAD = 10_000;

class BudgetExceeded extends Error {
  readonly bound: 'steps' | 'time' | 'size';
  constructor(bound: 'steps' | 'time' | 'size') {
    super(bound);
    this.bound = bound;
  }
}

interface Node {
  type?: string;
  value?: unknown;
  [key: string]: unknown;
}

export interface CompiledJsonata {
  evaluate(input: unknown, bindings: Record<string, unknown>, now: Date): Promise<unknown>;
}

const STEPS = Symbol('silo.steps');

function invalid(reason: string, stage: 'parse' | 'rule'): AppError {
  return new AppError('validation', stage === 'parse' ? 'the JSONata expression does not parse' : 'the JSONata expression is not permitted', {
    code: 'expression.invalid', details: { language: 'jsonata', stage, reason },
  });
}

// Every node beneath a JSONata AST node, whatever the property holding it.
function children(node: Node): Node[] {
  const out: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'position' || key === 'value' && node.type !== 'bind') continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (Array.isArray(item)) out.push(...(item.filter((i) => i && typeof i === 'object') as Node[]));
        else if (item && typeof item === 'object') out.push(item as Node);
      }
    } else if (value && typeof value === 'object') out.push(value as Node);
  }
  return out;
}

const references = (node: Node, name: string): boolean =>
  (node.type === 'variable' && node.value === name) || children(node).some((child) => references(child, name));

function checkRules(node: Node, depth = 0): void {
  if (depth > 200) throw invalid('nesting', 'rule');
  if (node.type === 'function' || node.type === 'partial') {
    const procedure = node['procedure'] as Node | undefined;
    if (procedure?.type === 'variable' && typeof procedure.value === 'string' && FORBIDDEN.has(procedure.value)) {
      throw invalid(`function_${procedure.value}`, 'rule');
    }
  }
  if (node.type === 'variable' && typeof node.value === 'string' && FORBIDDEN.has(node.value)) {
    throw invalid(`function_${node.value}`, 'rule');
  }
  // A regular expression runs in one native call, beyond the step budget: a pattern that
  // backtracks could hold the process. Without regex literals, $match has nothing to run
  // and $contains, $replace and $split match literal text.
  if (node.type === 'regex') throw invalid('regex_unavailable', 'rule');
  if (node.type === 'bind') {
    const lhs = node['lhs'] as Node | undefined;
    const rhs = node['rhs'] as Node | undefined;
    if (lhs?.type === 'variable' && rhs?.type === 'lambda' && typeof lhs.value === 'string' && references(rhs, lhs.value)) {
      throw invalid('recursive_function', 'rule');
    }
  }
  if (node.type === 'binary' && node.value === '..') {
    const lhs = node['lhs'] as Node | undefined;
    const rhs = node['rhs'] as Node | undefined;
    if (lhs?.type !== 'number' || rhs?.type !== 'number' || Number(rhs.value) - Number(lhs.value) > MAX_RANGE) {
      throw invalid('range', 'rule');
    }
  }
  for (const child of children(node)) checkRules(child, depth + 1);
}

// Values the library can produce that JSON cannot carry are dropped by stringify; the
// size is measured on what would be returned.
function sizeOf(value: unknown): number {
  if (value === undefined) return 0;
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

// JSONata wraps arrays in sequences carrying flags; return plain JSON.
function plain(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value) ?? 'null');
}

/** Parses and checks the rules. Throws AppError validation. */
export function compileJsonata(source: string, bounds: JsonataBounds): CompiledJsonata {
  let expression: ReturnType<typeof jsonata>;
  try {
    // The library's guardrails start their clock and depth per evaluation; steps are
    // counted on the evaluation's own frame, so concurrent evaluations share nothing.
    expression = jsonata(source, { timeout: bounds.timeMs, stack: 150, sequence: 100_000 } as Parameters<typeof jsonata>[1]);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw invalid(typeof code === 'string' ? code : 'syntax', 'parse');
  }
  checkRules(expression.ast() as unknown as Node);
  expression.assign(ENTRY as unknown as string, (_expr: unknown, _input: unknown, environment: { base: Record<symbol, number> }) => {
    const frame = environment.base;
    frame[STEPS] = (frame[STEPS] ?? 0) + 1;
    if (frame[STEPS] > bounds.steps) throw new BudgetExceeded('steps');
  });
  for (const name of FORBIDDEN) expression.assign(name, () => { throw new BudgetExceeded('steps'); });
  expression.registerFunction('pad', (text: string, width: number, char?: string) => {
    if (Math.abs(width) > MAX_PAD) throw new BudgetExceeded('size');
    const fill = (char ?? ' ').slice(0, 1) || ' ';
    const missing = Math.max(0, Math.abs(width) - [...text].length);
    return width < 0 ? fill.repeat(missing) + text : text + fill.repeat(missing);
  }, '<s-ns?:s>');
  expression.registerFunction('sha256Hex', (text: string) => hex(sha256(text)), '<s-:s>');
  expression.registerFunction('parseLinkHeader', (text: string) => parseLinkHeader(text), '<s-:o>');

  return {
    async evaluate(input, bindings, now) {
      let result: unknown;
      try {
        // The injected now shadows the library's clock functions for this evaluation.
        result = await expression.evaluate(input, { ...bindings, now: () => now.toISOString(), millis: () => now.getTime() });
      } catch (error) {
        if (error instanceof BudgetExceeded) throw budget(error.bound);
        const code = (error as { code?: unknown } | null)?.code;
        if (code === 'D1012') throw budget('time');
        if (code === 'D1011' || code === 'D2015' || code === 'D2014') throw budget('steps');
        throw new AppError('upstream', 'the expression failed on this input', {
          code: 'expression.failed', details: { language: 'jsonata', reason: typeof code === 'string' ? code : 'error' },
        });
      }
      if (sizeOf(result) > bounds.maxOutputBytes) throw budget('size');
      return plain(result);
    },
  };
}

function budget(bound: 'steps' | 'time' | 'size'): AppError {
  return new AppError('bounds', `the expression ran past its ${bound === 'size' ? 'output size' : bound === 'time' ? 'time' : 'step'} budget`, {
    code: 'expression.budget', details: { language: 'jsonata', bound },
  });
}
