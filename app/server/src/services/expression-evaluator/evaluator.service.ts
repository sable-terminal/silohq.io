// The bounded evaluator shared by connectors, Functions, state rules and Action validation
// (spec 14.2; catalogue: expression-evaluator). One entry point: an expression is compiled
// for the block it sits in, which fixes its language, the names it may read, its bounds and
// the shape of what it must return.
//
// Guards, none optional:
// - only the block's declared inputs are in scope. A secret is declared by auth.sign and
//   change.verify alone, which the credential service evaluates inside the mediator
//   callback (spec 15.1, 18.8); every other block cannot name one, and a name it was not
//   given does not type check (CEL) or is empty (JSONata);
// - no network, file, environment or randomness, and the only clock is the injected now;
// - a step budget and a deadline enforced from inside the evaluation, an input size bound
//   and an output size bound;
// - the result is checked against the block's shape before anyone uses it.
// Errors carry the library's code, never its message: a message can quote a value.

import { z } from 'zod';
import {
  CHANGE_OPERATIONS, EXPRESSION_BLOCKS, manifestExpressions, requestPatch, type ExpressionBlock, type Manifest,
} from '../../contracts/connect/manifest.contract.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { compileCel, type CelType, type CompiledCel } from './cel.service.ts';
import { compileJsonata, type CompiledJsonata } from './jsonata.service.ts';

export { EXPRESSION_BLOCKS, type ExpressionBlock };

interface CelBlock {
  language: 'cel';
  inputs: Readonly<Record<string, CelType>>;
  result: z.ZodType;
  steps: number;
  timeMs: number;
}

interface JsonataBlock {
  language: 'jsonata';
  /** Names bound beside $ (the input). */
  bindings: readonly string[];
  result: z.ZodType;
  steps: number;
  timeMs: number;
  maxOutputBytes: number;
}

type Block = CelBlock | JsonataBlock;

const KB = 1024;
const CEL_DEFAULT = { steps: 10_000, timeMs: 10 } as const;
const JSONATA_DEFAULT = { steps: 10_000, timeMs: 10, maxOutputBytes: 256 * KB } as const;

/** What a change stream's decode gives: deltas naming the object, the entity and what changed (spec 18.2). */
export const changeDeltas = z.array(z.strictObject({
  object: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
  entityRef: z.union([z.string().min(1).max(512), z.number()]),
  operation: z.enum(CHANGE_OPERATIONS),
  changed: z.record(z.string().min(1).max(500), z.json()).optional(),
  sourceAt: z.string().max(64).optional(),
  sourceSeq: z.union([z.string().min(1).max(200), z.number()]).optional(),
})).max(10_000);
export type ChangeDeltaDraft = z.infer<typeof changeDeltas>[number];

const signed = z.strictObject({
  headers: z.record(z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/), z.string().max(8_192)).optional(),
  query: z.record(z.string().min(1).max(200), z.string().max(8_192)).optional(),
});

// The blocks of spec 14.3, each with its inputs and result. Budgets are the spec's
// targets (CEL 10,000 units; JSONata 10,000 steps and 10 ms) except records, which
// reshapes a whole page in one evaluation: 100,000 steps and 100 ms (this build's choice).
export const BLOCKS: Readonly<Record<ExpressionBlock, Block>> = {
  'records': {
    language: 'jsonata', bindings: ['headers', 'params'], result: z.union([z.array(z.json()), z.record(z.string(), z.json()), z.null()]),
    steps: 100_000, timeMs: 100, maxOutputBytes: 64 * KB * KB,
  },
  'field': { language: 'jsonata', bindings: ['params'], result: z.json(), ...JSONATA_DEFAULT, maxOutputBytes: 64 * KB },
  // An MQTT message (20.2) to its record, or null to skip it: one message an evaluation.
  'source.decode': { language: 'jsonata', bindings: ['params'], result: z.union([z.record(z.string(), z.json()), z.null()]), ...JSONATA_DEFAULT, maxOutputBytes: 64 * KB },
  'paging.next': {
    language: 'cel', inputs: { request: 'dyn', response: 'dyn', page: 'dyn', links: 'dyn', params: 'dyn' },
    result: requestPatch.nullable(), ...CEL_DEFAULT,
  },
  'pushdown.filter': {
    language: 'cel', inputs: { field: 'string', op: 'string', value: 'dyn', params: 'dyn' }, result: requestPatch, ...CEL_DEFAULT,
  },
  'pushdown.sort': { language: 'cel', inputs: { field: 'string', direction: 'string', params: 'dyn' }, result: requestPatch, ...CEL_DEFAULT },
  'pushdown.limit': { language: 'cel', inputs: { limit: 'int', params: 'dyn' }, result: requestPatch, ...CEL_DEFAULT },
  'errors.when': {
    language: 'cel', inputs: { status: 'int', headers: 'dyn', body: 'dyn', sqlstate: 'string' }, result: z.boolean(), ...CEL_DEFAULT,
  },
  'errors.retryAfter': {
    language: 'cel', inputs: { status: 'int', headers: 'dyn', body: 'dyn', sqlstate: 'string', now: 'timestamp' },
    result: z.number().int().min(0).max(3_600), ...CEL_DEFAULT,
  },
  'auth.sign': {
    language: 'cel', inputs: { request: 'dyn', now: 'timestamp', public: 'dyn', secret: 'dyn' }, result: signed, ...CEL_DEFAULT,
  },
  'write.body': { language: 'jsonata', bindings: ['identifier', 'params'], result: z.json(), ...JSONATA_DEFAULT },
  'write.result': { language: 'jsonata', bindings: ['headers'], result: z.json(), ...JSONATA_DEFAULT },
  'write.valueCheck': { language: 'cel', inputs: { values: 'dyn', prior: 'dyn' }, result: z.boolean(), ...CEL_DEFAULT },
  // Change streams (spec 18.2, 18.6, 18.8). verify holds a secret, so like auth.sign it is
  // evaluated by the credential service only, which compares the two signatures in
  // constant time; signedAt is epoch seconds, for replay protection.
  'change.verify': {
    language: 'cel', inputs: { body: 'string', headers: 'dyn', params: 'dyn', now: 'timestamp', secret: 'dyn' },
    result: z.strictObject({
      expected: z.string().min(1).max(2_048),
      provided: z.string().max(2_048),
      signedAt: z.number().int().min(0).optional(),
    }), ...CEL_DEFAULT,
  },
  // A delivery's body to its deltas; it reshapes a whole delivery, so records' budget.
  'change.decode': {
    language: 'jsonata', bindings: ['headers', 'params'], result: z.union([changeDeltas, z.null()]),
    steps: 100_000, timeMs: 100, maxOutputBytes: 1024 * KB,
  },
  'change.dedupKey': { language: 'cel', inputs: { delta: 'dyn' }, result: z.string().min(1).max(1_024), ...CEL_DEFAULT },
  // An Action's outbound webhook body (spec 20.4): $ is the executed Action (references and its parameters).
  'webhook.payload': { language: 'jsonata', bindings: [], result: z.json(), ...JSONATA_DEFAULT, maxOutputBytes: 256 * KB },
};

export interface CompiledExpression {
  readonly block: ExpressionBlock;
  /**
   * CEL: scope holds the block's inputs. JSONata: scope.input is $, the rest are its
   * bindings. Names the block does not declare are ignored.
   */
  evaluate(scope: Record<string, unknown>, now: Date): Promise<unknown>;
}

const MAX_CACHED = 5_000;
const cache = new Map<string, CompiledExpression>();

/** Compiles an expression for its block; cached. Throws AppError validation, code expression.invalid. */
export function compileExpression(block: ExpressionBlock, language: 'cel' | 'jsonata', source: string): CompiledExpression {
  const spec = BLOCKS[block];
  if (spec === undefined) throw new AppError('validation', 'no such expression block', { code: 'expression.block' });
  if (spec.language !== language) {
    throw new AppError('validation', `a ${block} expression is ${spec.language}`, {
      code: 'expression.invalid', details: { block, stage: 'language', reason: 'wrong_language' },
    });
  }
  const key = `${block}\u0000${source}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let compiled: CompiledExpression;
  try {
    compiled = spec.language === 'cel' ? celExpression(block, spec, compileCel(source, spec.inputs))
      : jsonataExpression(block, spec, compileJsonata(source, spec));
  } catch (error) {
    if (isAppError(error) && error.code === 'expression.invalid') {
      throw new AppError('validation', error.message, { code: error.code, details: { ...error.details, block } });
    }
    throw error;
  }
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
  cache.set(key, compiled);
  return compiled;
}

function shaped(block: ExpressionBlock, spec: Block, value: unknown): unknown {
  const parsed = spec.result.safeParse(value);
  if (!parsed.success) {
    throw new AppError('upstream', `the ${block} expression returned the wrong shape`, {
      code: 'expression.result_shape', details: { block },
    });
  }
  return parsed.data;
}

function celExpression(block: ExpressionBlock, spec: CelBlock, program: CompiledCel): CompiledExpression {
  return {
    block,
    async evaluate(scope, now) {
      const activation: Record<string, unknown> = {};
      for (const name of Object.keys(spec.inputs)) activation[name] = name === 'now' ? now : scope[name];
      return shaped(block, spec, program.evaluate(activation, spec));
    },
  };
}

function jsonataExpression(block: ExpressionBlock, spec: JsonataBlock, program: CompiledJsonata): CompiledExpression {
  return {
    block,
    async evaluate(scope, now) {
      const bindings: Record<string, unknown> = {};
      for (const name of spec.bindings) bindings[name] = scope[name] ?? null;
      return shaped(block, spec, await program.evaluate(scope['input'] ?? null, bindings, now));
    },
  };
}

export interface ExpressionIssue {
  path: string;
  block: ExpressionBlock;
  code: string;
  reason: string;
}

/** Every expression of a manifest compiled for its block. Empty when all pass (spec 14.2). */
export function checkManifestExpressions(manifest: Manifest): ExpressionIssue[] {
  const issues: ExpressionIssue[] = [];
  for (const expression of manifestExpressions(manifest)) {
    try {
      compileExpression(expression.block, expression.language, expression.source);
    } catch (error) {
      if (!isAppError(error)) throw error;
      issues.push({
        path: expression.path, block: expression.block, code: error.code,
        reason: typeof error.details['reason'] === 'string' ? error.details['reason'] : error.code,
      });
    }
  }
  return issues;
}
