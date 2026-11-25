// CEL, for predicates and small computations (spec 14.2): request signing, pagination
// continuation, error classification, retry delay, pushdown patches, write range checks.
//
// Bounded from inside. CEL has no loops of its own, but a comprehension over a list
// inside another one is quadratic, and a 2,000-element list takes a quarter of a second.
// Every node the evaluator runs goes through Evaluator.run, so the meter wraps it: each
// call counts a step, and the evaluation stops at the step budget or the deadline,
// whichever comes first. The library exports no hook, so the prototype is reached once,
// at load, through a macro (whose evaluate hook receives the evaluator); if a release of
// the library changes that, this module refuses to load rather than run unbounded.
//
// Values: CEL integers are BigInt. Inputs are converted (integral numbers to BigInt) and
// results converted back; an integer beyond 2^53 is refused rather than rounded.

import { Environment } from '@marcbachmann/cel-js';
import { AppError } from '../../utils/errors.util.ts';
import {
  base64, base64Decode, base64url, canonicalQuery, epochMillis, epochSeconds, hex, hmacSha256, httpDate, parseLinkHeader, rfc3339,
  sha256, urlEncode, urlPath, urlQuery,
} from './library.service.ts';

export type CelType = 'dyn' | 'int' | 'string' | 'bool' | 'timestamp' | 'map';

// The library names the timestamp type by its protobuf name.
const TYPE_NAMES: Record<CelType, string> = {
  dyn: 'dyn', int: 'int', string: 'string', bool: 'bool', timestamp: 'google.protobuf.Timestamp', map: 'map',
};

export interface CelBounds {
  steps: number;
  timeMs: number;
}

interface Meter {
  steps: number;
  budget: number;
  deadline: number;
  exceeded?: 'steps' | 'time';
}

let active: Meter | undefined;

class BudgetExceeded extends Error {}

function installMeter(): void {
  let prototype: { run: (ast: unknown, ctx: unknown) => unknown } | undefined;
  const probe = new Environment();
  probe.registerFunction('__silo_probe(ast): dyn', () => ({
    typeCheck: (checker: { getType(name: string): unknown }) => checker.getType('dyn'),
    evaluate: (evaluator: object) => {
      prototype = Object.getPrototypeOf(evaluator) as typeof prototype;
      return null;
    },
  }));
  probe.evaluate('__silo_probe(1)');
  if (prototype === undefined || typeof prototype.run !== 'function') {
    throw new Error('the CEL evaluator cannot be bounded: the library no longer routes evaluation through run');
  }
  const run = prototype.run;
  prototype.run = function meteredRun(this: unknown, ast: unknown, ctx: unknown) {
    const meter = active;
    if (meter !== undefined) {
      meter.steps += 1;
      if (meter.steps > meter.budget) {
        meter.exceeded = 'steps';
        throw new BudgetExceeded();
      }
      if ((meter.steps & 127) === 0 && performance.now() > meter.deadline) {
        meter.exceeded = 'time';
        throw new BudgetExceeded();
      }
    }
    return run.call(this, ast, ctx);
  };
}
installMeter();

const LIMITS = { maxAstNodes: 2_000, maxDepth: 48, maxListElements: 200, maxMapEntries: 200, maxCallArguments: 8 };

// The library, registered once; each block's environment is a clone with its inputs.
const base = new Environment({ homogeneousAggregateLiterals: false, limits: LIMITS })
  .registerFunction('sha256(string): bytes', sha256)
  .registerFunction('sha256(bytes): bytes', sha256)
  .registerFunction('hmac_sha256(bytes, string): bytes', hmacSha256)
  .registerFunction('hmac_sha256(string, string): bytes', hmacSha256)
  .registerFunction('hmac_sha256(bytes, bytes): bytes', hmacSha256)
  .registerFunction('hex(bytes): string', hex)
  .registerFunction('base64(bytes): string', base64)
  .registerFunction('base64url(bytes): string', base64url)
  .registerFunction('base64_decode(string): bytes', base64Decode)
  .registerFunction('url_encode(string): string', urlEncode)
  .registerFunction('canonical_query(map): string', canonicalQuery)
  .registerFunction('epoch_seconds(google.protobuf.Timestamp): int', epochSeconds)
  .registerFunction('epoch_millis(google.protobuf.Timestamp): int', epochMillis)
  .registerFunction('rfc3339(google.protobuf.Timestamp): string', rfc3339)
  .registerFunction('http_date(google.protobuf.Timestamp): string', httpDate)
  .registerFunction('link_header(string): map', parseLinkHeader)
  .registerFunction('url_path(string): string', urlPath)
  .registerFunction('url_query(string): map', urlQuery)
  // A branch that stops, typed dyn so it pairs with a map in a ternary.
  .registerFunction('stop(): dyn', () => null);

export interface CompiledCel {
  evaluate(activation: Record<string, unknown>, bounds: CelBounds): unknown;
}

/** Parses and type checks against the declared inputs. Throws AppError validation with the library's code. */
export function compileCel(source: string, inputs: Readonly<Record<string, CelType>>): CompiledCel {
  // A regular expression runs in one native call, beyond the meter's reach: a pattern that
  // backtracks could hold the process. CEL's matches() is therefore not available.
  if (/\bmatches\s*\(/.test(source)) {
    throw new AppError('validation', 'regular expressions are not available in expressions', {
      code: 'expression.invalid', details: { language: 'cel', stage: 'rule', reason: 'regex_unavailable' },
    });
  }
  const env = base.clone();
  for (const [name, type] of Object.entries(inputs)) env.registerVariable(name, TYPE_NAMES[type]);
  let program: ReturnType<Environment['parse']>;
  try {
    program = env.parse(source);
  } catch (error) {
    throw invalid(error, 'parse');
  }
  const checked = program.check();
  if (!checked.valid) throw invalid(checked.error, 'type');
  return {
    evaluate(activation, bounds) {
      const meter: Meter = { steps: 0, budget: bounds.steps, deadline: performance.now() + bounds.timeMs };
      const input: Record<string, unknown> = {};
      for (const name of Object.keys(inputs)) input[name] = toCel(activation[name] ?? null, inputs[name]!);
      active = meter;
      try {
        return fromCel(program(input));
      } catch (error) {
        if (error instanceof BudgetExceeded) {
          throw new AppError('bounds', `the expression ran past its ${meter.exceeded === 'time' ? 'time' : 'step'} budget`, {
            code: 'expression.budget', details: { language: 'cel', bound: meter.exceeded ?? 'steps' },
          });
        }
        if (error instanceof AppError) throw error;
        // The library's message can quote a value; only its code leaves.
        throw new AppError('upstream', 'the expression failed on this input', {
          code: 'expression.failed', details: { language: 'cel', reason: codeOf(error) },
        });
      } finally {
        active = undefined;
      }
    },
  };
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[a-z0-9_]{1,64}$/i.test(code) ? code : 'error';
}

function invalid(error: unknown, stage: 'parse' | 'type'): AppError {
  return new AppError('validation', `the CEL expression does not ${stage === 'parse' ? 'parse' : 'type check'}`, {
    code: 'expression.invalid', details: { language: 'cel', stage, reason: codeOf(error) },
  });
}

const MAX_NODES = 200_000;

/** JSON-like input to CEL values: integral numbers become int. Bounded in size. */
function toCel(value: unknown, type: CelType): unknown {
  let nodes = 0;
  const walk = (v: unknown): unknown => {
    if (++nodes > MAX_NODES) {
      throw new AppError('bounds', 'the expression input is too large', { code: 'expression.input_too_large', details: { language: 'cel' } });
    }
    if (typeof v === 'number') return Number.isInteger(v) ? BigInt(v) : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v instanceof Date || v instanceof Uint8Array || v === null) return v;
    if (typeof v === 'object' && v !== undefined) {
      const out: Record<string, unknown> = {};
      for (const [k, item] of Object.entries(v as Record<string, unknown>)) if (item !== undefined) out[k] = walk(item);
      return out;
    }
    return v;
  };
  if (type === 'timestamp') return value instanceof Date ? value : new Date(String(value));
  return walk(value);
}

/** CEL values to JSON-like output: int back to number, refused beyond 2^53. */
function fromCel(value: unknown): unknown {
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new AppError('bounds', 'the expression produced an integer beyond 2^53', { code: 'expression.integer_range' });
    }
    return Number(value);
  }
  if (Array.isArray(value)) return value.map(fromCel);
  if (value instanceof Map) return Object.fromEntries([...value.entries()].map(([k, v]) => [String(k), fromCel(v)]));
  if (value instanceof Uint8Array || value instanceof Date || value === null) return value;
  if (typeof value === 'object' && value !== undefined) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, fromCel(v)]));
  }
  return value;
}
