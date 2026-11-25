// The expression evaluator's endpoints (catalogue: expression-evaluator). Builders check an
// expression as it is typed; Functions, state rules and Action validation evaluate one.
// Connectors evaluate in-process in connect-runtime, which links the same module.
//
// auth.sign is never evaluated here: its scope holds a secret, and only the credential
// service evaluates it, inside the mediator callback (spec 15.1).

import { z } from 'zod';
import { EXPRESSION_BLOCKS } from '../connect/manifest.contract.ts';
import { defineContract } from '../endpoint.contract.ts';

const CALLERS = ['connect-registry', 'connector-builder', 'visual-builder', 'conformance', 'connector-maintenance', 'ontology',
  'actions', 'state-plane', 'fde-orchestrator'] as const;

const expression = {
  block: z.enum(EXPRESSION_BLOCKS),
  language: z.enum(['cel', 'jsonata']),
  source: z.string().min(1).max(8_000),
};

export const validateExpression = defineContract({
  service: 'expression-evaluator', name: 'validateExpression', method: 'POST', path: '/v1/expressions/validations',
  callers: CALLERS, context: 'none', idempotency: 'none',
  body: z.strictObject(expression),
  response: z.discriminatedUnion('valid', [
    z.object({ valid: z.literal(true) }),
    z.object({ valid: z.literal(false), code: z.string(), stage: z.string(), reason: z.string() }),
  ]),
  maxBodyBytes: 16_384,
});

export const evaluateExpression = defineContract({
  service: 'expression-evaluator', name: 'evaluateExpression', method: 'POST', path: '/v1/expressions/evaluations',
  callers: CALLERS, context: 'none', idempotency: 'none',
  body: z.strictObject({
    ...expression,
    block: z.enum(EXPRESSION_BLOCKS).refine((b) => b !== 'auth.sign' && b !== 'change.verify',
      'auth.sign and change.verify are evaluated by the credential service only'),
    /** CEL: the block's inputs. JSONata: input is $, the rest its bindings. */
    scope: z.record(z.string().max(100), z.json()),
    /** The request's fixed now. */
    now: z.iso.datetime({ offset: true }),
  }),
  response: z.object({ value: z.json() }),
  maxBodyBytes: 512 * 1024,
});
